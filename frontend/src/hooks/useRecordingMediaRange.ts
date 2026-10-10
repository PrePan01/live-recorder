import { useCallback, useEffect, useState } from "react";
import { fetchRecordingPosition } from "../api/recordings";

export type RecordingMediaSnapshot = Awaited<ReturnType<typeof fetchRecordingPosition>>;

/** One file-media clock for the track, recording counter and seek bounds. */
export function useRecordingMediaRange(recordingId: string | undefined, video: HTMLVideoElement | null) {
  const [snapshot, setSnapshot] = useState<(RecordingMediaSnapshot & { recordingId: string }) | null>(null);
  const update = useCallback((data: RecordingMediaSnapshot) => {
    if (!recordingId) return;
    setSnapshot(current => {
      // A periodic read can finish after the fresher click-time request.
      if (current?.recordingId === recordingId && current.durationSeconds > data.durationSeconds) return current;
      return { ...data, recordingId };
    });
  }, [recordingId]);
  useEffect(() => {
    if (!recordingId) return;
    let disposed = false;
    let pending = false;
    const read = async () => {
      if (disposed || pending) return;
      pending = true;
      try {
        const data = await fetchRecordingPosition(recordingId);
        if (!disposed) update(data);
      } catch {
        // Preserve the last received media time; never substitute a wall clock.
      } finally { pending = false; }
    };
    const visibleRead = () => { if (!document.hidden) void read(); };
    void read();
    video?.addEventListener("loadeddata", read);
    document.addEventListener("visibilitychange", visibleRead);
    const timer = window.setInterval(visibleRead, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
      video?.removeEventListener("loadeddata", read);
      document.removeEventListener("visibilitychange", visibleRead);
    };
  }, [recordingId, video, update]);
  const data = snapshot?.recordingId === recordingId ? snapshot : null;
  return {
    durationSeconds: data?.durationSeconds ?? 0,
    previewOffsetSeconds: data?.previewOffsetSeconds ?? null,
    update,
  };
}
export type RecordingMediaRange = ReturnType<typeof useRecordingMediaRange>;
