import { randomUUID } from "node:crypto";
import { AppError } from "../types/error.js";
import { SharedDanmakuAdapter } from "./shared-adapter.js";
import { DanmakuPreviewBuffer } from "./preview-buffer.js";
import type { Room } from "../types/room.js";
import type { Services } from "../core/services.js";
import { bilibiliDanmakuAdapter } from "./adapters/bilibili.js";
import { douyinDanmakuAdapter } from "./adapters/douyin.js";
import { DanmakuCollector, unsupportedDanmakuAdapter } from "./collector.js";
import { DanmakuStore, type DanmakuReadOptions } from "./store.js";
import type { DanmakuAdapter, DanmakuGap, DanmakuStatus } from "./types.js";

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

interface PreviewSource {
  generation: string;
  startedAt: number;
  leases: Map<string, number>;
  buffer: DanmakuPreviewBuffer;
  abort: AbortController;
  status: DanmakuStatus;
  collector?: DanmakuCollector;
  done: Promise<void>;
}
const PREVIEW_LEASE_MS = 15000;
function loadCookie(services: Services, room: Room, signal: AbortSignal): Promise<string | undefined> {
  return new Promise(resolve => {
    const finish = (value?: string) => { signal.removeEventListener("abort", cancel); resolve(value); };
    const cancel = () => finish();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    else services.platformCookie(room.platform).then(finish, cancel);
  });
}

/**
 * 弹幕采集编排：随录制启停、每录制一个采集器与 sidecar。
 * 所有入口都吞异常——弹幕故障只降级弹幕自身，绝不影响录制（产品红线）。
 */
export class DanmakuManager {
  private sources = new Map<string, { room: Room; mediaNow: () => number | null }>();
  private collectors = new Map<string, DanmakuCollector>();
  private starts = new Map<string, { cancelled: boolean; abort: AbortController; done: Promise<void> }>();
  private stops = new Map<string, Promise<void>>();

  private adapters = new Map<string, SharedDanmakuAdapter>();
  private previews = new Map<string, PreviewSource>();
  private previewSweep: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly services: Services, private readonly resolveAdapter = adapterFor) {}

  private sharedAdapter(platform: string): SharedDanmakuAdapter {
    let adapter = this.adapters.get(platform);
    if (!adapter) {
      adapter = new SharedDanmakuAdapter(this.resolveAdapter(platform));
      this.adapters.set(platform, adapter);
    }
    return adapter;
  }

  /** Explicit preview visibility is independent of the recording persistence preference. */
  subscribePreview(room: Room, token: string) {
    this.sweepPreviews();
    let source = this.previews.get(room.id);
    const leaseCount = [...this.previews.values()].reduce((n, item) => n + item.leases.size, 0);
    if (!source?.leases.has(token) && leaseCount >= 8) throw new AppError("PREVIEW_LIMIT_REACHED", "弹幕预览数量已达上限");
    if (!source) {
      const generation = randomUUID();
      source = {
        generation, startedAt: Date.now(), leases: new Map(), buffer: new DanmakuPreviewBuffer(),
        abort: new AbortController(), status: { recordingId: `preview:${generation}`, state: "connecting", since: Date.now() },
        done: Promise.resolve(),
      };
      const entry = source;
      this.previews.set(room.id, entry);
      entry.done = (async () => {
        const cookie = await loadCookie(this.services, room, entry.abort.signal);
        if (entry.abort.signal.aborted) return;
        entry.collector = DanmakuCollector.start({
          recordingId: entry.status.recordingId, adapter: this.sharedAdapter(room.platform), roomUrl: room.url,
          cookie: cookie ?? null, store: entry.buffer,
          sink: { status: status => { entry.status = status; } },
          mediaNow: () => Math.max(0, Date.now() - entry.startedAt),
        });
      })().catch(() => { entry.status = { ...entry.status, state: "unavailable", reason: "弹幕启动失败" }; });
    }
    source.leases.set(token, Date.now() + PREVIEW_LEASE_MS);
    if (!this.previewSweep) {
      this.previewSweep = setInterval(() => this.sweepPreviews(), 5000);
      this.previewSweep.unref?.();
    }
    return this.previewSnapshot(source, 0);
  }

  readPreview(roomId: string, token: string, cursor: number) {
    this.sweepPreviews();
    const source = this.previews.get(roomId);
    if (!source?.leases.has(token)) throw new AppError("RESOURCE_NOT_FOUND", "弹幕预览会话已过期");
    source.leases.set(token, Date.now() + PREVIEW_LEASE_MS);
    return this.previewSnapshot(source, cursor);
  }

  private previewSnapshot(source: PreviewSource, cursor: number) {
    const mediaNowMs = Math.max(0, Date.now() - source.startedAt);
    return { ...source.buffer.read(cursor, mediaNowMs), generation: source.generation, mediaNowMs, status: source.status };
  }

  async unsubscribePreview(roomId: string, token: string): Promise<void> {
    const source = this.previews.get(roomId);
    if (!source) return;
    source.leases.delete(token);
    if (source.leases.size) return;
    this.previews.delete(roomId);
    if (!this.previews.size && this.previewSweep) { clearInterval(this.previewSweep); this.previewSweep = undefined; }
    source.abort.abort();
    await source.done;
    await source.collector?.stop();
    await source.buffer.close();
  }

  private sweepPreviews(): void {
    const now = Date.now();
    for (const [roomId, source] of this.previews) {
      for (const [token, expires] of source.leases) {
        if (expires <= now) void this.unsubscribePreview(roomId, token).catch(() => undefined);
      }
    }
  }

  /** 录制开始后调用（不阻塞录制路径）。 */
  startForRecording(
    recordingId: string,
    filePath: string | null,
    room: Room,
    mediaNow: () => number | null,
  ): void {
    try {
      if (!danmakuEnabledFor(room, this.services.settings.load() ?? {})) return;
      if (this.collectors.has(recordingId) || this.starts.has(recordingId) || this.stops.has(recordingId) || !filePath) return;
      this.sources.set(recordingId, { room, mediaNow });
      const pending = { cancelled: false, abort: new AbortController(), done: Promise.resolve() };
      this.starts.set(recordingId, pending);
      pending.done = (async () => {
        const store = await DanmakuStore.open(filePath);
        try {
          const cookie = await loadCookie(this.services, room, pending.abort.signal);
          if (pending.cancelled) { await store.close(); return; }
          const collector = DanmakuCollector.start({
            recordingId, adapter: this.sharedAdapter(room.platform), roomUrl: room.url,
            cookie: cookie ?? null, store,
            sink: { status: status => this.services.events.emit({ type: "danmaku:status", data: status }) },
            mediaNow, gaps: await store.readGaps(),
          });
          this.collectors.set(recordingId, collector);
        } catch (error) { await store.close(); throw error; }
      })().catch(() => {
        this.services.events.emit({ type: "danmaku:status", data: { recordingId, state: "unavailable", since: Date.now(), reason: "弹幕启动失败" } });
      }).finally(() => { if (this.starts.get(recordingId) === pending) this.starts.delete(recordingId); });
    } catch {
      /* 弹幕启动失败静默降级 */
    }
  }

  /** 录制收尾时调用：停采集并保留 sidecar（与录制同生命周期）。 */
  async stopForRecording(recordingId: string, finalMediaMs?: number): Promise<void> {
    const existing = this.stops.get(recordingId);
    if (existing) return existing;
    const pending = this.starts.get(recordingId);
    if (pending) { pending.cancelled = true; pending.abort.abort(); }
    const done = (async () => {
      await pending?.done;
      const collector = this.collectors.get(recordingId);
      if (!collector) return;
      await collector.stop(finalMediaMs).catch(() => undefined);
      this.collectors.delete(recordingId);
    })();
    this.stops.set(recordingId, done);
    try { await done; } finally { this.stops.delete(recordingId); this.sources.delete(recordingId); }
  }

  async shutdown(): Promise<void> {
    const previewStops = [...this.previews].flatMap(([roomId, source]) => [...source.leases.keys()].map(token => this.unsubscribePreview(roomId, token)));
    if (this.previewSweep) { clearInterval(this.previewSweep); this.previewSweep = undefined; }
    await Promise.all(previewStops);
    await Promise.all([...new Set([...this.starts.keys(), ...this.collectors.keys(), ...this.stops.keys()])].map(id => this.stopForRecording(id)));
  }

  /** 删除录制时联动删 sidecar（删除语义三层防线平移）。 */
  async removeSidecar(recordingFilePath: string | null): Promise<void> {
    if (!recordingFilePath) return;
    await DanmakuStore.remove(recordingFilePath).catch(() => undefined);
  }

  async moveSidecar(recordingId: string, from: string, to: string): Promise<void> {
    if (DanmakuStore.sidecarPathFor(from) === DanmakuStore.sidecarPathFor(to)) return;
    const source = this.sources.get(recordingId);
    await this.stopForRecording(recordingId);
    try {
      await DanmakuStore.move(from, to);
      if (source) this.startForRecording(recordingId, to, source.room, source.mediaNow);
    }
    catch (error) {
      console.warn(`[danmaku] sidecar move failed recording=${recordingId}`, error);
      this.services.events.emit({ type: "danmaku:status", data: { recordingId, state: "unavailable", since: Date.now(), reason: "弹幕文件迁移失败" } });
    }
  }

  gapsFor(recordingId: string): DanmakuGap[] {
    return this.collectors.get(recordingId)?.missing ?? [];
  }

  /** 采集状态快照（观测兜底：SSE 断连/首帧丢失时仍可查）。 */
  statusFor(recordingId: string): DanmakuStatus | null {
    return this.collectors.get(recordingId)?.status ?? null;
  }

  /** 读取区间消息（媒体时间轴）；gaps 取该录制采集器的独立缺失账。 */
  async readRange(
    recordingId: string,
    recordingFilePath: string,
    fromMs: number,
    toMs: number,
    opts: DanmakuReadOptions = {},
  ): Promise<{ messages: unknown[]; next: string | null; gaps: DanmakuGap[]; status: DanmakuStatus; mediaNowMs: number | null }> {
    const store = recordingFilePath ? await DanmakuStore.openExisting(recordingFilePath) : null;
    const gaps = this.collectors.has(recordingId) ? this.gapsFor(recordingId) : await store?.readGaps() ?? [];
    const mediaNowMs = this.collectors.get(recordingId)?.mediaTime ?? null;
    if (!store) return { mediaNowMs, messages: [], next: null, gaps, status: this.statusFor(recordingId) ?? { recordingId, state: "unavailable", since: 0 } };
    const result = await store.readRange(fromMs, toMs, opts);
    return {
      ...result,
      mediaNowMs,
      gaps,
      status: this.statusFor(recordingId) ?? { recordingId, state: "unavailable", since: 0 },
    };
  }
}
