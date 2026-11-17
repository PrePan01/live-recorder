import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchDanmakuListPage, type DanmakuListPage } from "./danmaku";
import { createDanmakuListSession, createRecordingPreviewListReader, notifyDanmakuSaved } from "./danmakuListSession";

vi.mock("./danmaku", () => ({ fetchDanmakuListPage: vi.fn() }));
const fetchPage = vi.mocked(fetchDanmakuListPage);
const first: DanmakuListPage = { messages: [], next: "123", resumeCursor: "123" };
const tail: DanmakuListPage = { messages: [], next: null, resumeCursor: "456" };

beforeEach(() => {
  vi.useFakeTimers();
  fetchPage.mockReset();
});
afterEach(() => vi.useRealTimers());

it("catches up, follows the completed-line cursor, and retries from it after failure", async () => {
  const onFailure = vi.fn();
  fetchPage.mockResolvedValueOnce(first).mockResolvedValueOnce(tail).mockRejectedValueOnce(new Error()).mockResolvedValue(tail);
  const session = createDanmakuListSession("live", true, vi.fn(), onFailure);
  await session.load();
  expect(fetchPage).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(50);
  expect(fetchPage).toHaveBeenLastCalledWith("live", "123", expect.any(AbortSignal));
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetchPage).toHaveBeenLastCalledWith("live", "456", expect.any(AbortSignal));
  expect(onFailure).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetchPage).toHaveBeenLastCalledWith("live", "456", expect.any(AbortSignal));
  session.close();
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetchPage).toHaveBeenCalledTimes(4);
});

it("loads history pages on demand and stops at the end", async () => {
  fetchPage.mockResolvedValueOnce(first).mockResolvedValueOnce(tail);
  const session = createDanmakuListSession("history", false, vi.fn(), vi.fn());
  await session.load();
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetchPage).toHaveBeenCalledTimes(1);
  await session.load();
  expect(fetchPage).toHaveBeenLastCalledWith("history", "123", expect.any(AbortSignal));
  await session.load();
  expect(fetchPage).toHaveBeenCalledTimes(2);
  session.close();
});

it("reads and follows the preview cache using its own cursor, without requesting a recording", async () => {
  const readPreviewPage = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(tail);
  const session = createDanmakuListSession("preview:room", true, vi.fn(), vi.fn(), readPreviewPage, "0");
  await session.load();
  expect(readPreviewPage).toHaveBeenLastCalledWith("0", expect.any(AbortSignal));
  await vi.advanceTimersByTimeAsync(50);
  expect(readPreviewPage).toHaveBeenLastCalledWith("123", expect.any(AbortSignal));
  await vi.advanceTimersByTimeAsync(2000);
  expect(readPreviewPage).toHaveBeenLastCalledWith("456", expect.any(AbortSignal));
  expect(fetchPage).not.toHaveBeenCalled();
  session.close();
  await vi.advanceTimersByTimeAsync(5000);
  expect(readPreviewPage).toHaveBeenCalledTimes(3);
});

it("reads the temporary cache once and polls the recording using a separate cursor", async () => {
  const readCachePage = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(tail);
  fetchPage.mockResolvedValue(tail);
  const session = createDanmakuListSession(
    "active", true, vi.fn(), vi.fn(), createRecordingPreviewListReader("active", readCachePage), "0",
  );
  await session.load();
  await vi.advanceTimersByTimeAsync(100);
  expect(readCachePage.mock.calls.map(([cursor]) => cursor)).toEqual(["0", "123"]);
  expect(fetchPage).toHaveBeenLastCalledWith("active", "0", expect.any(AbortSignal));
  notifyDanmakuSaved("active");
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchPage).toHaveBeenLastCalledWith("active", "456", expect.any(AbortSignal));
  expect(readCachePage).toHaveBeenCalledTimes(2);
  session.close();
});

it("refreshes immediately for the active recording and coalesces saves during an in-flight read", async () => {
  let finish!: (page: DanmakuListPage) => void;
  fetchPage.mockResolvedValueOnce(tail)
    .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue(tail);
  const session = createDanmakuListSession("active", true, vi.fn(), vi.fn());
  await session.load();
  notifyDanmakuSaved("other");
  expect(fetchPage).toHaveBeenCalledTimes(1);

  notifyDanmakuSaved("active");
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(fetchPage).toHaveBeenLastCalledWith("active", "456", expect.any(AbortSignal));
  notifyDanmakuSaved("active");
  notifyDanmakuSaved("active");
  expect(fetchPage).toHaveBeenCalledTimes(2);
  finish({ ...tail, resumeCursor: "500" });
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchPage).toHaveBeenCalledTimes(3);
  expect(fetchPage).toHaveBeenLastCalledWith("active", "500", expect.any(AbortSignal));
  session.close();
  notifyDanmakuSaved("active");
  expect(fetchPage).toHaveBeenCalledTimes(3);
});

it("drops a late response when the list closes or the recording changes", async () => {
  let finish!: (page: DanmakuListPage) => void;
  fetchPage
    .mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce(tail);
  const oldPage = vi.fn();
  const old = createDanmakuListSession("old", true, oldPage, vi.fn());
  const pending = old.load();
  await old.load();
  expect(fetchPage).toHaveBeenCalledTimes(1);
  old.close();
  expect(fetchPage.mock.calls[0]![2].aborted).toBe(true);

  const newPage = vi.fn();
  const current = createDanmakuListSession("new", false, newPage, vi.fn());
  await current.load();
  finish(first);
  await pending;
  await vi.advanceTimersByTimeAsync(10000);
  expect(oldPage).not.toHaveBeenCalled();
  expect(newPage).toHaveBeenCalledExactlyOnceWith(tail);
  expect(fetchPage).toHaveBeenLastCalledWith("new", "0", expect.any(AbortSignal));
  expect(fetchPage).toHaveBeenCalledTimes(2);
  current.close();
});

it("starts live at the tail, resumes incrementally and reopens without fetching old pages", async () => {
  fetchPage.mockResolvedValue({ ...tail, previous: "123" });
  const current = createDanmakuListSession("active", true, vi.fn(), vi.fn());
  await current.load();
  expect(fetchPage).toHaveBeenLastCalledWith("active", "latest", expect.any(AbortSignal));
  await vi.advanceTimersByTimeAsync(50);
  expect(fetchPage).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1950);
  expect(fetchPage).toHaveBeenLastCalledWith("active", "456", expect.any(AbortSignal));
  current.close();

  const next = createDanmakuListSession("active", true, vi.fn(), vi.fn());
  await next.load();
  expect(fetchPage).toHaveBeenLastCalledWith("active", "latest", expect.any(AbortSignal));
  next.close();
});

it("keeps the temporary prefix separate when jumping to the current recording tail", async () => {
  const cache = { id: "before", text: "preview", tMs: null, wallMs: 0, beforeRecording: true };
  const saved = { id: "after", text: "recorded", tMs: 0, wallMs: 0 };
  const cacheReader = vi.fn().mockResolvedValue({ ...tail, messages: [cache], cacheTruncated: true });
  fetchPage.mockResolvedValueOnce({ ...tail, messages: [saved] })
    .mockResolvedValueOnce({ ...tail, messages: [saved], previous: "123" });
  const reader = createRecordingPreviewListReader("active", cacheReader);
  const signal = new AbortController().signal;
  expect(await reader("latest", signal)).toMatchObject({
    messages: [cache, saved], resumeCursor: "recording:456", cacheTruncated: true,
  });
  expect(await reader("latest", signal)).toMatchObject({ messages: [saved], previous: "recording:123" });
});

it("reads older pages on demand and resumes live polling from the end of the newer page", async () => {
  const onPage = vi.fn();
  fetchPage.mockResolvedValue(tail);
  const session = createDanmakuListSession("active", true, onPage, vi.fn());
  await session.load();
  const older = await session.readEdge("before:123");
  expect(older).toEqual(tail);
  expect(fetchPage).toHaveBeenLastCalledWith("active", "before:123", expect.any(AbortSignal));
  notifyDanmakuSaved("active");
  await vi.advanceTimersByTimeAsync(5000);
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(onPage).toHaveBeenCalledOnce();
  session.resume("789");
  expect(fetchPage).toHaveBeenLastCalledWith("active", "789", expect.any(AbortSignal));
  session.close();
});

it("lazy loads the preview cache only after reaching the beginning of the recording", async () => {
  const row = { id: "saved", text: "saved", tMs: 0, wallMs: 0 };
  const cache = vi.fn().mockResolvedValue({ ...tail, previous: "20", rowCursors: ["20"] });
  fetchPage.mockResolvedValueOnce({ ...tail, messages: [row], rowCursors: ["0"], previous: null })
    .mockResolvedValueOnce({ ...tail, previous: null });
  const reader = createRecordingPreviewListReader("active", cache);
  const signal = new AbortController().signal;
  expect(await reader("before:recording:123", signal)).toMatchObject({
    messages: [row], rowCursors: ["recording:0"], previous: "recording:0",
  });
  expect(cache).not.toHaveBeenCalled();
  expect(await reader("before:recording:0", signal)).toMatchObject({ previous: "20" });
  expect(cache).toHaveBeenCalledExactlyOnceWith("latest", signal);
});
