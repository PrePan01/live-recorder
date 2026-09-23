// 统计看板纯函数层（task #51 · 评审稿 v2）：指标定义/格式化、TOP10 归并、房间名解析。
// 保持无 DOM 依赖（cssVar 有 window 守卫），可在 node 环境单测。
import { formatBytes } from "../../utils/format";

export type StatMetric = "recordings" | "bytes" | "durationMs";

/** 三指标切换（Q2 拍板：次数/大小/时长），默认次数。 */
export const METRIC_OPTIONS: ReadonlyArray<{
  value: StatMetric;
  label: string;
}> = [
  { value: "recordings", label: "次数" },
  { value: "bytes", label: "大小" },
  { value: "durationMs", label: "时长" },
];

export interface MetricRow {
  recordings: number;
  bytes: number;
  durationMs: number;
}

export function metricValue(row: MetricRow, metric: StatMetric): number {
  return row[metric];
}

/** 指标值展示：0 字节显示 0 B（而非 formatBytes 的 "-"），时长不足 1 小时按分钟。 */
export function formatMetric(value: number, metric: StatMetric): string {
  if (metric === "bytes") return value > 0 ? formatBytes(value) : "0 B";
  if (metric === "durationMs") {
    if (value >= 3_600_000) return `${(value / 3_600_000).toFixed(1)} 小时`;
    if (value >= 60_000) return `${Math.round(value / 60_000)} 分钟`;
    return value > 0 ? `${Math.round(value / 1000)} 秒` : "0 分钟";
  }
  return `${value} 场`;
}

/** 轴刻度简写（不带单位后缀的紧凑形态由轴标签承担，这里直接给可读串）。 */
export function formatAxisLabel(value: number, metric: StatMetric): string {
  if (metric === "bytes") return value > 0 ? formatBytes(value) : "0 B";
  if (metric === "durationMs") {
    if (value >= 3_600_000) return `${+(value / 3_600_000).toFixed(1)} 时`;
    if (value >= 60_000) return `${Math.round(value / 60_000)} 分`;
    return `${Math.round(value / 1000)} 秒`;
  }
  return `${value}`;
}

/** Q5/E1：有场次但大小为 0 → 含未统计大小的历史录制，tooltip 需标注。 */
export function unmeasuredBytesNote(row: MetricRow): boolean {
  return row.bytes === 0 && row.recordings > 0;
}

/** B4：有场次但时长为 0（ended_at NULL 的进行中录制等）→ tooltip 标注。 */
export function unmeasuredDurationNote(row: MetricRow): boolean {
  return row.durationMs === 0 && row.recordings > 0;
}

/**
 * 图3 房间名口径（评审稿 v2【四】/FE 意见 1）：
 * 房间存在 → 用 rooms store 当前 displayName（显示现名）；
 * 已删除/改名 → 回落 recordings.room_name 快照；两者皆无 → 占位。
 */
export function resolveRoomName(
  roomId: string,
  snapshot: string,
  rooms: ReadonlyArray<{ id: string; displayName: string }>,
): string {
  const current = rooms.find((r) => r.id === roomId)?.displayName;
  if (current && current.trim()) return current.trim();
  if (snapshot && snapshot.trim()) return snapshot.trim();
  return "未知房间";
}

export interface NamedMetricRow extends MetricRow {
  name: string;
}

export interface PieDatum extends MetricRow {
  name: string;
  value: number;
}

/** 饼图数据：按当前指标降序（TOPN 归并与「其他」计算都依赖该顺序）。 */
export function toPieData(
  rows: readonly NamedMetricRow[],
  metric: StatMetric,
): PieDatum[] {
  return rows
    .map((r) => ({
      name: r.name,
      recordings: r.recordings,
      bytes: r.bytes,
      durationMs: r.durationMs,
      value: metricValue(r, metric),
    }))
    .sort(
      (a, b) =>
        b.value - a.value || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
}

export const OTHER_NAME = "其他";

/**
 * TOP10+其他（Q3 默认形态，QA B5）：其余项归并为「其他」，
 * 其值 = 总量 − TOP10 之和（逐字段，不只当前指标，保证 tooltip 对账一致）。
 * 行数 ≤ topN 时原样返回。
 */
export function rollupTop(data: readonly PieDatum[], topN: number): PieDatum[] {
  if (data.length <= topN) return [...data];
  const top = data.slice(0, topN);
  const totals = data.reduce(
    (acc, d) => ({
      recordings: acc.recordings + d.recordings,
      bytes: acc.bytes + d.bytes,
      durationMs: acc.durationMs + d.durationMs,
      value: acc.value + d.value,
    }),
    { recordings: 0, bytes: 0, durationMs: 0, value: 0 },
  );
  const topSum = top.reduce(
    (acc, d) => ({
      recordings: acc.recordings + d.recordings,
      bytes: acc.bytes + d.bytes,
      durationMs: acc.durationMs + d.durationMs,
      value: acc.value + d.value,
    }),
    { recordings: 0, bytes: 0, durationMs: 0, value: 0 },
  );
  return [
    ...top,
    {
      name: OTHER_NAME,
      recordings: totals.recordings - topSum.recordings,
      bytes: totals.bytes - topSum.bytes,
      durationMs: totals.durationMs - topSum.durationMs,
      value: totals.value - topSum.value,
    },
  ];
}

/** 读取 lr-* 主题 token，供 echarts 使用；主题切换（data-theme）由页面驱动重建 option。 */
export function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function")
    return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

// ======================= task #55-① 日历月视图网格 =======================
import type { Dayjs } from "dayjs";

/** 周内天标签（周一为首列） */
export const WEEKDAY_LABELS = [
  "一",
  "二",
  "三",
  "四",
  "五",
  "六",
  "日",
] as const;

export interface MonthCell {
  /** 日号 1-31（格内展示） */
  day: number;
  /** 周内天：0=周一 … 6=周日 */
  weekday: number;
  /** 第几周（0 起，= 纵轴分类） */
  week: number;
  /** YYYY-MM-DD（本地日，与 byDay 键一致） */
  date: string;
}

/**
 * 构建某月的日历月视图网格（GitHub 式：横轴=星期、纵轴=周）。
 * 与项目切日口径一致：直接用 Dayjs 本地日历字段，不涉及时区转换。
 */
export function buildMonthGrid(month: Dayjs): {
  cells: MonthCell[];
  weekCount: number;
} {
  const first = month.startOf("month");
  const firstWeekday = (first.day() + 6) % 7; // day(): 0=周日 → 0=周一 制
  const total = first.add(1, "month").diff(first, "day");
  const cells: MonthCell[] = [];
  for (let i = 0; i < total; i++) {
    const d = first.add(i, "day");
    cells.push({
      day: d.date(),
      weekday: (d.day() + 6) % 7,
      week: Math.floor((firstWeekday + i) / 7),
      date: d.format("YYYY-MM-DD"),
    });
  }
  const weekCount = Math.floor((firstWeekday + total - 1) / 7) + 1;
  return { cells, weekCount };
}

// ======================= task #55-② 饼图 12 色板 =======================

/**
 * 互不重复的 12 色（孟菲斯四色基调 + 同饱和/亮度扩展）：
 * TOP10+其他 11 扇区全不重复；前两色保持平台饼图原观感，前四色保持原房间饼观感。
 */
export const PIE_PALETTE_12: readonly string[] = [
  "#FF5FA2",
  "#F4C400",
  "#20B7A5",
  "#7564E8",
  "#F28C38",
  "#8DBF3C",
  "#3182CE",
  "#A45BC5",
  "#E85D5D",
  "#30A9C6",
  "#5667C9",
  "#8A7868",
];
