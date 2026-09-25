import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  App,
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popover,
  Popconfirm,
  Row,
  Slider,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  DownloadOutlined,
  UploadOutlined,
  CheckCircleOutlined,
  SyncOutlined,
  QuestionCircleOutlined,
  GlobalOutlined,
  BugOutlined,
} from "@ant-design/icons";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAppearanceStore } from "../../stores/appearanceStore";
import { useAlertStore } from "../../stores/alertStore";
import { useRoomStore } from "../../stores/roomStore";
import { useServiceStore } from "../../stores/serviceStore";
import { useNotificationStore } from "../../stores/notificationStore";
import { bridge } from "../../stores/bootStore";
import { useAppTheme } from "../../theme";
import type { ThemePreference } from "../../types/settings";
import { validateDirectory } from "../../api/settings";
import {
  exportConfig,
  exportConfigToFile,
  importConfig,
} from "../../api/config";
import {
  downloadDiagnostics,
  exportDiagnosticsToFile,
  fetchPerformanceDiagnostics,
  type PerformanceDiagnostic,
} from "../../api/diagnostics";
import {
  fetchSelfCheck,
  type SelfCheckItem,
  type SelfCheckStatus,
} from "../../api/service";
import DirectoryPicker from "../../components/DirectoryPicker";
import PlatformAuthorizationList, {
  type PlatformAuthorizationConfig,
} from "../../components/PlatformAuthorizationList";
import MemphisRadioGroup from "../../components/MemphisRadioGroup";
import PipelineConfigCard from "../../components/PipelineConfigCard";
import NamingRuleCard from "../../components/NamingRuleCard";
import OpenListConfigCard from "../../components/OpenListConfigCard";
import EmailConfigCard from "../../components/EmailConfigCard";
import ResetSettingsCard from "../../components/ResetSettingsCard";
import { describeError } from "../../utils/errorMap";
import { ApiError } from "../../types/error";
import { formatBytes, formatTime } from "../../utils/format";
import { ALERT_LEVEL_META, alertSourceText } from "../../utils/alertText";
import type { SettingsInput } from "../../types/settings";
import type { NotificationEventPreference } from "../../types/notification";
import { recentErrorDiagnostics } from "../../utils/errorDiagnostics";
import saveCookieTutorial from "../../assets/img/save_cookie.png";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];
const CHECK_COLOR: Record<SelfCheckStatus, string> = {
  ok: "success",
  fail: "error",
  warn: "warning",
  pending: "default",
};
const CHECK_TEXT: Record<SelfCheckStatus, string> = {
  ok: "正常",
  fail: "异常",
  warn: "警告",
  pending: "检测中",
};
const OFFICIAL_SITE_URL = "https://live-rec.bspartner.top/";
const ISSUE_URL = "https://github.com/PrePan01/live-recorder/issues";
const PERFORMANCE_DIAGNOSTICS_ENABLED = import.meta.env.DEV;
const PERFORMANCE_STAGE_LABEL: Record<string, string> = {
  requested: "已请求",
  highlight_buffer_stopped: "精彩时刻缓存已停用",
  storage_checks_ready: "存储检查完成",
  platform_cookie_ready: "平台授权已读取",
  stream_url_ready: "流地址已获取",
  ready: "已收到首段直播数据",
  failed: "启动失败",
  skipped: "未执行",
};
const NOTIFICATION_EVENTS: Array<{
  key: keyof NotificationEventPreference;
  label: string;
}> = [
  { key: "liveStarted", label: "开播提醒" },
  { key: "recordingStarted", label: "录制开始" },
  { key: "recordingEnded", label: "录制结束" },
  { key: "recordingFailed", label: "录制失败" },
  { key: "diskSpaceLow", label: "磁盘空间不足" },
  { key: "uploadFailed", label: "上传失败" },
];

function openExternalUrl(url: string): void {
  if (bridge.isDesktop) {
    void bridge.openPath(url).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function CredentialManual({
  config,
  hasCookie,
}: {
  config: PlatformAuthorizationConfig;
  hasCookie: boolean;
}) {
  const tutorialImage =
    config.platform === "douyin" ? saveCookieTutorial : undefined;
  return (
    <Collapse
      className="lr-credential-manual"
      ghost
      items={[
        {
          key: "manual-cookie",
          label: "手动粘贴 Cookie（高级）",
          children: (
            <div className="lr-credential-manual__content">
              <Typography.Paragraph type="secondary">
                进入网页版{config.label}并登录，打开任意直播间后按 F12 →
                网络（Network） → 刷新页面 → 点开任意{" "}
                <Typography.Text code>{config.manualHost}</Typography.Text> 请求
                → 在「请求标头」复制完整 Cookie 并粘贴。
                {tutorialImage ? (
                  <span className="lr-network-help">
                    <Tooltip
                      styles={{
                        root: {
                          width: "min(600px, calc(100vw - 48px))",
                          maxWidth: "none",
                        },
                      }}
                      title={
                        <img
                          alt={`从网络面板保存${config.label} Cookie 的教程`}
                          className="lr-cookie-tutorial-image"
                          src={tutorialImage}
                        />
                      }
                      placement="top"
                    >
                      <Button
                        aria-label={`查看${config.label}网络面板 Cookie 教程`}
                        className="lr-inline-icon-button"
                        size="small"
                        type="text"
                        icon={<QuestionCircleOutlined />}
                      />
                    </Tooltip>
                  </span>
                ) : null}
              </Typography.Paragraph>
              <Form.Item
                name={config.cookieField}
                extra={hasCookie ? "已保存；留空则不修改" : undefined}
              >
                <Input.Password
                  placeholder={hasCookie ? "••••••" : config.manualPlaceholder}
                  autoComplete="new-password"
                />
              </Form.Item>
            </div>
          ),
        },
      ]}
    />
  );
}

export default function SettingsPage() {
  const { message } = App.useApp();
  const { hash } = useLocation();
  const { settings, load, save } = useSettingsStore();
  const rooms = useRoomStore((s) => s.rooms);
  const emailNotificationsEnabled = settings?.mail.enabled ?? false;
  const showGlobalSearch = useAppearanceStore((s) => s.showGlobalSearch);
  const setShowGlobalSearch = useAppearanceStore((s) => s.setShowGlobalSearch);
  const { preference, setPreference } = useAppTheme();
  const {
    preferences,
    load: loadNotifications,
    save: saveNotifications,
  } = useNotificationStore();
  const {
    alerts,
    fetchAlerts,
    markRead,
    markAllRead,
    clearAll,
    retryFailure,
    retryingId,
  } = useAlertStore();
  const status = useServiceStore((s) => s.status);
  const fetchStatus = useServiceStore((s) => s.fetchStatus);
  const [form] = Form.useForm();
  const recordingFormat = Form.useWatch("recordingFormat", form);
  const [dirMsg, setDirMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [diagnosticsPopoverOpen, setDiagnosticsPopoverOpen] = useState(false);
  const [checks, setChecks] = useState<SelfCheckItem[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [performanceDiagnostics, setPerformanceDiagnostics] = useState<
    PerformanceDiagnostic[]
  >([]);
  const [loadingPerformanceDiagnostics, setLoadingPerformanceDiagnostics] =
    useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ffmpegPromptedRef = useRef(false);
  const ffmpegCheck = checks?.find((c) => c.key === "ffmpeg");
  const showFfmpegWarning =
    recordingFormat === "mp4_after" &&
    !!ffmpegCheck &&
    ffmpegCheck.status !== "ok";
  const windowWindows =
    typeof navigator !== "undefined" &&
    (navigator.platform.toLowerCase().includes("win") ||
      /Windows/i.test(navigator.userAgent));
  const ffmpegInstallCmd = windowWindows
    ? "winget install Gyan.FFmpeg"
    : "brew install ffmpeg";

  useEffect(() => {
    void load();
    void fetchAlerts();
    void fetchStatus();
    void loadNotifications().catch(() => undefined);
  }, [load, fetchAlerts, fetchStatus, loadNotifications]);

  const loadPerformanceDiagnostics = async () => {
    setLoadingPerformanceDiagnostics(true);
    try {
      setPerformanceDiagnostics(await fetchPerformanceDiagnostics());
    } catch {
      // 性能诊断不可用不影响设置页其它功能。
    } finally {
      setLoadingPerformanceDiagnostics(false);
    }
  };

  useEffect(() => {
    if (PERFORMANCE_DIAGNOSTICS_ENABLED) void loadPerformanceDiagnostics();
  }, []);

  useEffect(() => {
    if (settings && settings.theme) {
      setPreference(settings.theme);
    }
  }, [settings, setPreference]);

  useEffect(() => {
    if (!bridge.isDesktop || !settings) return;
    void bridge
      .setFloatingRecorderSize(settings.floatingRecorderSize ?? 36)
      .catch(() => undefined);
  }, [settings]);

  useEffect(() => {
    const target =
      hash === "#douyin-cookie"
        ? "douyin-cookie"
        : hash === "#bilibili-cookie"
          ? "bilibili-cookie"
          : null;
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(target)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [hash]);

  useEffect(() => {
    if (settings) {
      form.setFieldsValue({
        recordingDirectory: settings.recordingDirectory,
        maxConcurrentRecordings: settings.maxConcurrentRecordings,
        checkIntervalSec: { ...settings.checkIntervalSec },
        quality: settings.quality,
        recordingFormat: settings.recordingFormat ?? "source_flv",
        autoRecord: settings.autoRecord ?? false,
        confirmAfterComplete: settings.confirmAfterComplete ?? false,
        highlightBufferSeconds: settings.highlightBufferSeconds ?? 300,
        highlightEnabled: settings.highlightEnabled ?? true,
        theme: settings.theme ?? preference,
        floatingRecorderSize: settings.floatingRecorderSize ?? 36,
        douyinCookie: "",
        bilibiliCookie: "",
        mail: {
          ...settings.mail,
          recipients: settings.mail.recipients.join(", "),
          password: "",
        },
      });
    }
  }, [settings, form, preference]);

  const checkDir = async () => {
    const dir = form.getFieldValue("recordingDirectory") as string;
    if (!dir) return;
    try {
      await validateDirectory(dir);
      setDirMsg({ ok: true, text: "目录可用" });
    } catch (e) {
      setDirMsg({
        ok: false,
        text:
          e instanceof ApiError ? describeError(e.code, e.message) : "校验失败",
      });
    }
  };

  const runSelfCheck = async () => {
    setChecking(true);
    setChecks(null);
    try {
      setChecks(await fetchSelfCheck());
    } catch (e) {
      message.error(
        e instanceof ApiError ? describeError(e.code, e.message) : "自检失败",
      );
    } finally {
      setChecking(false);
    }
  };

  // 选择「完成后转 MP4」时自动检测 ffmpeg：缺失则自动切回「源 FLV 直写」并提示（PrePan 反馈）。
  useEffect(() => {
    if (recordingFormat !== "mp4_after") {
      ffmpegPromptedRef.current = false;
      return;
    }
    if (!checks) {
      void runSelfCheck();
      return;
    }
    if (
      ffmpegCheck &&
      ffmpegCheck.status !== "ok" &&
      !ffmpegPromptedRef.current
    ) {
      ffmpegPromptedRef.current = true;
      Modal.warning({
        title: "需要安装 ffmpeg",
        content: (
          <Space direction="vertical">
            <Typography.Text>
              “完成后转 MP4”依赖 ffmpeg。当前未检测到 ffmpeg，已自动切回“源 FLV
              直写”。
            </Typography.Text>
            <Typography.Text>
              安装完成后重启 Live Recorder，再点击“一键自检”。
            </Typography.Text>
            <Typography.Text code>{ffmpegInstallCmd}</Typography.Text>
          </Space>
        ),
        okText: "知道了",
      });
      form.setFieldValue("recordingFormat", "source_flv");
    }
  }, [recordingFormat, checks, ffmpegCheck]);

  const sendDesktopTest = async () => {
    try {
      await bridge.notify("Live Recorder提醒", "这是一条桌面通知测试消息");
      message.success("桌面通知已发送");
    } catch (e) {
      message.error(
        e instanceof ApiError
          ? describeError(e.code, e.message)
          : "测试通知失败",
      );
    }
  };

  const persist = async (
    values: SettingsInput,
    clearCookies: { douyin?: boolean; bilibili?: boolean } = {},
  ): Promise<boolean> => {
    const { mail, douyinCookie, bilibiliCookie, ...rest } =
      values as SettingsInput & {
        mail?: Record<string, unknown> & {
          recipients?: string;
          password?: string;
        };
        douyinCookie?: string;
        bilibiliCookie?: string;
      };
    const cookieField = (
      value: string | undefined,
      clear: boolean | undefined,
      key: "douyinCookie" | "bilibiliCookie",
    ) =>
      clear
        ? { [key]: "" }
        : typeof value === "string" && value.length > 0
          ? { [key]: value }
          : {};
    try {
      await save({
        ...rest,
        ...cookieField(douyinCookie, clearCookies.douyin, "douyinCookie"),
        ...cookieField(bilibiliCookie, clearCookies.bilibili, "bilibiliCookie"),
        mail: mail
          ? {
              ...mail,
              recipients: String(mail.recipients ?? "")
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean),
              password: mail.password || undefined,
            }
          : undefined,
      });
      return true;
    } catch (e) {
      message.error(
        e instanceof ApiError ? describeError(e.code, e.message) : "保存失败",
      );
      return false;
    }
  };

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onValuesChange = (_changed: unknown, all: SettingsInput) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void persist(all), 500);
  };

  /** 无系统“另存为”窗口可用时的兜底：走浏览器下载。 */
  const downloadConfig = async () => {
    const config = await exportConfig();
    const blob = new Blob([JSON.stringify({ config }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `live-recorder-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    message.success("配置已导出");
  };

  const onExport = async () => {
    setExporting(true);
    try {
      const result = await exportConfigToFile();
      if (result.saved) {
        message.success(`配置已导出到 ${result.path}`);
      } else if (result.reason === "no-dialog") {
        await downloadConfig();
      }
    } catch (e) {
      message.error(
        e instanceof ApiError ? describeError(e.code, e.message) : "导出失败",
      );
    } finally {
      setExporting(false);
    }
  };

  const onExportDiagnostics = async (includeRooms: boolean) => {
    setDiagnosticsPopoverOpen(false);
    setExportingDiagnostics(true);
    try {
      const frontendDiagnostics = recentErrorDiagnostics();
      const result = await exportDiagnosticsToFile(
        frontendDiagnostics,
        includeRooms,
      );
      if (result.saved) {
        message.success(`诊断日志已导出到 ${result.path}`);
      } else if (result.reason === "no-dialog") {
        await downloadDiagnostics(frontendDiagnostics, includeRooms);
        message.success("诊断日志已下载");
      }
    } catch (e) {
      message.error(
        e instanceof ApiError
          ? describeError(e.code, e.message)
          : "诊断日志导出失败",
      );
    } finally {
      setExportingDiagnostics(false);
    }
  };

  const onImportFile = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { config?: unknown };
      if (!parsed.config) throw new Error("bad format");
      const result = await importConfig(parsed.config as never);
      const parts = [
        `设置${result.appliedSettings ? "已应用" : "未变更"}`,
        `房间新增 ${result.importedRooms} 个、跳过 ${result.skippedRooms} 个`,
        `告警 ${result.importedAlerts} 条`,
      ];
      if (result.prediction) {
        const { matchedRooms, skippedRooms, events, forecasts } =
          result.prediction;
        parts.push(
          `开播预测：${matchedRooms} 个直播间、开播记录 ${events} 条、预测记录 ${forecasts} 条` +
            (skippedRooms > 0
              ? `（${skippedRooms} 个直播间未匹配已跳过）`
              : ""),
        );
      }
      if (result.recordings) {
        parts.push(`录制历史 ${result.recordings.recordings} 条`);
      }
      message.success(`导入完成：${parts.join("，")}`);
      await load();
    } catch (e) {
      message.error(
        e instanceof ApiError
          ? describeError(e.code, e.message)
          : "导入失败：文件格式或内容非法",
      );
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const diskFree = status?.disk?.freeBytes ?? 0;
  const diskTotal = status?.disk?.totalBytes ?? 1;
  const diskRatio = diskTotal > 0 ? diskFree / diskTotal : 0;
  const diskDanger = diskFree < 20_000_000_000 || diskRatio < 0.1;

  return (
    <div className="lr-page lr-settings-page">
      <div className="lr-page-header lr-settings-header">
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            设置与告警
          </Typography.Title>
        </div>
        <Space className="lr-page-actions" wrap>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            loading={exporting}
            onClick={() => void onExport()}
          >
            导出配置
          </Button>
          <Button
            size="small"
            icon={<UploadOutlined />}
            loading={importing}
            onClick={() => fileRef.current?.click()}
          >
            导入配置
          </Button>
        </Space>
      </div>
      {diskDanger ? (
        <Alert
          type="warning"
          showIcon
          banner
          style={{ marginBottom: 16 }}
          message={`磁盘可用空间不足：剩余 ${formatBytes(diskFree)}（${Math.round(diskRatio * 100)}%），可用空间过低将可能无法开启新的录制`}
        />
      ) : null}
      <Row className="lr-settings-grid" gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card
            className="lr-settings-card lr-settings-card--primary"
            title="服务设置"
          >
            <Form
              className="lr-settings-form"
              form={form}
              layout="vertical"
              onValuesChange={onValuesChange}
              disabled={!settings}
            >
              <div className="lr-settings-section">
                <Typography.Title
                  className="lr-settings-section__title"
                  level={4}
                >
                  外观与存储
                </Typography.Title>
                <Form.Item label="主题" name="theme">
                  <MemphisRadioGroup
                    options={THEME_OPTIONS}
                    value={preference}
                    onChange={(e) =>
                      setPreference(e.target.value as ThemePreference)
                    }
                  />
                </Form.Item>
                <Form.Item label="显示底部全局搜索">
                  <Switch
                    aria-label="显示底部全局搜索"
                    checked={showGlobalSearch}
                    onChange={setShowGlobalSearch}
                    disabled={false}
                  />
                </Form.Item>
                <Form.Item
                  className="lr-floating-recorder-size"
                  label="全局录制按钮大小"
                >
                  <div className="lr-floating-recorder-size__control">
                    <Form.Item name="floatingRecorderSize" noStyle>
                      <Slider
                        aria-label="全局录制按钮大小"
                        min={20}
                        max={100}
                        step={1}
                        tooltip={{ formatter: (value) => `${value ?? 36}px` }}
                      />
                    </Form.Item>
                  </div>
                </Form.Item>
                <Form.Item label="保存目录">
                  <Space.Compact style={{ width: "100%" }}>
                    <Form.Item
                      name="recordingDirectory"
                      noStyle
                      rules={[{ required: true, message: "必填" }]}
                    >
                      <Input onBlur={() => void checkDir()} />
                    </Form.Item>
                    <Button onClick={() => setPickerOpen(true)}>浏览…</Button>
                    <Button onClick={() => void checkDir()}>校验</Button>
                  </Space.Compact>
                </Form.Item>
                {dirMsg && (
                  <Typography.Paragraph
                    className="lr-settings-directory-status"
                    type={dirMsg.ok ? "success" : "danger"}
                  >
                    {dirMsg.text}
                  </Typography.Paragraph>
                )}
              </div>
              <div className="lr-settings-section">
                <Typography.Title
                  className="lr-settings-section__title"
                  level={4}
                >
                  录制行为
                </Typography.Title>
                <Form.Item
                  label="录制完成后询问是否保留"
                  name="confirmAfterComplete"
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Row gutter={16}>
                  <Col xs={24} md={8}>
                    <Form.Item
                      label="最大并发"
                      name="maxConcurrentRecordings"
                      rules={[{ required: true }]}
                      extra="可同时录制的直播间数量"
                    >
                      <InputNumber min={1} max={8} style={{ width: "100%" }} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item
                      label="默认清晰度"
                      name="quality"
                      extra="拿不到所选清晰度时，自动改录能录到的最高清晰度"
                    >
                      <Select
                        options={[
                          { value: "original", label: "原画" },
                          { value: "1080p", label: "1080p" },
                          { value: "720p", label: "720p" },
                          { value: "360p", label: "360p" },
                        ]}
                      />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item
                      label="录制格式"
                      name="recordingFormat"
                      extra="FLV：无损最快；MP4：录制完成后自动转换，依赖FFmpeg"
                    >
                      <Select
                        options={[
                          { value: "source_flv", label: "FLV" },
                          { value: "mp4_after", label: "MP4" },
                        ]}
                      />
                    </Form.Item>
                  </Col>
                </Row>
                {showFfmpegWarning ? (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message="未检测到 ffmpeg，录制完成后转 MP4 不可用"
                    description={
                      <Typography.Text>
                        请安装视频工具 ffmpeg 后重试（
                        {windowWindows
                          ? "Windows 在 PowerShell 执行"
                          : "macOS 在终端执行"}
                        ）：{" "}
                        <Typography.Text code>
                          {ffmpegInstallCmd}
                        </Typography.Text>
                        ，安装完成后点击「一键自检」重新检测。
                      </Typography.Text>
                    }
                  />
                ) : null}
                <div className="lr-settings-section">
                  <Typography.Title
                    className="lr-settings-section__title"
                    level={4}
                  >
                    自动录制
                  </Typography.Title>
                  <Form.Item
                    label="检测到开播自动录制"
                    name="autoRecord"
                    valuePropName="checked"
                  >
                    <Switch />
                  </Form.Item>
                  <Typography.Title
                    className="lr-settings-section__title"
                    level={5}
                  >
                    检测频率
                  </Typography.Title>
                  <Typography.Paragraph
                    className="lr-settings-section__hint"
                    type="secondary"
                  >
                    按平台设置开播状态的检查间隔（秒），数值越小响应越快。
                  </Typography.Paragraph>
                  <Row gutter={16}>
                    <Col xs={24} md={8}>
                      <Form.Item
                        label="全局默认"
                        name={["checkIntervalSec", "default"]}
                        rules={[{ required: true }]}
                      >
                        <InputNumber
                          min={10}
                          max={3600}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item
                        label="B站"
                        name={["checkIntervalSec", "bilibili"]}
                        rules={[{ required: true }]}
                      >
                        <InputNumber
                          min={10}
                          max={3600}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={8}>
                      <Form.Item
                        label="抖音"
                        name={["checkIntervalSec", "douyin"]}
                        rules={[{ required: true }]}
                      >
                        <InputNumber
                          min={10}
                          max={3600}
                          style={{ width: "100%" }}
                        />
                      </Form.Item>
                    </Col>
                  </Row>
                </div>
                <div className="lr-settings-section">
                  <Typography.Title
                    className="lr-settings-section__title"
                    level={4}
                  >
                    精彩时刻
                  </Typography.Title>
                  <Typography.Paragraph
                    className="lr-settings-section__hint"
                    type="secondary"
                  >
                    录制当前时刻之前的片段，最高支持 600 秒。
                  </Typography.Paragraph>
                  <Form.Item
                    label="开启精彩时刻"
                    name="highlightEnabled"
                    valuePropName="checked"
                  >
                    <Switch />
                  </Form.Item>
                  <Form.Item
                    label="精彩时刻缓存上限"
                    name="highlightBufferSeconds"
                    rules={[{ required: true }]}
                  >
                    <InputNumber min={5} max={600} addonAfter="秒" />
                  </Form.Item>
                </div>
              </div>
              <div className="lr-settings-section lr-settings-section--credential">
                <Typography.Title
                  className="lr-settings-section__title"
                  level={4}
                >
                  平台授权
                </Typography.Title>
                <PlatformAuthorizationList
                  settings={settings}
                  onAuthorized={load}
                  onClear={(platform) => {
                    const cookieField =
                      platform === "douyin" ? "douyinCookie" : "bilibiliCookie";
                    form.setFieldValue(cookieField, "");
                    void persist(
                      form.getFieldsValue() as SettingsInput,
                      platform === "douyin"
                        ? { douyin: true }
                        : { bilibili: true },
                    );
                  }}
                  renderSupplement={(config, hasCookie) => (
                    <CredentialManual config={config} hasCookie={hasCookie} />
                  )}
                />
              </div>
            </Form>
            <DirectoryPicker
              open={pickerOpen}
              initialPath={settings?.recordingDirectory}
              onClose={() => setPickerOpen(false)}
              onPick={(dir) => {
                // setFieldValue 不会触发 Form 的 onValuesChange；如果只回填表单，
                // 离开页面后重新加载设置时会丢失目录选择。
                if (debounceRef.current) {
                  clearTimeout(debounceRef.current);
                  debounceRef.current = null;
                }
                form.setFieldValue("recordingDirectory", dir);
                void persist({
                  ...form.getFieldsValue(),
                  recordingDirectory: dir,
                } as SettingsInput).then((saved) => {
                  if (saved) message.success("目录已选择并保存");
                });
              }}
            />
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onImportFile(f);
              }}
            />
          </Card>
          <Card className="lr-settings-card" title="录制文件命名规则">
            <NamingRuleCard />
          </Card>
          <Card className="lr-settings-card" title="后处理管线">
            <PipelineConfigCard />
          </Card>
          <Card className="lr-settings-card" title="自动上传">
            <OpenListConfigCard />
          </Card>
          <ResetSettingsCard
            onExport={onExport}
            exporting={exporting}
            beforeReset={() => {
              if (debounceRef.current) {
                clearTimeout(debounceRef.current);
                debounceRef.current = null;
              }
            }}
          />
        </Col>
        <Col xs={24} lg={10}>
          <Card
            className="lr-settings-card lr-notification-card"
            title="通知设置"
          >
            <Space
              className="lr-notification-settings"
              orientation="vertical"
              style={{ width: "100%" }}
              size={16}
            >
              <div className="lr-notification-matrix">
                <div className="lr-notification-matrix__header">通知事件</div>
                <div className="lr-notification-matrix__header">桌面通知</div>
                <div className="lr-notification-matrix__header">邮件通知</div>
                {NOTIFICATION_EVENTS.map(({ key, label }) => (
                  <div className="lr-notification-matrix__row" key={key}>
                    <span>{label}</span>
                    <div className="lr-notification-matrix__cell">
                      <Switch
                        checked={preferences?.desktop[key] ?? false}
                        onChange={(value) =>
                          void saveNotifications({
                            desktop: {
                              [key]: value,
                            } as Partial<NotificationEventPreference>,
                          }).catch(() => message.error("保存失败"))
                        }
                      />
                    </div>
                    <div className="lr-notification-matrix__cell">
                      <Switch
                        checked={preferences?.email[key] ?? false}
                        disabled={!emailNotificationsEnabled}
                        onChange={(value) =>
                          void saveNotifications({
                            email: {
                              [key]: value,
                            } as Partial<NotificationEventPreference>,
                          }).catch(() => message.error("保存失败"))
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
              <Form.Item
                label="通知去重时间（分钟）"
                style={{ marginBottom: 0 }}
              >
                <InputNumber
                  min={1}
                  max={1440}
                  value={preferences?.dedupeWindowMinutes}
                  onChange={(v) => {
                    if (typeof v === "number" && v >= 1 && v <= 1440) {
                      void saveNotifications({ dedupeWindowMinutes: v }).catch(
                        () => message.error("保存失败"),
                      );
                    }
                  }}
                />
              </Form.Item>
              <Button size="small" onClick={() => void sendDesktopTest()}>
                发送桌面测试
              </Button>
              <div className="lr-notification-email-config">
                <Typography.Title level={5}>邮件服务</Typography.Title>
                <Typography.Paragraph type="secondary">
                  邮件通知需要启用下方总开关；测试邮件不受开关影响。
                </Typography.Paragraph>
                <EmailConfigCard />
              </div>
            </Space>
          </Card>
          <Card
            className="lr-settings-card lr-self-check-card"
            title="一键自检"
            extra={
              <Button
                size="small"
                icon={<SyncOutlined />}
                loading={checking}
                onClick={() => void runSelfCheck()}
              >
                {checks ? "重新检测" : "开始检测"}
              </Button>
            }
          >
            {checks === null ? (
              <Typography.Paragraph type="secondary">
                点击检测，检测功能是否正常
              </Typography.Paragraph>
            ) : (
              <List
                size="small"
                dataSource={checks}
                locale={{ emptyText: "无检测项" }}
                renderItem={(c) => (
                  <List.Item>
                    <List.Item.Meta
                      title={
                        <Space>
                          {c.status === "ok" ? (
                            <CheckCircleOutlined style={{ color: "#52c41a" }} />
                          ) : (
                            <Tag color={CHECK_COLOR[c.status]}>
                              {CHECK_TEXT[c.status]}
                            </Tag>
                          )}
                          <Typography.Text strong>{c.label}</Typography.Text>
                        </Space>
                      }
                      description={
                        <>
                          {c.detail ? (
                            <Typography.Text type="secondary">
                              {c.detail}
                            </Typography.Text>
                          ) : null}
                          {c.fixHint ? (
                            <Typography.Text
                              type="warning"
                              style={{ display: "block" }}
                            >
                              修复：{c.fixHint}
                            </Typography.Text>
                          ) : null}
                        </>
                      }
                    />
                  </List.Item>
                )}
              />
            )}
          </Card>
          {PERFORMANCE_DIAGNOSTICS_ENABLED && (
            <Card
              className="lr-settings-card"
              title="性能诊断"
              extra={
                <Button
                  size="small"
                  loading={loadingPerformanceDiagnostics}
                  onClick={() => void loadPerformanceDiagnostics()}
                >
                  刷新
                </Button>
              }
            >
              <Typography.Paragraph type="secondary">
                显示本次服务运行期间最近 100
                次录制或预览启动的服务端耗时；完整记录也会随诊断日志导出。
              </Typography.Paragraph>
              <List
                size="small"
                dataSource={performanceDiagnostics.slice(0, 20)}
                locale={{ emptyText: "尚无录制或预览启动记录" }}
                renderItem={(item) => {
                  const room = rooms.find(
                    (candidate) => candidate.id === item.roomId,
                  );
                  const kind =
                    item.kind === "recording_start" ? "录制启动" : "预览启动";
                  const outcome =
                    item.outcome === "ok"
                      ? "完成"
                      : item.outcome === "running"
                        ? "进行中"
                        : item.outcome === "skipped"
                          ? "跳过"
                          : "失败";
                  return (
                    <List.Item>
                      <List.Item.Meta
                        title={
                          <Space wrap>
                            <Typography.Text strong>{kind}</Typography.Text>
                            <Tag>
                              {item.platform === "bilibili" ? "B站" : "抖音"}
                            </Tag>
                            <Tag
                              color={
                                item.outcome === "ok"
                                  ? "success"
                                  : item.outcome === "failed"
                                    ? "error"
                                    : "default"
                              }
                            >
                              {outcome}
                            </Tag>
                            <Typography.Text type="secondary">
                              {item.elapsedMs} ms
                            </Typography.Text>
                          </Space>
                        }
                        description={
                          <>
                            <Typography.Text type="secondary">
                              {room?.displayName ?? "已删除的直播间"} ·{" "}
                              {formatTime(item.startedAt)}
                              {item.errorCode ? ` · ${item.errorCode}` : ""}
                            </Typography.Text>
                            <Typography.Text
                              type="secondary"
                              style={{ display: "block" }}
                            >
                              {item.stages
                                .map(
                                  (stage) =>
                                    `${PERFORMANCE_STAGE_LABEL[stage.name] ?? stage.name} ${stage.elapsedMs} ms`,
                                )
                                .join(" · ")}
                            </Typography.Text>
                          </>
                        }
                      />
                    </List.Item>
                  );
                }}
              />
            </Card>
          )}
          <Card
            className="lr-alerts-card lr-settings-card"
            title="告警"
            extra={
              <Space size={8}>
                <Button
                  size="small"
                  onClick={() => {
                    void markAllRead().catch(() => undefined);
                  }}
                >
                  全部已读
                </Button>
                <Popconfirm
                  title="清除全部告警？"
                  okText="清除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() =>
                    clearAll()
                      .then(() => message.success("已清除全部告警"))
                      .catch(() => message.error("清除告警失败"))
                  }
                >
                  <Button size="small" danger disabled={alerts.length === 0}>
                    清除全部
                  </Button>
                </Popconfirm>
              </Space>
            }
          >
            <List
              dataSource={alerts}
              locale={{ emptyText: "暂无告警" }}
              renderItem={(a) => (
                <List.Item
                  actions={
                    a.resolved
                      ? [<Tag key="done">已读</Tag>]
                      : [
                          a.roomId && a.errorCode ? (
                            <Button
                              key="retry"
                              size="small"
                              type="link"
                              loading={retryingId === a.id}
                              onClick={() =>
                                void retryFailure(a)
                                  .then(() => message.success("已触发重新检测"))
                                  .catch((e) =>
                                    message.error(
                                      e instanceof ApiError
                                        ? describeError(e.code, e.message)
                                        : "重试失败",
                                    ),
                                  )
                              }
                            >
                              重试
                            </Button>
                          ) : null,
                          <Button
                            key="read"
                            size="small"
                            type="link"
                            onClick={() => {
                              void markRead(a.id).catch(() => undefined);
                            }}
                          >
                            标记已读
                          </Button>,
                        ]
                  }
                >
                  <List.Item.Meta
                    title={
                      <Space>
                        <Tag color={ALERT_LEVEL_META[a.level].color}>
                          {ALERT_LEVEL_META[a.level].text}
                        </Tag>
                        <Typography.Text>{a.message}</Typography.Text>
                      </Space>
                    }
                    description={
                      <Typography.Text type="secondary">
                        {a.roomId
                          ? `直播间：${rooms.find((room) => room.id === a.roomId)?.displayName || a.roomId} · `
                          : ""}
                        {alertSourceText(a.source)} · {formatTime(a.occurredAt)}
                      </Typography.Text>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
      <footer className="lr-settings-footer" aria-label="相关链接">
        <Space size={16} wrap>
          <Typography.Link onClick={() => openExternalUrl(OFFICIAL_SITE_URL)}>
            <GlobalOutlined /> 官网
          </Typography.Link>
          <Space className="lr-settings-support-links" size={4}>
            <BugOutlined />
            <Typography.Link onClick={() => openExternalUrl(ISSUE_URL)}>
              提交 Issue
            </Typography.Link>
            <Typography.Text>|</Typography.Text>
            <Popover
              open={diagnosticsPopoverOpen}
              onOpenChange={(open) => {
                if (!exportingDiagnostics) setDiagnosticsPopoverOpen(open);
              }}
              title="是否导出包含直播间信息的日志？"
              content={
                <div style={{ width: 240 }}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                      gap: 8,
                    }}
                  >
                    <Button
                      block
                      size="small"
                      type="primary"
                      onClick={() => void onExportDiagnostics(true)}
                    >
                      是
                    </Button>
                    <Button
                      block
                      size="small"
                      onClick={() => void onExportDiagnostics(false)}
                    >
                      否
                    </Button>
                  </div>
                </div>
              }
              trigger="click"
            >
              <Typography.Link disabled={exportingDiagnostics}>
                {exportingDiagnostics ? "正在导出…" : "导出诊断日志"}
              </Typography.Link>
            </Popover>
          </Space>
        </Space>
      </footer>
    </div>
  );
}
