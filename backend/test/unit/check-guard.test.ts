import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  CHECK_INTERVAL_MAX_SEC,
  CHECK_INTERVAL_MIN_SEC,
  CHECK_MIN_GAP_MS,
  clampCheckIntervalSec,
  detectionLoad,
  effectiveIntervalMs,
  spreadDueTimes,
  THROTTLE_BACKOFF_MAX_MS,
} from '../../src/config/check-guard.js';
import { validateRoomPolicy } from '../../src/config/room-policy.js';
import { AppError } from '../../src/types/error.js';

describe('错峰抖动（A）', () => {
  const ids = Array.from({ length: 30 }, (_, index) => `room_${index.toString().padStart(4, '0')}`);
  const intervalMs = 60_000;
  const entries = ids.map((id) => ({ id, dueMs: 1_000_000, intervalMs }));

  it('同刻扎堆确定性错开：相邻 ≥2s、位移有界、结果稳定可复现', () => {
    const first = spreadDueTimes(entries);
    const second = spreadDueTimes(entries);
    expect([...second.entries()]).toEqual([...first.entries()]); // 确定性：不是随机数
    const dues = ids.map((id) => first.get(id)!).sort((a, b) => a - b);
    for (let index = 1; index < dues.length; index += 1)
      expect(dues[index]! - dues[index - 1]!).toBeGreaterThanOrEqual(CHECK_MIN_GAP_MS);
    // 位移封顶一个间隔：错峰不把检测推出本周期
    for (const entry of entries)
      expect(first.get(entry.id)! - entry.dueMs).toBeLessThanOrEqual(intervalMs);
  });

  it('无碰撞零变化：错开的到期时刻原样保留（既有到期语义不动）', () => {
    const spaced = spreadDueTimes([
      { id: 'fast', dueMs: 10_000, intervalMs: 10_000 },
      { id: 'slow', dueMs: 30_000, intervalMs: 30_000 },
    ]);
    expect(spaced.get('fast')).toBe(10_000);
    expect(spaced.get('slow')).toBe(30_000);
  });

  it('单房零行为变化', () => {
    const single = spreadDueTimes([{ id: 'only', dueMs: 1_234_567, intervalMs }]);
    expect(single.get('only')).toBe(1_234_567);
  });
});

describe('单房区间护栏（B）', () => {
  it('写入区间 1~3600 秒：夹紧与校验口径同源', () => {
    expect(clampCheckIntervalSec(0.5)).toBe(CHECK_INTERVAL_MIN_SEC);
    expect(clampCheckIntervalSec(7_200)).toBe(CHECK_INTERVAL_MAX_SEC);
    expect(clampCheckIntervalSec(60)).toBe(60);
    expect(validateRoomPolicy({ checkIntervalSec: 1 }).checkIntervalSec).toBe(1);
    expect(validateRoomPolicy({ checkIntervalSec: 3600 }).checkIntervalSec).toBe(3600);
    // 存量守恒：10..3600 之间的旧值继续合法
    expect(validateRoomPolicy({ checkIntervalSec: 10 }).checkIntervalSec).toBe(10);
    for (const bad of [0, 3601, 1.5, -5]) {
      expect(() => validateRoomPolicy({ checkIntervalSec: bad })).toThrowError(AppError);
    }
  });

  it('校验文案含统一区间（人话+同源）', () => {
    try {
      validateRoomPolicy({ checkIntervalSec: 0 });
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).message).toContain(`1~${CHECK_INTERVAL_MAX_SEC}`);
    }
  });
});

describe('合计频率护栏（C）', () => {
  it('不超限零影响、超限按比例拉伸（不拒绝不漏房）', () => {
    expect(effectiveIntervalMs(60_000, 30)).toBe(60_000); // 正常规模永不触发
    expect(effectiveIntervalMs(10_000, 240, 120)).toBe(20_000); // 超一倍拉伸一倍
    expect(effectiveIntervalMs(10_000, 12_000, 120)).toBe(1_000_000); // 极端风暴有界拉伸
  });

  it('供数与调度同源：频率/上限/拉伸房数一并出数', () => {
    const calm = detectionLoad([60_000, 60_000, 60_000]);
    expect(calm.perMinute).toBe(3);
    expect(calm.limitPerMinute).toBe(120);
    expect(calm.staggered).toBe(true);
    expect(calm.queued).toBe(0);
    const storm = detectionLoad(Array.from({ length: 25 }, () => 10_000));
    expect(storm.perMinute).toBe(150);
    expect(storm.queued).toBe(25);
    expect(detectionLoad([60_000]).staggered).toBe(false);
    expect(detectionLoad([499]).queued).toBe(1); // 120.24/min must not round down below the guard.
  });
});

describe('退避自愈（D）', () => {
  it('指数退避+封顶+抖动：恢复后回常频由调用方清状态', () => {
    expect(backoffDelayMs(0)).toBe(30_000);
    expect(backoffDelayMs(1)).toBe(60_000);
    expect(backoffDelayMs(2)).toBe(120_000);
    expect(backoffDelayMs(20, 4_999)).toBe(THROTTLE_BACKOFF_MAX_MS); // 封顶
    expect(backoffDelayMs(1, 5_000)).toBe(65_000);
    expect(backoffDelayMs(1, -1)).toBe(60_000); // 负抖动不缩小
  });
});
