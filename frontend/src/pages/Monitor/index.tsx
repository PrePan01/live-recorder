import { useRef, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, App, Button, Empty, Table } from "antd";
import { bridge } from "../../stores/bootStore";
import { useRoomStore } from "../../stores/roomStore";
import { useTagStore } from "../../stores/tagStore";
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
import RoomMasonry from "./components/RoomMasonry";
import RoomGrid from "./components/RoomGrid";
import {
  isMonitorSort,
  sortMonitorRooms,
  type MonitorSort,
} from "../../utils/monitorSort";
import { RoomCard, SortableRoomCardItem } from "./components/RoomCard";
import { buildMonitorListColumns } from "../../utils/monitorListColumns";
import { MonitorToolbar } from "./components/MonitorToolbar";
import {
  RoomSortableProvider,
  SortableRoomTableRow,
} from "../../components/RoomSortable";

let startupLiveCheck: Promise<void> | null = null;

type SavedMonitorFilters = {
  sort?: MonitorSort;
  filter?: "全部" | "开播中" | "录制中" | "收藏";
  platformFilter?: "全部" | Platform;
  tagIds?: string[];
};

/** 上次筛选的读取与形状校验；损坏或非法值一律回退默认。 */
function readSavedMonitorFilters(): SavedMonitorFilters {
  try {
    const raw = localStorage.getItem("lr-monitor-filters");
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: SavedMonitorFilters = {};
    if (isMonitorSort(parsed.sort)) out.sort = parsed.sort;
    if (
      parsed.filter === "全部" ||
      parsed.filter === "开播中" ||
      parsed.filter === "录制中" ||
      parsed.filter === "收藏"
    ) {
      out.filter = parsed.filter;
    }
    if (
      parsed.platformFilter === "全部" ||
      parsed.platformFilter === "bilibili" ||
      parsed.platformFilter === "douyin"
    ) {
      out.platformFilter = parsed.platformFilter;
    }
    if (
      Array.isArray(parsed.tagIds) &&
      parsed.tagIds.every((t) => typeof t === "string")
    ) {
      out.tagIds = parsed.tagIds as string[];
    }
    return out;
  } catch {
    return {};
  }
}

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
    () => readSavedMonitorFilters().filter ?? "全部",
  );
  const [platformFilter, setPlatformFilter] = useState<"全部" | Platform>(
    () => readSavedMonitorFilters().platformFilter ?? "全部",
  );
  const [tagIds, setTagIds] = useState<string[]>(
    () => readSavedMonitorFilters().tagIds ?? [],
  );
  const [keyword, setKeyword] = useState("");
  const [sort, setSort] = useState<MonitorSort>(
    () => readSavedMonitorFilters().sort ?? "manual",
  );
  const manualSort = sort === "manual";
  const CardLayout = manualSort ? RoomGrid : RoomMasonry;
  const tags = useTagStore((st) => st.tags);
  const loadTags = useTagStore((st) => st.load);
  useEffect(() => {
    void loadTags().catch(() => undefined);
  }, [loadTags]);
  const restoredTagsRef = useRef(false);
  useEffect(() => {
    if (restoredTagsRef.current || tags.length === 0) return;
    restoredTagsRef.current = true;
    setTagIds((prev) => {
      if (prev.length === 0) return prev;
      const known = prev.filter((id) => tags.some((t) => t.id === id));
      return known.length === prev.length ? prev : known;
    });
  }, [tags]);
  useEffect(() => {
    try {
      localStorage.setItem(
        "lr-monitor-filters",
        JSON.stringify({ filter, platformFilter, tagIds, sort }),
      );
    } catch {
      /* 存储不可用时筛选仍可用，仅不跨刷新记忆 */
    }
  }, [filter, platformFilter, tagIds, sort]);
  const [refreshing, setRefreshing] = useState(false);
  const [recentStop, setRecentStop] = useState<Record<string, number>>({});
  const [insightsLoading, setInsightsLoading] = useState(true);
  const [insightsFailed, setInsightsFailed] = useState(false);
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
      void stopRoomRecording(room.id).catch(() => {
        // 停止失败时撤回「刚停止」标记，不把失败窗口演成已停止。
        setRecentStop((prev) => {
          const next = { ...prev };
          delete next[room.id];
          return next;
        });
        message.error("停止请求失败");
      });
    },
    [message, stopRoomRecording],
  );

  useEffect(() => {
    void fetchRooms().catch(() => message.error("房间列表加载失败"));
  }, [fetchRooms, message]);

  useEffect(() => {
    void fetchServiceStatus();
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetchServiceStatus();
    }, 30_000);
    return () => clearInterval(timer);
  }, [fetchServiceStatus]);

  useEffect(() => {
    let disposed = false;
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
      setInsightsLoading(false);
      setInsightsFailed(false);
      return;
    }
    let disposed = false;
    setInsightsLoading(true);
    // Coalesce room events from the same polling batch into one insight request.
    const timer = setTimeout(() => {
      void fetchRoomInsights(ids)
        .then((next) => {
          if (!disposed) {
            setInsights(next);
            setInsightsFailed(false);
          }
        })
        .catch(() => {
          if (!disposed) {
            setInsights({});
            setInsightsFailed(true);
          }
        })
        .finally(() => {
          if (!disposed) setInsightsLoading(false);
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

  const keywordMatches = (r: Room) => {
    const kw = keyword.trim().toLowerCase();
    return (
      !kw ||
      r.displayName.toLowerCase().includes(kw) ||
      r.url.toLowerCase().includes(kw)
    );
  };
  const tagsMatch = (r: Room) =>
    tagIds.length === 0 || r.tags.some((t) => tagIds.includes(t.id));
  const filteredRooms = rooms
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
    .filter(keywordMatches)
    .filter(tagsMatch);
  const monitorRooms = sortMonitorRooms(filteredRooms, insights, sort);

  const commitRoomOrder = useCallback(
    async (roomIds: string[]) => {
      if (!manualSort) return;
      try {
        await reorderRooms(roomIds);
      } catch {
        message.error("排序保存失败，已恢复服务端顺序");
      }
    },
    [message, reorderRooms, manualSort],
  );

  // 渐进分片渲染：首屏同步出前 20 张卡，其余每片 6 张在帧间隙挂载——
  // 把百卡一次成帧的长任务（实测 5.4s、滚动冻结 6.7s）拆为亚秒小片，卡片分批出现；
  // 排序不受影响（DND 层按全量 ids 计算，见 RoomSortableProvider）。
  const [shown, setShown] = useState(20);
  useEffect(() => {
    if (view !== "卡片") return; // 列表视图不参与分片：否则 state 推进会连发整表重渲染
    if (shown >= monitorRooms.length) return;
    let raf = 0;
    const timer = setTimeout(() => {
      raf = requestAnimationFrame(() =>
        setShown((s) => Math.min(s + 6, monitorRooms.length)),
      );
    }, 50);
    return () => {
      clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [shown, monitorRooms.length, view]);

  const platformRooms = rooms
    .filter(
      (r) =>
        r.enabled &&
        (platformFilter === "全部" || r.platform === platformFilter),
    )
    .filter(keywordMatches)
    .filter(tagsMatch);
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
        sort={sort}
        setSort={setSort}
        filter={filter}
        setFilter={setFilter}
        platformFilter={platformFilter}
        setPlatformFilter={setPlatformFilter}
        view={view}
        setView={setView}
        keyword={keyword}
        tagIds={tagIds}
        setTagIds={setTagIds}
        tags={tags}
        setKeyword={setKeyword}
        liveCount={liveCount}
        recordingCount={recordingCount}
        loading={loading}
        refreshing={refreshing}
        handleRefresh={handleRefresh}
      />
      {!manualSort && insightsFailed ? (
        <Alert
          type="warning"
          showIcon
          message="排序数据加载失败，暂按手动顺序展示"
          style={{ marginBottom: 16 }}
        />
      ) : null}
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
        monitorRooms.length === 0 && rooms.some((r) => r.enabled) ? (
          <Empty description="当前筛选无匹配">
            <Button
              onClick={() => {
                setFilter("全部");
                setPlatformFilter("全部");
                setTagIds([]);
                setKeyword("");
              }}
            >
              清除筛选
            </Button>
          </Empty>
        ) : (
          <Empty description="暂无启用的直播间，请先在「直播间」中添加" />
        )
      ) : view === "列表" ? (
        <RoomSortableProvider
          allRooms={rooms}
          visibleRooms={monitorRooms}
          mode="table"
          disabled={reorderBusy || !manualSort}
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
          disabled={reorderBusy || !manualSort}
          onReorder={commitRoomOrder}
        >
          <CardLayout>
            {monitorRooms.slice(0, shown).map((room) => (
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
                  insightsLoading={insightsLoading}
                  insightsFailed={insightsFailed}
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
          </CardLayout>
        </RoomSortableProvider>
      )}
    </div>
  );
}
