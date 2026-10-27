import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { Recording } from "../types/index.js";
import type { Services } from "./services.js";
import {
  checkFileIntegrityDetailed,
  type IntegrityCheckDetail,
} from "../recorder/integrity.js";

interface VerifyJob {
  recordingId: string;
  filePath: string;
  fingerprint: string;
  key: string;
  createdAt: string;
  result: Promise<IntegrityCheckDetail>;
  resolve: (result: IntegrityCheckDetail) => void;
}

const VERIFY_CONCURRENCY = 2;
const fingerprint = (
  st: { dev: number; ino: number; size: number; mtimeMs: number } | null,
) => (st ? `${st.dev}|${st.ino}|${st.size}|${st.mtimeMs}` : "unavailable");

/** Recording completion, recovery, manual checks and pipeline checks share two probe slots. */
export class VerificationQueue {
  private queue: VerifyJob[] = [];
  private jobs = new Map<string, VerifyJob>();
  // Only recent, unchanged files are reused by the pipeline; manual enqueue always rechecks.
  private completed = new Map<
    string,
    { key: string; result: IntegrityCheckDetail }
  >();
  private active = 0;

  constructor(private services: Services) {}

  positionOf(recordingId: string): number | null {
    const idx = this.queue.findIndex((job) => job.recordingId === recordingId);
    return idx >= 0 ? idx + 1 : null;
  }

  private identity(rec: Recording): { key: string; fingerprint: string } {
    let stamp = "unavailable";
    try {
      stamp = fingerprint(statSync(rec.filePath!));
    } catch {
      /* Missing storage can be retried. */
    }
    return { key: `${rec.id}|${rec.filePath}|${stamp}`, fingerprint: stamp };
  }

  enqueue(rec: Recording): boolean {
    if (!rec.filePath) return false;
    const identity = this.identity(rec);
    if (this.jobs.has(identity.key)) return false;
    this.schedule(rec, identity);
    return true;
  }

  /** Await an existing job rather than launching a second ffprobe from the pipeline. */
  verify(rec: Recording): Promise<IntegrityCheckDetail> {
    if (!rec.filePath)
      return Promise.resolve({
        outcome: "unverifiable",
        detail: "录像文件暂不可访问",
      });
    const identity = this.identity(rec);
    const job = this.jobs.get(identity.key);
    if (job) return job.result;
    const cached = this.completed.get(rec.id);
    if (cached?.key === identity.key) return Promise.resolve(cached.result);
    return this.schedule(rec, identity).result;
  }

  private schedule(
    rec: Recording,
    identity: { key: string; fingerprint: string },
  ): VerifyJob {
    let resolve!: VerifyJob["resolve"];
    const result = new Promise<IntegrityCheckDetail>((done) => {
      resolve = done;
    });
    const job: VerifyJob = {
      recordingId: rec.id,
      filePath: rec.filePath!,
      ...identity,
      createdAt: rec.createdAt,
      result,
      resolve,
    };
    this.completed.delete(rec.id);
    this.jobs.set(job.key, job);
    this.queue.push(job);
    this.queue.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.services.recordings.update(rec.id, {
      integrityState: "queued",
      integrity: "pending",
      integrityError: null,
    });
    this.emit(rec.id);
    console.log(`[verify] 入队 ${rec.id}（第 ${this.positionOf(rec.id)} 位）`);
    this.pump();
    return job;
  }

  /** Boot pagination is intentionally unchanged here. */
  requeuePending(): number {
    const rows = this.services.recordings.list({
      pageSize: 100000,
      page: 1,
    }).items;
    let count = 0;
    for (const rec of rows) {
      const state = rec.integrityState;
      const stale =
        state == null ||
        state === "pending" ||
        state === "queued" ||
        state === "verifying";
      if (stale && this.enqueue(rec)) count += 1;
    }
    return count;
  }

  private emit(recordingId: string): void {
    const rec = this.services.recordings.get(recordingId);
    if (rec)
      this.services.events.emit({ type: "recording:updated", data: rec });
  }

  private pump(): void {
    while (this.active < VERIFY_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active += 1;
      void this.run(job).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async run(job: VerifyJob): Promise<void> {
    let result: IntegrityCheckDetail = {
      outcome: "unverifiable",
      detail: "校验异常，可重试",
    };
    try {
      const prev = this.services.recordings.get(job.recordingId);
      if (!prev || prev.filePath !== job.filePath) return;
      this.services.recordings.update(job.recordingId, {
        integrityState: "verifying",
        integrity: "pending",
        integrityError: null,
        integrityAttempts: (prev.integrityAttempts ?? 0) + 1,
        integrityLastAttempt: this.services.clock.iso(),
      });
      this.emit(job.recordingId);
      try {
        result = await checkFileIntegrityDetailed(job.filePath);
      } catch {
        /* Unexpected probe errors use the same unavailable result. */
      }
      // A delayed source check must not overwrite the result of a replacement file.
      const stamp = fingerprint(await stat(job.filePath).catch(() => null));
      const current = this.services.recordings.get(job.recordingId);
      if (
        !current ||
        current.filePath !== job.filePath ||
        stamp !== job.fingerprint
      ) {
        result = {
          outcome: "unverifiable",
          detail: "录像文件已变化，请重新校验",
        };
        const newerJob = [...this.jobs.values()].some(
          (other) => other !== job && other.recordingId === job.recordingId,
        );
        if (current && current.integrityState === "verifying" && !newerJob) {
          this.services.recordings.update(job.recordingId, {
            integrity: "pending",
            integrityState: "unverifiable",
            integrityError: result.detail,
          });
          this.emit(job.recordingId);
        }
        return;
      }
      const legacy =
        result.outcome === "ok"
          ? "verified"
          : result.outcome === "failed"
            ? "failed"
            : "pending";
      this.services.recordings.update(job.recordingId, {
        integrity: legacy,
        integrityState: result.outcome,
        integrityError: result.outcome === "ok" ? null : result.detail,
      });
      if (result.outcome !== "unverifiable") {
        this.completed.delete(job.recordingId);
        this.completed.set(job.recordingId, { key: job.key, result });
        if (this.completed.size > 128)
          this.completed.delete(this.completed.keys().next().value!);
      }
      console.log(
        `[verify] ${job.recordingId} → ${result.outcome}${result.detail ? `（${result.detail}）` : ""}`,
      );
      if (result.outcome === "failed") {
        this.services.alerts.createOrRefresh({
          level: "warning",
          source: "recorder",
          message: "录制文件校验失败，可能损坏或截断",
          occurredAt: this.services.clock.iso(),
          roomId: current.roomId,
          errorCode: "RECORDING_FILE_CORRUPTED",
          retryable: false,
        });
      }
      this.emit(job.recordingId);
    } catch {
      // Shutdown/deletion must still release the shared probe slot and all waiters.
    } finally {
      this.jobs.delete(job.key);
      job.resolve(result);
    }
  }
}
