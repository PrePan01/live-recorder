import { create } from "zustand";
interface SegmentDraft {
  recordingId: string | null;
  start: number | null;
  end: number | null;
  text: string;
  activate: (id: string) => void;
  setEnd: (id: string, end: number) => void;
  setStart: (id: string, start: number | null, text?: string) => void;
  setText: (id: string, text: string) => void;
}
// Session-only: closing a player preserves the draft; opening a different
// recording clears it. No persistence middleware or writes on playback ticks.
export const useSegmentDraftStore = create<SegmentDraft>((set) => ({
  recordingId: null,
  start: null,
  end: null,
  text: "",
  activate: (id) =>
    set((s) =>
      s.recordingId === id ? s : { recordingId: id, start: null, end: null, text: "" },
    ),
  setStart: (id, start, text = "") => set({ recordingId: id, start, end: null, text }),
  setText: (id, text) => set((s) =>
    s.recordingId === id && s.start != null ? { text } : s,
  ),
  setEnd: (id, end) => set((s) => (s.recordingId === id ? { end } : s)),
}));
