/** CPU 重任务共用预算。接受多个业务任务，排队不改变其确认/命名/状态生命周期。 */
export class MediaWorkQueue {
  private active = 0;
  private pending: Array<() => void> = [];

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency');
  }

  async run<T>(work: () => Promise<T>, signal?: AbortSignal, onWaiting?: () => void): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const abort = () => {
        if (heartbeat) clearInterval(heartbeat);
        signal?.removeEventListener('abort', abort);
        const index = this.pending.indexOf(start);
        if (index >= 0) this.pending.splice(index, 1);
        reject(new Error('Media job cancelled'));
      };
      const start = () => {
        if (heartbeat) clearInterval(heartbeat);
        signal?.removeEventListener('abort', abort);
        this.active += 1;
        resolve();
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.push(start);
      this.pump();
      // 排队是正常等待，不应触发后处理的卡死看门狗。派发后停止心跳，让真实进度接管。
      if (onWaiting && this.pending.includes(start)) {
        heartbeat = setInterval(() => { try { onWaiting(); } catch { abort(); } }, 1_000);
        heartbeat.unref();
      }
    });
    try {
      if (signal?.aborted) throw new Error('Media job cancelled');
      return await work();
    } finally {
      this.active -= 1;
      this.pump();
    }
  }

  private pump(): void {
    while (this.active < this.concurrency && this.pending.length) this.pending.shift()!();
  }
}

// 片段精确转码与后处理压缩共用，复制路径不占编码预算。
export const encodingWorkQueue = new MediaWorkQueue(2);
