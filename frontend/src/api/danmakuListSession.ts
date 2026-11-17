import { fetchDanmakuListPage, type DanmakuListPage } from "./danmaku";
import { ApiError } from "../types/error";

const savedListeners = new Map<string, Set<() => void>>();
export type DanmakuListPageReader = (cursor: string, signal: AbortSignal) => Promise<DanmakuListPage>;

/** The live list reads the temporary prefix once, then follows the recording file. */
export function createRecordingPreviewListReader(
  recordingId: string,
  readCachePage: DanmakuListPageReader,
): DanmakuListPageReader {
  const prefix = "recording:";
  const recordingStart = prefix + "0";
  const before = "before:";
  const readRecording = async (cursor: string, signal: AbortSignal) => {
    const page = await fetchDanmakuListPage(recordingId, cursor, signal);
    return {
      ...page,
      next: page.next === null ? null : prefix + page.next,
      previous: page.previous == null ? null : prefix + page.previous,
      rowCursors: page.rowCursors?.map(offset => prefix + offset),
      resumeCursor: prefix + page.resumeCursor,
    };
  };

  return async (cursor, signal) => {
    const backwards = cursor.startsWith(before);
    const boundary = backwards ? cursor.slice(before.length) : cursor;
    if (cursor === "latest" || boundary.startsWith(prefix)) {
      const offset = boundary.startsWith(prefix) ? boundary.slice(prefix.length) : "latest";
      const recording = await readRecording(backwards ? before + offset : offset, signal);
      if ((!backwards && cursor !== "latest") || recording.previous !== null) return recording;
      // Finish the recording page before fetching the preceding cache page.
      if (backwards && recording.messages.length) return { ...recording, previous: recordingStart };
      // A backwards page at the recording's beginning crosses into the preview cache.
      try {
        const cache = await readCachePage("latest", signal);
        return {
          ...recording,
          messages: [...cache.messages, ...recording.messages],
          rowCursors: [...(cache.rowCursors ?? []), ...(recording.rowCursors ?? [])],
          previous: cache.previous ?? null,
          cacheTruncated: cache.cacheTruncated,
          cacheSkipped: cache.cacheSkipped,
        };
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "RESOURCE_NOT_FOUND") throw error;
        return recording;
      }
    }
    try {
      const page = await readCachePage(cursor, signal);
      return backwards ? page : { ...page, next: page.next ?? recordingStart };
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "RESOURCE_NOT_FOUND") throw error;
      return { messages: [], next: backwards ? null : recordingStart, resumeCursor: recordingStart };
    }
  };
}

export function notifyDanmakuSaved(recordingId: string) {
  for (const listener of savedListeners.get(recordingId) ?? []) listener();
}

/** One reader for the lifetime of an open list. */
export function createDanmakuListSession(
  recordingId: string,
  live: boolean,
  onPage: (page: DanmakuListPage) => void,
  onFailure: () => void,
  readPage?: DanmakuListPageReader,
  startCursor = live ? "latest" : "0",
) {
  const controller = new AbortController();
  let cursor = startCursor;
  let running = false;
  let paused = false;
  let revision = 0;
  const read = (cursor: string) => readPage
    ? readPage(cursor, controller.signal)
    : fetchDanmakuListPage(recordingId, cursor, controller.signal);
  let refreshPending = false;
  let hasMore = true;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const load = async () => {
    if (controller.signal.aborted || running || paused || !hasMore) return;
    clearTimeout(timer);
    running = true;
    refreshPending = false;
    let delay = 2000;
    const requestedRevision = revision;
    try {
      const page = await read(cursor);
      if (controller.signal.aborted || revision !== requestedRevision) return;
      cursor = page.next ?? page.resumeCursor;
      hasMore = live || page.next !== null;
      failures = 0;
      if (page.next !== null) delay = 50;
      onPage(page);
    } catch {
      if (controller.signal.aborted || revision !== requestedRevision) return;
      failures += 1;
      delay = Math.min(10000, 2000 * failures);
      onFailure();
    } finally {
      running = false;
      if (live && !paused && !controller.signal.aborted) {
        timer = setTimeout(load, refreshPending && failures === 0 ? 0 : delay);
      }
    }
  };

  const onSaved = () => {
    if (paused) return;
    if (running) refreshPending = true;
    else if (failures === 0) void load();
  };
  const listeners = live
    ? savedListeners.get(recordingId) ?? new Set<() => void>()
    : null;
  if (listeners) {
    listeners.add(onSaved);
    savedListeners.set(recordingId, listeners);
  }

  return {
    load,
    async readEdge(cursor: string) {
      paused = true;
      revision++;
      clearTimeout(timer);
      const page = await read(cursor);
      return controller.signal.aborted ? undefined : page;
    },
    resume(cursorAfterPage: string) {
      cursor = cursorAfterPage;
      failures = 0;
      paused = false;
      void load();
    },
    close() {
      controller.abort();
      clearTimeout(timer);
      if (listeners?.delete(onSaved) && listeners.size === 0) savedListeners.delete(recordingId);
    },
  };
}
