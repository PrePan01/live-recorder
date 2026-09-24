import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Popconfirm,
  Row,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  AppstoreOutlined,
  EyeOutlined,
  LinkOutlined,
  ReloadOutlined,
  StarFilled,
  StarOutlined,
  StopOutlined,
  UnorderedListOutlined,
  VideoCameraAddOutlined,
} from "@ant-design/icons";
import { bridge } from "../../stores/bootStore";
import { useRoomStore } from "../../stores/roomStore";
import { usePreviewStore } from "../../stores/previewStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useServiceStore } from "../../stores/serviceStore";
import { isDirectoryUnavailable } from "../../utils/diskDisplay";
import {
  checkEnabledRooms,
  fetchRoomInsights,
  type RoomInsight,
} from "../../api/rooms";
import {
  fetchBilibiliCookieStatus,
  type BilibiliCookieStatus,
} from "../../api/settings";
import { PlatformIcon, PlatformLogoTag } from "../../components/PlatformLogo";
import MemphisRadioGroup from "../../components/MemphisRadioGroup";
import { MonitorStateTag } from "../../components/StatusTags";
import { formatRelative } from "../../utils/format";
import { credentialStatus } from "../../utils/credentialStatus";
import RoomStats from "../../components/RoomStats";
import RoomHealth from "../../components/RoomHealth";
import LiveStatusTag from "../../components/LiveStatusTag";
import LivePredictionBadge from "../../components/LivePredictionBadge";
import { ApiError } from "../../types/error";
import { describeError } from "../../utils/errorMap";
import type { Platform, Room } from "../../types/room";
import type { Quality } from "../../types/settings";
import {
  RoomSortableProvider,
  SortableRoomTableRow,
  useRoomSortableItem,
} from "../../components/RoomSortable";

let startupLiveCheck: Promise<void> | null = null;

function triggerStartupLiveCheck(): Promise<void> {
  if (!startupLiveCheck) {
    const request = checkEnabledRooms().then(() => undefined);
    startupLiveCheck = request;
    void request.catch(() => {
      if (startupLiveCheck === request) startupLiveCheck = null;
    });
  }
  return startupLiveCheck;
}

function SortableRoomCardItem({
  roomId,
  children,
}: {
  roomId: string;
  children: React.ReactNode;
}) {
  const sortable = useRoomSortableItem(roomId, "card");
  return (
    <Col
      xs={24}
      sm={12}
      lg={8}
      xxl={6}
      ref={sortable.setNodeRef}
      style={sortable.style}
      className={`lr-sortable-card ${sortable.isDragging ? "lr-sort-dragging" : ""}`}
      {...sortable.attributes}
      {...sortable.listeners}
    >
      {children}
    </Col>
  );
}

const EXPANDED_CARD_ACTION_WIDTH = 96;
const compactActionTooltipStyles = {
  container: {
    display: "flex",
    justifyContent: "center",
    textAlign: "center" as const,
  },
};

const QUALITY_ORDER = ["original", "1080p", "720p", "360p"];
const qualityRank = (q: string) => QUALITY_ORDER.indexOf(q);
const qualityLabel = (q: string) => (q === "original" ? "原画" : q);

/** 平台给出的可录清晰度中最高的一档；空数组表示平台没提供，不展示。 */
function bestQuality(qualities: string[]): string | null {
  let best: string | null = null;
  for (const q of qualities) {
    const rank = qualityRank(q);
    if (rank < 0) continue;
    if (best === null || rank < qualityRank(best)) best = q;
  }
  return best;
}

function useCompactRoomCardActions(actionCount: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const expandedWidth =
    actionCount * EXPANDED_CARD_ACTION_WIDTH + (actionCount - 1) * 2;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      setCompact(element.clientWidth < expandedWidth);
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [expandedWidth]);

  return { ref, compact };
}

const RoomCard = memo(function RoomCard({
  room,
  onWatch,
  onCheck,
  onStop,
  onRecord,
  onFavorite,
  onEnableFloating,
  layout,
  actingAction,
  acting,
  recentlyStopped,
  autoRecordEnabled,
  insight,
  qualityPreference,
  bilibiliAuthorized,
  floatingEnabled,
  floatingReady,
}: {
  room: Room;
  onWatch: (r: Room) => void;
  onCheck: (r: Room) => void;
  onStop: (r: Room) => void;
  onRecord: (r: Room) => void;
  onFavorite: (r: Room, favorited: boolean) => void;
  onEnableFloating: (r: Room) => void;
  layout: "card" | "list";
  actingAction?: "check" | "record" | "stop";
  acting?: boolean;
  recentlyStopped?: boolean;
  autoRecordEnabled: boolean;
  insight?: RoomInsight;
  qualityPreference: Quality | null;
  bilibiliAuthorized: boolean;
  floatingEnabled: boolean;
  floatingReady: boolean;
}) {
  const navigate = useNavigate();
  const recording =
    room.monitorState === "recording" || room.monitorState === "reconnecting";
  const onAir = room.lastLiveStatus === "live";
  const bestAvailable = bestQuality(room.availableQualities);
  const qualityShortfall =
    room.platform === "bilibili" &&
    bestAvailable !== null &&
    qualityPreference !== null &&
    qualityRank(bestAvailable) > qualityRank(qualityPreference);
  const offerBilibiliLogin = qualityShortfall && !bilibiliAuthorized;
  const actionCount = onAir || recording ? 4 : 2;
  const { ref, compact } = useCompactRoomCardActions(actionCount);
  return (
    <div ref={ref} className="lr-room-card__container">
      <Card
        className={`lr-room-card ${onAir ? "lr-room-card--live" : "lr-room-card--offline"} ${layout === "list" ? "lr-room-card--list" : ""}`}
        styles={{ body: { padding: 14 } }}
        title={
          <Space className="lr-room-card__title-row" align="center">
            <PlatformLogoTag platform={room.platform} />
            <Tooltip title={room.displayName}>
              <Typography.Text className="lr-room-card__title" strong ellipsis>
                {room.displayName}
              </Typography.Text>
            </Tooltip>
            {room.titleFallbackUsed ? (
              <Tooltip title="显示名为回退/占位来源，平台接口未返回正式标题">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  （回退标题）
                </Typography.Text>
              </Tooltip>
            ) : null}
          </Space>
        }
        extra={
          <Space size={0}>
            {onAir ? (
              <Tooltip
                title={
                  floatingReady
                    ? `${floatingEnabled ? "关闭" : "启用"}录制按钮`
                    : "正在加载录制按钮设置…"
                }
              >
                <Button
                  type="text"
                  aria-label="启用录制按钮"
                  className={`lr-floating-recorder-toggle ${floatingEnabled ? "lr-floating-recorder-toggle--enabled" : ""}`}
                  disabled={!floatingReady}
                  onClick={() => onEnableFloating(room)}
                >
                  <span
                    className="lr-floating-recorder-toggle__ring"
                    aria-hidden="true"
                  >
                    <span />
                  </span>
                </Button>
              </Tooltip>
            ) : null}
            <Button
              type="text"
              size="small"
              aria-label="收藏"
              icon={
                room.favorited ? (
                  <StarFilled style={{ color: "#faad14" }} />
                ) : (
                  <StarOutlined />
                )
              }
              onClick={() => onFavorite(room, !room.favorited)}
            />
          </Space>
        }
      >
        <Space className="lr-room-card__status" style={{ marginBottom: 10 }}>
          <LiveStatusTag
            status={room.lastLiveStatus}
            streamTitle={room.currentStreamTitle}
          />
          {autoRecordEnabled ? (
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              自动录
            </Tag>
          ) : null}
          <LivePredictionBadge insight={insight} hidden={onAir || recording} />
          {room.tags.length > 0 ? (
            <Space size={[4, 4]} wrap>
              {room.tags.map((t) => (
                <Tag key={t.id} color={t.color} style={{ marginInlineEnd: 0 }}>
                  {t.name}
                </Tag>
              ))}
            </Space>
          ) : null}
        </Space>
        <div
          className="lr-room-card__stats"
          style={{ marginBottom: 10, width: "100%" }}
        >
          <RoomStats
            lastCheckedAt={room.lastCheckedAt}
            startedAt={
              recording && room.activeRecording
                ? room.activeRecording.startedAt
                : null
            }
            state={room.monitorState}
          />
        </div>
        <div className="lr-room-card__health" style={{ marginBottom: 10 }}>
          <RoomHealth insight={insight} />
        </div>
        {qualityShortfall && bestAvailable ? (
          <Typography.Paragraph
            className="lr-room-card__quality"
            type="warning"
            style={{ marginBottom: 10, marginTop: 0, fontSize: 12 }}
          >
            {offerBilibiliLogin ? (
              <Typography.Link
                className="lr-room-card__error-link"
                underline
                style={{ fontSize: "inherit" }}
                onClick={() => navigate("/settings#bilibili-cookie")}
              >
                登录B站
              </Typography.Link>
            ) : null}
            前最高只能观看、录制 {qualityLabel(bestAvailable)}
          </Typography.Paragraph>
        ) : null}
        {room.lastError ? (
          <Typography.Paragraph
            className="lr-room-card__error"
            type="danger"
            style={{ marginBottom: 10, marginTop: 0 }}
          >
            {room.platform === "douyin" &&
            (room.lastError.code === "PLATFORM_ACCESS_RESTRICTED" ||
              room.lastError.code === "DOUYIN_COOKIE_EXPIRED") ? (
              <>
                平台访问受限，请检查{" "}
                <Typography.Link
                  className="lr-room-card__error-link"
                  underline
                  onClick={() => navigate("/settings#douyin-cookie")}
                >
                  抖音授权
                </Typography.Link>
              </>
            ) : room.platform === "bilibili" &&
              room.lastError.code === "PLATFORM_ACCESS_RESTRICTED" ? (
              <>
                平台访问受限，请检查{" "}
                <Typography.Link
                  className="lr-room-card__error-link"
                  underline
                  onClick={() => navigate("/settings#bilibili-cookie")}
                >
                  B站授权
                </Typography.Link>
              </>
            ) : (
              room.lastError.message
            )}
          </Typography.Paragraph>
        ) : null}
        <div
          className={`lr-room-card__actions ${compact ? "lr-room-card__actions--compact" : ""}`}
        >
          <Tooltip
            title={compact ? "检测" : undefined}
            styles={compactActionTooltipStyles}
          >
            <Button
              size="middle"
              aria-label="检测"
              icon={<ReloadOutlined />}
              loading={acting && actingAction === "check"}
              disabled={acting || room.monitorState === "checking" || recording}
              onClick={() => onCheck(room)}
            >
              <span className="lr-room-card__action-label">检测</span>
            </Button>
          </Tooltip>
          <Tooltip
            title={compact ? "打开直播间" : undefined}
            styles={compactActionTooltipStyles}
          >
            <Button
              size="middle"
              aria-label="打开直播间"
              icon={<LinkOutlined />}
              href={room.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="lr-room-card__action-label">直播间</span>
            </Button>
          </Tooltip>
          {onAir || recording ? (
            <Tooltip
              title={compact ? "观看" : undefined}
              styles={compactActionTooltipStyles}
            >
              <Button
                size="middle"
                type={recording ? "primary" : "default"}
                aria-label="观看"
                icon={<EyeOutlined />}
                onClick={() => onWatch(room)}
              >
                <span className="lr-room-card__action-label">观看</span>
              </Button>
            </Tooltip>
          ) : null}
          {room.monitorState === "recording" ||
          room.monitorState === "reconnecting" ? (
            <Popconfirm
              title="确定停止当前录制？"
              onConfirm={() => onStop(room)}
            >
              <Tooltip
                title={compact ? "停止录制" : undefined}
                styles={compactActionTooltipStyles}
              >
                <Button
                  size="middle"
                  danger
                  aria-label="停止录制"
                  loading={acting && actingAction === "stop"}
                  icon={<StopOutlined />}
                >
                  <span className="lr-room-card__action-label">停止</span>
                </Button>
              </Tooltip>
            </Popconfirm>
          ) : onAir ? (
            <Tooltip
              title={compact ? "录制" : undefined}
              styles={compactActionTooltipStyles}
            >
              <Button
                size="middle"
                type="primary"
                aria-label="录制"
                icon={<VideoCameraAddOutlined />}
                loading={acting && actingAction === "record"}
                disabled={acting || recentlyStopped || !onAir}
                onClick={() => onRecord(room)}
              >
                <span className="lr-room-card__action-label">录制</span>
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </Card>
    </div>
  );
});

export default function Monitor() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const {
    rooms,
    loading,
    actingRoomId,
    actingAction,
    fetchRooms,
    checkRoomNow,
    startRoomRecording,
    stopRoomRecording,
    favoriteRoom,
    reorderRooms,
    reorderBusy,
  } = useRoomStore();
  const openPreviewModal = usePreviewStore((s) => s.openModal);
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.load);
  // 保存目录可用性：进页检测一次 + 30s 轮询。
  const serviceStatus = useServiceStore((s) => s.status);
  const fetchServiceStatus = useServiceStore((s) => s.fetchStatus);
  const directoryUnavailable = isDirectoryUnavailable(
    serviceStatus?.directoryAvailable,
  );
  // B站登录态：整页只探测一次，结论给所有 B站卡片共用（不按房间重复请求）。
  const [bilibiliCookieStatus, setBilibiliCookieStatus] =
    useState<BilibiliCookieStatus | null>(null);
  const [view, setView] = useState<"卡片" | "列表">(() =>
    localStorage.getItem("lr-monitor-view") === "列表" ? "列表" : "卡片",
  );
  const [filter, setFilter] = useState<"全部" | "开播中" | "录制中" | "收藏">(
    "全部",
  );
  const [platformFilter, setPlatformFilter] = useState<"全部" | Platform>(
    "全部",
  );
  const [keyword, setKeyword] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [recentStop, setRecentStop] = useState<Record<string, number>>({});
  const [insights, setInsights] = useState<Record<string, RoomInsight>>({});
  const [floatingRoomId, setFloatingRoomId] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge.isDesktop) return;
    void bridge
      .getFloatingRecorderTarget()
      .then(setFloatingRoomId)
      .catch(() => undefined);
    return bridge.onFloatingRecorderTarget(setFloatingRoomId);
  }, []);

  useEffect(() => {
    const ids = Object.keys(recentStop);
    if (ids.length === 0) return;
    const timer = setTimeout(() => {
      setRecentStop((prev) => {
        const now = Date.now();
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          if (now - next[id] >= 1200) delete next[id];
        }
        return next;
      });
    }, 1200);
    return () => clearTimeout(timer);
  }, [recentStop]);

  const onStopRoom = useCallback(
    (room: Room) => {
      setRecentStop((prev) => ({ ...prev, [room.id]: Date.now() }));
      void stopRoomRecording(room.id).catch(() =>
        message.error("停止请求失败"),
      );
    },
    [message, stopRoomRecording],
  );

  useEffect(() => {
    void fetchRooms().catch(() => message.error("房间列表加载失败"));
  }, [fetchRooms, message]);

  useEffect(() => {
    void fetchServiceStatus();
    const timer = setInterval(() => void fetchServiceStatus(), 30_000);
    return () => clearInterval(timer);
  }, [fetchServiceStatus]);

  useEffect(() => {
    let disposed = false;
    void triggerStartupLiveCheck()
      .then(() => (disposed ? undefined : fetchRooms(true)))
      .catch(() => {
        if (!disposed) message.error("启动时开播检测失败，请稍后重试");
      });
    return () => {
      disposed = true;
    };
  }, [fetchRooms, message]);

  useEffect(() => {
    const ids = rooms.filter((room) => room.enabled).map((room) => room.id);
    if (ids.length === 0) {
      setInsights({});
      return;
    }
    let disposed = false;
    // Coalesce room events from the same polling batch into one insight request.
    const timer = setTimeout(() => {
      void fetchRoomInsights(ids)
        .then((next) => {
          if (!disposed) setInsights(next);
        })
        .catch(() => {
          if (!disposed) setInsights({});
        });
    }, 250);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [rooms]);

  useEffect(() => {
    if (!settings) void loadSettings();
  }, [settings, loadSettings]);

  useEffect(() => {
    let disposed = false;
    void fetchBilibiliCookieStatus()
      .then((status) => {
        if (!disposed) setBilibiliCookieStatus(status);
      })
      .catch(() => {
        if (!disposed) setBilibiliCookieStatus("unknown");
      });
    return () => {
      disposed = true;
    };
  }, []);

  const bilibiliAuthorized =
    credentialStatus(
      bilibiliCookieStatus,
      settings?.bilibiliCookie.hasCookie ?? false,
    ) === "authorized";

  const monitorRooms = rooms
    .filter((r) => r.enabled)
    .filter((r) => platformFilter === "全部" || r.platform === platformFilter)
    .filter((r) => {
      if (filter === "开播中") return r.lastLiveStatus === "live";
      if (filter === "录制中")
        return (
          r.monitorState === "recording" || r.monitorState === "reconnecting"
        );
      if (filter === "收藏") return r.favorited;
      return true;
    })
    .filter((r) => {
      const kw = keyword.trim().toLowerCase();
      return (
        !kw ||
        r.displayName.toLowerCase().includes(kw) ||
        r.url.toLowerCase().includes(kw)
      );
    });

  const commitRoomOrder = useCallback(
    async (roomIds: string[]) => {
      try {
        await reorderRooms(roomIds);
      } catch {
        message.error("排序保存失败，已恢复服务端顺序");
      }
    },
    [message, reorderRooms],
  );

  const platformRooms = rooms.filter(
    (r) =>
      r.enabled && (platformFilter === "全部" || r.platform === platformFilter),
  );
  const liveCount = platformRooms.filter(
    (r) => r.lastLiveStatus === "live",
  ).length;
  const recordingCount = platformRooms.filter(
    (r) => r.monitorState === "recording" || r.monitorState === "reconnecting",
  ).length;

  const handleWatch = useCallback(
    (room: Room) => {
      if (!openPreviewModal({ roomId: room.id })) {
        message.warning(describeError("PREVIEW_LIMIT_REACHED"));
        return;
      }
    },
    [message, openPreviewModal],
  );

  const onCheckRoom = useCallback(
    (room: Room) => {
      void checkRoomNow(room.id).catch((e) =>
        message.error(
          e instanceof ApiError
            ? describeError(e.code, e.message)
            : "检测请求失败",
        ),
      );
    },
    [checkRoomNow, message],
  );

  const onRecordRoom = useCallback(
    (room: Room) => {
      void startRoomRecording(room.id).catch((e) =>
        message.error(
          e instanceof ApiError
            ? describeError(e.code, e.message)
            : "录制请求失败",
        ),
      );
    },
    [message, startRoomRecording],
  );

  const onFavoriteRoom = useCallback(
    (room: Room, favorited: boolean) => {
      void favoriteRoom(room.id, favorited).catch((e) =>
        message.error(
          e instanceof ApiError
            ? describeError(e.code, e.message)
            : "收藏操作失败",
        ),
      );
    },
    [favoriteRoom, message],
  );

  const onEnableFloating = useCallback(
    (room: Room) => {
      if (!bridge.isDesktop) {
        message.info("全局录制按钮仅限桌面客户端");
        return;
      }
      const currentSettings = useSettingsStore.getState().settings;
      if (!currentSettings) {
        message.info("正在加载录制按钮设置，请稍后重试");
        return;
      }
      if (floatingRoomId === room.id) {
        void bridge
          .hideFloatingRecorder(true)
          .then(() => setFloatingRoomId(null))
          .catch(() => message.error("无法隐藏全局录制按钮"));
        return;
      }
      void bridge
        .showFloatingRecorder(
          room.id,
          currentSettings.floatingRecorderSize ?? 36,
        )
        .then(() => setFloatingRoomId(room.id))
        .catch(() => message.error("无法启用全局录制按钮"));
    },
    [floatingRoomId, message],
  );

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await checkEnabledRooms();
      await fetchRooms(true);
    } catch (error) {
      message.error(
        error instanceof ApiError
          ? describeError(error.code, error.message)
          : "刷新或开播检测失败，请稍后重试",
      );
    } finally {
      setRefreshing(false);
    }
  };

  const listColumns: ColumnsType<Room> = [
    {
      title: "收藏",
      dataIndex: "favorited",
      width: 60,
      render: (v: boolean, room) => (
        <Button
          type="text"
          size="small"
          icon={
            v ? <StarFilled style={{ color: "#faad14" }} /> : <StarOutlined />
          }
          onClick={() =>
            void favoriteRoom(room.id, !v).catch((e) =>
              message.error(
                e instanceof ApiError
                  ? describeError(e.code, e.message)
                  : "操作失败",
              ),
            )
          }
        />
      ),
    },
    {
      title: "平台",
      dataIndex: "platform",
      width: 80,
      render: (p) => <PlatformLogoTag platform={p} />,
    },
    {
      title: "显示名",
      dataIndex: "displayName",
      ellipsis: true,
      render: (v: string, room) => (
        <Space size={4}>
          <span>{v}</span>
          {room.titleFallbackUsed ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              （回退）
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: "标签",
      dataIndex: "tags",
      width: 160,
      render: (ts: Room["tags"]) =>
        ts.length === 0 ? (
          "-"
        ) : (
          <Space size={[4, 4]} wrap>
            {ts.map((t) => (
              <Tag key={t.id} color={t.color} style={{ marginInlineEnd: 0 }}>
                {t.name}
              </Tag>
            ))}
          </Space>
        ),
    },
    {
      title: "直播状态",
      dataIndex: "lastLiveStatus",
      width: 100,
      render: (s) => <LiveStatusTag status={s} />,
    },
    {
      title: "监控状态",
      dataIndex: "monitorState",
      width: 100,
      render: (s) => <MonitorStateTag state={s} />,
    },
    {
      title: "最近检测",
      dataIndex: "lastCheckedAt",
      width: 110,
      render: (t) => formatRelative(t),
    },
    {
      title: "操作",
      width: 300,
      fixed: "right" as const,
      render: (_, room) => {
        const recording =
          room.monitorState === "recording" ||
          room.monitorState === "reconnecting";
        const onAir = room.lastLiveStatus === "live";
        const acting = actingRoomId === room.id;
        return (
          <Space size={0} wrap>
            <Button
              size="small"
              type="link"
              icon={<ReloadOutlined />}
              loading={acting && actingAction === "check"}
              disabled={acting || room.monitorState === "checking" || recording}
              onClick={() =>
                void checkRoomNow(room.id).catch((e) =>
                  message.error(
                    e instanceof ApiError
                      ? describeError(e.code, e.message)
                      : "检测失败",
                  ),
                )
              }
            >
              检测
            </Button>
            <Button
              size="small"
              type="link"
              icon={<EyeOutlined />}
              disabled={!onAir && !recording}
              onClick={() => handleWatch(room)}
            >
              观看
            </Button>
            {recording ? (
              <Popconfirm
                title="确定停止当前录制？"
                onConfirm={() => onStopRoom(room)}
              >
                <Button
                  size="small"
                  type="link"
                  danger
                  icon={<StopOutlined />}
                  loading={acting && actingAction === "stop"}
                >
                  停止
                </Button>
              </Popconfirm>
            ) : (
              <Button
                size="small"
                type="link"
                icon={<VideoCameraAddOutlined />}
                disabled={acting || !onAir || recentStop[room.id] !== undefined}
                onClick={() =>
                  void startRoomRecording(room.id).catch((e) =>
                    message.error(
                      e instanceof ApiError
                        ? describeError(e.code, e.message)
                        : "录制失败",
                    ),
                  )
                }
              >
                录制
              </Button>
            )}
            <Button
              size="small"
              type="link"
              icon={<LinkOutlined />}
              href={room.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              直播间
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <div className="lr-page lr-monitor-page">
      <Space className="lr-page-header" wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          监控总览
        </Typography.Title>
        <Space className="lr-page-actions" wrap>
          <MemphisRadioGroup
            options={[
              { label: "全部", value: "全部" },
              { label: `开播中 ${liveCount}`, value: "开播中" },
              { label: `录制中 ${recordingCount}`, value: "录制中" },
              { label: "收藏", value: "收藏" },
            ]}
            value={filter}
            onChange={(e) =>
              setFilter(e.target.value as "全部" | "开播中" | "录制中" | "收藏")
            }
          />
          <MemphisRadioGroup
            className="lr-platform-filter"
            aria-label="平台筛选"
            options={[
              { label: "全部", value: "全部" },
              {
                label: (
                  <Tooltip title="B站">
                    <PlatformIcon platform="bilibili" />
                  </Tooltip>
                ),
                value: "bilibili",
              },
              {
                label: (
                  <Tooltip title="抖音">
                    <PlatformIcon platform="douyin" />
                  </Tooltip>
                ),
                value: "douyin",
              },
            ]}
            value={platformFilter}
            onChange={(e) =>
              setPlatformFilter(e.target.value as "全部" | Platform)
            }
          />
          <MemphisRadioGroup
            className="lr-monitor-view-toggle"
            aria-label="显示方式"
            options={[
              {
                label: (
                  <Tooltip title="卡片视图">
                    <AppstoreOutlined />
                  </Tooltip>
                ),
                value: "卡片",
              },
              {
                label: (
                  <Tooltip title="列表视图">
                    <UnorderedListOutlined />
                  </Tooltip>
                ),
                value: "列表",
              },
            ]}
            value={view}
            onChange={(e) => {
              const nextView = e.target.value as "卡片" | "列表";
              setView(nextView);
              localStorage.setItem("lr-monitor-view", nextView);
            }}
          />
          <Input.Search
            allowClear
            placeholder="搜索房间"
            style={{ width: 180 }}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Button
            aria-label="刷新"
            icon={<ReloadOutlined />}
            loading={loading || refreshing}
            onClick={() => {
              void handleRefresh().catch(() => undefined);
            }}
          ></Button>
        </Space>
      </Space>
      {directoryUnavailable ? (
        <Alert
          className="lr-directory-warning"
          type="warning"
          showIcon
          message="当前设置的保存目录不可用"
          action={
            <Button size="small" onClick={() => navigate("/settings")}>
              前往设置
            </Button>
          }
        />
      ) : null}
      {monitorRooms.length === 0 && !loading ? (
        <Empty description="暂无启用的直播间，请先在「直播间」中添加" />
      ) : view === "列表" ? (
        <RoomSortableProvider
          allRooms={rooms}
          visibleRooms={monitorRooms}
          mode="table"
          disabled={reorderBusy}
          onReorder={commitRoomOrder}
        >
          <Table
            rowKey="id"
            columns={listColumns}
            components={{ body: { row: SortableRoomTableRow } }}
            dataSource={monitorRooms}
            loading={loading}
            sticky={{ offsetScroll: 8 }}
            scroll={{ x: 1100 }}
            pagination={false}
            size="middle"
          />
        </RoomSortableProvider>
      ) : (
        <RoomSortableProvider
          allRooms={rooms}
          visibleRooms={monitorRooms}
          mode="card"
          disabled={reorderBusy}
          onReorder={commitRoomOrder}
        >
          <Row gutter={[16, 16]}>
            {monitorRooms.map((room) => (
              <SortableRoomCardItem key={room.id} roomId={room.id}>
                <RoomCard
                  room={room}
                  acting={actingRoomId === room.id}
                  actingAction={
                    actingRoomId === room.id
                      ? (actingAction ?? undefined)
                      : undefined
                  }
                  onWatch={handleWatch}
                  onCheck={onCheckRoom}
                  onStop={onStopRoom}
                  recentlyStopped={recentStop[room.id] !== undefined}
                  autoRecordEnabled={
                    room.autoRecord ?? settings?.autoRecord ?? false
                  }
                  insight={insights[room.id]}
                  qualityPreference={settings?.quality ?? null}
                  bilibiliAuthorized={bilibiliAuthorized}
                  floatingEnabled={floatingRoomId === room.id}
                  floatingReady={settings !== null}
                  onRecord={onRecordRoom}
                  onFavorite={onFavoriteRoom}
                  onEnableFloating={onEnableFloating}
                  layout="card"
                />
              </SortableRoomCardItem>
            ))}
          </Row>
        </RoomSortableProvider>
      )}
    </div>
  );
}
