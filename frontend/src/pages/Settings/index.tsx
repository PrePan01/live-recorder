import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  App,
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Row,
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
  CopyOutlined,
  SyncOutlined,
  NotificationOutlined,
  QuestionCircleOutlined,
} from "@ant-design/icons";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAppearanceStore } from "../../stores/appearanceStore";
import { useAlertStore } from "../../stores/alertStore";
import { useServiceStore } from "../../stores/serviceStore";
import { useNotificationStore } from "../../stores/notificationStore";
import { useAppTheme } from "../../theme";
import type { ThemePreference } from "../../types/settings";
import { validateDirectory } from "../../api/settings";
import { testNotification } from "../../api/notification";
import { exportConfig, importConfig } from "../../api/config";
import {
  fetchSelfCheck,
  type SelfCheckItem,
  type SelfCheckStatus,
} from "../../api/service";
import DirectoryPicker from "../../components/DirectoryPicker";
import MemphisRadioGroup from "../../components/MemphisRadioGroup";
import PipelineConfigCard from "../../components/PipelineConfigCard";
import NamingRuleCard from "../../components/NamingRuleCard";
import OpenListConfigCard from "../../components/OpenListConfigCard";
import EmailConfigCard from "../../components/EmailConfigCard";
import ResetSettingsCard from "../../components/ResetSettingsCard";
import { describeError } from "../../utils/errorMap";
import { ApiError } from "../../types/error";
import { formatBytes, formatTime } from "../../utils/format";
import type { SettingsInput } from "../../types/settings";
import saveCookieTutorial from "../../assets/img/save_cookie.png";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];
const LEVEL_COLOR: Record<string, string> = {
  info: "blue",
  warning: "orange",
  error: "red",
};
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

export default function SettingsPage() {
  const { message } = App.useApp();
  const { hash } = useLocation();
  const { settings, load, save } = useSettingsStore();
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
  const [checks, setChecks] = useState<SelfCheckItem[] | null>(null);
  const [checking, setChecking] = useState(false);
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

  useEffect(() => {
    if (settings && settings.theme) {
      setPreference(settings.theme);
    }
  }, [settings, setPreference]);

  useEffect(() => {
    if (hash !== "#douyin-cookie") return;
    const frame = requestAnimationFrame(() => {
      document.getElementById("douyin-cookie")?.scrollIntoView({
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
        autoRecord: settings.autoRecord ?? true,
        confirmAfterComplete: settings.confirmAfterComplete ?? false,
        highlightBufferSeconds: settings.highlightBufferSeconds ?? 300,
        highlightEnabled: settings.highlightEnabled ?? true,
        theme: settings.theme ?? preference,
        douyinCookie: "",
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
      setDirMsg({ ok: true, text: "目录可写" });
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
    if (ffmpegCheck && ffmpegCheck.status !== "ok" && !ffmpegPromptedRef.current) {
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

  const sendTest = async () => {
    try {
      const res = await testNotification();
      const parts: string[] = [];
      if (res.desktop) parts.push("桌面通知已发送");
      else parts.push("桌面通知未开启");
      if (res.email === "sent") parts.push("邮件已发送");
      else if (res.email === "skipped") parts.push("SMTP 未配置，邮件跳过");
      else if (res.email === "failed") parts.push("邮件发送失败");
      message[res.email === "failed" ? "warning" : "success"](parts.join("；"));
    } catch (e) {
      message.error(
        e instanceof ApiError
          ? describeError(e.code, e.message)
          : "测试通知失败",
      );
    }
  };

  const copyCookieCommand = async () => {
    try {
      await navigator.clipboard.writeText("copy(document.cookie)");
      message.success("命令已复制，可粘贴到 Console 执行");
    } catch {
      message.error("复制失败，请手动复制命令");
    }
  };

  const persist = async (values: SettingsInput, clearDouyinCookie = false) => {
    const { mail, douyinCookie, ...rest } = values as SettingsInput & {
      mail?: Record<string, unknown> & {
        recipients?: string;
        password?: string;
      };
      douyinCookie?: string;
    };
    try {
      await save({
        ...rest,
        ...(clearDouyinCookie
          ? { douyinCookie: "" }
          : typeof douyinCookie === "string" && douyinCookie.length > 0
            ? { douyinCookie }
            : {}),
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
    } catch (e) {
      message.error(
        e instanceof ApiError ? describeError(e.code, e.message) : "保存失败",
      );
    }
  };

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onValuesChange = (_changed: unknown, all: SettingsInput) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void persist(all), 500);
  };

  const onExport = async () => {
    setExporting(true);
    try {
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
      message.success("配置已导出（密码/Cookie 不含值，导入后需重配）");
    } catch (e) {
      message.error(
        e instanceof ApiError ? describeError(e.code, e.message) : "导出失败",
      );
    } finally {
      setExporting(false);
    }
  };

  const onImportFile = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { config?: unknown };
      if (!parsed.config) throw new Error("bad format");
      const result = await importConfig(parsed.config as never);
      message.success(
        `导入完成：设置${result.appliedSettings ? "已应用" : "未变更"}，房间新增 ${result.importedRooms} 个、跳过 ${result.skippedRooms} 个，告警 ${result.importedAlerts} 条`,
      );
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
      </div>
      {diskDanger ? (
        <Alert
          type="warning"
          showIcon
          banner
          style={{ marginBottom: 16 }}
          message={`磁盘可用空间不足：剩余 ${formatBytes(diskFree)}（${Math.round(diskRatio * 100)}%），低于阈值可能拒绝新录制`}
        />
      ) : null}
      <Row className="lr-settings-grid" gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card
            className="lr-settings-card lr-settings-card--primary"
            title="服务设置"
            extra={
              <Space>
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
            }
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
                <Form.Item label="保存目录">
                  <Space.Compact style={{ width: "100%" }}>
                    <Form.Item
                      name="recordingDirectory"
                      noStyle
                      rules={[{ required: true, message: "必填" }]}
                    >
                      <Input />
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
                <Row gutter={16}>
                  <Col xs={24} md={8}>
                    <Form.Item
                      label="最大并发"
                      name="maxConcurrentRecordings"
                      rules={[{ required: true }]}
                    >
                      <InputNumber min={1} max={8} style={{ width: "100%" }} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={8}>
                    <Form.Item
                      label="默认清晰度"
                      name="quality"
                      extra="若直播间未提供所选画质，将按实际可用画质录制"
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
                    录制当前时刻之前的片段。
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
                <div className="lr-settings-section">
                  <Form.Item
                    label="录制完成后询问是否保留"
                    name="confirmAfterComplete"
                    valuePropName="checked"
                  >
                    <Switch />
                  </Form.Item>
                </div>
              </div>
              <div
                id="douyin-cookie"
                className="lr-settings-section lr-settings-section--credential"
              >
                <Typography.Title
                  className="lr-settings-section__title"
                  level={4}
                >
                  抖音 Cookie
                </Typography.Title>
                <Typography.Paragraph
                  className="lr-settings-section__hint"
                  type="secondary"
                >
                  抖音直播间需登录 Cookie 才能取流。需要 douyin.com 的完整
                  Cookie 字符串。
                  <br />
                  获取方式（已登录抖音时）
                  <br />
                  方式一：进入抖音任意直播间 → F12 打开开发者工具 → Console
                  控制台 → 输入{" "}
                  <span className="lr-cookie-command">
                    <Typography.Text code>
                      copy(document.cookie)
                    </Typography.Text>
                    <Tooltip title="复制命令">
                      <Button
                        aria-label="复制 Cookie 命令"
                        className="lr-inline-icon-button"
                        size="small"
                        type="text"
                        icon={<CopyOutlined />}
                        onClick={() => void copyCookieCommand()}
                      />
                    </Tooltip>
                  </span>{" "}
                  回车 → 已自动复制到剪贴板 → 粘贴到下方输入框。
                  <br />
                  方式二：
                  <span className="lr-network-help">
                    网络（Network）面板任意 live.douyin.com 请求的请求标头中复制
                    Cookie 整段。
                    <Tooltip
                      styles={{
                        root: {
                          width: "min(600px, calc(100vw - 48px))",
                          maxWidth: "none",
                        },
                      }}
                      title={
                        <img
                          style={{
                            width: "100%",
                            maxWidth: "none",
                          }}
                          alt="从网络面板保存 Cookie 的教程"
                          className="lr-cookie-tutorial-image"
                          src={saveCookieTutorial}
                        />
                      }
                      placement="top"
                    >
                      <Button
                        aria-label="查看网络面板 Cookie 教程"
                        className="lr-inline-icon-button"
                        size="small"
                        type="text"
                        icon={<QuestionCircleOutlined />}
                      />
                    </Tooltip>
                  </span>
                  <br />
                  <b>
                    Cookie
                    仅存本机钥匙串，不会显示或上传，请勿泄露他人，粘贴到下方后自动保存。
                  </b>
                </Typography.Paragraph>
                <Form.Item
                  name="douyinCookie"
                  extra={
                    settings?.douyinCookie.hasCookie
                      ? "已保存，留空则不修改"
                      : undefined
                  }
                >
                  <Input.Password
                    placeholder={
                      settings?.douyinCookie.hasCookie
                        ? "••••••"
                        : "输入抖音 Cookie（可选）"
                    }
                    autoComplete="new-password"
                  />
                </Form.Item>
                <Button
                  disabled={!settings?.douyinCookie.hasCookie}
                  onClick={() => {
                    form.setFieldValue("douyinCookie", "");
                    void persist(form.getFieldsValue() as SettingsInput, true);
                  }}
                >
                  清除已存 Cookie
                </Button>
              </div>
            </Form>
            <DirectoryPicker
              open={pickerOpen}
              initialPath={settings?.recordingDirectory}
              onClose={() => setPickerOpen(false)}
              onPick={(dir) => {
                form.setFieldValue("recordingDirectory", dir);
                message.success("目录已选择，点击保存生效");
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
          <Card className="lr-settings-card" title="后处理管线">
            <PipelineConfigCard />
          </Card>
          <Card className="lr-settings-card" title="录制文件命名规则">
            <NamingRuleCard />
          </Card>
          <Card className="lr-settings-card" title="OpenList 自动上传">
            <OpenListConfigCard />
          </Card>
          <Card className="lr-settings-card" title="邮件通知（服务商预设）">
            <EmailConfigCard />
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
            title="桌面通知"
            extra={
              <Button
                size="small"
                icon={<NotificationOutlined />}
                onClick={() => void sendTest()}
              >
                发送测试
              </Button>
            }
          >
            <Space
              className="lr-notification-settings"
              orientation="vertical"
              style={{ width: "100%" }}
              size={16}
            >
              <Row className="lr-notification-grid" gutter={[12, 12]}>
                <Col xs={24} md={12}>
                  <Space>
                    <Switch
                      checked={preferences?.desktopEnabled ?? false}
                      onChange={(v) =>
                        void saveNotifications({ desktopEnabled: v }).catch(
                          () => message.error("保存失败"),
                        )
                      }
                    />
                    <span>启用桌面通知</span>
                  </Space>
                </Col>
                <Col xs={24} md={12}>
                  <Space>
                    <Switch
                      checked={preferences?.liveStarted ?? false}
                      onChange={(v) =>
                        void saveNotifications({ liveStarted: v }).catch(() =>
                          message.error("保存失败"),
                        )
                      }
                    />
                    <span>开播提醒</span>
                  </Space>
                </Col>
                <Col xs={24} md={12}>
                  <Space>
                    <Switch
                      checked={preferences?.recordingStarted ?? false}
                      onChange={(v) =>
                        void saveNotifications({ recordingStarted: v }).catch(
                          () => message.error("保存失败"),
                        )
                      }
                    />
                    <span>录制开始</span>
                  </Space>
                </Col>
                <Col xs={24} md={12}>
                  <Space>
                    <Switch
                      checked={preferences?.recordingEnded ?? false}
                      onChange={(v) =>
                        void saveNotifications({ recordingEnded: v }).catch(
                          () => message.error("保存失败"),
                        )
                      }
                    />
                    <span>录制结束</span>
                  </Space>
                </Col>
                <Col xs={24} md={12}>
                  <Space>
                    <Switch
                      checked={preferences?.recordingFailed ?? false}
                      onChange={(v) =>
                        void saveNotifications({ recordingFailed: v }).catch(
                          () => message.error("保存失败"),
                        )
                      }
                    />
                    <span>录制失败</span>
                  </Space>
                </Col>
                <Col xs={24} md={12}>
                  <Space>
                    <Switch
                      checked={preferences?.uploadFailed ?? false}
                      onChange={(v) =>
                        void saveNotifications({ uploadFailed: v }).catch(() =>
                          message.error("保存失败"),
                        )
                      }
                    />
                    <span>上传失败</span>
                  </Space>
                </Col>
                <Col xs={24} md={12}>
                  <Space>
                    <Switch
                      checked={preferences?.diskSpaceLow ?? false}
                      onChange={(v) =>
                        void saveNotifications({ diskSpaceLow: v }).catch(() =>
                          message.error("保存失败"),
                        )
                      }
                    />
                    <span>磁盘空间不足</span>
                  </Space>
                </Col>
              </Row>
              <Form.Item
                label="通知去重窗口（分钟）"
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
              <Typography.Paragraph
                type="secondary"
                style={{ marginBottom: 0 }}
              >
                桌面通知使用系统通知能力；邮件告警需在「SMTP
                邮件告警」配置并启用。测试会发送一条示例通知。
              </Typography.Paragraph>
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
                检测环境健康：后端可达、平台 Cookie、SMTP、磁盘空间、目录可写。
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
          <Card
            className="lr-alerts-card lr-settings-card"
            title="告警"
            extra={
              <Button size="small" onClick={() => void markAllRead()}>
                全部已读
              </Button>
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
                          a.roomId && a.failureReason ? (
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
                            onClick={() => void markRead(a.id)}
                          >
                            标记已读
                          </Button>,
                        ]
                  }
                >
                  <List.Item.Meta
                    title={
                      <Space>
                        <Tag color={LEVEL_COLOR[a.level]}>{a.level}</Tag>
                        <Typography.Text>{a.message}</Typography.Text>
                      </Space>
                    }
                    description={
                      <Space orientation="vertical" size={0}>
                        <Typography.Text type="secondary">
                          {a.source} · {formatTime(a.occurredAt)}
                        </Typography.Text>
                        {a.failureReason ? (
                          <Typography.Text type="danger">
                            [{a.failureReason.code}] {a.failureReason.message}
                          </Typography.Text>
                        ) : null}
                      </Space>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
