import { Typography } from "antd";
import { useSettingsStore } from "../stores/settingsStore";
import type { Settings } from "../types/settings";

export type DetectionLoad = NonNullable<Settings["detectionLoad"]>;

/** 提示行文案（与调度器同源出数）：只提示不硬拦，数值不在此处二次计算。 */
export function detectionLoadText(load: DetectionLoad): string {
  const frequency = `当前配置合计检测频率约 ${load.perMinute} 次/分`;
  return load.queued > 0
    ? `${frequency}，已自动降低检测频率（上限 ${load.limitPerMinute} 次/分）`
    : frequency;
}

/** 检测负载一行提示：后端未供数时不渲染。 */
export default function DetectionLoadHint() {
  const load = useSettingsStore((s) => s.settings?.detectionLoad);
  if (!load) return null;
  return (
    <Typography.Paragraph
      type="secondary"
      className="lr-detection-load-hint"
      role="status"
    >
      {detectionLoadText(load)}
    </Typography.Paragraph>
  );
}
