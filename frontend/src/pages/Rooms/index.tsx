import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  App,
  Alert,
  Button,
  Drawer,
  Form,
  Input,
  List,
  Modal,
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
  SnippetsOutlined,
} from "@ant-design/icons";
import { guessPlatform, PLATFORM_LABEL } from "../../utils/roomPlatform";
import RoomManagementCard from "./components/RoomManagementCard";
import BatchRoomPolicy from "./components/BatchRoomPolicy";
import "./rooms.css";
import { useRoomStore } from "../../stores/roomStore";
import { useTagStore } from "../../stores/tagStore";
import TagSelect from "./components/TagSelect";
import SchedulePanel from "./components/SchedulePanel";
import TagFilterSelect from "../../components/TagFilterSelect";
import type { Room } from "../../types/room";
import { ApiError } from "../../types/error";
import { describeError } from "../../utils/errorMap";
import { fetchDouyinCookieStatus } from "../../api/settings";
import { RoomSortableProvider } from "../../components/RoomSortable";

export default function Rooms() {
  const { message, modal } = App.useApp();
  const { search } = useLocation();
  const navigate = useNavigate();
  const {
    rooms,
    loading,
    fetchRooms,
    addRoom,
    batchAddRooms,
    editRoom,
    removeRoom,
    updateRoomTags,
    checkRoomNow,
    reorderRooms,
    reorderBusy,
  } = useRoomStore();
  const [batchPolicyIds, setBatchPolicyIds] = useState<string[] | null>(null);
  const tags = useTagStore((s) => s.tags);
  const [modalOpen, setModalOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchBusy2, setBatchBusy2] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchResult, setBatchResult] = useState<Awaited<
    ReturnType<typeof batchAddRooms>
  > | null>(null);
  const [editing, setEditing] = useState<Room | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [form] = Form.useForm<{
    url: string;
    displayName?: string;
  }>();
  const [keyword, setKeyword] = useState("");
  const [platform, setPlatform] = useState<string>();
  const [state, setState] = useState<string>();
  const [favOnly, setFavOnly] = useState<boolean>(false);
  const [filterTagIds, setFilterTagIds] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
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

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return rooms.filter((r) => {
      if (
        kw &&
        !r.displayName.toLowerCase().includes(kw) &&
        !r.url.toLowerCase().includes(kw)
      )
        return false;
      if (platform && r.platform !== platform) return false;
      if (state && r.monitorState !== state) return false;
      if (favOnly && !r.favorited) return false;
      return !(
        filterTagIds.length > 0 &&
        !filterTagIds.some((tagId) => r.tags.some((tag) => tag.id === tagId))
      );
    });
  }, [rooms, keyword, platform, state, favOnly, filterTagIds]);

  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / pageSize)),
  );
  const paginated = useMemo(
    () => filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filtered, currentPage, pageSize],
  );

  const commitRoomOrder = async (roomIds: string[]) => {
    try {
      await reorderRooms(roomIds);
    } catch {
      message.error("排序保存失败，已恢复服务端顺序");
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const focusId = params.get("focus");
    if (!focusId || rooms.length === 0) return;
    const idx = rooms.findIndex((r) => r.id === focusId);
    if (idx === -1) return;
    const targetPage = Math.floor(idx / pageSize) + 1;
    setPage(targetPage);
    const timer = setTimeout(() => {
      const el = document.querySelector(
        `[data-room-id="${focusId}"]`,
      ) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.style.transition = "background 1s ease";
        el.style.background = "var(--lr-hover-bg)";
        setTimeout(() => {
          el.style.background = "";
        }, 2000);
      }
    }, 400);
    window.history.replaceState({}, "", "/rooms");
    return () => clearTimeout(timer);
  }, [rooms, pageSize]);

  const resetPage = () => setPage(1);

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
    form.resetFields();
    setTagIds([]);
    setModalOpen(true);
  };

  useEffect(() => {
    if (new URLSearchParams(search).get("add") !== "1") return;
    setEditing(null);
    form.resetFields();
    setTagIds([]);
    setModalOpen(true);
    navigate("/rooms", { replace: true });
  }, [form, navigate, search]);

  const openEdit = useCallback(
    (room: Room) => {
      setEditing(room);
      form.setFieldsValue({
        url: room.url,
        displayName: room.displayName,
      });
      setTagIds(room.tags.map((t) => t.id));
      setModalOpen(true);
    },
    [form],
  );

  const promptDouyinAuthorization = async () => {
    const status = await fetchDouyinCookieStatus().catch(
      () => "unknown" as const,
    );
    if (status === "missing" || status === "invalid") {
      message.warning("如需观看、录制抖音直播间，请在设置内登录并授权", 5);
    }
  };

  const submit = async () => {
    let values: { url: string; displayName?: string };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const platform = guessPlatform(values.url);
    if (!platform) {
      message.error("支持 B站 / 抖音直播链接及小红书主页、直播分享链接");
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        await editRoom(editing.id, values);
        if (tagIds.length > 0 || editing.tags.length > 0) {
          await updateRoomTags(editing.id, tagIds);
        }
        message.success("直播间已更新");
      } else {
        const room = await addRoom({ ...values, platform });
        if (tagIds.length > 0) {
          await updateRoomTags(room.id, tagIds);
        }
        message.success("直播间已添加");
        // 添加后立即检测，让显示名/直播状态即时解析（不必等调度器最长 120s）。
        void checkRoomNow(room.id).catch(() => undefined);
        if (platform === "douyin") void promptDouyinAuthorization();
      }
      setModalOpen(false);
    } catch (e) {
      message.error(
        e instanceof ApiError ? describeError(e.code, e.message) : "保存失败",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const urlValue = Form.useWatch("url", form);

  const pasteRoomUrl = async () => {
    try {
      const url = await navigator.clipboard.readText();
      if (!url.trim()) {
        message.warning("剪贴板中没有可粘贴的内容");
        return;
      }
      form.setFieldValue("url", url.trim());
    } catch {
      message.error("无法读取剪贴板，请检查系统剪贴板权限");
    }
  };

  const submitBatch = async () => {
    const urls = batchText
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      message.warning("请粘贴至少一行直播链接");
      return;
    }
    setBatchBusy2(true);
    setBatchResult(null);
    try {
      const res = await batchAddRooms(urls);
      setBatchResult(res);
      message.success(
        `成功 ${res.succeeded.length} 条，失败 ${res.failed.length} 条`,
      );
      if (res.succeeded.some((r) => r.platform === "douyin"))
        void promptDouyinAuthorization();
    } catch (e) {
      message.error(
        e instanceof ApiError
          ? describeError(e.code, e.message)
          : "批量添加失败",
      );
    } finally {
      setBatchBusy2(false);
    }
  };

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
        pageSizeOptions={[10, 20, 50]}
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
      <Modal
        title={editing ? "编辑直播间" : "添加直播间"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        destroyOnHidden
        width={700}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="url"
            label="直播间链接"
            rules={[
              { required: true, message: "请输入直播间链接" },
              {
                validator: (_, v: string) =>
                  !v || guessPlatform(v)
                    ? Promise.resolve()
                    : Promise.reject(
                        new Error(
                          "支持 B站 / 抖音直播链接及小红书主页、直播分享链接",
                        ),
                      ),
              },
            ]}
            extra={
              urlValue && guessPlatform(urlValue)
                ? `识别为：${PLATFORM_LABEL[guessPlatform(urlValue)!]}`
                : undefined
            }
          >
            <Input
              placeholder="B站、抖音直播链接、小红书主页/直播链接"
              addonAfter={
                <Button
                  className="lr-room-url-paste"
                  type="text"
                  size="small"
                  icon={<SnippetsOutlined />}
                  onClick={() => void pasteRoomUrl()}
                >
                  粘贴
                </Button>
              }
            />
          </Form.Item>
          <Form.Item name="displayName" label="显示名（可选，留空自动解析）">
            <Input placeholder="主播昵称" />
          </Form.Item>
          <Form.Item label="标签">
            <TagSelect value={tagIds} onChange={setTagIds} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="批量添加直播间"
        open={batchOpen}
        onCancel={() => {
          setBatchOpen(false);
          setBatchResult(null);
          setBatchText("");
        }}
        onOk={() => void submitBatch()}
        confirmLoading={batchBusy2}
        okText="批量添加"
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          每行一个直播链接，支持 B站 / 抖音 / 小红书混排，最多 100
          条。自动去重（含已存在直播间与批内重复）。
        </Typography.Paragraph>
        <Input.TextArea
          rows={6}
          placeholder={
            "https://live.bilibili.com/...\nhttps://live.douyin.com/...\nhttps://www.xiaohongshu.com/livestream/..."
          }
          value={batchText}
          onChange={(e) => setBatchText(e.target.value)}
        />
        {batchResult ? (
          <div style={{ marginTop: 12 }}>
            {batchResult.failed.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={`失败 ${batchResult.failed.length} 条`}
                description={
                  <List
                    size="small"
                    dataSource={batchResult.failed}
                    renderItem={(f) => (
                      <List.Item>
                        <Typography.Text
                          type="secondary"
                          ellipsis
                          style={{ maxWidth: 260 }}
                        >
                          {f.url}
                        </Typography.Text>
                        <Typography.Text type="danger">
                          {f.reason}
                        </Typography.Text>
                      </List.Item>
                    )}
                  />
                }
              />
            ) : (
              <Alert
                type="success"
                showIcon
                message={`全部成功（${batchResult.succeeded.length} 条）`}
              />
            )}
          </div>
        ) : null}
      </Modal>
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
