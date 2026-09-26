import {
  App,
  Button,
  Card,
  List,
  Popconfirm,
  Space,
  Tag,
  Typography,
} from "antd";
import { useNavigate } from "react-router-dom";
import { useAlertStore } from "../../../stores/alertStore";
import { useRoomStore } from "../../../stores/roomStore";
import { ApiError } from "../../../types/error";
import { describeError } from "../../../utils/errorMap";
import { formatTime } from "../../../utils/format";
import { ALERT_LEVEL_META, alertSourceText } from "../../../utils/alertText";

/** 告警卡：原 Settings/index 内联告警列表整块迁移（store 直连，含查看深链与 retryable 标注）。 */
export default function AlertsCard() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const rooms = useRoomStore((s) => s.rooms);
  const { alerts, markRead, markAllRead, clearAll, retryFailure, retryingId } =
    useAlertStore();
  return (
    <Card
      className="lr-alerts-card lr-settings-card"
      title="告警"
      extra={
        <Space size={8}>
          <Button
            size="small"
            onClick={() => {
              void markAllRead().catch(() => undefined);
            }}
          >
            全部已读
          </Button>
          <Popconfirm
            title="清除全部告警？"
            okText="清除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() =>
              clearAll()
                .then(() => message.success("已清除全部告警"))
                .catch(() => message.error("清除告警失败"))
            }
          >
            <Button size="small" danger disabled={alerts.length === 0}>
              清除全部
            </Button>
          </Popconfirm>
        </Space>
      }
    >
      <div tabIndex={0} aria-label="告警列表">
        <List
          dataSource={alerts}
          locale={{ emptyText: "暂无告警" }}
          renderItem={(a) => (
            <List.Item
              actions={
                a.resolved
                  ? [<Tag key="done">已读</Tag>]
                  : [
                      a.roomId && a.errorCode && a.retryable !== false ? (
                        <Button
                          key="retry"
                          size="small"
                          type="link"
                          loading={retryingId === a.id}
                          onClick={() =>
                            void retryFailure(a)
                              .then(() => message.success("已触发重新检测"))
                              .catch((e) =>
                                message.error(
                                  e instanceof ApiError
                                    ? describeError(e.code, e.message)
                                    : "重试失败",
                                ),
                              )
                          }
                        >
                          重试
                        </Button>
                      ) : null,
                      a.roomId ? (
                        <Button
                          key="view"
                          size="small"
                          type="link"
                          onClick={() =>
                            navigate(`/history?roomId=${a.roomId}`)
                          }
                        >
                          查看
                        </Button>
                      ) : null,
                      a.retryable === false ? (
                        <Tag key="manual">需人工处理</Tag>
                      ) : null,
                      <Button
                        key="read"
                        size="small"
                        type="link"
                        onClick={() => {
                          void markRead(a.id).catch(() => undefined);
                        }}
                      >
                        标记已读
                      </Button>,
                    ]
              }
            >
              <List.Item.Meta
                title={
                  <Space>
                    <Tag color={ALERT_LEVEL_META[a.level].color}>
                      {ALERT_LEVEL_META[a.level].text}
                    </Tag>
                    <Typography.Text>{a.message}</Typography.Text>
                  </Space>
                }
                description={
                  <Typography.Text type="secondary">
                    {a.roomId
                      ? `直播间：${rooms.find((room) => room.id === a.roomId)?.displayName || a.roomId} · `
                      : ""}
                    {alertSourceText(a.source)} · {formatTime(a.occurredAt)}
                  </Typography.Text>
                }
              />
            </List.Item>
          )}
        />
      </div>
    </Card>
  );
}
