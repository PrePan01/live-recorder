import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Checkbox, Input, Tag, Tooltip, Typography } from "antd";
import {
  DeleteOutlined,
  EditOutlined,
  HolderOutlined,
  ScheduleOutlined,
  StarFilled,
  StarOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import type { Room } from "../../../types/room";
import { useRoomStore } from "../../../stores/roomStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { useRoomSortableItem } from "../../../components/RoomSortable";
import { PlatformLogoTag } from "../../../components/PlatformLogo";
import { MonitorStateTag } from "../../../components/StatusTags";
import RoomAvatar from "../../Monitor/components/RoomAvatar";
import { ApiError } from "../../../types/error";
import { describeError } from "../../../utils/errorMap";
import {
  roomPolicy,
  DEFAULT_ROOM_POLICY,
  isDefaultPolicy,
  type RoomPolicy,
} from "../model/roomPolicy";
import RoomPolicyFields, { RoomEnabledControl } from "./RoomPolicyFields";

const errorText = (error: unknown) =>
  error instanceof ApiError
    ? describeError(error.code, error.message)
    : "保存失败，请重试";

export default memo(function RoomManagementCard({
  room,
  selected,
  onSelect,
  onEdit,
  onSchedule,
  onDelete,
}: {
  room: Room;
  selected: boolean;
  onSelect: (id: string, selected: boolean) => void;
  onEdit: (room: Room) => void;
  onSchedule: (room: Room) => void;
  onDelete: (rooms: Room[]) => void;
}) {
  const settings = useSettingsStore((s) => s.settings);
  const editRoom = useRoomStore((s) => s.editRoom);
  const favoriteRoom = useRoomStore((s) => s.favoriteRoom);
  const [draft, setDraft] = useState<RoomPolicy>({});
  const pendingDraft = useRef<RoomPolicy>({});
  const policySaveVersion = useRef(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [favoriteError, setFavoriteError] = useState("");
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const { setNodeRef, style, attributes, listeners } = useRoomSortableItem(
    room.id,
    "management",
  );
  const policy: RoomPolicy = { ...roomPolicy(room), ...draft };
  useEffect(() => {
    if (
      saving ||
      error ||
      pendingDraft.current !== draft ||
      !Object.keys(draft).length
    )
      return;
    const confirmed = roomPolicy(room);
    if (
      (Object.keys(draft) as (keyof RoomPolicy)[]).every(
        (key) => draft[key] === confirmed[key],
      )
    ) {
      pendingDraft.current = {};
      setDraft({});
    }
  }, [room, draft, saving, error]);
  const tagsRef = useRef<HTMLDivElement>(null);
  const [visibleTagCount, setVisibleTagCount] = useState(room.tags.length);
  useLayoutEffect(() => {
    const el = tagsRef.current;
    if (!el) return;
    const measure = () => {
      const nodes = Array.from(
        el.querySelectorAll<HTMLElement>("[data-tag-index]"),
      );
      if (nodes.length === 0) {
        setVisibleTagCount(0);
        return;
      }
      const gap = 4;
      let used = 0;
      let fits = 0;
      for (let i = 0; i < nodes.length; i++) {
        const width = nodes[i].offsetWidth + (i > 0 ? gap : 0);
        if (used + width > el.clientWidth) break;
        used += width;
        fits++;
      }
      setVisibleTagCount(Math.max(Math.min(fits, nodes.length), 1));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [room.tags]);
  const hiddenTags = room.tags.slice(visibleTagCount);
  const save = async (patch: RoomPolicy) => {
    const version = ++policySaveVersion.current;
    const next = { ...pendingDraft.current, ...patch };
    pendingDraft.current = next;
    setDraft(next);
    setSaving(true);
    setError("");
    try {
      await editRoom(room.id, next);
    } catch (error) {
      if (version === policySaveVersion.current) setError(errorText(error));
    } finally {
      if (version === policySaveVersion.current) setSaving(false);
    }
  };
  const saveName = async () => {
    if (name === null || nameSaving) return;
    if (name.trim() === room.displayName) {
      setName(null);
      return;
    }
    setNameSaving(true);
    setNameError("");
    try {
      await editRoom(room.id, { displayName: name.trim() });
      setName(null);
    } catch (error) {
      setNameError(errorText(error));
    } finally {
      setNameSaving(false);
    }
  };
  return (
    <article
      ref={setNodeRef}
      style={style}
      data-room-id={room.id}
      aria-busy={saving}
      className={`lr-room-management-card lr-broadcast-channel${selected ? " is-selected" : ""}${policy.enabled ? "" : " is-disabled"}${room.monitorState === "recording" ? " is-recording" : ""}`}
    >
      <div className="lr-room-policy-identity">
        <div className="lr-room-policy-identity-top">
          <Checkbox
            aria-label={`选择 ${room.displayName}`}
            checked={selected}
            onChange={(event) => onSelect(room.id, event.target.checked)}
          />
          <button
            type="button"
            className="lr-room-policy-drag"
            aria-label={`拖动排序 ${room.displayName}`}
            {...attributes}
            {...listeners}
          >
            <HolderOutlined />
          </button>
        </div>
        <div className="lr-room-policy-identity-main">
          <div className="lr-room-policy-profile">
            <RoomAvatar
              platform={room.platform}
              roomId={room.id}
              avatarUrl={room.avatarUrl}
              name={room.displayName}
              live={room.lastLiveStatus === "live"}
              size={44}
            />
          </div>
          <div className="lr-room-policy-name">
            <PlatformLogoTag platform={room.platform} />
            {name !== null ? (
              <Input
                autoFocus
                aria-label="显示名"
                value={name}
                disabled={nameSaving}
                onChange={(event) => setName(event.target.value)}
                onBlur={() => void saveName()}
                onPressEnter={() => void saveName()}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setName(null);
                    setNameError("");
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="lr-room-policy-name-button"
                title={`${room.displayName || "待识别主播"} · 点击修改显示名`}
                onClick={() => setName(room.displayName)}
              >
                <span className="lr-room-policy-name-text">
                  {room.displayName || "待识别主播"}
                </span>
                <EditOutlined />
              </button>
            )}
            <Button
              type="text"
              size="small"
              className="lr-room-policy-favorite"
              loading={favoriteBusy}
              aria-label={`${room.favorited ? "取消收藏" : "收藏"} ${room.displayName}`}
              icon={room.favorited ? <StarFilled /> : <StarOutlined />}
              onClick={() => {
                setFavoriteBusy(true);
                setFavoriteError("");
                void favoriteRoom(room.id, !room.favorited)
                  .catch((error) => setFavoriteError(errorText(error)))
                  .finally(() => setFavoriteBusy(false));
              }}
            />
          </div>
          {favoriteError && (
            <span role="alert" className="lr-room-policy-error">
              {favoriteError}
            </span>
          )}
          {nameError && (
            <span role="alert" className="lr-room-policy-error">
              {nameError}
            </span>
          )}
          <div className="lr-room-policy-state-row">
            <div className="lr-channel-state">
              <MonitorStateTag state={room.monitorState} />
            </div>
            <div className="lr-room-policy-tags">
              <div className="lr-room-policy-tags-row" ref={tagsRef}>
                {room.tags.map((tag, index) => (
                  <Tag
                    color={tag.color}
                    key={tag.id}
                    title={tag.name}
                    data-tag-index={index}
                    className={
                      index < visibleTagCount ? undefined : "lr-room-tag-ghost"
                    }
                  >
                    {tag.name}
                  </Tag>
                ))}
              </div>
              {hiddenTags.length > 0 && (
                <Tooltip title={hiddenTags.map((tag) => tag.name).join("、")}>
                  <span
                    className="lr-room-tags-more"
                    aria-label={`还有 ${hiddenTags.length} 个标签`}
                  >
                    +{hiddenTags.length}
                  </span>
                </Tooltip>
              )}
            </div>
          </div>

          {room.lastError && (
            <Tooltip title={room.lastError.message}>
              <span className="lr-room-policy-error lr-room-policy-last-error">
                {room.lastError.message}
              </span>
            </Tooltip>
          )}
        </div>
        <div className="lr-channel-power">
          <RoomEnabledControl
            compact
            enabled={draft.enabled ?? room.enabled}
            onChange={(enabled) => void save({ enabled })}
          />
          <Typography.Link
            className="lr-room-policy-url"
            href={room.liveRoomUrl ?? room.url}
            target="_blank"
            rel="noreferrer"
            copyable={{ text: room.url, tooltips: ["复制链接", "已复制"] }}
            title={room.url}
          >
            <span>打开直播间 ↗</span>
          </Typography.Link>
        </div>
      </div>
      <div className="lr-room-policy-settings">
        <RoomPolicyFields
          value={policy}
          settings={settings}
          platform={room.platform}
          effective={room.effective}
          onChange={(patch) => void save(patch)}
          hideEnabled
          presentation="console"
          status={
            error ? (
              <span className="lr-room-policy-error" role="alert">
                {error}
                <Button
                  size="small"
                  type="link"
                  disabled={saving}
                  onClick={() => void save({})}
                >
                  重试
                </Button>
              </span>
            ) : undefined
          }
        />
        {!isDefaultPolicy(policy) && (
          <div className="lr-room-policy-reset">
            <Button
              type="text"
              size="small"
              className="lr-room-policy-url"
              icon={<UndoOutlined />}
              disabled={saving}
              aria-label={`恢复 ${room.displayName || "直播间"} 的默认设置`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void save(DEFAULT_ROOM_POLICY)}
            >
              恢复默认
            </Button>
          </div>
        )}
      </div>
      <nav
        className="lr-room-management-actions"
        aria-label={`${room.displayName} 的操作`}
      >
        <Tooltip title="编辑" placement="left">
          <Button
            type="text"
            icon={<EditOutlined />}
            aria-label={`编辑 ${room.displayName}`}
            onClick={() => onEdit(room)}
          />
        </Tooltip>
        <Tooltip title="定时计划" placement="left">
          <Button
            type="text"
            icon={<ScheduleOutlined />}
            aria-label={`定时计划 ${room.displayName}`}
            onClick={() => onSchedule(room)}
          />
        </Tooltip>
        <Tooltip title="删除" placement="left">
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            aria-label={`删除 ${room.displayName}`}
            onClick={() => onDelete([room])}
          />
        </Tooltip>
      </nav>
    </article>
  );
});
