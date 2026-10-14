import { beforeEach, describe, expect, it } from "vitest";
import { useSegmentDraftStore } from "./segmentDraftStore";
beforeEach(() =>
  useSegmentDraftStore.setState({ recordingId: null, start: null, end: null, text: "" }),
);
describe("unfinished segment identity", () => {
  it("keeps the draft when reopening the same recording or switching its playback mode", () => {
    const s = useSegmentDraftStore.getState();
    s.activate("r");
    s.setStart("r", 12, "片段 1");
    s.setText("r", "精彩片段");
    s.activate("r");
    expect(useSegmentDraftStore.getState().start).toBe(12);
    expect(useSegmentDraftStore.getState().text).toBe("精彩片段");
  });
  it("clears the draft on switching recording and cannot recover it by switching back", () => {
    const s = useSegmentDraftStore.getState();
    s.setStart("a", 12, "片段 1");
    s.activate("b");
    expect(useSegmentDraftStore.getState().start).toBeNull();
    expect(useSegmentDraftStore.getState().text).toBe("");
    s.activate("a");
    expect(useSegmentDraftStore.getState().start).toBeNull();
  });
});
