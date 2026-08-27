import type { ErrorObject } from '../types/index.js';

export interface Clock {
  now(): number;
  iso(): string;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  iso(): string {
    return new Date().toISOString();
  }
  setTimeout(cb: () => void, ms: number): unknown {
    return setTimeout(cb, ms);
  }
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

/** 测试可跳时钟：定时任务登记后由 tick 手动推进，不真实等待。 */
export class FakeClock implements Clock {
  private current: number;
  private seq = 0;
  private timers = new Map<number, { at: number; cb: () => void }>();

  constructor(start = new Date('2026-08-28T00:00:00.000Z').getTime()) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }
  iso(): string {
    return new Date(this.current).toISOString();
  }
  setTimeout(cb: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.current + ms, cb });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** 推进 ms 毫秒并触发到期定时器（按时间序）。 */
  advance(ms: number): void {
    const target = this.current + ms;
    const due = [...this.timers.entries()]
      .filter(([, t]) => t.at <= target)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      this.current = Math.max(this.current, timer.at);
      timer.cb();
    }
    this.current = target;
  }

  pendingTimers(): number {
    return this.timers.size;
  }
}

export interface NotifierErrorFactory {
  (code: string, message: string, opts?: { roomId?: string | null; recordingId?: string | null; retryable?: boolean; details?: Record<string, unknown>; error?: ErrorObject }): ErrorObject;
}
