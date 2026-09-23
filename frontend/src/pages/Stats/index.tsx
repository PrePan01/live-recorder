import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Row,
  Select,
  Space,
  Statistic,
  Typography,
} from "antd";
import { LeftOutlined, RightOutlined } from "@ant-design/icons";
import axios from "axios";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import type { EChartsOption } from "echarts";
import { fetchRecordingsStats } from "../../api/stats";
import { useRoomStore } from "../../stores/roomStore";
import { useTagStore } from "../../stores/tagStore";
import { describeError } from "../../utils/errorMap";
import { ApiError } from "../../types/error";
import { formatBytes } from "../../utils/format";
import type { RecordingsStats, StatsByDay } from "../../types/stats";
import { EChartCard } from "./EChartCard";
import MemphisRadioGroup from "../../components/MemphisRadioGroup";
import {
  METRIC_OPTIONS,
  PIE_PALETTE_12,
  WEEKDAY_LABELS,
  buildMonthGrid,
  cssVar,
  formatAxisLabel,
  formatMetric,
  metricValue,
  resolveRoomName,
  rollupTop,
  toPieData,
  unmeasuredBytesNote,
  unmeasuredDurationNote,
  type PieDatum,
  type StatMetric,
} from "./agg";

const PLATFORM_LABEL: Record<string, string> = {
  bilibili: "B站",
  douyin: "抖音",
};

type MetricKey = "trend" | "platform" | "room" | "heat";
const DEFAULT_METRICS: Record<MetricKey, StatMetric> = {
  trend: "recordings",
  platform: "recordings",
  room: "recordings",
  heat: "recordings",
};
const PIE_CENTER_Y = "42%";
const PIE_LEGEND_BOTTOM = 8;

function defaultRange(): [Dayjs, Dayjs] {
  return [dayjs().subtract(29, "day").startOf("day"), dayjs().endOf("day")];
}

export default function Stats() {
  const { message } = App.useApp();
  const rooms = useRoomStore((s) => s.rooms);
  const fetchRooms = useRoomStore((s) => s.fetchRooms);
  const tags = useTagStore((s) => s.tags);

  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(defaultRange());
  const [platform, setPlatform] = useState<string | undefined>();
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [roomId, setRoomId] = useState<string | undefined>();

  const [stats, setStats] = useState<RecordingsStats | null>(null);
  const [loading, setLoading] = useState(false);

  // —— 热力图独立状态 ——
  const [heatMonth, setHeatMonth] = useState<Dayjs>(() => dayjs());
  const [heat, setHeat] = useState<RecordingsStats | null>(null);
  const [heatLoading, setHeatLoading] = useState(false);

  const [metrics, setMetrics] =
    useState<Record<MetricKey, StatMetric>>(DEFAULT_METRICS);
  const [roomExpanded, setRoomExpanded] = useState(false);

  // 主题切换（data-theme）后重建 option，让 echarts 重新读取 lr-* token。
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((t) => t + 1));
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => mo.disconnect();
  }, []);

  const filterQuery = useMemo(
    () => ({
      ...(platform ? { platform } : {}),
      ...(tagIds.length > 0 ? { tagId: tagIds.join(",") } : {}),
      ...(roomId ? { roomId } : {}),
    }),
    [platform, tagIds, roomId],
  );

  const mainSeqRef = useRef(0);
  const firstMainRef = useRef(true);
  const mainQuery = useMemo(() => {
    if (!range) return { ...filterQuery };
    const from = range[0].second(0).millisecond(0);
    const to = range[1].second(59).millisecond(999);
    return { from: from.toISOString(), to: to.toISOString(), ...filterQuery };
  }, [range, filterQuery]);

  useEffect(() => {
    const ctrl = new AbortController();
    const timer = window.setTimeout(
      () => {
        if (ctrl.signal.aborted) return;
        const seq = ++mainSeqRef.current;
        setLoading(true);
        void fetchRecordingsStats(mainQuery, { signal: ctrl.signal })
          .then((data) => setStats(data))
          .catch((e: unknown) => {
            if (!axios.isCancel(e)) {
              message.error(
                e instanceof ApiError
                  ? describeError(e.code, e.message)
                  : "统计加载失败",
              );
            }
          })
          .finally(() => {
            if (mainSeqRef.current === seq) setLoading(false);
          });
      },
      firstMainRef.current ? 0 : 300,
    );
    firstMainRef.current = false;
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [mainQuery, message]);

  // 热力图查询：所选月区间 + 平台/标签/房间；每次翻月/约束变更恰好 1 请求（D2）。
  const heatSeqRef = useRef(0);
  const firstHeatRef = useRef(true);
  const heatMonthKey = heatMonth.format("YYYY-MM-DD");
  const heatQuery = useMemo(() => {
    const m = dayjs(heatMonthKey);
    return {
      from: m.startOf("month").toISOString(),
      to: m.endOf("month").toISOString(),
      ...filterQuery,
    };
  }, [heatMonthKey, filterQuery]);
  useEffect(() => {
    const ctrl = new AbortController();
    const timer = window.setTimeout(
      () => {
        if (ctrl.signal.aborted) return;
        const seq = ++heatSeqRef.current;
        setHeatLoading(true);
        void fetchRecordingsStats(heatQuery, { signal: ctrl.signal })
          .then((data) => setHeat(data))
          .catch((e: unknown) => {
            if (!axios.isCancel(e)) {
              message.error(
                e instanceof ApiError
                  ? describeError(e.code, e.message)
                  : "热力图加载失败",
              );
            }
          })
          .finally(() => {
            if (heatSeqRef.current === seq) setHeatLoading(false);
          });
      },
      firstHeatRef.current ? 0 : 300,
    );
    firstHeatRef.current = false;
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [heatQuery, message]);

  useEffect(() => {
    if (rooms.length === 0) void fetchRooms().catch(() => undefined);
    if (tags.length === 0)
      void useTagStore
        .getState()
        .load()
        .catch(() => undefined);
  }, [rooms.length, tags.length, fetchRooms]);

  const setMetric = (key: MetricKey, value: StatMetric) =>
    setMetrics((prev) => ({ ...prev, [key]: value }));

  const resetAll = () => {
    setRange(defaultRange());
    setPlatform(undefined);
    setTagIds([]);
    setRoomId(undefined);
    setMetrics(DEFAULT_METRICS);
    setRoomExpanded(false);
    setHeatMonth(dayjs());
  };

  // —— 预设范围（task #55-③ · antd「预设范围」样式，直达含时间的范围）——
  const rangePresets = useMemo<
    { label: string; value: [Dayjs, Dayjs] }[]
  >(() => {
    const d0 = () => dayjs().startOf("day");
    const dE = () => dayjs().endOf("day");
    const lastMonth = dayjs().subtract(1, "month");
    return [
      { label: "今天", value: [d0(), dE()] },
      {
        label: "昨天",
        value: [d0().subtract(1, "day"), dE().subtract(1, "day")],
      },
      { label: "近7天", value: [d0().subtract(6, "day"), dE()] },
      { label: "近30天", value: [d0().subtract(29, "day"), dE()] },
      { label: "本月", value: [dayjs().startOf("month"), dE()] },
      {
        label: "上月",
        value: [lastMonth.startOf("month"), lastMonth.endOf("month")],
      },
    ];
  }, []);

  const tone = useMemo(
    () => ({
      ink: cssVar("--lr-ink", "#000000"),
      text: cssVar("--lr-text", "#000000"),
      muted: cssVar("--lr-muted", "#65616c"),
      surface: cssVar("--lr-surface", "#ffffff"),
      surfaceAlt: cssVar("--lr-surface-alt", "#f4f0ff"),
      pink: cssVar("--lr-pink", "#ff5fa2"),
      yellow: cssVar("--lr-yellow", "#ffd500"),
      teal: cssVar("--lr-teal", "#2ec4b6"),
      primary: cssVar("--lr-primary", "#607ae3"),
    }),
    [themeTick],
  );

  const tooltipBase = useMemo(
    () => ({
      borderColor: tone.ink,
      borderWidth: 2,
      backgroundColor: tone.surface,
      textStyle: { color: tone.text },
    }),
    [tone],
  );

  const trendOption = useMemo<EChartsOption | null>(() => {
    const rows = stats?.byDay ?? [];
    if (rows.length === 0) return null;
    const m = metrics.trend;
    const metricRowText = (row: StatsByDay) => {
      const lines = [
        `场次 ${row.recordings}`,
        `大小 ${row.bytes > 0 ? formatBytes(row.bytes) : "0 B"}`,
        `时长 ${formatMetric(row.durationMs, "durationMs")}`,
      ];
      if (unmeasuredBytesNote(row)) lines.push("⚠ 含未统计大小的录制");
      if (unmeasuredDurationNote(row)) lines.push("⚠ 含未统计时长的录制");
      return lines;
    };
    return {
      grid: { left: 8, right: 14, top: 16, bottom: 4, containLabel: true },
      tooltip: {
        ...tooltipBase,
        trigger: "axis",
        formatter: (params: unknown) => {
          const list = Array.isArray(params)
            ? (params as Array<{ dataIndex?: number }>)
            : [params as { dataIndex?: number }];
          const idx = list[0]?.dataIndex ?? -1;
          const row = rows[idx];
          if (!row) return "";
          return [`<b>${row.date}</b>`, ...metricRowText(row)].join("<br/>");
        },
      },
      xAxis: {
        type: "category",
        data: rows.map((d) => d.date.slice(5)),
        axisLine: { lineStyle: { color: tone.ink, width: 2 } },
        axisTick: { show: false },
        axisLabel: { color: tone.muted, fontSize: 11, hideOverlap: true },
      },
      yAxis: {
        type: "value",
        splitLine: {
          lineStyle: { color: tone.muted, opacity: 0.25, width: 1 },
        },
        axisLabel: {
          color: tone.muted,
          fontSize: 11,
          formatter: (v: number) => formatAxisLabel(v, m),
        },
      },
      series: [
        {
          type: "bar",
          barMaxWidth: 26,
          data: rows.map((d) => metricValue(d, m)),
          itemStyle: {
            color: tone.pink,
            borderColor: tone.ink,
            borderWidth: 1.5,
            borderRadius: [3, 3, 0, 0],
          },
        },
      ],
    } as unknown as EChartsOption;
  }, [stats, metrics.trend, tone, tooltipBase]);

  const buildPieOption = useMemo(() => {
    return (data: PieDatum[]): EChartsOption =>
      ({
        // task #55-②：固定 12 色互不重复（TOP10+其他 11 扇区不重色），前两色保持平台饼原观感
        color: [...PIE_PALETTE_12],
        tooltip: {
          ...tooltipBase,
          trigger: "item",
          formatter: (params: unknown) => {
            const p = params as { data?: PieDatum; percent?: number };
            const d = p.data;
            if (!d) return "";
            const lines = [
              `<b>${d.name}</b>`,
              `占比 ${(p.percent ?? 0).toFixed(1)}%`,
              `场次 ${d.recordings}`,
              `大小 ${d.bytes > 0 ? formatBytes(d.bytes) : "0 B"}`,
              `时长 ${formatMetric(d.durationMs, "durationMs")}`,
            ];
            if (unmeasuredBytesNote(d)) lines.push("⚠ 含未统计大小的录制");
            if (unmeasuredDurationNote(d)) lines.push("⚠ 含未统计时长的录制");
            return lines.join("<br/>");
          },
        },
        legend: {
          type: "scroll",
          bottom: PIE_LEGEND_BOTTOM,
          textStyle: { color: tone.text, fontSize: 11 },
          itemWidth: 12,
          itemHeight: 12,
        },
        series: [
          {
            type: "pie",
            radius: ["44%", "70%"],
            center: ["50%", PIE_CENTER_Y],
            data,
            label: { color: tone.text, fontSize: 11, formatter: "{b}\n{d}%" },
            labelLine: { lineStyle: { color: tone.muted } },
            itemStyle: {
              borderColor: tone.ink,
              borderWidth: 2,
            },
            emphasis: { scaleSize: 6 },
          },
        ],
      }) as unknown as EChartsOption;
  }, [tone, tooltipBase]);

  // 图2 平台分布饼图（byPlatform）
  const platformOption = useMemo<EChartsOption | null>(() => {
    const rows = stats?.byPlatform ?? [];
    if (rows.length === 0) return null;
    const data = toPieData(
      rows.map((p) => ({
        name: PLATFORM_LABEL[p.platform] ?? p.platform,
        recordings: p.recordings,
        bytes: p.bytes,
        durationMs: p.durationMs,
      })),
      metrics.platform,
    );
    return buildPieOption(data);
  }, [stats, metrics.platform, buildPieOption]);

  // 图3 直播间分布饼图（byRoom；房间名现名优先、快照兜底；TOP10+其他 / 展开全部）
  const roomOption = useMemo<EChartsOption | null>(() => {
    const rows = stats?.byRoom ?? [];
    if (rows.length === 0) return null;
    const data = toPieData(
      rows.map((r) => ({
        name: resolveRoomName(r.roomId, r.roomName, rooms),
        recordings: r.recordings,
        bytes: r.bytes,
        durationMs: r.durationMs,
      })),
      metrics.room,
    );
    return buildPieOption(roomExpanded ? data : rollupTop(data, 10));
  }, [stats, metrics.room, roomExpanded, rooms, buildPieOption]);

  /** custom 系列 renderItem API（task #55-①，echarts 6.1.0 heatmap 回归的替代实现） */
  interface CustomRenderApi {
    coord: (v: number[]) => [number, number];
    size: (v: number[]) => [number, number];
    visual: (dim: string) => string | undefined;
    value: (idx: number) => number;
  }

  // 图4 日历热力图（task #55-①：日历月视图——横轴=星期、纵轴=周、格内日号、
  // 仅 rgb(255,95,162) 粉 + 透明度分档；数据 = 热力图独立查询的 byDay）
  const heatOption = useMemo<EChartsOption | null>(() => {
    const rows = heat?.byDay ?? [];
    const m = metrics.heat;
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const { cells, weekCount } = buildMonthGrid(heatMonth);
    if (rows.length === 0 && heatLoading) return null;
    const maxV = Math.max(0, ...rows.map((r) => metricValue(r, m)));
    const xCats = WEEKDAY_LABELS.map((label) => `周${label}`);
    const yCats = Array.from({ length: weekCount }, (_, i) => `第${i + 1}周`);
    const cellByCoord = new Map(
      cells.map((c) => [`${c.weekday}:${c.week}`, c]),
    );
    const data = cells.map((c) => {
      const row = byDate.get(c.date);
      return { value: [c.weekday, c.week, row ? metricValue(row, m) : 0] };
    });
    // 单一粉色 rgb(255,95,162) 的 5 档透明度（PrePan：只用该粉 + 透明度分档）
    const pink = (a: number) => `rgba(255, 95, 162, ${a})`;
    return {
      grid: { left: 10, right: 16, top: 10, bottom: 46, containLabel: true },
      tooltip: {
        ...tooltipBase,
        // 与饼图已验证配置对齐：显式 item 触发（缺省时 custom 系列悬停不出 tooltip）
        trigger: "item",
        formatter: (params: unknown) => {
          const p = params as { value?: [number, number, number] };
          if (!p.value) return "";
          const cell = cellByCoord.get(`${p.value[0]}:${p.value[1]}`);
          if (!cell) return "";
          const row = byDate.get(cell.date);
          if (!row) return `<b>${cell.date}</b><br/>无录制数据`;
          const lines = [
            `<b>${cell.date}</b>`,
            `场次 ${row.recordings}`,
            `大小 ${row.bytes > 0 ? formatBytes(row.bytes) : "0 B"}`,
            `时长 ${formatMetric(row.durationMs, "durationMs")}`,
          ];
          if (unmeasuredBytesNote(row)) lines.push("⚠ 含未统计大小的录制");
          if (unmeasuredDurationNote(row)) lines.push("⚠ 含未统计时长的录制");
          return lines.join("<br/>");
        },
      },
      xAxis: {
        type: "category",
        data: xCats,
        splitLine: { lineStyle: { color: tone.ink, width: 1.5 } },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: tone.muted, fontSize: 11 },
      },
      yAxis: {
        type: "category",
        data: yCats,
        inverse: true,
        splitLine: { lineStyle: { color: tone.ink, width: 1.5 } },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
      },
      visualMap: {
        min: 0,
        max: maxV > 0 ? maxV : 1,
        calculable: false,
        orient: "horizontal",
        left: "center",
        bottom: 0,
        itemWidth: 14,
        itemHeight: 8,
        textStyle: { color: tone.muted, fontSize: 10 },
        // 5 档透明度：无数据/低值 → 浅，高值 → 实色
        inRange: {
          color: [pink(0), pink(0.25), pink(0.5), pink(0.75), pink(1)],
        },
      },
      series: [
        {
          type: "custom",
          data,
          encode: { x: 0, y: 1 },
          renderItem: (_params: unknown, api: CustomRenderApi) => {
            const coord = api.coord([api.value(0), api.value(1)]);
            const size = api.size([1, 1]);
            const color = api.visual("color") ?? "rgba(255, 95, 162, 0.12)";
            const w = Math.max(size[0] - 3, 2);
            const h = Math.max(size[1] - 3, 2);
            const cell = cellByCoord.get(`${api.value(0)}:${api.value(1)}`);
            return {
              type: "group",
              children: [
                {
                  type: "rect",
                  shape: {
                    x: coord[0] - w / 2,
                    y: coord[1] - h / 2,
                    width: w,
                    height: h,
                    r: 2,
                  },
                  // 网格分隔线是相邻日期唯一共享的边框，避免每格重复描边。
                  style: { fill: color },
                },
                {
                  type: "text",
                  style: {
                    x: coord[0],
                    y: coord[1],
                    text: cell ? String(cell.day) : "",
                    fill: tone.text,
                    fontSize: 10,
                    textAlign: "center",
                    textVerticalAlign: "middle",
                  },
                },
              ],
            };
          },
        },
      ],
    } as unknown as EChartsOption;
  }, [heat, metrics.heat, heatMonth, heatLoading, tone, tooltipBase]);

  const totals = stats?.totals;

  const metricExtra = (key: MetricKey): ReactNode => (
    <MemphisRadioGroup
      className="lr-stats-metric-toggle"
      aria-label="指标切换"
      options={METRIC_OPTIONS.map((o) => ({
        value: o.value as string,
        label: o.label,
      }))}
      value={metrics[key]}
      onChange={(event) => setMetric(key, event.target.value as StatMetric)}
    />
  );

  return (
    <div className="lr-page lr-stats-page">
      <Space className="lr-page-header" wrap={false}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          统计看板
        </Typography.Title>
        <Space className="lr-page-actions" wrap={false}>
          <DatePicker.RangePicker
            className="lr-stats-range-picker"
            format="YYYY-MM-DD HH:mm"
            showTime={{ format: "HH:mm" }}
            needConfirm={false}
            classNames={{ popup: { root: "lr-stats-range-picker-popup" } }}
            placeholder={["开始日期时间", "结束日期时间"]}
            presets={rangePresets}
            value={range}
            onChange={(value) => setRange(value as [Dayjs, Dayjs] | null)}
          />
          <Select
            allowClear
            placeholder="平台"
            style={{ width: 110 }}
            value={platform}
            onChange={setPlatform}
            options={[
              { value: "bilibili", label: "B站" },
              { value: "douyin", label: "抖音" },
            ]}
          />
          <Select
            mode="multiple"
            allowClear
            className="lr-stats-tag-filter"
            placeholder="标签"
            style={{ width: 140 }}
            value={tagIds}
            onChange={(v) => setTagIds(v as string[])}
            options={tags.map((t) => ({ value: t.id, label: t.name }))}
          />
          <Select
            allowClear
            placeholder="房间"
            style={{ width: 160 }}
            value={roomId}
            onChange={setRoomId}
            options={rooms.map((r) => ({ value: r.id, label: r.displayName }))}
          />
          <Button onClick={resetAll}>重置</Button>
        </Space>
      </Space>

      {stats && totals ? (
        <Row className="lr-stats-grid" gutter={[16, 16]}>
          <Col xs={24} sm={12} lg={6}>
            <Card loading={loading}>
              <Statistic
                title="录制场次"
                value={totals.recordings}
                suffix={
                  totals.failed > 0 ? `（失败 ${totals.failed}）` : undefined
                }
              />
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card loading={loading}>
              <Statistic
                title="录制时长"
                value={Math.round(totals.durationMs / 3600000)}
                suffix="小时"
              />
              <Typography.Text type="secondary" className="lr-stats-kpi__sub">
                约 {(totals.durationMs / 86400000).toFixed(1)} 天
              </Typography.Text>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card loading={loading}>
              <Statistic
                title="占用空间"
                value={totals.bytes}
                formatter={(v) => formatBytes(Number(v))}
              />
              <Typography.Text type="secondary" className="lr-stats-kpi__sub">
                {totals.recordings > 0
                  ? `平均每场 ${formatBytes(Math.round(totals.bytes / totals.recordings))}`
                  : "平均每场 -"}
              </Typography.Text>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card loading={loading}>
              <Statistic
                title="成功率"
                value={totals.successRate}
                suffix="%"
                styles={{
                  content: {
                    color: totals.successRate >= 80 ? undefined : "#cf1322",
                  },
                }}
              />
            </Card>
          </Col>

          <Col xs={24} lg={14}>
            <EChartCard
              chartName="trend"
              title="每日录制趋势"
              extra={metricExtra("trend")}
              option={trendOption}
              empty={!trendOption}
              emptyText="该区间暂无录制数据"
              loading={loading}
              height={300}
            />
          </Col>
          <Col xs={24} lg={10}>
            <EChartCard
              chartName="platform"
              title="平台分布"
              extra={metricExtra("platform")}
              option={platformOption}
              empty={!platformOption}
              emptyText="暂无平台数据"
              loading={loading}
              height={300}
            />
          </Col>
          <Col xs={24} lg={11}>
            <EChartCard
              chartName="room"
              title="直播间分布"
              extra={
                <Space size={6} className="lr-stats-card-extra">
                  <Button
                    size="small"
                    className="lr-stats-room-expand"
                    aria-label={roomExpanded ? "收起全部" : "展开全部"}
                    onClick={() => setRoomExpanded((v) => !v)}
                  >
                    {roomExpanded ? "收起" : "展开全部"}
                  </Button>
                  {metricExtra("room")}
                </Space>
              }
              option={roomOption}
              empty={!roomOption}
              emptyText="暂无直播间数据"
              loading={loading}
              height={340}
            />
          </Col>
          <Col xs={24} lg={13}>
            <EChartCard
              chartName="heat"
              title={
                <Space size={6} className="lr-stats-card-extra">
                  <span>热力图</span>
                </Space>
              }
              extra={
                <Space size={6} className="lr-stats-card-extra">
                  <Button
                    size="small"
                    className="lr-stats-heat__month-nav"
                    aria-label="上一月"
                    icon={<LeftOutlined />}
                    onClick={() => setHeatMonth((m) => m.subtract(1, "month"))}
                  />
                  <Typography.Text strong className="lr-stats-heat__month">
                    {heatMonth.format("YYYY年MM月")}
                  </Typography.Text>
                  <Button
                    size="small"
                    className="lr-stats-heat__month-nav"
                    aria-label="下一月"
                    icon={<RightOutlined />}
                    onClick={() => setHeatMonth((m) => m.add(1, "month"))}
                  />
                  {metricExtra("heat")}
                </Space>
              }
              option={heatOption}
              empty={!heatOption}
              emptyText="该月暂无录制数据"
              loading={heatLoading}
              height={340}
            />
          </Col>
        </Row>
      ) : !loading ? (
        <Empty description="暂无统计数据" />
      ) : null}

      {stats ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
          数据刷新于 {dayjs(stats.generatedAt).format("YYYY-MM-DD HH:mm:ss")}
        </Typography.Paragraph>
      ) : null}
    </div>
  );
}
