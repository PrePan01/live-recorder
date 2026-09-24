import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, App, Button, Empty, Row, Table } from "antd";
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
import { credentialStatus } from "../../utils/credentialStatus";
import { ApiError } from "../../types/error";
import { describeError } from "../../utils/errorMap";
import type { Platform, Room } from "../../types/room";
import { triggerStartupLiveCheck } from "./components/startupLiveCheck";
import { RoomCard, SortableRoomCardItem } from "./components/roomCard";
import { buildMonitorListColumns } from "./components/listColumns";
import { MonitorToolbar } from "./components/MonitorToolbar";
import {
  RoomSortableProvider,
  SortableRoomTableRow,
} from "../../components/RoomSortable";

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
  const serviceStatus = useServiceStore((s) => s.status);
  const fetchServiceStatus = useServiceStore((s) => s.fetchStatus);
  const directoryUnavailable = isDirectoryUnavailable(
    serviceStatus?.directoryAvailable,
  );
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

  const listColumns = buildMonitorListColumns({
    favoriteRoom,
    checkRoomNow,
    startRoomRecording,
    handleWatch,
    onStopRoom,
    actingRoomId,
    actingAction,
    recentStop,
    message,
  });

  return (
    <div className="lr-page lr-monitor-page">
      <MonitorToolbar
        filter={filter}
        setFilter={setFilter}
        platformFilter={platformFilter}
        setPlatformFilter={setPlatformFilter}
        view={view}
        setView={setView}
        keyword={keyword}
        setKeyword={setKeyword}
        liveCount={liveCount}
        recordingCount={recordingCount}
        loading={loading}
        refreshing={refreshing}
        handleRefresh={handleRefresh}
      />
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
