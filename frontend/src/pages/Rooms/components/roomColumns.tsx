// 拆分（task #62）：直播间表格列定义——自 index.tsx 原样迁移为工厂函数；
// 闭包依赖改为显式入参（原标识符名），列体/渲染/文案/类名零改动。
import type { Dispatch, SetStateAction } from "react";
import { App, Button, Input, Select, Space, Switch, Tag, Tooltip, Typography } from "antd";
import {
  DeleteOutlined,
  EditOutlined,
  ScheduleOutlined,
  StarFilled,
  StarOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { ApiError } from "../../../types/error";
import { describeError } from "../../../utils/errorMap";
import { formatRelative } from "../../../utils/format";
import { MonitorStateTag } from "../../../components/StatusTags";
import { PlatformLogoTag } from "../../../components/PlatformLogo";
import type { Room } from "../../../types/room";

type MessageApi = ReturnType<typeof App.useApp>["message"];

export type DisplayNameDraft = { id: string; value: string } | null;

export interface RoomColumnsDeps {
  favoriteRoom: (id: string, favorited: boolean) => Promise<void>;
  setAutoRecord: (id: string, value: boolean | null) => Promise<void>;
  setLiveNotification: (id: string, value: boolean) => Promise<void>;
  toggleRoom: (id: string, enabled: boolean) => Promise<void>;
  editingDisplayName: DisplayNameDraft;
  setEditingDisplayName: Dispatch<SetStateAction<DisplayNameDraft>>;
  saveDisplayName: (room: Room) => Promise<void> | void;
  openEdit: (room: Room) => void;
  setScheduleRoom: (room: Room) => void;
  confirmDeleteRooms: (targets: Room[]) => void;
  message: MessageApi;
}

export function buildRoomColumns(deps: RoomColumnsDeps): ColumnsType<Room> {
  const {
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
  } = deps;
  return [
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
      width: 60,
      render: (p) => <PlatformLogoTag platform={p} />,
    },
    {
      title: "自动录制",
      dataIndex: "autoRecord",
      width: 120,
      render: (v: boolean | null, room) => (
        <Select
          size="small"
          value={v === null ? "inherit" : v ? "on" : "off"}
          style={{ width: 100 }}
          onChange={(val) =>
            void setAutoRecord(room.id, val === "inherit" ? null : val === "on")
              .then(() =>
                message.success(
                  val === "inherit"
                    ? "已恢复跟随全局"
                    : `已${val === "on" ? "开启" : "关闭"}`,
                ),
              )
              .catch((e) =>
                message.error(
                  e instanceof ApiError
                    ? describeError(e.code, e.message)
                    : "操作失败",
                ),
              )
          }
          options={[
            { value: "inherit", label: "跟随全局" },
            { value: "on", label: "开启" },
            { value: "off", label: "关闭" },
          ]}
        />
      ),
    },
    {
      title: "开播提醒",
      dataIndex: "liveNotificationEnabled",
      width: 100,
      render: (v: boolean, room) => (
        <Switch
          checked={v}
          onChange={(checked) =>
            void setLiveNotification(room.id, checked).catch((e) =>
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
      title: "显示名",
      dataIndex: "displayName",
      width: 160,
      ellipsis: true,
      render: (v: string, r) =>
        editingDisplayName?.id === r.id ? (
          <Input
            autoFocus
            size="small"
            value={editingDisplayName.value}
            onChange={(event) =>
              setEditingDisplayName((current) =>
                current ? { ...current, value: event.target.value } : current,
              )
            }
            onPressEnter={() => void saveDisplayName(r)}
            onBlur={() => void saveDisplayName(r)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditingDisplayName(null);
            }}
          />
        ) : (
          <Space
            size={4}
            onDoubleClick={() =>
              setEditingDisplayName({ id: r.id, value: r.displayName })
            }
            style={{ cursor: "text" }}
          >
            <span>{v || "-"}</span>
            {r.titleFallbackUsed ? (
              <Tooltip title="回退/占位标题，平台接口未返回正式标题">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  （回退）
                </Typography.Text>
              </Tooltip>
            ) : null}
          </Space>
        ),
    },
    {
      title: "标签",
      dataIndex: "tags",
      width: 120,
      render: (ts: Room["tags"]) =>
        ts.length === 0 ? (
          <Typography.Text type="secondary">-</Typography.Text>
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
      title: "链接",
      dataIndex: "url",
      width: 300,
      ellipsis: true,
      render: (u: string) => (
        <Typography.Link copyable={{ text: u }} href={u} target="_blank">
          {u}
        </Typography.Link>
      ),
    },
    {
      title: "状态",
      dataIndex: "monitorState",
      width: 100,
      render: (s) => <MonitorStateTag state={s} />,
    },
    {
      title: "最近错误",
      dataIndex: "lastError",
      width: 180,
      ellipsis: true,
      render: (e: Room["lastError"]) =>
        e ? <Typography.Text type="danger">{e.message}</Typography.Text> : "-",
    },
    {
      title: "最近检测",
      dataIndex: "lastCheckedAt",
      width: 110,
      render: (t) => formatRelative(t),
    },
    {
      title: "启用",
      dataIndex: "enabled",
      width: 70,
      render: (v: boolean, room) => (
        <Switch
          checked={v}
          onChange={(checked) =>
            void toggleRoom(room.id, checked).catch((e) =>
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
      title: "操作",
      width: 220,
      fixed: "right" as const,
      render: (_, room) => (
        <Space size={0}>
          <Button
            size="small"
            type="link"
            icon={<EditOutlined />}
            onClick={() => openEdit(room)}
          >
            编辑
          </Button>
          <Button
            size="small"
            type="link"
            icon={<ScheduleOutlined />}
            onClick={() => setScheduleRoom(room)}
          >
            计划
          </Button>
          <Button
            size="small"
            type="link"
            danger
            icon={<DeleteOutlined />}
            onClick={() => confirmDeleteRooms([room])}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];
}
