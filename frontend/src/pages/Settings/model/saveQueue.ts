export type Patch = Record<string, unknown>;
export type SavePhase =
  "pending" | "saving" | "saved" | "invalid" | "error" | "draft";
export interface SaveState {
  phase: SavePhase;
  error?: string;
}
export function mergePatch(base: Patch, patch: Patch): Patch {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    next[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? mergePatch((base[key] as Patch) ?? {}, value as Patch)
        : value;
  }
  return next;
}
/** A response acknowledges only the draft it actually sent, never newer edits. */
export function acknowledgeDrafts(drafts: Patch, sent: Patch): Patch {
  const next = { ...drafts };
  for (const id of Object.keys(sent)) {
    if (JSON.stringify(next[id]) === JSON.stringify(sent[id])) delete next[id];
  }
  return next;
}
interface Job {
  patch: Patch;
  run: (patch: Patch) => Promise<void>;
  ready: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** A shared queue for all configuration endpoints. Failed groups retain their latest patch. */
export class SettingsSaveQueue {
  private jobs = new Map<string, Job>();
  private states: Record<string, SaveState> = {};
  private running = false;
  private listeners = new Set<() => void>();
  private idleWaiters: Array<() => void> = [];
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.states;
  private publish(id: string, state: SaveState) {
    this.states = { ...this.states, [id]: state };
    this.listeners.forEach((fn) => fn());
  }
  stage(id: string, error?: string) {
    const job = this.jobs.get(id);
    if (job?.timer) clearTimeout(job.timer);
    this.jobs.delete(id);
    this.publish(id, { phase: error ? "invalid" : "draft", error });
  }
  enqueue(id: string, patch: Patch, run: Job["run"], delay = 0) {
    const previous = this.jobs.get(id);
    if (previous?.timer) clearTimeout(previous.timer);
    const job: Job = {
      patch: mergePatch(previous?.patch ?? {}, patch),
      run,
      ready: delay === 0,
    };
    this.jobs.set(id, job);
    // A failed group is paused until explicitly retried.
    if (this.states[id]?.phase === "error") return;
    this.publish(id, { phase: "pending" });
    if (delay)
      job.timer = setTimeout(() => {
        job.ready = true;
        void this.drain();
      }, delay);
    void this.drain();
  }
  retry(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.ready = true;
    this.publish(id, { phase: "pending" });
    void this.drain();
  }
  discard(id: string) {
    const job = this.jobs.get(id);
    if (job?.timer) clearTimeout(job.timer);
    this.jobs.delete(id);
    this.publish(id, { phase: "saved" });
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const entry = [...this.jobs].find(
          ([id, job]) => job.ready && this.states[id]?.phase === "pending",
        );
        if (!entry) break;
        const [id, job] = entry;
        if (job.timer) clearTimeout(job.timer);
        this.jobs.delete(id);
        this.publish(id, { phase: "saving" });
        try {
          await job.run(job.patch);
          if (!this.jobs.has(id) && this.states[id]?.phase === "saving")
            this.publish(id, { phase: "saved" });
        } catch (error) {
          const newer = this.jobs.get(id);
          // The user may have replaced the request with an invalid/manual draft,
          // or discarded it while it was in flight. Do not resurrect that patch.
          if (!newer && this.states[id]?.phase !== "saving") continue;
          if (newer?.timer) clearTimeout(newer.timer);
          this.jobs.set(id, {
            patch: mergePatch(job.patch, newer?.patch ?? {}),
            run: newer?.run ?? job.run,
            ready: true,
          });
          this.publish(id, {
            phase: "error",
            error: error instanceof Error ? error.message : "保存失败，请重试",
          });
        }
      }
    } finally {
      this.running = false;
      this.idleWaiters.splice(0).forEach((fn) => fn());
    }
  }
  async flush(ids?: readonly string[]) {
    for (const [id, job] of this.jobs) {
      if (ids && !ids.includes(id)) continue;
      if (job.timer) clearTimeout(job.timer);
      job.ready = true;
    }
    if (this.running)
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    await this.drain();
    return !Object.entries(this.states).filter(([id]) => !ids || ids.includes(id)).some(([, s]) =>
      ["pending", "saving", "draft", "invalid", "error"].includes(s.phase),
    );
  }
  hasUnsaved = () =>
    Object.values(this.states).some((s) => !["saved"].includes(s.phase));
  dispose() {
    for (const job of this.jobs.values())
      if (job.timer) clearTimeout(job.timer);
    this.jobs.clear();
  }
}
