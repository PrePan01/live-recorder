import type { AlertLevel } from "../types/alert";

export const ALERT_LEVEL_META: Record<AlertLevel, { color: string; text: string }> = {
  info: { color: "blue", text: "提示" },
  warning: { color: "orange", text: "警告" },
  error: { color: "red", text: "错误" },
};

const ALERT_SOURCE_TEXT: Record<string, string> = {
  platform: "平台",
  network: "网络",
  disk: "磁盘",
  recorder: "录制",
  smtp: "邮件",
  service: "服务",
  pipeline: "后处理",
  upload: "上传",
  import: "导入",
  test: "测试",
};

export function alertSourceText(source: string): string {
  return ALERT_SOURCE_TEXT[source] ?? "系统";
}
