import type { Patch } from "./saveQueue";
export type Domain =
  | "settings"
  | "pipeline"
  | "notifications"
  | "naming"
  | "email"
  | "openlist"
  | "appearance";
export const SECTIONS = [
  ["appearance", "外观", "界面主题与快捷操作"],
  ["recording", "录制", "录制默认值与自动录制"],
  ["monitoring", "监测", "开播状态监测与检测频率"],
  ["files", "文件与存储", "保存位置与文件命名"],
  ["highlights", "精彩时刻", "直播回溯缓存"],
  ["pipeline", "录制后处理", "录制完成后的文件处理"],
  ["authorization", "平台授权", "平台登录与凭据管理"],
  ["notifications", "通知与邮件", "事件提醒与邮件连接"],
  ["upload", "自动上传", "OpenList 连接与上传行为"],
  ["maintenance", "运行信息", "诊断、备份与危险操作"],
] as const;
export interface SettingDefinition {
  id: string;
  section: string;
  domain: Domain;
  path: string;
  label: string;
  description: string;
  keywords?: string;
  advanced?: boolean;
  restorable?: boolean;
  secret?: boolean;
  min?: number;
  max?: number;
  nullable?: boolean;
  unit?: string;
  dependsOn?: string;
  dependsValue?: unknown;
}
const field = (
  id: string,
  section: string,
  domain: Domain,
  path: string,
  label: string,
  description: string,
  extra: Partial<SettingDefinition> = {},
): SettingDefinition => ({
  id,
  section,
  domain,
  path,
  label,
  description,
  restorable: true,
  ...extra,
});
export const DEFINITIONS: SettingDefinition[] = [
  field(
    "theme",
    "appearance",
    "settings",
    "theme",
    "主题",
    "浅色、深色或跟随系统；选择后自动保存。",
  ),
  field(
    "global-search",
    "appearance",
    "appearance",
    "showGlobalSearch",
    "显示底部全局搜索",
    "当前客户端偏好，仅影响这台设备的界面。",
  ),
  field(
    "recorder-size",
    "appearance",
    "settings",
    "floatingRecorderSize",
    "全局录制按钮大小",
    "调整桌面全局录制按钮的尺寸。",
    { min: 20, max: 100, unit: "px" },
  ),
  field(
    "quality",
    "recording",
    "settings",
    "quality",
    "默认清晰度",
    "无法获取所选清晰度时，自动使用当前可录制的最高清晰度；影响新录制。",
  ),
  field(
    "concurrency",
    "recording",
    "settings",
    "maxConcurrentRecordings",
    "最大同时录制数量",
    "限制可同时录制的直播间数量。",
    { min: 1, max: 8, unit: "个" },
  ),
  field(
    "auto-record",
    "recording",
    "settings",
    "autoRecord",
    "检测到开播自动录制",
    "全局默认，房间单独设置优先；关闭后仍继续监测开播状态。",
  ),
  field(
    "danmaku",
    "recording",
    "settings",
    "danmaku.enabled",
    "录制弹幕",
    "全局默认，房间单独设置优先；影响新启动的弹幕采集。",
  ),
  field(
    "prevent-sleep",
    "recording",
    "settings",
    "preventSleepWhileRecording",
    "录制中防止系统休眠",
    "录制期间保持系统唤醒，减少休眠导致的中断。",
  ),
  field(
    "confirm-complete",
    "recording",
    "settings",
    "confirmAfterComplete",
    "录制完成后询问是否保留",
    "等待保留确认时，后处理和上传将暂缓执行。",
  ),
  ...(["default", "bilibili", "douyin"] as const).map((platform, index) =>
    field(
      `interval-${platform}`,
      "monitoring",
      "settings",
      `checkIntervalSec.${platform}`,
      `${["全局默认", "B站", "抖音"][index]}检测间隔`,
      "开播状态检查间隔，数值越小响应越快；自动录制关闭时仍生效。",
      {
        min: 10,
        max: 3600,
        unit: "秒",
        keywords: "检测频率 轮询",
      },
    ),
  ),
  field(
    "recording-directory",
    "files",
    "settings",
    "recordingDirectory",
    "保存目录",
    "校验并应用后用于新录制；已有文件不会移动。",
    { restorable: false, keywords: "存储 路径" },
  ),
  field(
    "naming-rule",
    "files",
    "naming",
    "namingRule",
    "录制文件命名规则",
    "修改只影响新录制，已有文件不会重命名。",
    { keywords: "模板 文件名" },
  ),
  field(
    "highlight-enabled",
    "highlights",
    "settings",
    "highlightEnabled",
    "开启精彩时刻",
    "缓存当前时刻之前的直播片段；关闭后停止回溯缓存。",
  ),
  field(
    "highlight-buffer",
    "highlights",
    "settings",
    "highlightBufferSeconds",
    "精彩时刻缓存上限",
    "关闭功能后保留此数值，重新开启时继续使用。",
    { min: 5, max: 600, unit: "秒", dependsOn: "highlight-enabled" },
  ),
  field(
    "pipeline-enabled",
    "pipeline",
    "pipeline",
    "enabled",
    "启用录制后处理",
    "设置影响之后创建的处理任务，运行中的任务继续使用原配置。",
    { keywords: "管线" },
  ),
  field(
    "encoding-mode",
    "pipeline",
    "settings",
    "encodingMode",
    "编码方式",
    "用于后处理压缩与片段重编码；自动模式优先使用硬件，失败时回退软件。",
    { keywords: "硬编 软编 转码 压缩" },
  ),
  field(
    "pipeline-verify",
    "pipeline",
    "pipeline",
    "verify",
    "完整性校验",
    "校验源文件，损坏时停止处理并保留源文件。",
    { dependsOn: "pipeline-enabled" },
  ),
  field(
    "pipeline-cover",
    "pipeline",
    "pipeline",
    "exportCover",
    "导出封面",
    "导出图片用于录制历史展示。",
    { dependsOn: "pipeline-enabled" },
  ),
  field(
    "pipeline-segment",
    "pipeline",
    "pipeline",
    "segmentSeconds",
    "切片",
    "按指定时长分割文件；0 表示不切片。",
    { min: 0, max: 86400, unit: "秒", dependsOn: "pipeline-enabled" },
  ),
  field(
    "pipeline-audio",
    "pipeline",
    "pipeline",
    "exportAudio",
    "导出音频",
    "录制完成后导出 MP3 音频。",
    { dependsOn: "pipeline-enabled" },
  ),
  field(
    "pipeline-format",
    "pipeline",
    "pipeline",
    "outputFormat",
    "格式转换",
    "保留源格式，或无损转换为 MP4。",
    { dependsOn: "pipeline-enabled" },
  ),
  field(
    "pipeline-delete",
    "pipeline",
    "pipeline",
    "deleteSourceAfterConvert",
    "转换成功后删除源文件",
    "仅在成功转换为 MP4 后删除录制源文件。",
    { dependsOn: "pipeline-format", dependsValue: "mp4" },
  ),
  field(
    "pipeline-crf",
    "pipeline",
    "pipeline",
    "crf",
    "压缩",
    "CRF 数值越小质量越高，文件越大；关闭压缩时不重编码。",
    { min: 0, max: 51, nullable: true, dependsOn: "pipeline-enabled" },
  ),
  field(
    "archive-directory",
    "pipeline",
    "pipeline",
    "archiveDirectory",
    "归档目录",
    "留空表示不归档；仅影响之后创建的处理任务。",
    { restorable: false, dependsOn: "pipeline-enabled" },
  ),
  field(
    "douyin-cookie",
    "authorization",
    "settings",
    "douyinCookie",
    "抖音授权",
    "在授权窗口登录，或手动保存完整 Cookie；凭据已保存不等于授权有效。",
    { restorable: false, secret: true, keywords: "Cookie 登录 账户" },
  ),
  field(
    "bilibili-cookie",
    "authorization",
    "settings",
    "bilibiliCookie",
    "B站授权",
    "授权用于获取可用的高画质档位；凭据已保存不等于授权有效。",
    { restorable: false, secret: true, keywords: "Cookie 登录 账户" },
  ),
  field(
    "notification-dedupe",
    "notifications",
    "notifications",
    "dedupeWindowMinutes",
    "重复提醒间隔",
    "同类重复事件在此时间窗口内合并提醒。",
    { min: 1, max: 1440, unit: "分钟" },
  ),
  field(
    "email-enabled",
    "notifications",
    "email",
    "enabled",
    "启用邮件通知",
    "邮件配置自动保存；关闭后保留通知事件偏好。",
  ),
  ...(
    [
      "host",
      "port",
      "secure",
      "username",
      "from",
      "recipients",
      "password",
    ] as const
  ).map((path, i) =>
    field(
      `email-${path}`,
      "notifications",
      "email",
      path,
      [
        "邮件服务器",
        "邮件端口",
        "TLS 加密",
        "邮件用户名",
        "发件地址",
        "收件地址",
        "邮件密码",
      ][i]!,
      "邮件连接参数自动保存，测试前等待保存完成。",
      { restorable: false, secret: path === "password", keywords: "SMTP 邮箱" },
    ),
  ),
  field(
    "upload-enabled",
    "upload",
    "openlist",
    "enabled",
    "启用自动上传",
    "开启前验证已保存的连接配置；保存成功与连接正常分别展示。",
  ),
  field(
    "upload-delete",
    "upload",
    "openlist",
    "deleteSourceAfterUpload",
    "上传成功后删除本地文件",
    "仅在确认远端上传成功后删除本地源文件。",
    { dependsOn: "upload-enabled" },
  ),
  ...(["serverUrl", "username", "token", "directoryTemplate"] as const).map(
    (path, i) =>
      field(
        `upload-${path}`,
        "upload",
        "openlist",
        path,
        ["服务器地址", "上传用户名", "令牌（WebDAV 密码）", "上传目录模板"][i]!,
        path === "directoryTemplate"
          ? "支持 {platform}/{room}/{date} 等变量。"
          : "连接参数自动保存；测试前等待保存完成。",
        {
          restorable: false,
          secret: path === "token",
          keywords: "OpenList WebDAV 连接",
        },
      ),
  ),
];
export const NOTIFICATION_EVENTS = [
  ["liveStarted", "开播提醒"],
  ["recordingStarted", "录制开始"],
  ["recordingEnded", "录制结束"],
  ["recordingFailed", "录制失败"],
  ["diskSpaceLow", "磁盘空间不足"],
  ["uploadFailed", "上传失败"],
  ["pipelineCompleted", "后处理完成"],
  ["pipelineFailed", "后处理失败"],
] as const;
for (const [key, label] of NOTIFICATION_EVENTS)
  for (const channel of ["desktop", "email"])
    DEFINITIONS.push(
      field(
        `notify-${channel}-${key}`,
        "notifications",
        "notifications",
        `${channel}.${key}`,
        `${label} · ${channel === "desktop" ? "桌面" : "邮件"}`,
        "控制此事件的通知渠道。",
        channel === "email" ? { dependsOn: "email-enabled" } : {},
      ),
    );
export const BY_ID = Object.fromEntries(DEFINITIONS.map((d) => [d.id, d]));
export function getPath(data: Patch | undefined, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === "object" ? (value as Patch)[key] : undefined,
      data,
    );
}
export function pathPatch(path: string, value: unknown): Patch {
  return path
    .split(".")
    .reverse()
    .reduce<unknown>((nested, key) => ({ [key]: nested }), value) as Patch;
}
export function validateValue(
  def: SettingDefinition,
  value: unknown,
): string | undefined {
  if (def.nullable && value === null) return undefined;
  if (def.id === "upload-serverUrl" && value) {
    try {
      const url = new URL(String(value));
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      return "请输入有效的 HTTP 或 HTTPS 服务器地址";
    }
  }

  if (
    def.id === "email-port" &&
    (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535)
  )
    return "端口需为 1–65535 的整数";
  if (
    def.id === "email-from" &&
    value &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))
  )
    return "发件邮箱地址无效";
  if (def.id === "email-recipients") {
    const recipients = Array.isArray(value)
      ? value
      : String(value ?? "")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
    if (recipients.some((v) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))))
      return "请填写有效的收件邮箱地址";
  }

  if (
    def.min !== undefined &&
    (!Number.isInteger(value) ||
      Number(value) < def.min ||
      Number(value) > def.max!)
  )
    return `请输入 ${def.min}–${def.max} 范围内的整数`;
  if (
    def.id === "naming-rule" &&
    (typeof value !== "string" || !value.trim() || value.length > 200)
  )
    return "命名规则需为 1–200 个字符";
  return undefined;
}
export function searchSettings(
  query: string,
  modifiedOnly: boolean,
  isModified: (id: string) => boolean,
) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return DEFINITIONS.filter(
    (def) =>
      (!modifiedOnly || isModified(def.id)) &&
      terms.every((term) =>
        `${def.label} ${def.description} ${def.keywords ?? ""} ${SECTIONS.find((s) => s[0] === def.section)?.[1]}`
          .toLocaleLowerCase()
          .includes(term),
      ),
  );
}

export const ORIGINAL_HELP: Record<string, string> = {
  "highlight-enabled": "录制当前时刻之前的片段，最高支持 600 秒。",
  concurrency: "可同时录制的直播间数量",
  quality: "无法获取选择的清晰度时，自动改录能录到的最高清晰度",
  "upload-directoryTemplate": "支持 {room}/{platform}/{date} 等变量",
};
