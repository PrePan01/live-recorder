import { AppError } from "../types/error.js";
import type { DanmakuStore } from "./store.js";
import type {
  DanmakuAdapter,
  DanmakuGap,
  DanmakuMessage,
  DanmakuState,
  DanmakuStatus,
} from "./types.js";

const RETRY_CHAIN_SEC = [1, 2, 5, 10, 30];
/** 连续失败到此次数进入「不可用」展示态，仍按封顶节奏继续重试。 */
const UNAVAILABLE_AFTER_ATTEMPTS = 8;

export type DanmakuCollectorStore = Pick<DanmakuStore, "append" | "error" | "onError" | "saveGaps" | "close"> & {
  persistent?: boolean;
  gapHistoryLimit?: number;
};

export interface DanmakuSink {
  /** 状态变化即刻推送（SSE/前端消费）。 */
  status(status: DanmakuStatus): void;
}

/**
 * 弹幕采集管理器（每条录制一个）：适配器只产消息流，
 * 重连退避/状态四态/缺失账/写盘全在这里统一管。
 * 铁律：本类任何故障只降级弹幕自身，绝不抛出到录制链路。
 */
export class DanmakuCollector {
  private state: DanmakuState = "connecting";
  private stateSince = Date.now();
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private gaps: DanmakuGap[] = [];
  private gapFromMs: number | null = null;
  private attempts = 0;
  private stopped = false;
  private lastMediaMs: number | null = null;
  private stored = 0;
  private wakeSleep: (() => void) | null = null;
  private persist: Promise<void> = Promise.resolve();
  private unsubscribeError: (() => void) | null = null;

  private constructor(
    private readonly recordingId: string,
    private readonly adapter: DanmakuAdapter,
    private readonly roomUrl: string,
    private readonly cookie: string | null,
    private readonly store: DanmakuCollectorStore,
    private readonly sink: DanmakuSink,
    /** 当前媒体时间（毫秒）；由录制会话注入，弹幕按到达时刻打媒体时间戳。 */
    private readonly mediaNow: () => number | null,
  ) {}

  static start(args: {
    recordingId: string;
    adapter: DanmakuAdapter;
    roomUrl: string;
    cookie: string | null;
    store: DanmakuCollectorStore;
    sink: DanmakuSink;
    mediaNow: () => number | null;
    gaps?: DanmakuGap[];
  }): DanmakuCollector {
    const collector = new DanmakuCollector(
      args.recordingId,
      args.adapter,
      args.roomUrl,
      args.cookie,
      args.store,
      args.sink,
      args.mediaNow,
    );
    collector.gaps = args.gaps ?? [];
    collector.unsubscribeError = args.store.onError(() => {
      collector.openGap();
      collector.setState("unavailable", "弹幕存储不可用");
      collector.abort?.abort();
      collector.wakeSleep?.();
    });
    // 首帧必发：初始态与首次 setState 同值，同态守卫会吞掉它——直接推快照。
    collector.sink.status(collector.status);
    collector.loop = collector.run().catch(() => undefined);
    return collector;
  }

  get mediaTime(): number | null {
    const current = this.mediaNow();
    if (current !== null && Number.isFinite(current) && current >= 0) this.lastMediaMs = current;
    return current !== null && Number.isFinite(current) && current >= 0 ? current : null;
  }

  get status(): DanmakuStatus {
    return this.currentStatus();
  }

  private currentStatus(): DanmakuStatus {
    return {
      recordingId: this.recordingId,
      state: this.state,
      since: this.stateSince,
    };
  }

  get missing(): DanmakuGap[] {
    const toMs = this.mediaTime ?? this.lastMediaMs;
    return [...this.gaps, ...(this.gapFromMs !== null && toMs !== null && toMs > this.gapFromMs
      ? [{ fromMs: this.gapFromMs, toMs, reason: "stream_disconnect" }] : [])];
  }

  private setState(state: DanmakuState, reason?: string): void {
    if (this.state === state && !reason) return;
    this.state = state;
    this.stateSince = Date.now();
    this.sink.status({ ...this.status, ...(reason ? { reason } : {}) });
  }

  private openGap(): void {
    if (this.gapFromMs === null) this.gapFromMs = this.mediaTime ?? this.lastMediaMs ?? 0;
  }

  private closeGap(reason: string, finalMediaMs?: number): void {
    if (this.gapFromMs === null) return;
    const toMs = finalMediaMs ?? this.mediaTime ?? this.lastMediaMs ?? this.gapFromMs;
    if (toMs > this.gapFromMs) {
      this.gaps.push({ fromMs: this.gapFromMs, toMs, reason });
      if (this.store.gapHistoryLimit && this.gaps.length > this.store.gapHistoryLimit) {
        this.gaps.splice(0, this.gaps.length - this.store.gapHistoryLimit);
      }
      const snapshot = [...this.gaps];
      this.persist = this.persist.then(() => this.store.saveGaps(snapshot)).catch(() => undefined);
    }
    this.gapFromMs = null;
  }

  private async run(): Promise<void> {
    this.openGap();
    while (!this.stopped && !this.store.error) {
      this.abort = new AbortController();
      try {
        this.setState(this.attempts === 0 ? "connecting" : "reconnecting");
        console.log(`[danmaku ${new Date().toISOString()}] connect platform=${this.adapter.platform} attempt=${this.attempts}`);
        for await (const message of this.adapter.collect(
          this.roomUrl,
          this.cookie,
          this.abort.signal,
          () => {
            if (this.stopped || this.store.error) return;
            this.attempts = 0;
            this.closeGap("stream_disconnect");
            this.setState("collecting");
          },
        )) {
          if (this.stopped) break;
          this.attempts = 0;
          this.closeGap("stream_disconnect");
          this.setState("collecting");
          this.emit(message);
          if (this.store.persistent !== false && this.stored % 50 === 1) {
            console.log(`[danmaku ${new Date().toISOString()}] write recording=${this.recordingId} rows=${this.stored}`);
          }
        }
        // 适配器正常返回=连接结束；按断连处理进重试。
        if (!this.stopped) this.openGap();
      } catch (error) {
        // 采集异常只降级弹幕：开缺失账、进退避重试。
        this.openGap();
        console.log(`[danmaku ${new Date().toISOString()}] disconnect recording=${this.recordingId} err=${(error as Error)?.message ?? error}`);
      }
      if (this.stopped || this.store.error) break;
      this.attempts += 1;
      this.setState(
        this.attempts >= UNAVAILABLE_AFTER_ATTEMPTS ? "unavailable" : "reconnecting",
      );
      const delaySec =
        RETRY_CHAIN_SEC[Math.min(this.attempts - 1, RETRY_CHAIN_SEC.length - 1)] ?? 30;
      await this.sleep(delaySec * 1000);
    }
  }

  private emit(message: DanmakuMessage): void {
    const tMs = this.mediaTime;
    const stamped: DanmakuMessage =
      tMs === null
        ? { ...message, tMs: null, unmappable: true, wallMs: message.wallMs || Date.now() }
        : { ...message, tMs };
    if (this.store.append(stamped)) this.stored += 1;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); this.wakeSleep = null; resolve(); };
      const timer = setTimeout(finish, ms);
      this.wakeSleep = finish;
      timer.unref?.();
    });
  }

  async stop(finalMediaMs?: number): Promise<void> {
    this.stopped = true;
    this.openGap();
    this.abort?.abort();
    this.wakeSleep?.();
    await this.loop?.catch(() => undefined);
    this.closeGap("collector_stopped", finalMediaMs);
    await this.persist;
    await this.store.close();
    this.unsubscribeError?.();
    this.setState("unavailable");
  }
}

/** 造一个「不可用」的静态适配器（平台不支持弹幕时占位，状态直接落 unavailable）。 */
export function unsupportedDanmakuAdapter(platform: string): DanmakuAdapter {
  return {
    platform,
    async *collect(): AsyncIterable<DanmakuMessage> {
      throw new AppError("PLATFORM_CHANGED", "该平台暂不支持弹幕保存", {});
    },
  };
}
