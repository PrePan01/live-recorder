import type { DanmakuMessage } from './types.js';

/** Ephemeral preview storage: no disk I/O, bounded by age, count and text bytes. */
export class DanmakuPreviewBuffer {
  readonly persistent = false;
  readonly gapHistoryLimit = 64;
  readonly error = null;
  private items: { seq: number; message: DanmakuMessage; bytes: number }[] = [];
  private head = 0;
  private bytes = 0;
  private seq = 0;
  private discardedBytes = 0;
  onError(): () => void { return () => {}; }
  async saveGaps(): Promise<void> {}
  async close(): Promise<void> { this.items = []; this.head = 0; this.bytes = 0; this.discardedBytes = 0; }
  append(message: DanmakuMessage): boolean {
    const bytes = Buffer.byteLength(message.text);
    if (bytes > 32000) return false;
    this.items.push({ seq: ++this.seq, message, bytes }); this.bytes += bytes;
    this.prune(message.tMs ?? 0);
    return true;
  }
  private prune(nowMs: number) {
    while (this.head < this.items.length && (this.items.length - this.head > 2000 || this.bytes > 1024 * 1024 || (this.items[this.head]!.message.tMs ?? 0) < nowMs - 30000)) {
      const bytes = this.items[this.head++]!.bytes;
      this.bytes -= bytes; this.discardedBytes += bytes;
    }
    if (this.head >= 512 || this.discardedBytes >= 256 * 1024) { this.items.splice(0, this.head); this.head = 0; this.discardedBytes = 0; }
  }
  read(cursor: number, nowMs: number) {
    this.prune(nowMs);
    const messages: DanmakuMessage[] = [];
    let next = cursor;
    for (let i = this.head; i < this.items.length && messages.length < 1000; i++) {
      const item = this.items[i]!;
      if (item.seq <= cursor) continue;
      messages.push(item.message); next = item.seq;
    }
    return { messages, cursor: Math.max(next, this.items[this.head]?.seq ? this.items[this.head]!.seq - 1 : this.seq) };
  }
}
