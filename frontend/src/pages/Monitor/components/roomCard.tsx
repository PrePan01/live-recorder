import { memo, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Col,
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
  StopOutlined,
  VideoCameraAddOutlined,
} from "@ant-design/icons";
import { PlatformLogoTag } from "../../../components/PlatformLogo";
import RoomAvatar from "../../../components/RoomAvatar";
import RoomStats from "../../../components/RoomStats";
import RoomHealth from "../../../components/RoomHealth";
import LiveStatusTag from "../../../components/LiveStatusTag";
import LivePredictionBadge from "../../../components/LivePredictionBadge";
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
              {room.titleFallbackUsed ? (
                <Tooltip title="显示名为回退/占位来源，平台接口未返回正式标题">
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    （回退标题）
                  </Typography.Text>
                </Tooltip>
              ) : null}
            </Space>
          </>
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
