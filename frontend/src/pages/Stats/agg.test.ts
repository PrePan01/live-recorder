import { describe, expect, it } from 'vitest';
import {
  METRIC_OPTIONS,
  OTHER_NAME,
  formatAxisLabel,
  formatMetric,
  metricValue,
  resolveRoomName,
  rollupTop,
  toPieData,
  unmeasuredBytesNote,
  unmeasuredDurationNote,
} from './agg';

const row = (recordings: number, bytes: number, durationMs: number) => ({ recordings, bytes, durationMs });

describe('metric 定义与格式化', () => {
  it('三指标选项为 次数/大小/时长，默认次数', () => {
    expect(METRIC_OPTIONS.map((o) => o.value)).toEqual(['recordings', 'bytes', 'durationMs']);
    expect(METRIC_OPTIONS[0].label).toBe('次数');
  });

  it('metricValue 取对应字段', () => {
    const r = row(3, 1024, 60_000);
    expect(metricValue(r, 'recordings')).toBe(3);
    expect(metricValue(r, 'bytes')).toBe(1024);
    expect(metricValue(r, 'durationMs')).toBe(60_000);
  });

  it('formatMetric：0 字节按 0 B 展示（Q5/E1 需参与聚合）', () => {
    expect(formatMetric(0, 'bytes')).toBe('0 B');
    expect(formatMetric(2048, 'bytes')).toBe('2.0 KB');
  });

  it('formatMetric：时长 ≥1 小时按小时、否则分钟', () => {
    expect(formatMetric(3_600_000, 'durationMs')).toBe('1.0 小时');
    expect(formatMetric(5_400_000, 'durationMs')).toBe('1.5 小时');
    expect(formatMetric(90_000, 'durationMs')).toBe('2 分钟');
    expect(formatMetric(0, 'durationMs')).toBe('0 分钟');
  });

  it('formatMetric：次数带「场」', () => {
    expect(formatMetric(0, 'recordings')).toBe('0 场');
    expect(formatMetric(7, 'recordings')).toBe('7 场');
  });

  it('formatAxisLabel：紧凑形态', () => {
    expect(formatAxisLabel(1048576, 'bytes')).toBe('1.0 MB');
    expect(formatAxisLabel(3_600_000, 'durationMs')).toBe('1 时');
    expect(formatAxisLabel(5, 'recordings')).toBe('5');
  });
});

describe('未统计标注（Q5/E1 · B4）', () => {
  it('bytes=0 且有场次 → 标注未统计大小', () => {
    expect(unmeasuredBytesNote(row(2, 0, 1000))).toBe(true);
    expect(unmeasuredBytesNote(row(0, 0, 1000))).toBe(false);
    expect(unmeasuredBytesNote(row(2, 1, 1000))).toBe(false);
  });

  it('durationMs=0 且有场次 → 标注未统计时长（进行中录制）', () => {
    expect(unmeasuredDurationNote(row(1, 5, 0))).toBe(true);
    expect(unmeasuredDurationNote(row(0, 5, 0))).toBe(false);
    expect(unmeasuredDurationNote(row(1, 5, 1))).toBe(false);
  });
});

describe('resolveRoomName（图3 口径：现名优先、快照兜底、占位兜底）', () => {
  const rooms = [
    { id: 'r1', displayName: '当前名' },
    { id: 'r2', displayName: '  ' },
  ];

  it('房间存在 → 当前 displayName', () => {
    expect(resolveRoomName('r1', '旧快照名', rooms)).toBe('当前名');
  });

  it('房间已删除 → 回落 room_name 快照（E2）', () => {
    expect(resolveRoomName('gone', '快照名', rooms)).toBe('快照名');
  });

  it('房间在但 displayName 空 → 回落快照', () => {
    expect(resolveRoomName('r2', '快照名', rooms)).toBe('快照名');
  });

  it('两者皆无 → 占位（快照空显示占位 · QA B6）', () => {
    expect(resolveRoomName('gone', '', rooms)).toBe('未知房间');
    expect(resolveRoomName('gone', '   ', rooms)).toBe('未知房间');
  });
});

describe('toPieData 排序', () => {
  it('按当前指标降序，同值按名称稳定排序', () => {
    const data = toPieData(
      [
        { name: 'B', recordings: 1, bytes: 300, durationMs: 5 },
        { name: 'A', recordings: 1, bytes: 300, durationMs: 9 },
        { name: 'C', recordings: 9, bytes: 100, durationMs: 1 },
      ],
      'bytes',
    );
    expect(data.map((d) => d.name)).toEqual(['A', 'B', 'C']);
    const byDuration = toPieData(
      [
        { name: 'B', recordings: 1, bytes: 300, durationMs: 5 },
        { name: 'A', recordings: 1, bytes: 300, durationMs: 9 },
      ],
      'durationMs',
    );
    expect(byDuration.map((d) => d.name)).toEqual(['A', 'B']);
  });
});

describe('rollupTop（Q3 默认 TOP10+其他 · QA B5）', () => {
  const rows = Array.from({ length: 13 }, (_, i) => ({
    name: `room-${String(i).padStart(2, '0')}`,
    recordings: i + 1,
    bytes: (i + 1) * 10,
    durationMs: (i + 1) * 1000,
    value: i + 1,
  }));

  it('超过 topN：归并为 topN+1，其他=总量−TOPN 之和（逐字段）', () => {
    const out = rollupTop(rows, 10);
    expect(out).toHaveLength(11);
    expect(out[out.length - 1].name).toBe(OTHER_NAME);
    const totals = rows.reduce(
      (a, r) => ({
        recordings: a.recordings + r.recordings,
        bytes: a.bytes + r.bytes,
        durationMs: a.durationMs + r.durationMs,
        value: a.value + r.value,
      }),
      { recordings: 0, bytes: 0, durationMs: 0, value: 0 },
    );
    const top = out.slice(0, 10);
    const topSum = top.reduce(
      (a, r) => ({
        recordings: a.recordings + r.recordings,
        bytes: a.bytes + r.bytes,
        durationMs: a.durationMs + r.durationMs,
        value: a.value + r.value,
      }),
      { recordings: 0, bytes: 0, durationMs: 0, value: 0 },
    );
    const other = out[out.length - 1];
    expect(other.recordings).toBe(totals.recordings - topSum.recordings);
    expect(other.bytes).toBe(totals.bytes - topSum.bytes);
    expect(other.durationMs).toBe(totals.durationMs - topSum.durationMs);
    expect(other.value).toBe(totals.value - topSum.value);
    // 其他按值应排在最后（入参已降序，top10 最小值 ≥ 其他值之外的余项之和的常见形态不强制，仅校验归并正确）
    expect(top.map((d) => d.name)).toEqual(rows.slice(0, 10).map((r) => r.name));
  });

  it('行数 ≤ topN 原样返回（不产生「其他」）', () => {
    const out = rollupTop(rows.slice(0, 10), 10);
    expect(out).toHaveLength(10);
    expect(out.some((d) => d.name === OTHER_NAME)).toBe(false);
  });

  it('空数据安全', () => {
    expect(rollupTop([], 10)).toEqual([]);
  });
});
