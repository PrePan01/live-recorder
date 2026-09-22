// 统计看板 v2（task #51 · 评审稿 v2 notes/review-stats-dashboard.md）：
// - 筛选：日期（date-only RangePicker）+ 起/止时间（TimePicker HH:mm，小时精度，task #54）
//   + 平台 + 标签多选 + 房间；防抖 300ms、丢弃在途旧请求、可重置；
// - 四图：每日趋势柱状 / 平台饼图 / 直播间饼图（TOP10+其他、可展开全部）/ 日历热力图（独立翻月）；
//   每图三指标（次数/大小/时长）独立切换，默认次数、纯前端 0 请求（Q2）；
// - 热力图仅受平台/标签/房间约束、不随上方日期（Q1=A），每次翻月单独 1 请求；
// - 历史兼容：0 字节/进行中录制 tooltip 标注（Q5/B4）；房间名现名优先、快照兜底（图3 口径）；
// - 风格：孟菲斯双重遵循（lr-memphis token，冲突以项目内为准）；echarts 仅随本路由懒加载（QA G3）。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { App, Button, Card, Col, DatePicker, Empty, Row, Select, Segmented, Space, Statistic, TimePicker, Typography } from 'antd';
import axios from 'axios';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import type { EChartsOption } from 'echarts';
import { fetchRecordingsStats } from '../../api/stats';
import { useRoomStore } from '../../stores/roomStore';
import { useTagStore } from '../../stores/tagStore';
import { describeError } from '../../utils/errorMap';
import { ApiError } from '../../types/error';
import { formatBytes } from '../../utils/format';
import type { RecordingsStats, StatsByDay } from '../../types/stats';
import { EChartCard } from './EChartCard';
import {
  METRIC_OPTIONS,
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
} from './agg';

const PLATFORM_LABEL: Record<string, string> = { bilibili: 'B站', douyin: '抖音' };
const HEAT_NOTE = '仅受平台/标签/房间约束，不随上方日期';

type MetricKey = 'trend' | 'platform' | 'room' | 'heat';
const DEFAULT_METRICS: Record<MetricKey, StatMetric> = {
  trend: 'recordings',
  platform: 'recordings',
  room: 'recordings',
  heat: 'recordings',
};

function defaultRange(): [Dayjs, Dayjs] {
  return [dayjs().subtract(29, 'day').startOf('day'), dayjs().endOf('day')];
}

export default function Stats() {
  const { message } = App.useApp();
  const rooms = useRoomStore((s) => s.rooms);
  const fetchRooms = useRoomStore((s) => s.fetchRooms);
  const tags = useTagStore((s) => s.tags);

  // —— 全局筛选（Q1=A 下热力图不受 range 约束）——
  // task #54：antd 6.6.1 showTime RangePicker 为 needConfirm 交互（面板点选永不推进结束字段，
  // 外部关闭会用旧结束日期提交，上游 antd#35851→#27779 长期设计），实机不可用；
  // 改为 date-only RangePicker（两击自然选，History 页同款已验证）+ 起/止两个独立 TimePicker（HH:mm）。
  const [range, setRange] = useState<[Dayjs, Dayjs] | null>(defaultRange());
  const [startTime, setStartTime] = useState<Dayjs>(() => dayjs().startOf('day'));
  const [endTime, setEndTime] = useState<Dayjs>(() => dayjs().startOf('day').hour(23).minute(59));
  const [platform, setPlatform] = useState<string | undefined>();
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [roomId, setRoomId] = useState<string | undefined>();

  const [stats, setStats] = useState<RecordingsStats | null>(null);
  const [loading, setLoading] = useState(false);

  // —— 热力图独立状态 ——
  const [heatMonth, setHeatMonth] = useState<Dayjs>(() => dayjs());
  const [heat, setHeat] = useState<RecordingsStats | null>(null);
  const [heatLoading, setHeatLoading] = useState(false);

  const [metrics, setMetrics] = useState<Record<MetricKey, StatMetric>>(DEFAULT_METRICS);
  const [roomExpanded, setRoomExpanded] = useState(false);

  // 主题切换（data-theme）后重建 option，让 echarts 重新读取 lr-* token。
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setThemeTick((t) => t + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  const filterQuery = useMemo(
    () => ({
      ...(platform ? { platform } : {}),
      ...(tagIds.length > 0 ? { tagId: tagIds.join(',') } : {}),
      ...(roomId ? { roomId } : {}),
    }),
    [platform, tagIds, roomId],
  );

  const mainSeqRef = useRef(0);
  const firstMainRef = useRef(true);
  const mainQuery = useMemo(() => {
    if (!range) return { ...filterQuery };
    // 小时精度（A2 闭区间语义不变）：from = 起日+起时（分内 00.000 起），to = 止日+止时（分内 59.999 止）。
    // 默认 00:00/23:59 与旧 endOf/startOf day 构造完全等价。
    const from = range[0].hour(startTime.hour()).minute(startTime.minute()).second(0).millisecond(0);
    const to = range[1].hour(endTime.hour()).minute(endTime.minute()).second(59).millisecond(999);
    return { from: from.toISOString(), to: to.toISOString(), ...filterQuery };
  }, [range, startTime, endTime, filterQuery]);

  // 主查询：首载立即、筛选变更防抖 300ms；effect 清理即中止在途请求（A5/竞态红线）。
  useEffect(() => {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      if (ctrl.signal.aborted) return;
      const seq = ++mainSeqRef.current;
      setLoading(true);
      void fetchRecordingsStats(mainQuery, { signal: ctrl.signal })
        .then((data) => setStats(data))
        .catch((e: unknown) => {
          if (!axios.isCancel(e)) {
            message.error(e instanceof ApiError ? describeError(e.code, e.message) : '统计加载失败');
          }
        })
        .finally(() => {
          if (mainSeqRef.current === seq) setLoading(false);
        });
    }, firstMainRef.current ? 0 : 300);
    firstMainRef.current = false;
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [mainQuery, message]);

  // 热力图查询：所选月区间 + 平台/标签/房间；每次翻月/约束变更恰好 1 请求（D2）。
  const heatSeqRef = useRef(0);
  const firstHeatRef = useRef(true);
  const heatMonthKey = heatMonth.format('YYYY-MM-DD');
  const heatQuery = useMemo(() => {
    const m = dayjs(heatMonthKey);
    return {
      from: m.startOf('month').toISOString(),
      to: m.endOf('month').toISOString(),
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
              message.error(e instanceof ApiError ? describeError(e.code, e.message) : '热力图加载失败');
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
    if (tags.length === 0) void useTagStore.getState().load().catch(() => undefined);
  }, [rooms.length, tags.length, fetchRooms]);

  const setMetric = (key: MetricKey, value: StatMetric) =>
    setMetrics((prev) => ({ ...prev, [key]: value }));

  const resetAll = () => {
    setRange(defaultRange());
    setStartTime(dayjs().startOf('day'));
    setEndTime(dayjs().startOf('day').hour(23).minute(59));
    setPlatform(undefined);
    setTagIds([]);
    setRoomId(undefined);
    setMetrics(DEFAULT_METRICS);
    setRoomExpanded(false);
    setHeatMonth(dayjs());
  };

  // —— 调色板（读 lr token，随 themeTick 重建）——
  const tone = useMemo(
    () => ({
      ink: cssVar('--lr-ink', '#000000'),
      text: cssVar('--lr-text', '#000000'),
      muted: cssVar('--lr-muted', '#65616c'),
      surface: cssVar('--lr-surface', '#ffffff'),
      surfaceAlt: cssVar('--lr-surface-alt', '#f4f0ff'),
      pink: cssVar('--lr-pink', '#ff5fa2'),
      yellow: cssVar('--lr-yellow', '#ffd500'),
      teal: cssVar('--lr-teal', '#2ec4b6'),
      primary: cssVar('--lr-primary', '#607ae3'),
      palette: [
        cssVar('--lr-pink', '#ff5fa2'),
        cssVar('--lr-yellow', '#ffd500'),
        cssVar('--lr-teal', '#2ec4b6'),
        cssVar('--lr-primary', '#607ae3'),
      ],
    }),
    // themeTick：主题切换（data-theme 变更）时重新读取 token。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // 图1 每日趋势柱状（byDay，三指标切换）
  const trendOption = useMemo<EChartsOption | null>(() => {
    const rows = stats?.byDay ?? [];
    if (rows.length === 0) return null;
    const m = metrics.trend;
    const metricRowText = (row: StatsByDay) => {
      const lines = [`场次 ${row.recordings}`, `大小 ${row.bytes > 0 ? formatBytes(row.bytes) : '0 B'}`, `时长 ${formatMetric(row.durationMs, 'durationMs')}`];
      if (unmeasuredBytesNote(row)) lines.push('⚠ 含未统计大小的录制');
      if (unmeasuredDurationNote(row)) lines.push('⚠ 含未统计时长的录制');
      return lines;
    };
    return {
      grid: { left: 8, right: 14, top: 16, bottom: 4, containLabel: true },
      tooltip: {
        ...tooltipBase,
        trigger: 'axis',
        formatter: (params: unknown) => {
          const list = Array.isArray(params) ? (params as Array<{ dataIndex?: number }>) : [params as { dataIndex?: number }];
          const idx = list[0]?.dataIndex ?? -1;
          const row = rows[idx];
          if (!row) return '';
          return [`<b>${row.date}</b>`, ...metricRowText(row)].join('<br/>');
        },
      },
      xAxis: {
        type: 'category',
        data: rows.map((d) => d.date.slice(5)),
        axisLine: { lineStyle: { color: tone.ink, width: 2 } },
        axisTick: { show: false },
        axisLabel: { color: tone.muted, fontSize: 11, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: tone.muted, opacity: 0.25, width: 1 } },
        axisLabel: { color: tone.muted, fontSize: 11, formatter: (v: number) => formatAxisLabel(v, m) },
      },
      series: [
        {
          type: 'bar',
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
        color: [...tone.palette],
        tooltip: {
          ...tooltipBase,
          trigger: 'item',
          formatter: (params: unknown) => {
            const p = params as { data?: PieDatum; percent?: number };
            const d = p.data;
            if (!d) return '';
            const lines = [`<b>${d.name}</b>`, `占比 ${(p.percent ?? 0).toFixed(1)}%`, `场次 ${d.recordings}`, `大小 ${d.bytes > 0 ? formatBytes(d.bytes) : '0 B'}`, `时长 ${formatMetric(d.durationMs, 'durationMs')}`];
            if (unmeasuredBytesNote(d)) lines.push('⚠ 含未统计大小的录制');
            if (unmeasuredDurationNote(d)) lines.push('⚠ 含未统计时长的录制');
            return lines.join('<br/>');
          },
        },
        legend: {
          type: 'scroll',
          bottom: 0,
          textStyle: { color: tone.text, fontSize: 11 },
          itemWidth: 12,
          itemHeight: 12,
        },
        series: [
          {
            type: 'pie',
            radius: ['44%', '70%'],
            center: ['50%', '44%'],
            data,
            label: { color: tone.text, fontSize: 11, formatter: '{b}\n{d}%' },
            labelLine: { lineStyle: { color: tone.muted } },
            itemStyle: { borderColor: tone.ink, borderWidth: 2, borderRadius: 4 },
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

  // 图4 日历热力图（月视图；数据 = 热力图独立查询的 byDay）
  const heatOption = useMemo<EChartsOption | null>(() => {
    const rows = heat?.byDay ?? [];
    if (rows.length === 0) return null;
    const m = metrics.heat;
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const values = rows.map((r) => metricValue(r, m));
    const maxV = Math.max(...values, 0);
    const monthStart = heatMonth.startOf('month');
    const monthEnd = heatMonth.endOf('month');
    return {
      tooltip: {
        ...tooltipBase,
        formatter: (params: unknown) => {
          const p = params as { data?: [string, number] };
          const date = p.data?.[0];
          const row = date ? byDate.get(date) : undefined;
          if (!row) return '';
          const lines = [`<b>${row.date}</b>`, `场次 ${row.recordings}`, `大小 ${row.bytes > 0 ? formatBytes(row.bytes) : '0 B'}`, `时长 ${formatMetric(row.durationMs, 'durationMs')}`];
          if (unmeasuredBytesNote(row)) lines.push('⚠ 含未统计大小的录制');
          if (unmeasuredDurationNote(row)) lines.push('⚠ 含未统计时长的录制');
          return lines.join('<br/>');
        },
      },
      visualMap: {
        min: 0,
        max: maxV > 0 ? maxV : 1,
        calculable: false,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        itemWidth: 14,
        itemHeight: 8,
        textStyle: { color: tone.muted, fontSize: 10 },
        inRange: { color: [tone.surfaceAlt, tone.teal, tone.yellow, tone.pink] },
      },
      calendar: {
        range: [monthStart.format('YYYY-MM-DD'), monthEnd.format('YYYY-MM-DD')],
        left: 48,
        right: 14,
        top: 24,
        bottom: 40,
        cellSize: ['auto', 20],
        splitLine: { lineStyle: { color: tone.ink, width: 2 } },
        itemStyle: { color: tone.surface, borderWidth: 1, borderColor: tone.surfaceAlt },
        dayLabel: { firstDayOfWeek: 1, color: tone.muted, fontSize: 10, nameMap: 'ZH' },
        monthLabel: { color: tone.text, fontSize: 11 },
        yearLabel: { show: false },
      },
      series: [
        {
          type: 'heatmap',
          coordinateSystem: 'calendar',
          data: rows.map((r) => [r.date, metricValue(r, m)]),
          itemStyle: { borderColor: tone.ink, borderWidth: 1, borderRadius: 2 },
        },
      ],
    } as unknown as EChartsOption;
  }, [heat, metrics.heat, heatMonth, tone, tooltipBase]);

  const totals = stats?.totals;

  const metricExtra = (key: MetricKey): ReactNode => (
    <Segmented
      size="small"
      aria-label="指标切换"
      options={METRIC_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))}
      value={metrics[key]}
      onChange={(v) => setMetric(key, v as StatMetric)}
    />
  );

  return (
    <div className="lr-page">
      <Space className="lr-page-header" wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          统计看板
        </Typography.Title>
        <Space className="lr-page-actions" wrap>
          <DatePicker.RangePicker
            value={range}
            onChange={(v) => setRange(v as [Dayjs, Dayjs] | null)}
          />
          <TimePicker
            aria-label="起始时间"
            format="HH:mm"
            allowClear={false}
            value={startTime}
            onChange={(v) => v && setStartTime(v)}
          />
          <TimePicker
            aria-label="结束时间"
            format="HH:mm"
            allowClear={false}
            value={endTime}
            onChange={(v) => v && setEndTime(v)}
          />
          <Select
            allowClear
            placeholder="平台"
            style={{ width: 110 }}
            value={platform}
            onChange={setPlatform}
            options={[
              { value: 'bilibili', label: 'B站' },
              { value: 'douyin', label: '抖音' },
            ]}
          />
          <Select
            mode="multiple"
            allowClear
            placeholder="标签（可多选）"
            style={{ minWidth: 150, maxWidth: 260 }}
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
                suffix={totals.failed > 0 ? `（失败 ${totals.failed}）` : undefined}
              />
              <Typography.Text type="secondary" className="lr-stats-kpi__sub">
                完成 {totals.completed} · 失败 {totals.failed}
              </Typography.Text>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card loading={loading}>
              <Statistic title="录制时长" value={Math.round(totals.durationMs / 3600000)} suffix="小时" />
              <Typography.Text type="secondary" className="lr-stats-kpi__sub">
                约 {(totals.durationMs / 86400000).toFixed(1)} 天
              </Typography.Text>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card loading={loading}>
              <Statistic title="占用空间" value={totals.bytes} formatter={(v) => formatBytes(Number(v))} />
              <Typography.Text type="secondary" className="lr-stats-kpi__sub">
                {totals.recordings > 0 ? `平均每场 ${formatBytes(Math.round(totals.bytes / totals.recordings))}` : '平均每场 -'}
              </Typography.Text>
            </Card>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Card loading={loading}>
              <Statistic
                title="成功率"
                value={totals.successRate}
                suffix="%"
                styles={{ content: { color: totals.successRate >= 80 ? undefined : '#cf1322' } }}
              />
              <Typography.Text type="secondary" className="lr-stats-kpi__sub">
                {totals.completed + totals.failed > 0
                  ? `${totals.completed}/${totals.completed + totals.failed} 场完成判定`
                  : '暂无完成判定'}
              </Typography.Text>
            </Card>
          </Col>

          <Col xs={24} lg={14}>
            <EChartCard
              chartName="trend"
              title="每日录制趋势"
              extra={metricExtra('trend')}
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
              extra={metricExtra('platform')}
              option={platformOption}
              empty={!platformOption}
              emptyText="暂无平台数据"
              loading={loading}
              height={300}
            />
          </Col>
          <Col xs={24} lg={10}>
            <EChartCard
              chartName="room"
              title="直播间分布"
              extra={
                <Space size={6}>
                  <Button
                    size="small"
                    aria-label={roomExpanded ? '收起全部' : '展开全部'}
                    onClick={() => setRoomExpanded((v) => !v)}
                  >
                    {roomExpanded ? '收起' : '展开全部'}
                  </Button>
                  {metricExtra('room')}
                </Space>
              }
              option={roomOption}
              empty={!roomOption}
              emptyText="暂无直播间数据"
              loading={loading}
              height={300}
            />
          </Col>
          <Col xs={24} lg={14}>
            <EChartCard
              chartName="heat"
              title={
                <Space size={6} wrap>
                  <span>日历热力图</span>
                  <Typography.Text type="secondary" className="lr-stats-heat__note">
                    （{HEAT_NOTE}）
                  </Typography.Text>
                </Space>
              }
              extra={
                <Space size={6} wrap>
                  <Button
                    size="small"
                    aria-label="上一月"
                    onClick={() => setHeatMonth((m) => m.subtract(1, 'month'))}
                  >
                    ‹
                  </Button>
                  <Typography.Text strong className="lr-stats-heat__month">
                    {heatMonth.format('YYYY年MM月')}
                  </Typography.Text>
                  <Button size="small" aria-label="下一月" onClick={() => setHeatMonth((m) => m.add(1, 'month'))}>
                    ›
                  </Button>
                  {metricExtra('heat')}
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
          数据刷新于 {dayjs(stats.generatedAt).format('YYYY-MM-DD HH:mm:ss')}
        </Typography.Paragraph>
      ) : null}
    </div>
  );
}
