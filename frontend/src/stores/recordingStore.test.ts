import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRecordingStore } from "./recordingStore";
import type { Recording } from "../types/recording";

function recording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: "rec-1",
    roomId: "room-1",
    roomName: "测试直播间",
    platform: "douyin",
    streamSessionId: null,
    streamTitle: "测试直播",
    quality: null,
    expectedQuality: null,
    integrity: null,
    state: "completed",
    pipelineStatus: null,
    upload: null,
    metadata: null,
    coverPath: null,
    startedAt: "2026-09-29T00:00:00.000Z",
    endedAt: "2026-09-29T01:00:00.000Z",
    filePath: "/recordings/test.flv",
    fileSizeBytes: 1024,
    failureReason: null,
    retryCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  useRecordingStore.setState({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    loading: false,
    query: {},
    completionNotice: null,
    pendingConfirm: null,
    pendingClipExport: null,
    clipExports: {},
    clipDoneQueue: [],
    historyLoaded: false,
    recordingSnapshots: {},
  });
});

describe("recording completion notices", () => {
  it("notifies for a normally completed recording received via SSE", () => {
    const rec = recording({ id: "rec-natural", endReason: "natural" });

    useRecordingStore
      .getState()
      .upsertRecordingFromEvent({ ...rec, state: "recording", endedAt: null });
    useRecordingStore.getState().upsertRecordingFromEvent(rec);

    expect(useRecordingStore.getState().completionNotice).toEqual(rec);
  });

  it("does not notify when startup recovery completes a service-restart recording", () => {
    useRecordingStore
      .getState()
      .upsertRecordingFromEvent(
        recording({ id: "rec-restarted", endReason: "service_restart" }),
      );

    expect(useRecordingStore.getState().completionNotice).toBeNull();
  });

  it("does not notify when startup integrity verification updates a historical completed recording", () => {
    useRecordingStore.getState().upsertRecordingFromEvent(
      recording({
        id: "rec-damaged-history",
        endReason: "stopped",
        integrity: "failed",
        integrityState: "failed",
      }),
    );

    expect(useRecordingStore.getState().completionNotice).toBeNull();
  });
});

describe("terminal state transitions via SSE", () => {
  it("keeps the stale-frame guard: a delayed frame cannot pull a terminal recording back to recording", () => {
    const rec = recording({ id: "rec-guard" });
    useRecordingStore.setState({ items: [rec], total: 1 });
    useRecordingStore
      .getState()
      .upsertRecordingFromEvent({ ...rec, state: "recording" });

    expect(useRecordingStore.getState().items[0]?.state).toBe("completed");
  });

  it("拦住已决策录制的迟到 awaiting 重放，确认框不重弹", () => {
    const rec = recording({ id: "rec-clip", endReason: "clip_export" });
    useRecordingStore.setState({ items: [rec], total: 1 });
    // 已完成的录制收到 SSE 重放的 awaiting 事件：过期帧一律拦死。
    useRecordingStore.getState().upsertRecordingFromEvent({
      ...rec,
      state: "awaiting_confirmation",
      endReason: "clip_export",
    });

    expect(useRecordingStore.getState().pendingConfirm).toBeNull();
    expect(useRecordingStore.getState().items[0]?.state).toBe("completed");
  });

  it("整段停录进入待确认仍照常弹框（合法推进不被拦）", () => {
    const rec = recording({
      id: "rec-awaiting",
      state: "recording",
      endedAt: null,
    });
    useRecordingStore.setState({ items: [rec], total: 1 });
    useRecordingStore
      .getState()
      .upsertRecordingFromEvent({
        ...rec,
        state: "awaiting_confirmation",
      });

    expect(useRecordingStore.getState().pendingConfirm?.id).toBe(
      "rec-awaiting",
    );
  });
});

describe("clip export prompt and background export", () => {
  it("等待后处理完成才通知，校验与后处理进度事件不会提前或重复通知", () => {
    const clip = recording({ id: "clip-pipeline-wait", origin: "clip", endReason: "clip_export" });
    const store = useRecordingStore.getState();
    store.upsertRecordingFromEvent({ ...clip, state: "processing" });
    store.upsertRecordingFromEvent({ ...clip, pipelineStatus: "queued" });
    expect(useRecordingStore.getState().clipDoneQueue).toEqual([]);
    // 请求响应晚于导出交接，不能把待后处理片段当成已结束。
    store.beginClipExport("source", clip.id);
    expect(useRecordingStore.getState().clipExports[clip.id]).toBe("source");
    store.upsertRecordingFromEvent({ ...clip, state: "processing", pipelineStatus: "queued" });
    store.upsertRecordingFromEvent({ ...clip, state: "processing", pipelineStatus: "running" });
    expect(useRecordingStore.getState().recordingSnapshots[clip.id]?.pipelineStatus).toBe("running");
    expect(useRecordingStore.getState().clipDoneQueue).toEqual([]);
    const done = { ...clip, pipelineStatus: "ok" as const };
    store.upsertRecordingFromEvent(done);
    expect(useRecordingStore.getState().clipDoneQueue).toEqual([done]);
    expect(useRecordingStore.getState().clipExports).toEqual({});
    store.clearClipDoneQueue();
    store.upsertRecordingFromEvent(done);
    expect(useRecordingStore.getState().clipDoneQueue).toEqual([]);
  });

  it("无需后处理时立即通知；不同片段的后处理互不影响", () => {
    const store = useRecordingStore.getState();
    const pending = recording({ id: "clip-still-running", origin: "clip", state: "processing", pipelineStatus: "running" });
    const ready = recording({ id: "clip-no-pipeline", origin: "clip", pipelineStatus: "not_required" });
    store.upsertRecordingFromEvent(pending);
    store.beginClipExport("source", ready.id);
    store.upsertRecordingFromEvent(ready);
    expect(useRecordingStore.getState().clipDoneQueue).toEqual([ready]);
    expect(Object.keys(useRecordingStore.getState().clipExports)).toEqual([pending.id]);
  });

  it.each(["failed", "partial"] as const)("后处理 %s 作为独立结果入队，不与成功混淆", pipelineStatus => {
    const store = useRecordingStore.getState();
    const clip = recording({ id: `clip-pipeline-${pipelineStatus}`, origin: "clip" });
    store.upsertRecordingFromEvent({ ...clip, state: "processing", pipelineStatus: "running" });
    store.upsertRecordingFromEvent({ ...clip, pipelineStatus });
    expect(useRecordingStore.getState().clipDoneQueue[0]?.pipelineStatus).toBe(pipelineStatus);
    expect(useRecordingStore.getState().clipExports).toEqual({});
  });

  it("片段完成 SSE 早于保存响应时，只发片段通知", () => {
    const clip = recording({ id: "clip-before-response", origin: "clip", endReason: "clip_export" });
    const store = useRecordingStore.getState();
    store.upsertRecordingFromEvent({ ...clip, state: "processing", endReason: undefined });
    store.upsertRecordingFromEvent(clip);
    expect(useRecordingStore.getState().completionNotice).toBeNull();
    expect(useRecordingStore.getState().clipDoneQueue).toEqual([clip]);
    store.beginClipExport("source", clip.id);
    expect(useRecordingStore.getState().clipExports).toEqual({});
    store.clearClipDoneQueue();
    // 列表外的片段也要忽略迟到进度，避免再次触发完成通知。
    store.upsertRecordingFromEvent({ ...clip, state: "processing" });
    store.upsertRecordingFromEvent(clip);
    expect(useRecordingStore.getState().completionNotice).toBeNull();
    expect(useRecordingStore.getState().clipDoneQueue).toEqual([]);
  });

  it("片段确认保存后不走普通录制完成通知", () => {
    const clip = recording({ id: "clip-after-confirm", endReason: "clip_export" });
    const store = useRecordingStore.getState();
    store.upsertRecordingFromEvent({ ...clip, state: "awaiting_confirmation" });
    store.upsertRecordingFromEvent(clip);
    expect(useRecordingStore.getState().completionNotice).toBeNull();
    expect(useRecordingStore.getState().clipDoneQueue).toEqual([clip]);
  });

  it("首次收到历史片段更新时不误报刚保存", () => {
    useRecordingStore.getState().upsertRecordingFromEvent(
      recording({ id: "historical-clip", origin: "clip", endReason: "clip_export" }),
    );
    expect(useRecordingStore.getState().completionNotice).toBeNull();
    expect(useRecordingStore.getState().clipDoneQueue).toEqual([]);
  });

  it("canceling the prompt leaves zero backend state", () => {
    useRecordingStore.getState().setPendingClipExport({
      recordingId: "rec-src",
      roomId: "room-1",
      startSecond: 0,
      endSecond: 30,
      defaultName: "测试直播间_片段",
    });
    expect(useRecordingStore.getState().pendingClipExport?.recordingId).toBe(
      "rec-src",
    );

    useRecordingStore.getState().clearPendingClipExport();
    expect(useRecordingStore.getState().pendingClipExport).toBeNull();
    expect(useRecordingStore.getState().clipExports).toEqual({});
    expect(useRecordingStore.getState().clipDoneQueue).toEqual([]);
  });

  it("routes a finished clip to the clip notice instead of the generic completion notice", () => {
    useRecordingStore.getState().beginClipExport("rec-src", "clip-1");
    const clip = recording({
      id: "clip-1",
      streamTitle: "测试直播间_片段",
      endReason: "clip_export",
    });
    useRecordingStore
      .getState()
      .upsertRecordingFromEvent({
        ...clip,
        state: "processing",
        endedAt: null,
        endReason: undefined,
      });
    useRecordingStore.getState().upsertRecordingFromEvent(clip);

    expect(useRecordingStore.getState().clipDoneQueue.map((r) => r.id)).toEqual([
      "clip-1",
    ]);
    expect(useRecordingStore.getState().completionNotice).toBeNull();
    expect(useRecordingStore.getState().clipExports).toEqual({});
  });

  it("surfaces a failed clip export with its failure reason", () => {
    useRecordingStore.getState().beginClipExport("rec-src", "clip-2");
    useRecordingStore.getState().upsertRecordingFromEvent(
      recording({
        id: "clip-2",
        state: "failed",
        endReason: null,
        failureReason: {
          code: "RECORDING_FILE_CORRUPTED",
          message: "片段导出失败",
          occurredAt: "2026-09-29T00:00:00.000Z",
          retryable: false,
        },
      }),
    );

    expect(useRecordingStore.getState().clipDoneQueue.map((r) => r.state)).toEqual([
      "failed",
    ]);
    expect(useRecordingStore.getState().clipExports).toEqual({});
  });

  it("notifies every clip finished in the same batch (parallel exports)", () => {
    useRecordingStore.getState().beginClipExport("rec-src", "clip-p1");
    useRecordingStore.getState().beginClipExport("rec-src", "clip-p2");
    expect(Object.keys(useRecordingStore.getState().clipExports).sort()).toEqual([
      "clip-p1",
      "clip-p2",
    ]);

    useRecordingStore
      .getState()
      .upsertRecordingFromEvent(
        recording({ id: "clip-p1", endReason: "clip_export" }),
      );
    useRecordingStore
      .getState()
      .upsertRecordingFromEvent(
        recording({ id: "clip-p2", endReason: "clip_export" }),
      );

    expect(
      useRecordingStore.getState().clipDoneQueue.map((r) => r.id).sort(),
    ).toEqual(["clip-p1", "clip-p2"]);
    expect(useRecordingStore.getState().clipExports).toEqual({});
    expect(useRecordingStore.getState().completionNotice).toBeNull();
  });

  it("does not re-notify when a terminal clip event is replayed after SSE reconnect", () => {
    useRecordingStore.getState().beginClipExport("rec-src", "clip-3");
    const clip = recording({ id: "clip-3", endReason: "clip_export" });
    useRecordingStore.getState().upsertRecordingFromEvent(clip);
    expect(useRecordingStore.getState().clipDoneQueue.map((r) => r.id)).toEqual([
      "clip-3",
    ]);
    useRecordingStore.getState().clearClipDoneQueue();

    useRecordingStore.getState().upsertRecordingFromEvent(clip);
    expect(useRecordingStore.getState().clipDoneQueue).toEqual([]);
  });
});

describe("history query invalidation on list-external records", () => {
  it("silently refetches the current page when an event arrives for a record outside the list", async () => {
    vi.useFakeTimers();
    const spy = vi.fn().mockResolvedValue(undefined);
    useRecordingStore.setState({ historyLoaded: true, fetchHistory: spy });

    useRecordingStore
      .getState()
      .upsertRecordingFromEvent(recording({ id: "brand-new" }));
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    expect(spy).toHaveBeenCalledWith(undefined, { silent: true });
    vi.useRealTimers();
  });

  it("does not refetch for records already in the list", async () => {
    vi.useFakeTimers();
    const spy = vi.fn().mockResolvedValue(undefined);
    const rec = recording({ id: "known-row" });
    useRecordingStore.setState({
      historyLoaded: true,
      items: [rec],
      total: 1,
      fetchHistory: spy,
    });

    useRecordingStore
      .getState()
      .upsertRecordingFromEvent({ ...rec, state: "recording", endedAt: null });
    await vi.advanceTimersByTimeAsync(800);
    expect(spy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not refetch when the room filter excludes the record", async () => {
    vi.useFakeTimers();
    const spy = vi.fn().mockResolvedValue(undefined);
    useRecordingStore.setState({
      historyLoaded: true,
      query: { roomId: "room-other" },
      fetchHistory: spy,
    });

    useRecordingStore
      .getState()
      .upsertRecordingFromEvent(recording({ id: "other-room" }));
    await vi.advanceTimersByTimeAsync(800);
    expect(spy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not refetch before the history query has ever loaded", async () => {
    vi.useFakeTimers();
    const spy = vi.fn().mockResolvedValue(undefined);
    useRecordingStore.setState({ historyLoaded: false, fetchHistory: spy });

    useRecordingStore
      .getState()
      .upsertRecordingFromEvent(recording({ id: "early-event" }));
    await vi.advanceTimersByTimeAsync(800);
    expect(spy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
