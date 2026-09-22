// 图表卡片容器（task #51）：antd Card（全局孟菲斯描边）+ echarts 实例生命周期。
// - init 一次、dispose 兜底；ResizeObserver 只观察自身容器并在卸载时断开；
// - option 变化仅 setOption（指标切换/数据刷新 0 请求由父层保证）；
// - empty → clear() + 空态；loading → 轻量浮层，不卸载图表容器（避免反复 init/dispose）。
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Card, Empty, Spin } from 'antd';
import type { EChartsOption } from 'echarts';
import { echarts, type ChartInstance } from './echarts';

interface Props {
  title: ReactNode;
  extra?: ReactNode;
  option: EChartsOption | null;
  loading?: boolean;
  empty?: boolean;
  emptyText?: string;
  height?: number;
  /** 测试/走查定位用 */
  chartName: string;
}

export function EChartCard({
  title,
  extra,
  option,
  loading = false,
  empty = false,
  emptyText = '该区间暂无数据',
  height = 300,
  chartName,
}: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartInstance | null>(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return undefined;
    const chart = echarts.init(el);
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (empty || !option) {
      chart.clear();
      return;
    }
    chart.setOption(option, { notMerge: true });
  }, [option, empty]);

  return (
    <Card
      title={title}
      extra={extra}
      styles={{ body: { padding: 12 } }}
      data-chart={chartName}
    >
      <div className="lr-chart" style={{ height }}>
        <div ref={elRef} className="lr-chart__canvas" />
        {empty ? (
          <div className="lr-chart__overlay">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />
          </div>
        ) : null}
        {loading ? (
          <div className="lr-chart__overlay lr-chart__overlay--loading">
            <Spin />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
