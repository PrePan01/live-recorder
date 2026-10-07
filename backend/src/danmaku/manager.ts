import type { Room } from "../types/room.js";
import type { Services } from "../core/services.js";
import { bilibiliDanmakuAdapter } from "./adapters/bilibili.js";
import { douyinDanmakuAdapter } from "./adapters/douyin.js";
import { DanmakuCollector, unsupportedDanmakuAdapter } from "./collector.js";
import { DanmakuStore } from "./store.js";
import type { DanmakuAdapter, DanmakuGap } from "./types.js";

function adapterFor(platform: string): DanmakuAdapter {
  if (platform === "bilibili") return bilibiliDanmakuAdapter;
  if (platform === "douyin") return douyinDanmakuAdapter;
  return unsupportedDanmakuAdapter(platform);
}

/** 是否为该房间启用弹幕采集：房间覆盖优先，缺省继承全局（默认关）。 */
export function danmakuEnabledFor(
  room: Pick<Room, "danmakuEnabled">,
  settings: { danmaku?: { enabled: boolean } },
): boolean {
  if (room.danmakuEnabled === false) return false;
  if (room.danmakuEnabled === true) return true;
  return settings.danmaku?.enabled === true;
}

/**
 * 弹幕采集编排：随录制启停、每录制一个采集器与 sidecar。
 * 所有入口都吞异常——弹幕故障只降级弹幕自身，绝不影响录制（产品红线）。
 */
export class DanmakuManager {
  private collectors = new Map<string, DanmakuCollector>();

  constructor(private readonly services: Services) {}

  /** 录制开始后调用（不阻塞录制路径）。 */
  startForRecording(
    recordingId: string,
    filePath: string | null,
    room: Room,
    mediaNow: () => number | null,
  ): void {
    try {
      if (!danmakuEnabledFor(room, this.services.settings.load() ?? {})) return;
      if (this.collectors.has(recordingId)) return;
      if (!filePath) return;
      void Promise.all([
        DanmakuStore.open(filePath),
        this.services.platformCookie(room.platform).catch(() => undefined),
      ])
        .then(([store, cookie]) => {
          const collector = DanmakuCollector.start({
            recordingId,
            adapter: adapterFor(room.platform),
            roomUrl: room.url,
            cookie: cookie ?? null,
            store,
            sink: {
              status: (status) => {
                this.services.events.emit({ type: "danmaku:status", data: status });
              },
            },
            mediaNow,
          });
          this.collectors.set(recordingId, collector);
        })
        .catch(() => undefined);
    } catch {
      /* 弹幕启动失败静默降级 */
    }
  }

  /** 录制收尾时调用：停采集并保留 sidecar（与录制同生命周期）。 */
  async stopForRecording(recordingId: string): Promise<void> {
    const collector = this.collectors.get(recordingId);
    if (!collector) return;
    this.collectors.delete(recordingId);
    await collector.stop().catch(() => undefined);
  }

  /** 删除录制时联动删 sidecar（删除语义三层防线平移）。 */
  async removeSidecar(recordingFilePath: string | null): Promise<void> {
    if (!recordingFilePath) return;
    await DanmakuStore.remove(recordingFilePath).catch(() => undefined);
  }

  gapsFor(recordingId: string): DanmakuGap[] {
    return this.collectors.get(recordingId)?.missing ?? [];
  }

  /** 采集状态快照（观测兜底：SSE 断连/首帧丢失时仍可查）。 */
  statusFor(recordingId: string): { state: string; since: number } | null {
    return this.collectors.get(recordingId)?.status ?? null;
  }

  /** 读取区间消息（媒体时间轴）；gaps 取该录制采集器的独立缺失账。 */
  async readRange(
    recordingId: string,
    recordingFilePath: string,
    fromMs: number,
    toMs: number,
    opts: { limit?: number; includeUnmappable?: boolean } = {},
  ): Promise<{ messages: unknown[]; next: number | null; gaps: DanmakuGap[]; status: { state: string; since: number } }> {
    const gaps = this.gapsFor(recordingId);
    const store = await DanmakuStore.openExisting(recordingFilePath);
    if (!store) return { messages: [], next: null, gaps, status: this.statusFor(recordingId) ?? { state: "unavailable", since: 0 } };
    const result = await store.readRange(fromMs, toMs, opts);
    return {
      ...result,
      gaps,
      status: this.statusFor(recordingId) ?? { state: "unavailable", since: 0 },
    };
  }
}
