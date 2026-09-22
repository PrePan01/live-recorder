// ECharts 按需引入（task #51 · 评审稿 v2【六】）：
// - 仅注册四图所需 chart/component + canvas renderer，控制 chunk 体积；
// - 本模块只被 Stats 路由引用，随 Stats 懒加载 chunk 加载，首屏 JS 不包含 echarts（QA G3）。
import * as echarts from 'echarts/core';
// 注：日历坐标系是 CalendarComponent（配合 HeatmapChart 的 calendar 系列），
// echarts/charts 并无 CalendarChart 导入项。
import { BarChart, HeatmapChart, PieChart } from 'echarts/charts';
import {
  CalendarComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  PieChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CalendarComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

export type ChartInstance = ReturnType<typeof echarts.init>;
export { echarts };
