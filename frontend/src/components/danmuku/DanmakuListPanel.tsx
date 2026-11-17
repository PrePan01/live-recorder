import { MenuFoldOutlined } from "@ant-design/icons";
import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { App, Button, Tooltip } from "antd";
import dayjs from "dayjs";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { DanmakuListPage } from "../../api/danmaku";
import {
  createDanmakuListSession,
  type DanmakuListPageReader,
} from "../../api/danmakuListSession";
import type { DanmakuMessage } from "../../types/danmaku";
import { playbackClock } from "../../utils/player/playbackClock";
import { useDanmakuListResize } from "./useDanmakuListResize";

const DEFAULT_ROW_HEIGHT = 36;
const OVERSCAN = 5;
const CHUNK_SIZE = 512;
const MAX_LIVE_ROWS = 1000;
const MAX_LIVE_TEXT_BYTES = 2 * 1024 * 1024;

interface SavedRows {
  chunks: DanmakuMessage[][];
  count: number;
  startIndex: number;
  rowCursors: string[];
  previous: string | null;
  next: string | null;
  firstRecordedIndex: number | null;
}

const EMPTY_ROWS: SavedRows = {
  chunks: [],
  count: 0,
  startIndex: 0,
  rowCursors: [],
  previous: null,
  next: null,
  firstRecordedIndex: null,
};

function appendRows(
  previous: SavedRows,
  messages: DanmakuMessage[],
): SavedRows {
  if (messages.length === 0) return previous;
  const chunks = previous.chunks.slice();
  const tailLength = previous.count % CHUNK_SIZE;
  const fill = tailLength === 0 ? 0 : CHUNK_SIZE - tailLength;
  if (fill > 0) chunks.push(chunks.pop()!.concat(messages.slice(0, fill)));
  for (let index = fill; index < messages.length; index += CHUNK_SIZE) {
    chunks.push(messages.slice(index, index + CHUNK_SIZE));
  }
  let firstRecordedIndex = previous.firstRecordedIndex;
  if (firstRecordedIndex === null) {
    const offset = messages.findIndex((row) => !row.beforeRecording);
    if (offset !== -1) firstRecordedIndex = previous.count + offset;
  }
  return {
    ...previous,
    chunks,
    count: previous.count + messages.length,
    firstRecordedIndex,
  };
}

function mergeLiveRows(
  previous: SavedRows,
  page: DanmakuListPage,
  direction: "older" | "newer",
  next: string | null,
): SavedRows {
  const older = direction === "older";
  if (page.messages.length === 0) {
    const earlier =
      older || previous.count === 0
        ? (page.previous ?? null)
        : previous.previous;
    if (earlier === previous.previous && next === previous.next)
      return previous;
    return { ...previous, previous: earlier, next };
  }
  const current = previous.chunks.flat();
  const combined = older
    ? page.messages.concat(current)
    : current.concat(page.messages);
  const pageCursors = page.rowCursors ?? page.messages.map(() => "");
  const cursors = older
    ? pageCursors.concat(previous.rowCursors)
    : previous.rowCursors.concat(pageCursors);

  // Keep the edge the user is moving toward, and remember how to reload anything evicted.
  let retained = 0;
  let bytes = 0;
  while (retained < Math.min(combined.length, MAX_LIVE_ROWS)) {
    const row = combined[older ? retained : combined.length - retained - 1];
    bytes += 2 * (row.text.length + row.id.length);
    if (bytes > MAX_LIVE_TEXT_BYTES) break;
    retained++;
  }
  const start = older ? 0 : combined.length - retained;
  const end = start + retained;
  return {
    ...appendRows(EMPTY_ROWS, combined.slice(start, end)),
    startIndex:
      previous.startIndex + start - (older ? page.messages.length : 0),
    rowCursors: cursors.slice(start, end),
    previous:
      (start > 0 && cursors[start]) ||
      (older || previous.count === 0
        ? (page.previous ?? null)
        : previous.previous),
    next: (end < combined.length && cursors[end]) || next,
  };
}

export const DanmakuListPanel = memo(function DanmakuListPanel({
  id,
  listId,
  live,
  open,
  onExitComplete,
  onCollapse,
  onSeek,
  seekDisabled,
  readPage,
  previewOnly,
  playerRef,
}: {
  id: string;
  listId: string;
  live: boolean;
  open: boolean;
  onExitComplete: () => void;
  onCollapse: () => void;
  onSeek: (second: number) => void;
  seekDisabled: boolean;
  readPage?: DanmakuListPageReader | null;
  previewOnly: boolean;
  playerRef: RefObject<HTMLDivElement | null>;
}) {
  const { message } = App.useApp();
  const panelRef = useRef<HTMLElement>(null);
  const { preferredHeight, maxHeight, resizeProps } = useDanmakuListResize(
    panelRef,
    playerRef,
    open,
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  // Only the last chunk is copied when a page arrives.
  const [rows, setRows] = useState(EMPTY_ROWS);
  const { chunks, count, startIndex, firstRecordedIndex } = rows;
  const isPreview = previewOnly;
  const dividerIndex =
    !isPreview && count > 0 && firstRecordedIndex !== 0
      ? (firstRecordedIndex ?? count)
      : null;
  const itemCount = count + (dividerIndex === null ? 0 : 1);
  const [scrollTop, setScrollTop] = useState(0);
  const [{ height, rowHeight }, setViewportSize] = useState({
    height: 0,
    rowHeight: DEFAULT_ROW_HEIGHT,
  });
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [hasNext, setHasNext] = useState(false);
  const [edgeStatus, setEdgeStatus] = useState<{
    direction: "older" | "newer";
    failed: boolean;
  } | null>(null);
  const edgePending = useRef(false);
  const latestCursor = useRef("latest");
  const lastPosition = useRef({
    startIndex: 0,
    dividerIndex: null as number | null,
  });
  const programmaticTop = useRef<number | null>(null);
  const [cacheTruncated, setCacheTruncated] = useState(false);
  const [cacheSkipped, setCacheSkipped] = useState(false);
  const [pointerInside, setPointerInside] = useState(false);
  const stickToTail = useRef(true);
  const committedRowHeight = useRef(DEFAULT_ROW_HEIGHT);
  const resizeScrollTop = useRef<number | undefined>(undefined);
  const sessionRef = useRef<ReturnType<typeof createDanmakuListSession> | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!open || readPage === null) return;
    let firstPage = true;
    stickToTail.current = true;
    setEdgeStatus(null);
    setStatus("loading");
    const session = createDanmakuListSession(
      listId,
      live,
      (page) => {
        const { messages, next, cacheTruncated, cacheSkipped } = page;
        latestCursor.current = next ?? page.resumeCursor;
        const reset = firstPage;
        firstPage = false;
        setRows((previous) => {
          const base = reset ? EMPTY_ROWS : previous;
          return live
            ? mergeLiveRows(base, page, "newer", null)
            : appendRows(base, messages);
        });
        if (cacheTruncated) setCacheTruncated(true);
        if (cacheSkipped) setCacheSkipped(true);
        setHasNext(next !== null);
        setStatus("ready");
      },
      () => setStatus("error"),
      readPage,
    );
    sessionRef.current = session;
    const initialLoad = setTimeout(session.load, 0);
    return () => {
      clearTimeout(initialLoad);
      session.close();
      edgePending.current = false;
      sessionRef.current = null;
    };
  }, [listId, live, open, readPage]);

  useLayoutEffect(() => {
    if (open) return;
    let cancelled = false;
    const animations = panelRef.current?.getAnimations?.() ?? [];
    // Reduced motion disables the animation, so there may be no exit to wait for.
    void Promise.allSettled(
      animations.map((animation) => animation.finished),
    ).then(() => {
      if (!cancelled) onExitComplete();
    });
    return () => {
      cancelled = true;
    };
  }, [open, onExitComplete]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      const nextHeight = viewport.clientHeight;
      const nextRowHeight =
        parseFloat(
          getComputedStyle(viewport).getPropertyValue(
            "--lr-danmaku-row-height",
          ),
        ) || DEFAULT_ROW_HEIGHT;
      if (nextRowHeight !== committedRowHeight.current) {
        resizeScrollTop.current =
          viewport.scrollTop * (nextRowHeight / committedRowHeight.current);
      }
      setViewportSize((previous) =>
        previous.height === nextHeight && previous.rowHeight === nextRowHeight
          ? previous
          : { height: nextHeight, rowHeight: nextRowHeight },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const previous = lastPosition.current;
    const resized = resizeScrollTop.current;
    const anchor = resized ?? viewport.scrollTop;
    const topRow = Math.floor(anchor / rowHeight);
    const oldDividerBefore =
      previous.dividerIndex !== null && topRow >= previous.dividerIndex ? 1 : 0;
    const contentRow =
      topRow - oldDividerBefore + previous.startIndex - startIndex;
    const newDividerBefore =
      dividerIndex !== null && contentRow >= dividerIndex ? 1 : 0;
    const shift =
      previous.startIndex - startIndex + newDividerBefore - oldDividerBefore;
    const target =
      live && rows.next === null && stickToTail.current
        ? viewport.scrollHeight
        : resized === undefined && shift === 0
          ? undefined
          : Math.max(0, anchor + shift * rowHeight);
    resizeScrollTop.current = undefined;
    committedRowHeight.current = rowHeight;
    lastPosition.current = { startIndex, dividerIndex };
    if (target === undefined) return;
    viewport.scrollTop = target;
    programmaticTop.current = viewport.scrollTop;
    setScrollTop(viewport.scrollTop);
  }, [dividerIndex, height, itemCount, live, rowHeight, rows.next, startIndex]);

  const loadEdge = useCallback(
    async (direction: "older" | "newer") => {
      const session = sessionRef.current;
      const boundary = direction === "older" ? rows.previous : rows.next;
      if (!open || !session || !boundary || edgePending.current) return;
      edgePending.current = true;
      setEdgeStatus({ direction, failed: false });
      try {
        const page = await session.readEdge(
          direction === "older" ? `before:${boundary}` : boundary,
        );
        if (!page || sessionRef.current !== session) return;
        const next =
          direction === "older"
            ? (rows.next ?? latestCursor.current)
            : page.next;
        // A forward history page extends the window. Keep showing the same rows
        // until the user scrolls to the new end.
        if (direction === "newer" && page.messages.length)
          stickToTail.current = false;
        setRows((previous) => mergeLiveRows(previous, page, direction, next));
        if (page.cacheTruncated) setCacheTruncated(true);
        if (page.cacheSkipped) setCacheSkipped(true);
        if (next === null) {
          latestCursor.current = page.resumeCursor;
          session.resume(page.resumeCursor);
        }
        setEdgeStatus(null);
      } catch {
        if (sessionRef.current === session)
          setEdgeStatus({ direction, failed: true });
      } finally {
        if (sessionRef.current === session) edgePending.current = false;
      }
    },
    [open, rows.next, rows.previous],
  );

  const checkEdge = (
    viewport: HTMLDivElement,
    direction: "older" | "newer",
  ) => {
    if (!live || status === "loading" || edgeStatus?.failed) return;
    const distance =
      direction === "older"
        ? viewport.scrollTop
        : viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distance <= OVERSCAN * rowHeight) void loadEdge(direction);
  };

  const load = useCallback(() => {
    setStatus("loading");
    void sessionRef.current?.load();
  }, []);

  useLayoutEffect(() => {
    if (
      !live &&
      hasNext &&
      status === "ready" &&
      itemCount * rowHeight - scrollTop - height <= rowHeight * OVERSCAN
    ) {
      void sessionRef.current?.load();
    }
  }, [itemCount, hasNext, height, live, rowHeight, scrollTop, status]);

  const copy = async (text: string) => {
    try {
      if (isTauri()) await writeText(text);
      else await navigator.clipboard.writeText(text);
      message.success("已复制弹幕");
    } catch {
      message.error("复制弹幕失败");
    }
  };

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const end = Math.min(
    itemCount,
    Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN,
  );
  const empty = count === 0 && status === "ready";
  return (
    <aside
      id={id}
      ref={panelRef}
      className="lr-danmaku-list"
      {...resizeProps}
      style={
        {
          height: preferredHeight,
          "--lr-danmaku-list-max-height":
            maxHeight === undefined ? undefined : `${maxHeight}px`,
        } as CSSProperties
      }
      aria-labelledby={`${id}-title`}
      aria-hidden={!open || undefined}
      inert={!open}
      data-motion={open ? "enter" : "exit"}
      data-scrollbar-visible={open && pointerInside && !empty ? "" : undefined}
      onPointerEnter={(event) =>
        setPointerInside(event.pointerType === "mouse")
      }
      onPointerLeave={(event) => {
        setPointerInside(false);
        resizeProps.onPointerLeave(event);
      }}
    >
      <header className="lr-danmaku-list__title">
        <h2 id={`${id}-title`}>弹幕列表</h2>
        <Tooltip title="收起弹幕列表" trigger={["hover", "focus"]}>
          <Button
            className="lr-danmaku-list__collapse"
            type="text"
            size="small"
            icon={<MenuFoldOutlined />}
            aria-label="收起弹幕列表"
            onClick={onCollapse}
          />
        </Tooltip>
      </header>
      <div
        className="lr-danmaku-list__viewport"
        data-empty={empty ? "" : undefined}
        ref={viewportRef}
        tabIndex={0}
        aria-label={isPreview ? "预览弹幕" : "已保存弹幕"}
        onScroll={(event) => {
          const viewport = event.currentTarget;
          const top = viewport.scrollTop;
          setScrollTop(top);
          const positioned = programmaticTop.current === top;
          programmaticTop.current = null;
          if (positioned) return;
          stickToTail.current =
            viewport.scrollHeight - top - viewport.clientHeight <= rowHeight;
          if (top !== scrollTop)
            checkEdge(viewport, top < scrollTop ? "older" : "newer");
        }}
        onWheel={(event) => {
          if (event.deltaY < 0 && rows.previous) stickToTail.current = false;
          if (event.deltaY !== 0)
            checkEdge(
              event.currentTarget,
              event.deltaY < 0 ? "older" : "newer",
            );
        }}
        onKeyDown={(event) => {
          if (["Home", "PageUp", "ArrowUp"].includes(event.key)) {
            if (rows.previous) stickToTail.current = false;
            checkEdge(event.currentTarget, "older");
          } else if (["End", "PageDown", "ArrowDown"].includes(event.key)) {
            checkEdge(event.currentTarget, "newer");
          }
        }}
      >
        <ul
          className="lr-danmaku-list__rows"
          style={{ height: itemCount * rowHeight }}
        >
          {Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
            const index = start + offset;
            const style = { top: index * rowHeight, height: rowHeight };
            if (index === dividerIndex) {
              return (
                <li
                  key="recording-divider"
                  className="lr-danmaku-list__divider"
                  style={style}
                >
                  以下弹幕已保存 ↓
                </li>
              );
            }
            const rowIndex =
              dividerIndex !== null && index > dividerIndex ? index - 1 : index;
            const row =
              chunks[Math.floor(rowIndex / CHUNK_SIZE)][rowIndex % CHUNK_SIZE];
            const useLocalTime = isPreview || row.beforeRecording;
            const second =
              !useLocalTime &&
              row.tMs != null &&
              Number.isFinite(row.tMs) &&
              !row.unmappable
                ? row.tMs / 1000
                : null;
            const localTime =
              useLocalTime && row.wallMs != null ? dayjs(row.wallMs) : null;
            const timeLabel = localTime?.isValid()
              ? localTime.format("HH:mm:ss")
              : second === null
                ? "无可用时间"
                : playbackClock(second);
            const content = (
              <>
                <span className="lr-danmaku-list__time">{timeLabel}</span>
                <span className="lr-danmaku-list__text">{row.text}</span>
              </>
            );
            return (
              <li
                key={rows.rowCursors[rowIndex] || startIndex + rowIndex}
                className="lr-danmaku-list__row"
                style={style}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void copy(row.text);
                }}
              >
                <Tooltip
                  title={
                    <div className="lr-danmaku-list__full-text">{row.text}</div>
                  }
                  trigger={["hover", "focus"]}
                >
                  {second === null ? (
                    <div className="lr-danmaku-list__item" tabIndex={0}>
                      {content}
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="lr-danmaku-list__item"
                      aria-disabled={seekDisabled}
                      onClick={() => {
                        if (!seekDisabled) onSeek(second);
                      }}
                    >
                      {content}
                    </button>
                  )}
                </Tooltip>
              </li>
            );
          })}
        </ul>
        {empty && (
          <div className="lr-danmaku-list__empty" role="status">
            {isPreview ? "正在采集弹幕" : "正在保存实时弹幕"}
          </div>
        )}
      </div>
      {(cacheTruncated || cacheSkipped) && (
        <div className="lr-danmaku-list__notice" role="status">
          {cacheTruncated && "预览缓存已达上限，仅保留最近弹幕。"}
          {cacheSkipped && "部分预览弹幕过长，未能缓存。"}
        </div>
      )}
      {edgeStatus && (
        <div className="lr-danmaku-list__notice" role="status">
          {edgeStatus.failed ? (
            <>
              弹幕读取失败{" "}
              <Button
                type="link"
                size="small"
                onClick={() => void loadEdge(edgeStatus.direction)}
              >
                重试
              </Button>
            </>
          ) : (
            "弹幕加载中…"
          )}
        </div>
      )}
      {status === "loading" && (
        <div className="lr-danmaku-list__notice" role="status">
          弹幕加载中…
        </div>
      )}
      {status === "error" && (
        <div className="lr-danmaku-list__notice" role="status">
          弹幕读取失败{" "}
          <Button type="link" size="small" onClick={load}>
            重试
          </Button>
        </div>
      )}
    </aside>
  );
});
