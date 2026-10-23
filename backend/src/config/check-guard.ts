/**
 * 检测负载防呆：护栏阈值与调度决策集中一处，调度器、设置校验、设置页供数共用同一套数，
 * 防止出现两套旋钮。护栏哲学=安全网非限速器：正常配置永不触发，触发时自动消化、不拒绝不报错。
 */

/** 写入区间（秒）：下限防手滑、上限与前端一致；只管新写入，存量值不清不拒。 */
export const CHECK_INTERVAL_MIN_SEC = 1;
export const CHECK_INTERVAL_MAX_SEC = 3600;

/** 合计频率护栏（次/分钟）：正常规模远在其下，超限按比例拉伸生效间隔消化风暴。 */
export const MAX_CHECKS_PER_MINUTE = 120;

/** 平台侧限流/服务端故障类错误码：撞上即对该平台整体退避，别的平台不受影响。 */
export const PLATFORM_THROTTLE_CODES = new Set(["PLATFORM_SERVER_ERROR"]);
export const THROTTLE_BACKOFF_BASE_MS = 30_000;
export const THROTTLE_BACKOFF_MAX_MS = 10 * 60_000;

export function clampCheckIntervalSec(value: number): number {
  return Math.min(
    CHECK_INTERVAL_MAX_SEC,
    Math.max(CHECK_INTERVAL_MIN_SEC, Math.round(value)),
  );
}

/** 每房确定性相位（毫秒）：同频房间按 id 稳定打散，重启后相位不变（不是随机数）。 */
export function roomPhaseMs(roomId: string, intervalMs: number): number {
  if (intervalMs <= 0) return 0;
  let hash = 2166136261;
  for (let index = 0; index < roomId.length; index += 1) {
    hash ^= roomId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % intervalMs;
}

/** 同刻碰撞时相邻检测的最小间隔：齐步走尖峰按此摊平。 */
export const CHECK_MIN_GAP_MS = 2_000;

/**
 * 碰撞感知错峰：只在多房到期撞在同一时刻、且规模超过并发槽位时，把超出部分按 id
 * 哈希序错开（相邻 ≥minGapMs、位移封顶一个间隔）。小规模同刻（并发槽位内）与无碰撞
 * 的房间零变化——不改任何既有到期语义，只削平真正的齐步走尖峰。
 */
export function spreadDueTimes(
  entries: readonly { id: string; dueMs: number; intervalMs: number }[],
  minGapMs: number = CHECK_MIN_GAP_MS,
  keepImmediate = 0,
): Map<string, number> {
  const result = new Map(entries.map((entry) => [entry.id, entry.dueMs]));
  const sorted = [...entries].sort(
    (left, right) =>
      left.dueMs - right.dueMs ||
      roomPhaseMs(left.id, 1e9) - roomPhaseMs(right.id, 1e9),
  );
  let clusterBase = Number.NEGATIVE_INFINITY;
  let slot = 0;
  // 每簇至少保住第一名原地不动：错峰只后移「超出部分」，不动最早到期者。
  const keep = Math.max(1, keepImmediate);
  for (const entry of sorted) {
    if (entry.dueMs - clusterBase >= minGapMs) {
      clusterBase = entry.dueMs;
      slot = 0;
    }
    slot += 1;
    if (slot > keep) {
      const displaced = clusterBase + (slot - keep) * minGapMs;
      result.set(
        entry.id,
        Math.min(displaced, entry.dueMs + Math.max(0, entry.intervalMs)),
      );
    }
  }
  return result;
}

/**
 * 合计频率超上限时按比例拉伸生效间隔：不丢检测、不报错、不漏房，
 * 风暴过去拉伸归零自动回常。拉伸量取基准间隔（防自指）。
 */
export function effectiveIntervalMs(
  intervalMs: number,
  totalPerMinute: number,
  capPerMinute: number = MAX_CHECKS_PER_MINUTE,
): number {
  if (intervalMs <= 0 || totalPerMinute <= capPerMinute || totalPerMinute <= 0)
    return intervalMs;
  return Math.ceil((intervalMs * totalPerMinute) / capPerMinute);
}

/** 平台退避时长（指数 + 抖动）：上限封顶，恢复后自动回常频。 */
export function backoffDelayMs(attempt: number, jitterMs = 0): number {
  return (
    Math.min(
      THROTTLE_BACKOFF_MAX_MS,
      THROTTLE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt) + Math.max(0, jitterMs),
    )
  );
}

export interface DetectionLoad {
  /** 当前合计检测频率（次/分钟，按各房基准间隔折算）。 */
  perMinute: number;
  limitPerMinute: number;
  /** 多房同频时调度已按 id 相位自动打散。 */
  staggered: boolean;
  /** 被合计护栏拉伸顺延的房间数（正常为 0）。 */
  queued: number;
}

/** 设置页供数：与调度器同一套纯函数出数（同源），不带任何凭据。 */
export function detectionLoad(
  intervalsMs: readonly number[],
  capPerMinute: number = MAX_CHECKS_PER_MINUTE,
): DetectionLoad {
  // 向上取整，避免阈值附近的配置因四舍五入绕过护栏。
  const perMinute = Math.ceil(
    intervalsMs.reduce((sum, value) => sum + (value > 0 ? 60_000 / value : 0), 0),
  );
  return {
    perMinute,
    limitPerMinute: capPerMinute,
    staggered: intervalsMs.length > 1,
    queued: intervalsMs.filter(
      (value) => effectiveIntervalMs(value, perMinute, capPerMinute) > value,
    ).length,
  };
}

