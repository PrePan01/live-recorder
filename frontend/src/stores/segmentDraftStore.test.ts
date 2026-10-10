import { beforeEach, describe, expect, it } from "vitest";
import { useSegmentDraftStore } from "./segmentDraftStore";
beforeEach(() =>
  useSegmentDraftStore.setState({ recordingId: null, start: null, end: null }),
);
describe("unfinished segment identity", () => {
  it("keeps the draft when reopening the same recording or switching its playback mode", () => {
    const s = useSegmentDraftStore.getState();
    s.activate("r");
    s.setStart("r", 12);
    s.activate("r");
    expect(useSegmentDraftStore.getState().start).toBe(12);
  });
  it("clears the draft on switching recording and cannot recover it by switching back", () => {
    const s = useSegmentDraftStore.getState();
    s.setStart("a", 12);
    s.activate("b");
    expect(useSegmentDraftStore.getState().start).toBeNull();
    s.activate("a");
    expect(useSegmentDraftStore.getState().start).toBeNull();
  });
});
