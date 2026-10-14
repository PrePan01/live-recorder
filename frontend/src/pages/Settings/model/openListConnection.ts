import { SettingsSaveQueue } from "./saveQueue";

export interface ConnectionState {
  phase: "unchecked" | "checking" | "ok" | "error";
  message: string;
}
interface Operations {
  test: () => Promise<{ ok: boolean }>;
  writeEnabled: (enabled: boolean) => Promise<void>;
  rejectedEnable: () => void;
  status: (state: ConnectionState) => void;
}

/** Network probes never occupy the shared configuration write queue. */
export class OpenListConnection {
  private revision = 0;
  private request = 0;
  private queue: SettingsSaveQueue;
  private operations?: Operations;
  private pendingWrites = new Set<Promise<"ok" | "error" | "stale">>();
  constructor(queue: SettingsSaveQueue, operations?: Operations) {
    this.queue = queue;
    this.operations = operations;
  }
  configure(operations: Operations) { this.operations = operations; }
  invalidate() { this.revision++; this.request++; this.pendingWrites.clear(); }

  hasPendingWrites = () => this.pendingWrites.size > 0;
  async waitForWrites() {
    while (this.pendingWrites.size) await Promise.all([...this.pendingWrites]);
  }
  verify(mode: "enable" | "revalidate" | "check", prepare?: () => Promise<boolean>) {
    const pending = this.run(mode, prepare);
    if (mode !== "check") {
      this.pendingWrites.add(pending);
      const settled = () => { this.pendingWrites.delete(pending); };
      void pending.then(settled, settled);
    }
    return pending;
  }

  private async run(mode: "enable" | "revalidate" | "check", prepare?: () => Promise<boolean>): Promise<"ok" | "error" | "stale"> {
    const operations = this.operations;
    if (!operations) return "stale";
    const revision = this.revision;
    const request = ++this.request;
    const current = () => revision === this.revision && request === this.request;
    operations.status({ phase: "checking", message: "正在验证连接…" });
    try {
      if (prepare && !(await prepare())) throw new Error("请先修正连接配置中的无效输入或保存错误");
      if (!current()) return "stale";
      if (!(await operations.test()).ok) throw new Error("连接异常");
    } catch (error) {
      if (!current()) return "stale";
      const reason = error instanceof Error ? error.message : "连接失败";
      operations.status({ phase: "error", message: reason });
      if (mode === "enable") operations.rejectedEnable();
      if (mode === "revalidate") {
        this.queue.enqueue("upload-enabled", { enabled: false }, async () => {
          if (!current()) return;
          await operations.writeEnabled(false);
          if (current()) operations.status({ phase: "error", message: `连接检测未通过，已关闭自动上传：${reason}` });
        });
      }
      return "error";
    }
    if (!current()) return "stale";
    if (mode === "enable") {
      this.queue.enqueue("upload-enabled", { enabled: true }, async () => {
        // Recheck after waiting behind other configuration writes.
        if (!current()) return;
        await operations.writeEnabled(true);
        if (current()) operations.status({ phase: "ok", message: "连接正常，自动上传已启用" });
      });
    } else operations.status({ phase: "ok", message: "连接正常" });
    return "ok";
  }
}
