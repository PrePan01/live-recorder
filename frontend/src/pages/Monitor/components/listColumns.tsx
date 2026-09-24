// Monitor 拆分（task #61）：列表视图列定义——自 index.tsx 原样迁移为工厂函数；
// 闭包依赖改为显式入参（原标识符名），列体/渲染/错误文案/类名零改动。
import { Button, Popconfirm, Space, Tag, Typography } from "antd";
import type { App } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  EyeOutlined,
  LinkOutlined,
  ReloadOutlined,
  StarFilled,
  StarOutlined,
  StopOutlined,
  VideoCameraAddOutlined,
} from "@ant-design/icons";
import { ApiError } from "../../../types/error";
import { describeError } from "../../../utils/errorMap";
import { formatRelative } from "../../../utils/format";
import { PlatformLogoTag } from "../../../components/PlatformLogo";
import { MonitorStateTag } from "../../../components/StatusTags";
import LiveStatusTag from "../../../components/LiveStatusTag";
import type { Room } from "../../../types/room";

type MessageApi = ReturnType<typeof App.useApp>["message"];

export interface MonitorListColumnsDeps {
  favoriteRoom: (id: string, favorited: boolean) => Promise<unknown>;
  checkRoomNow: (id: string) => Promise<unknown>;
  startRoomRecording: (id: string) => Promise<unknown>;
  handleWatch: (room: Room) => void;
  onStopRoom: (room: Room) => void;
  actingRoomId: string | null;
  actingAction: string | null;
  recentStop: Record<string, number>;
  message: MessageApi;
}

export function buildMonitorListColumns(
  deps: MonitorListColumnsDeps,
): ColumnsType<Room> {
  const {
    favoriteRoom,
    checkRoomNow,
    startRoomRecording,
    handleWatch,
    onStopRoom,
    actingRoomId,
    actingAction,
    recentStop,
    message,
  } = deps;
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

  return listColumns;
}
