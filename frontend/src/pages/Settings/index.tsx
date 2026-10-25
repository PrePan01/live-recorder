import { useCallback, useEffect, useRef, useState } from "react";
import { useBlocker, useLocation, useNavigate } from "react-router-dom";
import {
  App,
  Alert,
  Button,
  Input,
  Popconfirm,
  Popover,
  Space,
  Typography,
} from "antd";
import {
  DownloadOutlined,
  UploadOutlined,
  SearchOutlined,
  GlobalOutlined,
  BugOutlined,
} from "@ant-design/icons";
import { useAlertStore } from "../../stores/alertStore";
import { useRoomStore } from "../../stores/roomStore";
import { useServiceStore } from "../../stores/serviceStore";
import { useTagStore } from "../../stores/tagStore";
import { bridge } from "../../stores/bootStore";
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
import { describeError } from "../../utils/errorMap";
import { ApiError } from "../../types/error";
import { formatBytes } from "../../utils/format";
import { recentErrorDiagnostics } from "../../utils/errorDiagnostics";
import { useSettingsModelContext } from "./model/SettingsContext";
import { SettingsProvider } from "./model/SettingsProvider";
import {
  BY_ID,
  ORIGINAL_HELP,
  SECTIONS,
  searchSettings,
} from "./model/catalog";
import {
  OrdinaryRow,
  SaveStatus,
  SettingsSection,
} from "./components/SettingsPrimitives";
import {
  AppearancePanel,
  RecordingPanel,
  MonitoringPanel,
  DirectoryRow,
  NamingPanel,
  PipelinePanel,
} from "./components/SettingsPanels";
import { AuthorizationPanel } from "./components/AuthorizationPanel";
import { NotificationPanel } from "./components/NotificationPanels";
import { ConnectionPanel } from "./components/ConnectionPanel";
import ResetSettingsCard from "./components/ResetSettingsCard";
import SelfDiagnosticsCard from "./components/SelfDiagnosticsCard";
import AlertsCard from "./components/AlertsCard";

function openExternalUrl(url: string) {
  if (bridge.isDesktop)
    void bridge
      .openPath(url)
      .catch(() => window.open(url, "_blank", "noopener,noreferrer"));
  else window.open(url, "_blank", "noopener,noreferrer");
}
export default function SettingsPage() {
  return (
    <SettingsProvider>
      <SettingsContent />
    </SettingsProvider>
  );
}
function SettingsContent() {
  const model = useSettingsModelContext();
  const hasUnsaved = model.hasUnsaved;
  const { message, modal } = App.useApp();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const rooms = useRoomStore((s) => s.rooms);
  const status = useServiceStore((s) => s.status);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string>("appearance");
  const [menuOpen, setMenuOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [diagnosticsPopoverOpen, setDiagnosticsPopoverOpen] = useState(false);
  const [checks, setChecks] = useState<SelfCheckItem[] | null>(null);
  const [checking, setChecking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const prepareLeave = async (): Promise<boolean> => {
    if (await model.flush()) return true;
    return new Promise((resolve) =>
      modal.confirm({
        title: "还有未保存的修改",
        content:
          "部分配置尚未提交、输入有误或保存失败。继续离开将不保留这些内容。",
        okText: "继续离开",
        cancelText: "返回编辑",
        onOk: async () => {
          await model.discardAll();
          resolve(true);
        },
        onCancel: () => resolve(false),
      }),
    );
  };
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      currentLocation.pathname !== nextLocation.pathname &&
      hasUnsaved(),
  );
  const resolvingBlock = useRef(false);
  useEffect(() => {
    if (blocker.state !== "blocked") {
      resolvingBlock.current = false;
      return;
    }
    if (resolvingBlock.current) return;
    resolvingBlock.current = true;
    void prepareLeave()
      .then((leave) => {
        if (leave) blocker.proceed?.();
        else blocker.reset?.();
      })
      .catch(() => blocker.reset?.());
  });
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (hasUnsaved()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [hasUnsaved]);
  useEffect(() => {
    void useAlertStore.getState().fetchAlerts();
    void useServiceStore.getState().fetchStatus();
  }, []);
  const locate = useCallback((id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    let ancestor: HTMLElement | null = target;
    while (ancestor) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    // Platform authorization anchors contain an advanced manual editor.
    if (BY_ID[id]?.secret || id === "pipeline")
      target.querySelectorAll("details").forEach((d) => {
        d.open = true;
      });
    const frame = requestAnimationFrame(() => {
      target.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "start",
      });
      const control =
        target.querySelector<HTMLElement>(
          'input:not([disabled]),[role="switch"]:not([disabled]),[role="combobox"]:not([disabled]),[role="slider"]',
        ) ?? target.querySelector<HTMLElement>("button:not([disabled])");
      control?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const settingsLoaded = !!model.models.settings;
  useEffect(() => {
    if (hash) return locate(decodeURIComponent(hash.slice(1)));
  }, [hash, locate, settingsLoaded]);
  const jump = (id: string) => {
    setQuery("");
    setMenuOpen(false);
    navigate({ hash: `#${id}` });
    locate(id);
  };
  useEffect(() => {
    const root = rootRef.current;
    const scroll = root?.closest(".lr-app-content");
    if (!root || !scroll) return;
    const update = () => {
      const top =
        scroll.getBoundingClientRect().top +
        (window.innerWidth < 1100 || window.innerHeight <= 600 ? 160 : 30);
      let id: string = "appearance";
      const sections = root.querySelectorAll<HTMLElement>(
        "[data-settings-section]",
      );
      for (const i in sections) {
        if (
          sections[i].getBoundingClientRect &&
          sections[i].getBoundingClientRect().top <= top
        )
          id = sections[i].id;
      }
      setActive(id);
    };
    scroll.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      scroll.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
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
    if (!(await prepareLeave())) return;
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
    if (!(await prepareLeave())) {
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
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
      await Promise.all([
        model.reload(),
        useRoomStore.getState().fetchRooms(true),
        useTagStore.getState().load(),
      ]);
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

  const results = searchSettings(query, false, () => false);
  const panels = {
    appearance: <AppearancePanel />,
    recording: <RecordingPanel />,
    monitoring: <MonitoringPanel />,
    files: (
      <>
        <DirectoryRow id="recording-directory" />
        <NamingPanel />
      </>
    ),
    highlights: (
      <>
        <OrdinaryRow id="highlight-enabled" />
        <OrdinaryRow id="highlight-buffer" />
      </>
    ),
    pipeline: <PipelinePanel />,
    authorization: <AuthorizationPanel />,
    notifications: (
      <>
        <NotificationPanel />
      </>
    ),
    upload: <ConnectionPanel domain="openlist" />,
  };
  const diskFree = status?.disk?.freeBytes;
  const diskTotal = status?.disk?.totalBytes;
  const diskDanger =
    diskFree !== undefined &&
    diskTotal !== undefined &&
    (diskFree < 20_000_000_000 ||
      (diskTotal > 0 && diskFree / diskTotal < 0.1));
  return (
    <div ref={rootRef} className="lr-page lr-settings-page">
      <div className="lr-page-header lr-settings-header">
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            设置
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
            title="导入将应用备份中的设置并合并数据，当前设置可能被覆盖"
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
      <div className="lr-settings-toolbar">
        <Input
          aria-label="搜索设置"
          placeholder="搜索设置"
          prefix={<SearchOutlined />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          allowClear
        />
        <SaveStatus />
      </div>
      {Object.entries(model.loadErrors)
        .filter(([domain]) => domain !== "defaults")
        .map(([domain, error]) => (
          <Alert
            key={domain}
            className={domain === "openlist" ? "lr-upload-warning-alert" : undefined}
            type="error"
            showIcon
            title={error}
            action={
              <Button onClick={() => void model.reload()}>重试加载</Button>
            }
          />
        ))}
      {query.trim() ? (
        <div className="lr-settings-results" aria-label="设置搜索结果">
          {!results.length && <div>没有对应的设置</div>}
          {results.map((def) => (
            <button key={def.id} onClick={() => jump(def.id)}>
              <strong>{def.label}</strong>
              <span>{SECTIONS.find((s) => s[0] === def.section)?.[1]}</span>
              {ORIGINAL_HELP[def.id] && <small>{ORIGINAL_HELP[def.id]}</small>}
            </button>
          ))}
        </div>
      ) : null}
      {diskDanger && (
        <Alert
          type="warning"
          showIcon
          title={`磁盘可用空间不足：剩余 ${formatBytes(diskFree!)}，可能无法开启新的录制。`}
        />
      )}
      <div className="lr-settings-layout">
        <nav
          className={`lr-settings-nav${menuOpen ? " is-open" : ""}`}
          aria-label="设置目录"
        >
          <Button
            className="lr-settings-nav__toggle"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {SECTIONS.find((s) => s[0] === active)?.[1]}
          </Button>
          <div className="lr-settings-nav__items">
            {SECTIONS.map(([id, title]) => (
              <div key={id}>
                <a
                  href={`#${id}`}
                  aria-current={active === id ? "location" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    jump(id);
                  }}
                >
                  {title}
                </a>
              </div>
            ))}
          </div>
        </nav>
        <div className="lr-settings-content">
          {SECTIONS.map(([id, title]) => (
            <SettingsSection key={id} id={id} title={title}>
              {id !== "maintenance" ? (
                panels[id]
              ) : (
                <>
                  <div className="lr-settings-runtime">
                    <SelfDiagnosticsCard
                      checks={checks}
                      checking={checking}
                      runSelfCheck={runSelfCheck}
                      rooms={rooms}
                    />
                    <AlertsCard />
                  </div>
                  <div className="lr-settings-danger">
                    <ResetSettingsCard
                      onExport={onExport}
                      exporting={exporting}
                      beforeReset={prepareLeave}
                    />
                  </div>
                </>
              )}
            </SettingsSection>
          ))}
        </div>
      </div>
      <footer className="lr-settings-footer" aria-label="相关链接">
        <Space size={16} wrap>
          <Typography.Link
            onClick={() => openExternalUrl("https://live-rec.bspartner.top/")}
          >
            <GlobalOutlined /> 官网
          </Typography.Link>
          <Space className="lr-settings-support-links" size={4}>
            <BugOutlined />
            <Typography.Link
              onClick={() =>
                openExternalUrl(
                  "https://github.com/PrePan01/live-recorder/issues",
                )
              }
            >
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
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onImportFile(file);
        }}
      />
    </div>
  );
}
