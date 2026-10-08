import { memo } from "react";
import {
  Button,
  Card,
  Popover,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  EyeOutlined,
  LinkOutlined,
  ReloadOutlined,
  StarFilled,
  StarOutlined,
  VideoCameraAddOutlined,
} from "@ant-design/icons";
import { PlatformLogoTag } from "../../../components/PlatformLogo";
import RecordingStopIcon from "../../../components/RecordingStopIcon";
import RoomWarningMarquee, { type RoomWarning } from "./RoomWarningMarquee";
import RoomCover from "./RoomCover";
import RoomAvatar from "./RoomAvatar";
import RoomStats from "./RoomStats";
import RoomHealth from "./RoomHealth";
import LiveStatusTag from "../../../components/LiveStatusTag";
import { RoomQualityLight } from "../../../components/QualityLight";
import LivePredictionBadge from "./LivePredictionBadge";
import { useRoomSortableItem } from "../../../components/RoomSortable";
import type { RoomInsight } from "../../../api/rooms";
import type { Room } from "../../../types/room";
import type { Quality } from "../../../types/settings";

export function SortableRoomCardItem({
  roomId,
  children,
}: {
  roomId: string;
  children: React.ReactNode;
}) {
  const sortable = useRoomSortableItem(roomId, "card");
  return (
    <div
      data-room-id={roomId}
      ref={sortable.setNodeRef}
      style={sortable.style}
      className={`lr-sortable-card ${sortable.disabled ? "lr-sortable-card--disabled" : ""} ${sortable.isDragging ? "lr-sort-dragging" : ""}`}
      {...sortable.listeners}
    >
      {children}
    </div>
  );
}

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

export const RoomCard = memo(function RoomCard({
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
  insightsLoading,
  insightsFailed,
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
  insightsLoading?: boolean;
  insightsFailed?: boolean;
  qualityPreference: Quality | null;
  bilibiliAuthorized: boolean;
  floatingEnabled: boolean;
  floatingReady: boolean;
}) {
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
  const warnings: RoomWarning[] = [];
  if (room.lastError) {
    const needsAuthorization =
      room.lastError.code === "PLATFORM_ACCESS_RESTRICTED" ||
      (room.platform === "douyin" &&
        room.lastError.code === "DOUYIN_COOKIE_EXPIRED");
    warnings.push(
      needsAuthorization
        ? {
            text: `平台访问受限，请`,
            action: {
              label: "检查授权",
              to: `/settings#${room.platform}-cookie`,
            },
          }
        : { text: room.lastError.message },
    );
  }
  if (qualityShortfall && bestAvailable) {
    warnings.push({
      text: `当前最高可观看、录制 ${qualityLabel(bestAvailable)}${offerBilibiliLogin ? "，" : ""}`,
      ...(offerBilibiliLogin
        ? {
            action: { label: "登录B站", to: "/settings#bilibili-cookie" },
            suffix: "可尝试获取更高画质",
          }
        : {}),
    });
  }
  return (
    <div className="lr-room-card__container">
      <Card
        className={`lr-room-card ${onAir ? "lr-room-card--live" : "lr-room-card--offline"} ${layout === "list" ? "lr-room-card--list" : ""}`}
        cover={
          warnings.length > 0 ? (
            <RoomWarningMarquee messages={warnings} />
          ) : undefined
        }
        title={
          <>
            <div className="lr-room-card__corner">
              <div className="lr-room-card__corner-rot">
                <Popover
                  content={
                    <div className="lr-room-card__avatar-preview">
                      <RoomAvatar
                        platform={room.platform}
                        avatarUrl={room.avatarUrl}
                        name={room.displayName}
                        live={onAir}
                        size={120}
                      />
                    </div>
                  }
                  mouseEnterDelay={0.15}
                  placement="rightTop"
                  trigger="hover"
                >
                  <span
                    className="lr-room-card__avatar-trigger"
                    aria-label="查看高清头像"
                  >
                    <RoomAvatar
                      platform={room.platform}
                      avatarUrl={room.avatarUrl}
                      name={room.displayName}
                      live={onAir}
                      size={40}
                    />
                  </span>
                </Popover>
                <span className="lr-room-card__corner-logo">
                  <PlatformLogoTag platform={room.platform} />
                </span>
              </div>
            </div>
            <Space className="lr-room-card__title-row" align="center">
              <Tooltip title={room.displayName}>
                <Typography.Text
                  className="lr-room-card__title"
                  strong
                  ellipsis
                >
                  {room.displayName}
                </Typography.Text>
              </Tooltip>
            </Space>
          </>
        }
        extra={
          <Space size={0} className="lr-room-card__header-actions">
            {recording ? (
              <RoomQualityLight recordingId={room.activeRecording?.recordingId} />
            ) : null}
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
                  aria-label={floatingEnabled ? "关闭录制按钮" : "启用录制按钮"}
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
              aria-label={room.favorited ? "取消收藏" : "收藏"}
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
        {onAir && layout === "card" ? (
          <>
            <RoomCover
              key={`${room.id}:${room.liveCoverUrl ?? ""}`}
              room={room}
            />
          </>
        ) : null}
        <Space className="lr-room-card__status" style={{ marginBottom: 10 }}>
          <LiveStatusTag status={room.lastLiveStatus} />
          {autoRecordEnabled ? (
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              自动录制
            </Tag>
          ) : null}
          {onAir ? (
            <LiveStatusTag
              status="live"
              streamTitle={
                room.currentStreamTitle?.trim() || "直播标题暂未获取"
              }
              titleOnly
            />
          ) : (
            <LivePredictionBadge insight={insight} hidden={recording} />
          )}
          {room.tags.map((t) => (
            <Tag key={t.id} color={t.color} style={{ marginInlineEnd: 0 }}>
              {t.name}
            </Tag>
          ))}
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
          <RoomHealth
            insight={insight}
            loading={insightsLoading}
            failed={insightsFailed}
          />
        </div>
        <div
          className={`lr-room-card__actions ${(onAir || recording) && layout === "card" ? "lr-room-card__actions--live" : ""}`}
        >
          <Tooltip title="立即检测">
            <Button
              size="middle"
              aria-label="立即检测"
              icon={<ReloadOutlined />}
              loading={acting && actingAction === "check"}
              disabled={acting || room.monitorState === "checking" || recording}
              onClick={() => onCheck(room)}
            >
              <span className="lr-room-card__action-label">立即检测</span>
            </Button>
          </Tooltip>
          <Tooltip title="打开直播间">
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
            <Tooltip title="观看直播">
              <Button
                size="middle"
                type="default"
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
              <Tooltip title="停止录制">
                <Button
                  size="middle"
                  danger
                  className="lr-record-stop-button"
                  aria-label="停止录制"
                  loading={acting && actingAction === "stop"}
                  icon={<RecordingStopIcon />}
                >
                  <span className="lr-room-card__action-label">停止录制</span>
                </Button>
              </Tooltip>
            </Popconfirm>
          ) : onAir ? (
            <Tooltip title="开始录制">
              <Button
                size="middle"
                type="primary"
                aria-label="开始录制"
                icon={<VideoCameraAddOutlined />}
                loading={acting && actingAction === "record"}
                disabled={acting || recentlyStopped || !onAir}
                onClick={() => onRecord(room)}
              >
                <span className="lr-room-card__action-label">开始录制</span>
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </Card>
    </div>
  );
});
