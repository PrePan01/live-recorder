import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import type { DanmakuMessage } from "./types.js";

/**
 * 弹幕 sidecar 存储：行式 JSONL 追加写。行式的意义=崩溃/断电只丢最后一行，
 * 不会像单个大 JSON 那样整体损坏。文件与录制同名（.danmaku.jsonl），
 * 删除录制时联动删除本文件。
 */
export class DanmakuStore {
  private writer: WriteStream | null = null;
  private queue: string[] = [];
  private pumping = false;
  private failed: Error | null = null;
  private count = 0;

  private constructor(
    readonly filePath: string,
  ) {}

  static sidecarPathFor(recordingFilePath: string): string {
    const ext = path.extname(recordingFilePath);
    const base = ext ? recordingFilePath.slice(0, -ext.length) : recordingFilePath;
    return `${base}.danmaku.jsonl`;
  }

  static async open(recordingFilePath: string): Promise<DanmakuStore> {
    const filePath = DanmakuStore.sidecarPathFor(recordingFilePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    const store = new DanmakuStore(filePath);
    store.writer = createWriteStream(filePath, { flags: "a" });
    store.writer.on("error", (error) => {
      store.failed ??= error;
    });
    return store;
  }

  /** 打开既有 sidecar 供读取（不创建、不写入）。 */
  static async openExisting(recordingFilePath: string): Promise<DanmakuStore | null> {
    const filePath = DanmakuStore.sidecarPathFor(recordingFilePath);
    const info = await stat(filePath).catch(() => null);
    if (!info) return null;
    return new DanmakuStore(filePath);
  }

  get error(): Error | null {
    return this.failed;
  }

  get size(): number {
    return this.count;
  }

  /**
   * 追加一条消息。写入失败只记内部错误状态、绝不抛出——
   * 弹幕存储故障不得影响录制主链路（产品红线）。
   */
  append(message: DanmakuMessage): void {
    if (this.failed || !this.writer) return;
    this.count += 1;
    this.queue.push(JSON.stringify(message));
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && this.writer && !this.failed) {
        const line = this.queue.shift()!;
        const ok = this.writer.write(`${line}\n`);
        if (!ok) await this.waitForDrain();
      }
    } finally {
      this.pumping = false;
    }
  }

  private waitForDrain(): Promise<void> {
    return new Promise((resolve) => {
      const writer = this.writer;
      if (!writer) return resolve();
      const settle = () => {
        writer.off("drain", settle);
        writer.off("error", settle);
        writer.off("close", settle);
        resolve();
      };
      writer.once("drain", settle);
      writer.once("error", settle);
      writer.once("close", settle);
    });
  }

  async close(): Promise<void> {
    const writer = this.writer;
    this.writer = null;
    if (!writer) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => resolve(), 3000);
      timer.unref?.();
      writer.end(() => {
        if (timer) clearTimeout(timer);
        resolve();
      });
      writer.on("error", () => {
        if (timer) clearTimeout(timer);
        resolve();
      });
    });
  }

  /** 读取区间消息（媒体时间轴查询）。unmappable 消息默认不返回。 */
  async readRange(
    fromMs: number,
    toMs: number,
    opts: { limit?: number; includeUnmappable?: boolean } = {},
  ): Promise<{ messages: DanmakuMessage[]; next: number | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 5000, 1), 20000);
    const raw = await readFile(this.filePath, "utf8").catch(() => "");
    const messages: DanmakuMessage[] = [];
    let next: number | null = null;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let message: DanmakuMessage;
      try {
        message = JSON.parse(line) as DanmakuMessage;
      } catch {
        continue; // 崩溃残行：跳过不毁全量
      }
      if (message.unmappable) {
        // 无媒体时间轴的归属：仅显式请求时返回，且不参与时间窗过滤。
        if (!opts.includeUnmappable) continue;
        if (messages.length >= limit) break;
        messages.push(message);
        continue;
      }
      const t = message.tMs;
      if (t === null || t < fromMs || t > toMs) continue;
      if (messages.length >= limit) {
        next = t;
        break;
      }
      messages.push(message);
    }
    return { messages, next };
  }

  /** 删除 sidecar（删除录制时联动）。 */
  static async remove(recordingFilePath: string): Promise<void> {
    await rm(DanmakuStore.sidecarPathFor(recordingFilePath), { force: true });
  }
}
