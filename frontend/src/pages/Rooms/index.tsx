import { useEffect, useMemo, useRef, useState } from "react";
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
  Popover,
  Select,
  Space,
  Switch,
  Table,
  Typography,
} from "antd";
import {
  PlusOutlined,
  StarOutlined,
  ExclamationCircleFilled,
  SnippetsOutlined,
} from "@ant-design/icons";
import { guessPlatform, PLATFORM_LABEL } from "./components/roomPlatform";
import { buildRoomColumns } from "./components/roomColumns";
import { useRoomStore } from "../../stores/roomStore";
import { useTagStore } from "../../stores/tagStore";
import { useResizableColumns } from "../../hooks/useResizableColumns";
import TagSelect from "../../components/TagSelect";
import SchedulePanel from "../../components/SchedulePanel";
import type { Room } from "../../types/room";
import { ApiError } from "../../types/error";
import { describeError } from "../../utils/errorMap";
import { fetchDouyinCookieStatus } from "../../api/settings";
import {
  RoomSortableProvider,
  SortableRoomTableRow,
} from "../../components/RoomSortable";

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
    toggleRoom,
    favoriteRoom,
    setAutoRecord,
    setLiveNotification,
    updateRoomTags,
    checkRoomNow,
    reorderRooms,
    reorderBusy,
  } = useRoomStore();
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
    liveNotificationEnabled: boolean;
  }>();
  const [keyword, setKeyword] = useState("");
  const [platform, setPlatform] = useState<string>();
  const [state, setState] = useState<string>();
  const [favOnly, setFavOnly] = useState<boolean>(false);
  const [tagId, setTagId] = useState<string>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [scheduleRoom, setScheduleRoom] = useState<Room | null>(null);
  const [editingDisplayName, setEditingDisplayName] = useState<{
    id: string;
    value: string;
  } | null>(null);
  const savingDisplayNameIdRef = useRef<string | null>(null);

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
      return !(tagId && !r.tags.some((t) => t.id === tagId));
    });
  }, [rooms, keyword, platform, state, favOnly, tagId]);

  const paginated = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize],
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

  const saveDisplayName = async (room: Room) => {
    const draft = editingDisplayName;
    if (
      !draft ||
      draft.id !== room.id ||
      savingDisplayNameIdRef.current === room.id
    )
      return;
    savingDisplayNameIdRef.current = room.id;
    setEditingDisplayName(null);
    const displayName = draft.value.trim();
    try {
      if (displayName !== room.displayName) {
        await editRoom(room.id, { displayName });
      }
    } catch (e) {
      message.error(
        e instanceof ApiError
          ? describeError(e.code, e.message)
          : "显示名保存失败",
      );
    } finally {
      savingDisplayNameIdRef.current = null;
    }
  };

  const runBatch = async (fn: (r: Room) => Promise<void>, okMsg: string) => {
    const targets = rooms.filter((r) => selectedKeys.includes(r.id));
    if (targets.length === 0) {
      message.warning("请先选择要操作的直播间");
      return;
    }
    setBatchBusy(true);
    try {
      await Promise.all(targets.map((r) => fn(r)));
      message.success(`${okMsg} ${targets.length} 个直播间`);
      setSelectedKeys([]);
    } catch (e) {
      message.error(
        e instanceof ApiError
          ? describeError(e.code, e.message)
          : "批量操作失败",
      );
    } finally {
      setBatchBusy(false);
    }
  };

  const confirmDeleteRooms = (targets: Room[]) => {
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
  };

  const batchActions = (
    <Space>
      <Button
        size="small"
        disabled={batchBusy || selectedKeys.length === 0}
        onClick={() => void runBatch((r) => toggleRoom(r.id, true), "已启用")}
      >
        批量启用
      </Button>
      <Button
        size="small"
        disabled={batchBusy || selectedKeys.length === 0}
        onClick={() => void runBatch((r) => toggleRoom(r.id, false), "已停用")}
      >
        批量停用
      </Button>
      <Button
        size="small"
        disabled={batchBusy || selectedKeys.length === 0}
        onClick={() =>
          void runBatch(
            (r) => setLiveNotification(r.id, true),
            "已开启开播提醒",
          )
        }
      >
        开启开播提醒
      </Button>
      <Button
        size="small"
        disabled={batchBusy || selectedKeys.length === 0}
        onClick={() =>
          void runBatch(
            (r) => setLiveNotification(r.id, false),
            "已关闭开播提醒",
          )
        }
      >
        关闭开播提醒
      </Button>
      <Button
        size="small"
        danger
        disabled={batchBusy || selectedKeys.length === 0}
        onClick={() =>
          confirmDeleteRooms(rooms.filter((r) => selectedKeys.includes(r.id)))
        }
      >
        批量删除
      </Button>
    </Space>
  );

  const openAdd = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldValue("liveNotificationEnabled", false);
    setTagIds([]);
    setModalOpen(true);
  };

  useEffect(() => {
    if (new URLSearchParams(search).get("add") !== "1") return;
    setEditing(null);
    form.resetFields();
    form.setFieldValue("liveNotificationEnabled", false);
    setTagIds([]);
    setModalOpen(true);
    navigate("/rooms", { replace: true });
  }, [form, navigate, search]);

  const openEdit = (room: Room) => {
    setEditing(room);
    form.setFieldsValue({
      url: room.url,
      displayName: room.displayName,
      liveNotificationEnabled: room.liveNotificationEnabled,
    });
    setTagIds(room.tags.map((t) => t.id));
    setModalOpen(true);
  };

  /**
   * 添加抖音直播间后，用设置页同一探测口径检查抖音登录态：未登录（missing）
   * 或 Cookie 已失效（invalid）时提示去设置页登录授权。探测失败（unknown）
   * 不做提示，避免把网络异常误报成未登录。
   */
  const promptDouyinAuthorization = async () => {
    const status = await fetchDouyinCookieStatus().catch(
      () => "unknown" as const,
    );
    if (status === "missing" || status === "invalid") {
      message.warning("如需观看、录制抖音直播间，请在设置内登录并授权", 5);
    }
  };

  const submit = async () => {
    // Ant Design rejects when client-side validation fails.  This handler is
    // invoked with `void submit()`, so validation failures must be consumed
    // here instead of becoming a window-level unhandled rejection.
    let values: {
      url: string;
      displayName?: string;
      liveNotificationEnabled: boolean;
    };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    const platform = guessPlatform(values.url);
    if (!platform) {
      message.error("仅支持 B站 / 抖音 直播链接");
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
      // 批量里含抖音也只探测一次，不按房间重复请求。
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

  const columns = buildRoomColumns({
    favoriteRoom,
    setAutoRecord,
    setLiveNotification,
    toggleRoom,
    editingDisplayName,
    setEditingDisplayName,
    saveDisplayName,
    openEdit,
    setScheduleRoom,
    confirmDeleteRooms,
    message,
  });

  const { columns: resizedColumns, components: resizableComponents } =
    useResizableColumns<Room>(columns);

  return (
    <div className="lr-page">
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
        <Select
          allowClear
          placeholder="标签"
          style={{ width: 120 }}
          value={tagId}
          onChange={(v) => {
            setTagId(v);
            resetPage();
          }}
          options={tags.map((t) => ({ value: t.id, label: t.name }))}
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
        <Popover content={batchActions} trigger="click" placement="bottom">
          <Button disabled={selectedKeys.length === 0}>批量操作</Button>
        </Popover>
        {selectedKeys.length > 0 ? (
          <Typography.Text type="secondary">
            已选 {selectedKeys.length} 项
          </Typography.Text>
        ) : null}
      </Space>
      <RoomSortableProvider
        allRooms={rooms}
        visibleRooms={paginated}
        mode="table"
        disabled={reorderBusy}
        onReorder={commitRoomOrder}
      >
        <Table
          rowKey="id"
          columns={resizedColumns}
          components={{
            ...resizableComponents,
            body: { row: SortableRoomTableRow },
          }}
          dataSource={paginated}
          loading={loading}
          sticky={{ offsetScroll: 8 }}
          scroll={{ x: 1500 }}
          onRow={(room) =>
            ({ "data-room-id": room.id }) as React.HTMLAttributes<HTMLElement>
          }
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: setSelectedKeys,
          }}
          pagination={{
            current: page,
            pageSize,
            total: filtered.length,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50],
            showTotal: (t) => `共 ${t} 个直播间`,
            onChange: (p, ps) => {
              setPage(p);
              setPageSize(ps);
            },
          }}
        />
      </RoomSortableProvider>
      <Modal
        title={editing ? "编辑直播间" : "添加直播间"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => void submit()}
        confirmLoading={submitting}
        destroyOnHidden
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
                    : Promise.reject(new Error("仅支持 B站 / 抖音 直播链接")),
              },
            ]}
            extra={
              urlValue && guessPlatform(urlValue)
                ? `识别为：${PLATFORM_LABEL[guessPlatform(urlValue)!]}`
                : undefined
            }
          >
            <Input
              placeholder="https://live.bilibili.com/... 或 https://live.douyin.com/..."
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
          <Form.Item
            name="liveNotificationEnabled"
            label="开播提醒"
            valuePropName="checked"
          >
            <Switch aria-label="开播提醒" />
          </Form.Item>
          {editing ? (
            <Form.Item label="标签">
              <TagSelect value={tagIds} onChange={setTagIds} />
            </Form.Item>
          ) : null}
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
          每行一个直播链接，支持 B站 / 抖音 混排，最多 100
          条。自动去重（含已存在直播间与批内重复）。
        </Typography.Paragraph>
        <Input.TextArea
          rows={6}
          placeholder={
            "https://live.bilibili.com/...\nhttps://live.douyin.com/..."
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
