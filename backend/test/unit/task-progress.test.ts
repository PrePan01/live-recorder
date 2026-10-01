import { describe, expect, it } from 'vitest';
import {
  compositeClipProgress,
  composeRunProgress,
  resetProgressHighWater,
} from '../../src/core/task-progress.js';
import type { PipelineArtifact } from '../../src/types/index.js';

function art(step: string, status: PipelineArtifact['status']): Pick<PipelineArtifact, 'step' | 'status'> {
  return { step: step as PipelineArtifact['step'], status };
}

describe('管线刻度归一（#110）', () => {
  it('从 0 起步、跳过计满、步内铺满、单调推进（消掉 40 底板与两套刻度）', () => {
    // 首步起点=0（普通管线起点 ≤5%）
    expect(composeRunProgress([], 'verify', 0)).toBe(0);
    // 步内比例铺满本段
    const inConvert = composeRunProgress(
      [art('verify', 'ok'), art('sidecar', 'ok'), art('cover', 'skipped'), art('segment', 'skipped'), art('audio', 'skipped')],
      'convert',
      0,
    );
    expect(inConvert).toBe(5 + 2 + 8 + 25 + 10); // 50：前置权重和
    expect(composeRunProgress([art('verify', 'ok')], 'verify', 1)).toBeLessThanOrEqual(100);
    // 跳过步骤计满、含当前步内比例单调推进
    const seq = [
      composeRunProgress([], 'segment', 0),
      composeRunProgress([art('segment', 'ok')], 'audio', 0),
      composeRunProgress([art('segment', 'ok'), art('audio', 'ok')], 'convert', 0.5),
      composeRunProgress([art('segment', 'ok'), art('audio', 'ok'), art('convert', 'ok')], 'compress', 1),
    ];
    for (let i = 1; i < seq.length; i += 1) expect(seq[i]!).toBeGreaterThanOrEqual(seq[i - 1]!);
    // 全部完成=100
    expect(
      composeRunProgress(
        [art('verify', 'ok'), art('sidecar', 'ok'), art('cover', 'ok'), art('segment', 'ok'), art('audio', 'ok'), art('convert', 'ok'), art('compress', 'ok'), art('archive', 'ok')],
        'archive',
        1,
      ),
    ).toBe(100);
  });
});

describe('clip 两相位动态 ETA 合成（#110）', () => {
  const T0 = Date.parse('2026-10-01T12:00:00.000Z');
  const base = {
    startedAt: '2026-10-01T12:00:00.000Z',
    endedAt: '2026-10-01T12:00:30.000Z', // 选区 30s
    createdAt: '2026-10-01T12:00:00.000Z',
    fileSizeBytes: 50 * 1024 * 1024,
  };

  it('单相位（无后处理）：导出铺满全量程、从 0 起步', () => {
    resetProgressHighWater();
    expect(compositeClipProgress({ ...base, id: 'a', exportPct: 0, run: null, hasPostPhase: false, now: T0 })).toBe(0);
    resetProgressHighWater();
    expect(compositeClipProgress({ ...base, id: 'b', exportPct: 50, run: null, hasPostPhase: false, now: T0 })).toBe(50);
  });

  it('两相位：0-100 连续、只进不退（重算不倒退）', () => {
    resetProgressHighWater();
    const mid = compositeClipProgress({ ...base, id: 'c', exportPct: 50, run: null, hasPostPhase: true, now: T0 + 15_000 });
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(60);
    const later = compositeClipProgress({
      ...base,
      id: 'c',
      exportPct: null,
      run: { progressPct: 80, etaSeconds: 10, startedAt: '2026-10-01T12:00:30.000Z', createdAt: '2026-10-01T12:00:30.000Z' },
      hasPostPhase: true,
      now: T0 + 90_000,
    });
    expect(later).toBeGreaterThanOrEqual(mid);
    expect(later).toBeGreaterThan(80);
    // 倒退输入被高水位钳住
    const back = compositeClipProgress({ ...base, id: 'c', exportPct: 20, run: null, hasPostPhase: true, now: T0 + 90_000 });
    expect(back).toBeGreaterThanOrEqual(later);
    expect(back).toBeLessThanOrEqual(100);
  });
});
