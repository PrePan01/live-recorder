import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  App,
  Button,
  Drawer,
  Input,
  Checkbox,
  Empty,
  Pagination,
  Spin,
  Select,
  Space,
  Typography,
} from "antd";
import {
  PlusOutlined,
  StarOutlined,
  ExclamationCircleFilled,
} from "@ant-design/icons";
import RoomManagementCard from "./components/RoomManagementCard";
import BatchRoomPolicy from "./components/BatchRoomPolicy";
import RoomEditorModal from "./components/RoomEditorModal";
import BatchAddRoomsModal from "./components/BatchAddRoomsModal";
import "./rooms.css";
import { useRoomStore } from "../../stores/roomStore";
import { useTagStore } from "../../stores/tagStore";
import SchedulePanel from "./components/SchedulePanel";
import TagFilterSelect from "../../components/TagFilterSelect";
import type { Room } from "../../types/room";
import { ApiError } from "../../types/error";
import { describeError } from "../../utils/error/errorMap";
import { RoomSortableProvider } from "../../components/RoomSortable";
import { useRoomList } from "./hooks/useRoomList";

export default function Rooms() {
  const { message, modal } = App.useApp();
  const { search } = useLocation();
  const navigate = useNavigate();
  const {
    rooms,
    loading,
    fetchRooms,
    removeRoom,
    reorderRooms,
    reorderBusy,
  } = useRoomStore();
  const [batchPolicyIds, setBatchPolicyIds] = useState<string[] | null>(null);
  const tags = useTagStore((s) => s.tags);
  const [modalOpen, setModalOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [editing, setEditing] = useState<Room | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [scheduleRoom, setScheduleRoom] = useState<Room | null>(null);
  useEffect(() => {
    void fetchRooms().catch(() => message.error("直播间列表加载失败"));
  }, [fetchRooms, message]);

  useEffect(() => {
    void useTagStore
      .getState()
      .load()
      .catch(() => undefined);
  }, []);

  const {
    keyword,
    setKeyword,
    platform,
    setPlatform,
    state,
    setState,
    favOnly,
    setFavOnly,
    filterTagIds,
    setFilterTagIds,
    pageSize,
    setPageSize,
    setPage,
    currentPage,
    filtered,
    paginated,
    resetPage,
  } = useRoomList(rooms);

  const commitRoomOrder = async (roomIds: string[]) => {
    try {
      await reorderRooms(roomIds);
    } catch {
      message.error("排序保存失败，已恢复服务端顺序");
    }
  };

  const confirmDeleteRooms = useCallback(
    (targets: Room[]) => {
      if (targets.length === 0) {
        return message.warning("请先选择要操作的直播间");
      }
      const recording = targets.filter(
        (r) =>
          r.monitorState === "recording" || r.monitorState === "reconnecting",
      );
      const multiple = targets.length > 1;
      modal.confirm({
        title:
          recording.length > 0
            ? multiple
              ? `所选直播间中有 ${recording.length} 个正在录制，确定删除？`
              : "该直播间正在录制，确定删除？"
            : multiple
              ? `确定删除所选 ${targets.length} 个直播间？`
              : "确定删除该直播间？",
        icon:
          recording.length > 0 ? (
            <ExclamationCircleFilled style={{ color: "#faad14" }} />
          ) : undefined,
        content:
          recording.length > 0
            ? "删除会先停止录制并保存已录内容，随后删除直播间。"
            : "删除后不可恢复。",
        okText: recording.length > 0 ? "停止录制并删除" : "删除",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: async () => {
          setBatchBusy(true);
          try {
            for (const room of targets) await removeRoom(room.id);
            setSelectedKeys([]);
            message.success(`已删除 ${targets.length} 个直播间`);
          } catch (e) {
            message.error(
              e instanceof ApiError
                ? describeError(e.code, e.message)
                : "删除失败",
            );
          } finally {
            setBatchBusy(false);
          }
        },
      });
    },
    [message, modal, removeRoom],
  );

  const openAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };

  useEffect(() => {
    if (new URLSearchParams(search).get("add") !== "1") return;
    setEditing(null);
    setModalOpen(true);
    navigate("/rooms", { replace: true });
  }, [navigate, search]);

  const openEdit = useCallback((room: Room) => {
    setEditing(room);
    setModalOpen(true);
  }, []);

  const selectRoom = useCallback((id: string, checked: boolean) => {
    setSelectedKeys((keys) =>
      checked ? [...new Set([...keys, id])] : keys.filter((key) => key !== id),
    );
  }, []);
  const selectedIds = useMemo(() => {
    const available = new Set(rooms.map((room) => room.id));
    return new Set(selectedKeys.map(String).filter((id) => available.has(id)));
  }, [selectedKeys, rooms]);
  const selectedVisible = paginated.filter((room) =>
    selectedIds.has(room.id),
  ).length;

  return (
    <div className="lr-page lr-rooms-page">
      <Space className="lr-page-header" wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          直播间管理
        </Typography.Title>
        <Space className="lr-page-actions" wrap>
          <Button
            icon={<PlusOutlined />}
            onClick={() => {
              setBatchOpen(true);
            }}
          >
            批量添加
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
            添加直播间
          </Button>
        </Space>
      </Space>
      <Space className="lr-filter-bar" wrap>
        <Input.Search
          allowClear
          placeholder="搜索显示名 / 链接"
          style={{ width: 220 }}
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            resetPage();
          }}
        />
        <Select
          allowClear
          placeholder="平台"
          style={{ width: 110 }}
          value={platform}
          onChange={(v) => {
            setPlatform(v);
            resetPage();
          }}
          options={[
            { value: "bilibili", label: "B站" },
            { value: "douyin", label: "抖音" },
            { value: "xiaohongshu", label: "小红书" },
            { value: "youtube", label: "YouTube" },
          ]}
        />
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 130 }}
          value={state}
          onChange={(v) => {
            setState(v);
            resetPage();
          }}
          options={[
            { value: "idle", label: "空闲" },
            { value: "checking", label: "检测中" },
            { value: "recording", label: "录制中" },
            { value: "reconnecting", label: "重连中" },
            { value: "completed", label: "已完成" },
            { value: "failed", label: "失败" },
            { value: "disabled", label: "已停用" },
          ]}
        />
        <TagFilterSelect
          tags={tags}
          value={filterTagIds}
          onChange={(nextTagIds) => {
            setFilterTagIds(nextTagIds);
            resetPage();
          }}
          placeholder="标签"
          style={{ width: 120 }}
        />
        <Button
          type={favOnly ? "primary" : "default"}
          icon={<StarOutlined />}
          onClick={() => {
            setFavOnly((v) => !v);
            resetPage();
          }}
        >
          仅看收藏
        </Button>
        <Button
          disabled={selectedIds.size === 0 || batchBusy}
          onClick={() => setBatchPolicyIds([...selectedIds])}
        >
          批量设置
        </Button>
        <Button
          danger
          disabled={selectedIds.size === 0 || batchBusy}
          onClick={() =>
            confirmDeleteRooms(rooms.filter((room) => selectedIds.has(room.id)))
          }
        >
          批量删除
        </Button>
        {selectedIds.size > 0 ? (
          <Typography.Text type="secondary">
            已选 {selectedIds.size} 项
          </Typography.Text>
        ) : null}
      </Space>
      <div className="lr-rooms-list-toolbar">
        <Checkbox
          checked={paginated.length > 0 && selectedVisible === paginated.length}
          indeterminate={
            selectedVisible > 0 && selectedVisible < paginated.length
          }
          disabled={!paginated.length}
          onChange={(event) => {
            const visible = new Set(paginated.map((room) => room.id));
            setSelectedKeys((keys) =>
              event.target.checked
                ? [...new Set([...keys, ...visible])]
                : keys.filter((key) => !visible.has(String(key))),
            );
          }}
        >
          选择本页
        </Checkbox>
        <span>{filtered.length} 个直播间</span>
      </div>
      <Spin spinning={loading}>
        <RoomSortableProvider
          allRooms={rooms}
          visibleRooms={paginated}
          mode="management"
          disabled={reorderBusy}
          onReorder={commitRoomOrder}
        >
          <div className="lr-room-management-list">
            {paginated.map((room) => (
              <RoomManagementCard
                key={room.id}
                room={room}
                selected={selectedIds.has(room.id)}
                onSelect={selectRoom}
                onEdit={openEdit}
                onSchedule={setScheduleRoom}
                onDelete={confirmDeleteRooms}
              />
            ))}
            {!paginated.length && (
              <Empty
                description={
                  rooms.length
                    ? "没有符合筛选条件的直播间"
                    : "添加第一个直播间，开始安排录制"
                }
              >
                {!rooms.length && (
                  <Button type="primary" onClick={openAdd}>
                    添加直播间
                  </Button>
                )}
              </Empty>
            )}
          </div>
        </RoomSortableProvider>
      </Spin>
      <Pagination
        className="lr-rooms-pagination"
        current={currentPage}
        pageSize={pageSize}
        total={filtered.length}
        showSizeChanger
        pageSizeOptions={[10, 20, 50, 100, 200]}
        showTotal={(total) => `共 ${total} 个直播间`}
        onChange={(nextPage, size) => {
          setPage(nextPage);
          setPageSize(size);
        }}
      />
      {batchPolicyIds && (
        <BatchRoomPolicy
          ids={batchPolicyIds}
          onClose={() => setBatchPolicyIds(null)}
        />
      )}
      <RoomEditorModal
        open={modalOpen}
        room={editing}
        onClose={() => setModalOpen(false)}
      />
      <BatchAddRoomsModal open={batchOpen} onClose={() => setBatchOpen(false)} />
      <Drawer
        title={`定时计划：${scheduleRoom?.displayName ?? ""}`}
        open={scheduleRoom !== null}
        size={720}
        onClose={() => setScheduleRoom(null)}
      >
        {scheduleRoom ? <SchedulePanel roomId={scheduleRoom.id} /> : null}
      </Drawer>
    </div>
  );
}
