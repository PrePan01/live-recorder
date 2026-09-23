import * as echarts from "echarts/core";
import { BarChart, CustomChart, HeatmapChart, PieChart } from "echarts/charts";
import {
  CalendarComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([
  BarChart,
  PieChart,
  HeatmapChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CalendarComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

export type ChartInstance = ReturnType<typeof echarts.init>;
export { echarts };
