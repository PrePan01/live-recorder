import type { PipelineArtifact, PipelineRun } from '../types/index.js';

/**
 * 任务进度刻度（单一事实源，三处同源：任务卡/角标/历史行读同一值）。
 *
 * 两套旧刻度混算（步序 33% 起 + 硬编码 62/75 起）会让任务「先 0 再跳过 40」——
 * 此处统一为：①管线内部=按步骤耗时先验铺满 0-100、步步内推进；②clip 两相位=
 * 按预计耗时占比动态合成（实时速率优先、头几秒物理量兜底）；③合成值只进不退。
 */

/** 步骤耗时先验（合计 100）：按典型耗时粗分；跳过/秒过步骤计满其权重。 */
export const STEP_WEIGHTS: Record<string, number> = {
  verify: 5,
  sidecar: 2,
  cover: 8,
  segment: 25,
  audio: 10,
  convert: 25,
  compress: 20,
  archive: 5,
};

/**
 * 管线 run 进度（0-100）：已完成/跳过步权重和 + 当前步内比例。
 * 从 0 起步、单调推进；跳过步骤计满权重（刻度不卡洞）。
 */
export function composeRunProgress(
  artifacts: Pick<PipelineArtifact, 'step' | 'status'>[],
  activeStep: string,
  ratio: number,
): number {
  let base = 0;
  for (const art of artifacts) {
    if (art.step === activeStep) continue;
    if (art.status === 'ok' || art.status === 'skipped') base += STEP_WEIGHTS[art.step] ?? 0;
  }
  const weight = STEP_WEIGHTS[activeStep] ?? 0;
  const r = Math.max(0, Math.min(1, ratio));
  return Math.max(0, Math.min(100, Math.round(base + weight * r)));
}

/** 高水位：合成值只进不退（重算不倒退）。 */
const highWater = new Map<string, number>();

export function resetProgressHighWater(): void {
  highWater.clear();
}

function clampHigh(id: string, pct: number): number {
  const prev = highWater.get(id) ?? -1;
  const v = Math.max(prev, Math.max(0, Math.min(100, pct)));
  highWater.set(id, v);
  return v;
}

export interface ClipProgressInput {
  id: string;
  /** clip 行——startedAt/endedAt 即选区映射，createdAt=导出开始墙钟。 */
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  fileSizeBytes: number;
  /** 导出相位进度（0-99）；null=导出已结束（或不存在）。 */
  exportPct: number | null;
  /** 后处理 run（无=后处理未开始/不存在）。 */
  run: Pick<PipelineRun, 'progressPct' | 'etaSeconds' | 'startedAt' | 'createdAt'> | null;
  /** 是否存在后处理相位（管线启用与否；关闭=单相位全量程归导出）。 */
  hasPostPhase: boolean;
  /** 当前墙钟毫秒（调用方传入，保持纯函数可测）。 */
  now: number;
}

/**
 * clip 任务合成进度（0-100 连续不跳变）：
 * - 单相位（无导出 或 无后处理）：该相位铺满全量程、从 0 起步；
 * - 两相位：按预计耗时占比动态合成（导出速率算剩余、后处理用自带 ETA、头几秒物理量兜底）。
 */
export function compositeClipProgress(input: ClipProgressInput): number {
  const exportRatio = input.exportPct != null ? input.exportPct / 100 : 1;
  const postRatio = input.run?.progressPct != null ? input.run.progressPct / 100 : 0;

  if (!input.hasPostPhase) {
    // 只有导出相位：全量程 0-100。
    return clampHigh(input.id, Math.round(exportRatio * 100));
  }
  if (input.exportPct == null && !input.run) {
    return clampHigh(input.id, 0);
  }
  const selectionSec = Math.max(
    1,
    (Date.parse(input.endedAt ?? input.createdAt) - Date.parse(input.startedAt)) / 1000,
  );
  const exportElapsedSec = Math.max(0, (input.now - Date.parse(input.createdAt)) / 1000);
  const runElapsedSec = Math.max(
    0,
    (input.now - Date.parse(input.run?.startedAt ?? input.run?.createdAt ?? input.createdAt)) / 1000,
  );
  // 两相位预计总耗时（秒）：速率可用时用实测外推，头几秒用物理量先验。
  const exportTotal =
    input.exportPct != null && input.exportPct >= 5 && exportElapsedSec > 0
      ? exportElapsedSec / (exportRatio || 1)
      : Math.max(5, selectionSec / 3);
  const postTotal =
    input.run &&
    input.run.progressPct != null &&
    input.run.progressPct >= 2 &&
    input.run.etaSeconds != null
      ? runElapsedSec + input.run.etaSeconds
      : Math.max(5, input.fileSizeBytes / (5 * 1024 * 1024) + 5);

  const done = exportTotal * exportRatio + postTotal * postRatio;
  const total = Math.max(1, exportTotal + postTotal);
  return clampHigh(input.id, Math.round((done / total) * 100));
}
