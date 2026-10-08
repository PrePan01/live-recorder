import type { Services } from "./services.js";

export type StreamHealthState = "good" | "degraded" | "empty" | "unknown";

export interface StreamHealth {
  recordingId: string;
  state: StreamHealthState;
  /** degraded/empty 必填人话原因；good/unknown=null。 */
  reason: string | null;
  /** 最近一次媒体数据时间（墙钟毫秒）。 */
  lastDataAt: number | null;
  /** 实际画质是否发生回退（与预期清晰度不符）。 */
  qualityFallback: boolean;
  issue?: "no_data" | "write_error" | "low_bitrate" | "media_stalled" | null;
  sampledAt?: number;
  silenceMs?: number;
  recovering?: boolean;
  missingMs?: number;
  active?: boolean;
}

export interface HealthProbe {
  dataIntervalMs?: number;
  recordingId: string;
  roomId: string;
  /** 累计写入字节（码率样本源）。 */
  bytes: number;
  /** 媒体时间推进面（毫秒；帧率/静帧样本源）。 */
  mediaTsMs: number | null;
  /** 最近媒体数据墙钟毫秒。 */
  lastDataAt: number;
  /** 写入错误（复用 1.2 写入错误判定）。 */
  writeError: boolean;
  /** 画质回退（实际≠预期）。 */
  qualityFallback: boolean;
  recovering?: boolean;
  missingMs?: number;
}

/** 数据静默、持续码率下降和状态迁移分别使用独立判据窗。 */
const DEGRADED_SILENCE_MS = 6_000;
const EMPTY_SILENCE_MS = 30_000;
const DEGRADED_SUSTAIN_MS = 10_000;
const STATE_DEBOUNCE_MS = 3_000;
const TICK_MS = 3_000;
/** 码率跌落判定：低于本场基线一半。 */
const DROP_RATIO = 0.5;
const HEARTBEAT_MS = 15_000;

interface Track {
  bornAt: number;
  bytes: number;
  mediaTsMs: number | null;
  sampledAt: number;
  /** 基线：前 30 秒字节速率均值（本场基线，不跨场）。 */
  baselineBytesRate: number | null;
  baselineSamples: number;
  dropSince: number | null;
  state: StreamHealthState;
  reason: string | null;
  issue: Exclude<StreamHealth["issue"], undefined>;
  dropIssue: Exclude<StreamHealth["issue"], undefined>;
  emittedAt: number;
  tentativeState: StreamHealthState | null;
  tentativeSince: number;
  alertId?: string;
}

/**
 * 流质量状态服务（旁路采样零侵入）：只读会话计数器（bytes/媒体时钟/最近数据时间），
 * 不给写盘链加任何负担；灯只报告不动作（重连告警走既有链）。
 */
export class QualityHealthService {
  private tracks = new Map<string, Track>();
  private lastEmitted = new Map<string, StreamHealth>();
  private timer: unknown = null;
  private stopped = false;

  constructor(private readonly services: Services) {
    const tick = () => {
      if (this.stopped) return;
      try {
        this.sample();
      } catch {
        /* 旁路采样不能影响录制 */
      }
      if (!this.stopped) this.arm(tick);
    };
    this.arm(tick);
  }

  private arm(tick: () => void): void {
    this.timer = this.services.clock.setTimeout(tick, TICK_MS);
    (this.timer as { unref?: () => void } | null)?.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) this.services.clock.clearTimeout(this.timer);
    this.timer = null;
    this.tracks.clear();
    this.lastEmitted.clear();
  }

  snapshotAll(): StreamHealth[] {
    return [...this.lastEmitted.values()];
  }

  /** 快照口（SSE 断连兜底，与 status 快照双保险同哲学）。 */
  snapshot(recordingId: string): StreamHealth {
    return (
      this.lastEmitted.get(recordingId) ?? {
        recordingId,
        state: "unknown",
        reason: null,
        lastDataAt: null,
        qualityFallback: false,
      }
    );
  }

  private sample(): void {
    let probes: HealthProbe[];
    try {
      probes = this.services.manager.healthProbe();
    } catch {
      return;
    }
    const liveIds = new Set<string>();
    const now = this.services.clock.now();
    for (const probe of probes) {
      liveIds.add(probe.recordingId);
      const health = this.evaluate(probe, now);
      this.syncQualityAlert(probe.roomId, health);
      this.publish(health);
    }
    // 会话消失=未知态收口（会话切换瞬间=unknown，设计语义）。
    for (const id of [...this.tracks.keys()]) {
      if (!liveIds.has(id)) {
        this.resolveQualityAlert(this.tracks.get(id)!);
        this.tracks.delete(id);
        this.publish({
          recordingId: id,
          state: "unknown",
          reason: null,
          lastDataAt: null,
          qualityFallback: false,
          active: false,
          sampledAt: now,
        });
        this.lastEmitted.delete(id);
      }
    }
  }

  private evaluate(probe: HealthProbe, now: number): StreamHealth {
    let track = this.tracks.get(probe.recordingId);
    const firstSample = !track;
    if (!track) {
      track = {
        bornAt: now,
        bytes: probe.bytes,
        mediaTsMs: probe.mediaTsMs,
        sampledAt: now,
        baselineBytesRate: null,
        baselineSamples: 0,
        dropSince: null,
        state: "unknown",
        reason: null,
        issue: null,
        dropIssue: null,
        emittedAt: 0,
        tentativeState: null,
        tentativeSince: now,
      };
      this.tracks.set(probe.recordingId, track);
    }
    const dt = Math.max(1, now - track.sampledAt);
    const bytesRate = ((probe.bytes - track.bytes) / dt) * 1000;
    const mediaProgress =
      probe.mediaTsMs != null && track.mediaTsMs != null
        ? (probe.mediaTsMs - track.mediaTsMs) / dt
        : null;
    let silence = Math.max(0, now - probe.lastDataAt);
    // HLS 按整段交付数据，正常等待分片不能被连续流的 6 秒窗误判。
    const degradedSilenceMs = Math.max(
      DEGRADED_SILENCE_MS,
      (probe.dataIntervalMs ?? 0) * 2,
    );
    const emptySilenceMs = Math.max(
      EMPTY_SILENCE_MS,
      (probe.dataIntervalMs ?? 0) * 3,
    );
    // 测试专用钩子（生产禁设）：LR_QA_SILENCE_AFTER_S=会话 N 秒后视为数据停止——
    // 静默从此刻起累积，驱动 degraded→empty 真实状态机全链（env 不设=惰性零影响）。
    const silenceAfterS = Number(process.env.LR_QA_SILENCE_AFTER_S ?? 0);
    if (silenceAfterS > 0) {
      const cutoff = track.bornAt + silenceAfterS * 1000;
      if (now > cutoff) silence = now - cutoff;
    }
    track.bytes = probe.bytes;
    track.mediaTsMs = probe.mediaTsMs;
    track.sampledAt = now;

    // 本场基线：前 30 秒字节速率样本累积。
    if (
      !firstSample &&
      now - track.bornAt <= 30_000 &&
      bytesRate > 0 &&
      silence < degradedSilenceMs
    ) {
      track.baselineBytesRate =
        track.baselineBytesRate === null
          ? bytesRate
          : (track.baselineBytesRate * track.baselineSamples + bytesRate) /
            (track.baselineSamples + 1);
      track.baselineSamples += 1;
    }

    let state: StreamHealthState = probe.bytes > 0 ? "good" : "unknown";
    let reason: string | null = null;
    let issue: Exclude<StreamHealth["issue"], undefined> = null;
    if (probe.writeError) {
      state = "empty";
      reason = "录像写入异常";
      issue = "write_error";
    } else if (silence >= emptySilenceMs) {
      state = "empty";
      reason = "长时间未收到直播数据";
      issue = "no_data";
    } else if (silence >= degradedSilenceMs) {
      state = "degraded";
      reason = "直播数据暂时中断";
      issue = "no_data";
    } else if (!firstSample && probe.bytes > 0) {
      // 码率/媒体时钟异常需持续判定（防误报）。
      const bitrateDrop =
        (probe.dataIntervalMs ?? 0) === 0 &&
        track.baselineBytesRate !== null &&
        track.baselineBytesRate > 0 &&
        bytesRate < track.baselineBytesRate * DROP_RATIO;
      // 没有媒体时钟时不判停帧；时间推进也不能推断视频帧率。
      const frameDrop = mediaProgress === 0;
      const dropIssue = bitrateDrop
        ? "low_bitrate"
        : frameDrop
          ? "media_stalled"
          : null;
      if (dropIssue && !probe.recovering) {
        if (track.dropIssue !== dropIssue) track.dropSince = now;
        track.dropIssue = dropIssue;
        track.dropSince ??= now;
        if (now - track.dropSince >= DEGRADED_SUSTAIN_MS) {
          state = "degraded";
          reason = bitrateDrop ? "码率持续下降" : "媒体时间暂未推进";
          issue = dropIssue;
        }
      } else {
        track.dropSince = null;
        track.dropIssue = null;
      }
    }

    if (probe.writeError || silence >= degradedSilenceMs) {
      track.dropSince = null;
      track.dropIssue = null;
    }

    // 测试专用钩子（生产禁设）：LR_QA_FORCE_STATE=state:reason 直接定态（UI 灯色/互斥端到端可验）。
    const forced = process.env.LR_QA_FORCE_STATE;
    if (forced) {
      const idx = forced.indexOf(":");
      const fState = (
        idx >= 0 ? forced.slice(0, idx) : forced
      ) as StreamHealthState;
      const fReason = idx >= 0 ? forced.slice(idx + 1) : "测试注入";
      if (
        fState === "good" ||
        fState === "degraded" ||
        fState === "empty" ||
        fState === "unknown"
      ) {
        state = fState;
        reason = fState === "good" || fState === "unknown" ? null : fReason;
      }
    }

    // 状态迁移去抖 3s：抖回原态不发帧（BE 出数即稳态，FE 零防抖负担）。
    if (state !== track.state) {
      if (track.tentativeState !== state) {
        track.tentativeState = state;
        track.tentativeSince = now;
      } else if (now - track.tentativeSince >= STATE_DEBOUNCE_MS) {
        track.state = state;
        track.reason = reason;
        track.issue = issue;
        track.tentativeState = null;
      }
    } else {
      track.tentativeState = null;
      track.reason = reason;
      track.issue = issue;
    }

    return {
      recordingId: probe.recordingId,
      state: track.state,
      reason: track.reason,
      lastDataAt: probe.bytes > 0 ? probe.lastDataAt : null,
      issue: track.issue,
      sampledAt: now,
      silenceMs: silence,
      recovering: probe.recovering ?? false,
      missingMs: probe.missingMs ?? 0,
      active: true,
      qualityFallback: probe.qualityFallback,
    };
  }

  private publish(health: StreamHealth): void {
    const prev = this.lastEmitted.get(health.recordingId);
    const stateChanged =
      !prev ||
      prev.state !== health.state ||
      prev.reason !== health.reason ||
      prev.qualityFallback !== health.qualityFallback ||
      prev.recovering !== health.recovering ||
      prev.missingMs !== health.missingMs;
    const track = this.tracks.get(health.recordingId);
    const heartbeatDue =
      track && this.services.clock.now() - track.emittedAt >= HEARTBEAT_MS;
    // 状态变化立即同步；稳定状态每 15 秒同步一次时间，限制事件频率。
    this.lastEmitted.set(health.recordingId, health);
    if (!stateChanged && !heartbeatDue) return;
    if (track) track.emittedAt = this.services.clock.now();
    try {
      this.services.events.emit({ type: "stream-health", data: health });
    } catch {
      /* 事件面故障不反噬采样 */
    }
  }

  private syncQualityAlert(roomId: string, health: StreamHealth): void {
    const track = this.tracks.get(health.recordingId)!;
    // 断流和写盘告警由既有录制链负责，这里只补持续码率/媒体时钟异常。
    const actionable =
      health.state === "degraded" &&
      (health.issue === "low_bitrate" || health.issue === "media_stalled");
    if (!actionable) {
      if (
        health.state === "good" ||
        health.issue === "no_data" ||
        health.issue === "write_error"
      )
        this.resolveQualityAlert(track);
      return;
    }
    if (track.alertId || !this.services.alerts) return;
    try {
      const alert = this.services.alerts.createOrRefresh({
        level: "warning",
        source: "stream-health",
        roomId,
        occurredAt: this.services.clock.iso(),
        message: `${health.reason}，请检查直播源；已收到的数据仍会保存。`,
      });
      track.alertId = alert.id;
      this.services.events.emit({ type: "alert:created", data: alert });
    } catch {
      /* 告警旁路不影响采样 */
    }
  }

  private resolveQualityAlert(track: Track): void {
    if (!track.alertId) return;
    try {
      const alert = this.services.alerts.markResolved(track.alertId);
      if (alert)
        this.services.events.emit({ type: "alert:updated", data: alert });
      delete track.alertId;
    } catch {
      /* 告警旁路不影响采样 */
    }
  }
}
