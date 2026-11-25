import { UnorderedListOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useDanmakuPrefsStore } from "../../stores/danmakuPrefsStore";
import type { DanmakuListPageReader } from "../../api/danmakuListSession";
import {
  LIVE_DANMAKU_LIST_GAP,
  REPLAY_DANMAKU_LIST_GAP,
  DANMAKU_LIST_MAX_WIDTH,
  DANMAKU_LIST_MIN_WIDTH,
  DANMAKU_LIST_WINDOW_GUTTER,
  danmakuListReservedWidth,
} from "../../utils/danmaku/danmakuListLayout";
import { DanmakuListPanel } from "./DanmakuListPanel";
import "../../styles/components/danmaku/danmaku-list.css";

export function useDanmakuListVisibility(listId: string | undefined) {
  const expanded = useDanmakuPrefsStore((s) => s.listExpanded);
  const setExpanded = useDanmakuPrefsStore((s) => s.setListExpanded);
  const open = Boolean(listId && expanded);
  const [retainedListId, setRetainedListId] = useState<string>();
  // Keep the closing panel in place only for the list it was opened for.
  if (
    retainedListId !== listId &&
    (open || retainedListId !== undefined)
  ) {
    setRetainedListId(open ? listId : undefined);
  }
  const showPanel = Boolean(
    listId && (open || retainedListId === listId),
  );
  const finishExit = useCallback(() => setRetainedListId(undefined), []);
  return { listId, open, showPanel, finishExit, setExpanded };
}

export function useDanmakuListModal({
  visibility,
  playerWidth,
  live,
  onSeek,
  seekDisabled = false,
  centerPlayer = false,
  suspended = false,
  readPage,
  previewOnly = false,
  toggleTitle = "弹幕列表",
}: {
  visibility: ReturnType<typeof useDanmakuListVisibility>;
  playerWidth: number;
  live: boolean;
  onSeek: (second: number) => void;
  seekDisabled?: boolean;
  centerPlayer?: boolean;
  suspended?: boolean;
  readPage?: DanmakuListPageReader | null;
  previewOnly?: boolean;
  toggleTitle?: string;
}) {
  const id = useId();
  const { listId, open, finishExit, setExpanded } = visibility;
  const showPanel = visibility.showPanel && !suspended;
  const gap = live ? LIVE_DANMAKU_LIST_GAP : REPLAY_DANMAKU_LIST_GAP;
  const reserve = danmakuListReservedWidth(centerPlayer, gap);
  const playerSize = showPanel
    ? `min(${playerWidth}px, max(1px, calc(100vw - ${reserve}px)))`
    : `${playerWidth}px`;
  const freeWidth = centerPlayer
    ? `(100vw - ${playerSize}) / 2 - ${DANMAKU_LIST_WINDOW_GUTTER + gap}px`
    : `100vw - ${playerSize} - ${2 * DANMAKU_LIST_WINDOW_GUTTER + gap}px`;
  const panelWidth = `clamp(${DANMAKU_LIST_MIN_WIDTH}px, calc(${freeWidth}), ${DANMAKU_LIST_MAX_WIDTH}px)`;
  const seekRef = useRef(onSeek);
  useLayoutEffect(() => {
    seekRef.current = onSeek;
  }, [onSeek]);
  const seek = useCallback((second: number) => seekRef.current(second), []);
  const toggleRef = useRef<HTMLButtonElement | HTMLAnchorElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const toggleList = () => {
    if (open && document.getElementById(id)?.contains(document.activeElement))
      toggleRef.current?.focus({ preventScroll: true });
    setExpanded(!open);
  };
  const collapse = useCallback(() => {
    setExpanded(false);
    toggleRef.current?.focus({ preventScroll: true });
  }, [setExpanded]);

  return {
    width:
      showPanel && !centerPlayer
        ? `calc(${playerSize} + ${gap}px + ${panelWidth})`
        : playerSize,
    toggleList,
    toggle: listId ? (
      <Tooltip title={toggleTitle}>
        <span className="lr-danmaku-list-toggle">
          <Button
            ref={toggleRef}
            type="text"
            size="small"
            icon={<UnorderedListOutlined />}
            aria-label="弹幕列表"
            aria-expanded={open}
            aria-controls={open ? id : undefined}
            onClick={toggleList}
          />
        </span>
      </Tooltip>
    ) : null,
    render: (player: ReactNode) => (
      <div
        className="lr-danmaku-list-layout"
        data-danmaku-centered={showPanel && centerPlayer ? "" : undefined}
        style={
          {
            "--lr-danmaku-player-width": playerSize,
            "--lr-danmaku-list-width": panelWidth,
            "--lr-danmaku-list-gap": `${gap}px`,
          } as CSSProperties
        }
      >
        <div className="lr-danmaku-list-layout__player" ref={playerRef}>{player}</div>
        {showPanel && listId && (
          <DanmakuListPanel
            key={listId}
            id={id}
            listId={listId}
            live={live}
            open={open}
            onExitComplete={finishExit}
            onCollapse={collapse}
            onSeek={seek}
            seekDisabled={seekDisabled}
            readPage={readPage}
            previewOnly={previewOnly}
            playerRef={playerRef}
          />
        )}
      </div>
    ),
  };
}
