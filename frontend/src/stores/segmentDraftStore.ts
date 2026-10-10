import { create } from "zustand";
interface SegmentDraft {
  recordingId: string | null;
  start: number | null;
  end: number | null;
  activate: (id: string) => void;
  setEnd: (id: string, end: number) => void;
  setStart: (id: string, start: number | null) => void;
}
// Session-only: closing a player preserves the draft; opening a different
// recording clears it. No persistence middleware or writes on playback ticks.
export const useSegmentDraftStore = create<SegmentDraft>((set) => ({
  recordingId: null,
  start: null,
  end: null,
  activate: (id) =>
    set((s) =>
      s.recordingId === id ? s : { recordingId: id, start: null, end: null },
    ),
  setStart: (id, start) => set({ recordingId: id, start, end: null }),
  setEnd: (id, end) => set((s) => (s.recordingId === id ? { end } : s)),
}));
