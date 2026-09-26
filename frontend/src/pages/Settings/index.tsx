import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  App,
  Alert,
  Button,
  Card,
  Col,
  Form,
  Modal,
  Popover,
  Popconfirm,
  Row,
  Space,
  Typography,
} from "antd";
import {
  DownloadOutlined,
  UploadOutlined,
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
import { validateDirectory } from "../../api/settings";
import {
  exportConfig,
  exportConfigToFile,
  importConfig,
} from "../../api/config";
import {
  downloadDiagnostics,
  exportDiagnosticsToFile,
} from "../../api/diagnostics";
import { fetchSelfCheck, type SelfCheckItem } from "../../api/service";
import PipelineConfigCard from "../../components/PipelineConfigCard";
import NamingRuleCard from "../../components/NamingRuleCard";
import OpenListConfigCard from "../../components/OpenListConfigCard";
import ResetSettingsCard from "../../components/ResetSettingsCard";
import ServiceSettingsCard from "./components/ServiceSettingsCard";
import NotificationSettingsCard from "./components/NotificationSettingsCard";
import SelfDiagnosticsCard from "./components/SelfDiagnosticsCard";
import AlertsCard from "./components/AlertsCard";
import { describeError } from "../../utils/errorMap";
import { ApiError } from "../../types/error";
import { formatBytes } from "../../utils/format";
import type { SettingsInput } from "../../types/settings";
import { recentErrorDiagnostics } from "../../utils/errorDiagnostics";

const OFFICIAL_SITE_URL = "https://live-rec.bspartner.top/";
const ISSUE_URL = "https://github.com/PrePan01/live-recorder/issues";

function openExternalUrl(url: string): void {
  if (bridge.isDesktop) {
    void bridge.openPath(url).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export default function SettingsPage() {
  const { message } = App.useApp();
  const { hash } = useLocation();
  const { settings, load, save } = useSettingsStore();

  // 无障碍：antd 不把 aria-label 透传到滑杆手柄（role=slider 需自带名字）——挂载后补写一次。
  useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      const handle = document.querySelector(".ant-slider-handle");
      if (handle) {
        if (!handle.hasAttribute("aria-label")) {
          handle.setAttribute("aria-label", "全局录制按钮大小");
        }
        clearInterval(timer);
      } else if (++tries > 20) {
        clearInterval(timer);
      }
    }, 300);
    return () => clearInterval(timer);
  }, []);
  const rooms = useRoomStore((s) => s.rooms);
  const showGlobalSearch = useAppearanceStore((s) => s.showGlobalSearch);
  const setShowGlobalSearch = useAppearanceStore((s) => s.setShowGlobalSearch);
  const { preference, setPreference } = useAppTheme();
  const { load: loadNotifications } = useNotificationStore();
  const { fetchAlerts } = useAlertStore();
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
          <Popconfirm
            title="导入将应用备份中的设置并合并房间/告警等数据，当前设置可能被覆盖。选择备份文件？"
            okText="选择文件"
            cancelText="取消"
            onConfirm={() => fileRef.current?.click()}
          >
            <Button size="small" icon={<UploadOutlined />} loading={importing}>
              导入配置
            </Button>
          </Popconfirm>
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
          <ServiceSettingsCard
            form={form}
            settings={settings}
            preference={preference}
            showGlobalSearch={showGlobalSearch}
            setShowGlobalSearch={setShowGlobalSearch}
            onValuesChange={onValuesChange}
            checkDir={checkDir}
            dirMsg={dirMsg}
            pickerOpen={pickerOpen}
            setPickerOpen={setPickerOpen}
            load={load}
            persist={persist}
            showFfmpegWarning={showFfmpegWarning}
            ffmpegInstallCmd={ffmpegInstallCmd}
            windowWindows={windowWindows}
            fileRef={fileRef}
            onImportFile={onImportFile}
            setPreference={setPreference}
            debounceRef={debounceRef}
          />

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
          <NotificationSettingsCard />
          <SelfDiagnosticsCard
            checks={checks}
            checking={checking}
            runSelfCheck={runSelfCheck}
            rooms={rooms}
          />

          <AlertsCard />
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
