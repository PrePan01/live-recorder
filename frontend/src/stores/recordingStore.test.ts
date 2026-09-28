import { beforeEach, describe, expect, it } from "vitest";
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
