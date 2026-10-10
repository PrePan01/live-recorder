import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Popover,
  Progress,
  Space,
  Tag,
  Typography,
  List,
} from "antd";
import { CloudServerOutlined, WarningOutlined } from "@ant-design/icons";
import { useLocation, useNavigate } from "react-router-dom";
import { useServiceStore } from "../stores/serviceStore";
import { useAppearanceStore } from "../stores/appearanceStore";
import { useAlertStore, isAlertRead, selectUnreadCount } from "../stores/alertStore";
import { useRoomStore } from "../stores/roomStore";
import { formatBytes, formatRelative } from "../utils/format";
import { diskDisplay } from "../utils/diskDisplay";
import { alertSourceText } from "../utils/alertText";
import GlobalSearch from "./GlobalSearch";
import { TaskProgressEntry } from "./TaskProgressEntry";
import { fetchRecordingDownloadSpeed } from "../api/service";
import { EndpointResolver } from "../api/endpoint";
import { stopAllRecordings } from "../api/rooms";

function RecordingDownloadSpeed() {
  const sseConnected = useServiceStore((s) => s.sseConnected);
  const [downloadSpeed, setDownloadSpeed] = useState(0);

  useEffect(() => {
    if (!sseConnected) return;
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      const endpoint = EndpointResolver.base;
      try {
        const speed = await fetchRecordingDownloadSpeed();
        if (!disposed && endpoint === EndpointResolver.base) setDownloadSpeed(speed);
      } catch {
        if (!disposed) setDownloadSpeed(0);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    const onVisibilityChange = () => void refresh();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [sseConnected]);

  const speed = sseConnected ? downloadSpeed : 0;
  return (
    <span style={{ marginLeft: 16, fontVariantNumeric: "tabular-nums" }} title="录制任务总下载速度">
      ↓ {speed > 0 ? formatBytes(speed) : "0 B"}/s
    </span>
  );
}

function RecordingStatusTag({ count }: { count: number | undefined }) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = (count ?? 0) > 0;

  const stopAll = async () => {
    if (stopping) return;
    setStopping(true);
    setError(null);
    try {
      const result = await stopAllRecordings();
      if (result.failed.length) {
        setError(`${result.failed.length} 个直播间停止失败，请重试。`);
      } else {
        setOpen(false);
      }
    } catch {
      setError("停止录制失败，请重试。");
    } finally {
      setStopping(false);
      void useServiceStore.getState().fetchStatus();
      void useRoomStore.getState().fetchRooms(true).catch(() => undefined);
    }
  };

  return (
    <Popover
      trigger={active ? "click" : []}
      placement="topLeft"
      open={active && open}
      onOpenChange={(next) => {
        if (stopping) return;
        setOpen(active && next);
        setError(null);
      }}
      content={
        <div style={{ minWidth: 180 }}>
          <div>是否停止全部录制？</div>
          {error && <div style={{ marginTop: 8 }}><Typography.Text type="danger">{error}</Typography.Text></div>}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
            <Button size="small" disabled={stopping} onClick={() => setOpen(false)}>取消</Button>
            <Button size="small" type="primary" danger loading={stopping} onClick={() => void stopAll()}>确认</Button>
          </div>
        </div>
      }
    >
      <Tag
        color={active ? "red" : "default"}
        style={{ cursor: active ? "pointer" : "default" }}
        role={active ? "button" : undefined}
        tabIndex={active ? 0 : undefined}
        aria-expanded={active ? open : undefined}
        onKeyDown={(event) => {
          if (active && !stopping && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            setOpen((value) => !value);
            setError(null);
          }
        }}
      >
        {count !== undefined ? `录制中 ${count}` : "录制中 -"}
        {active && <RecordingDownloadSpeed />}
      </Tag>
    </Popover>
  );
}

export default function StatusBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const status = useServiceStore((s) => s.status);
  const showGlobalSearch = useAppearanceStore((s) => s.showGlobalSearch);
  const sseConnected = useServiceStore((s) => s.sseConnected);
  const alerts = useAlertStore((s) => s.alerts);
  const rooms = useRoomStore((s) => s.rooms);
  const unread = useAlertStore(selectUnreadCount);
  const fetchAlerts = useAlertStore((s) => s.fetchAlerts);
  const markRead = useAlertStore((s) => s.markRead);
  const markAllRead = useAlertStore((s) => s.markAllRead);
  const retryFailure = useAlertStore((s) => s.retryFailure);
  const retryingId = useAlertStore((s) => s.retryingId);

  useEffect(() => {
    void fetchAlerts();
  }, [fetchAlerts]);

  useEffect(() => {
    const t = setInterval(() => {
      // 后台暂停界面状态轮询，回前台由 5 分钟下一拍（或 SSE patch）补上；
      // 状态栏为低频展示面，不做立即补刷。
      if (document.visibilityState !== "visible") return;
      void useServiceStore.getState().fetchStatus();
    }, 300_000);
    return () => clearInterval(t);
  }, []);

  const online = status?.state === "running" && sseConnected;
  const free = status?.disk?.freeBytes ?? 0;
  const total = status?.disk?.totalBytes ?? 1;
  const freeRatio = total > 0 ? free / total : 0;
  const disk = diskDisplay(status?.directoryAvailable, free, total);
  const isSettingsPage = pathname.startsWith("/settings");

  return (
    <div
      className="lr-statusbar"
      style={{
        display: "flex",
        alignItems: "center",
        padding: "0 clamp(12px, 2vw, 24px)",
        background: "var(--lr-surface)",
        borderBottom: "1px solid var(--lr-border)",
        gap: 20,
        height: 36,
        minWidth: 0,
      }}
    >
      <Space>
        <CloudServerOutlined
          style={{ color: online ? "#52c41a" : "#ff4d4f" }}
        />
        <Typography.Text strong>
          {status?.state === "restarting"
            ? "服务重启中"
            : online
              ? "服务正常"
              : "服务已断开"}
        </Typography.Text>
        <RecordingStatusTag key={(status?.activeRecordings ?? 0) > 0 ? "active" : "idle"} count={status?.activeRecordings} />
      </Space>
      {showGlobalSearch ? (
        <div className="lr-statusbar__search" style={{ marginLeft: "auto" }}>
          <GlobalSearch />
        </div>
      ) : null}
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          marginLeft: "auto",
        }}
      >
        <div className="lr-statusbar__disk">
          <Typography.Text type={disk.danger ? "danger" : "secondary"}>
            {disk.text}
          </Typography.Text>
          {disk.showProgress ? (
            <Progress
              aria-label="磁盘可用空间"
              percent={Math.round(freeRatio * 100)}
              status={disk.spaceDanger ? "exception" : "normal"}
              size="small"
              style={{ width: 120 }}
              format={() => formatBytes(free)}
            />
          ) : null}
          {disk.showCleanup ? <Tag color="red">需清理</Tag> : null}
        </div>
        <Popover
          trigger="click"
          placement="bottomRight"
          content={
            <List
              size="small"
              style={{ width: 360, maxHeight: 400, overflow: "auto" }}
              header={
                <Space>
                  <Typography.Text strong>告警</Typography.Text>
                  <Button
                    size="small"
                    disabled={isSettingsPage}
                    onClick={() => {
                      void markAllRead().catch(() => undefined);
                    }}
                  >
                    全部已读
                  </Button>
                  {!isSettingsPage && (
                    <Button
                      size="small"
                      type="link"
                      onClick={() => navigate("/settings")}
                    >
                      查看全部
                    </Button>
                  )}
                </Space>
              }
              dataSource={alerts.slice(0, 8)}
              locale={{ emptyText: "暂无告警" }}
              renderItem={(a) => (
                <List.Item
                  actions={
                    isAlertRead(a)
                      ? []
                      : [
                          a.roomId && a.errorCode ? (
                            <Button
                              key="retry"
                              size="small"
                              type="link"
                              loading={retryingId === a.id}
                              onClick={() =>
                                void retryFailure(a).catch(() => undefined)
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
                            已读
                          </Button>,
                        ]
                  }
                >
                  <List.Item.Meta
                    title={a.message}
                    description={
                      <span>
                        {a.roomId ? `直播间：${rooms.find((room) => room.id === a.roomId)?.displayName || a.roomId} · ` : ''}{alertSourceText(a.source)} ·{" "}
                        {formatRelative(a.occurredAt)}
                      </span>
                    }
                  />
                </List.Item>
              )}
            />
          }
        >
          <Badge count={unread} size="small" offset={[-4, 4]}>
            <Button
              type="text"
              aria-label="告警"
              icon={<WarningOutlined style={{ fontSize: 18 }} />}
            />
          </Badge>
        </Popover>
        <TaskProgressEntry />
      </div>
    </div>
  );
}
