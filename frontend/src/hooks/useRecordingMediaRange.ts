import { useCallback, useEffect, useState } from "react";
import { fetchRecordingPosition } from "../api/recordings";

export type RecordingMediaSnapshot = Awaited<ReturnType<typeof fetchRecordingPosition>>;

// YouTube delivers several seconds of confirmed media together. Starting at the
// exact tail on modal mount exhausts the smooth clock before its very first tick.
// Keep a small reservoir of already received media; never invent future media.
const INITIAL_SMOOTH_BUFFER_SECONDS = 5;
// Preserve the last committed display across closing/reopening a preview. A new
// modal must not restart five seconds behind a clock the user has already seen.
export const recordingMediaClockMemory = new Map<string, number>();

/** Shared media clock for the track, recording button, markers and seek bounds.
 * Polling is independent of video readiness: opening/reloading preview cannot pause it.
 */
export function useRecordingMediaRange(recordingId: string | undefined, video: HTMLVideoElement | null, smooth = false) {
  const [snapshot, setSnapshot] = useState<(RecordingMediaSnapshot & {
    recordingId: string; displayedSeconds: number; sampledAt: number;
  }) | null>(null);
  const advance = useCallback((current: NonNullable<typeof snapshot>, now: number) => {
    // Consume only confirmed media, at playback speed. Never extrapolate past
    // the received tail or catch up a suspended/hidden tab in one large jump.
    const elapsed = document.hidden ? 0 : Math.min(1, Math.max(0, (now - current.sampledAt) / 1000));
    return { ...current, sampledAt: now,
      displayedSeconds: Math.min(current.durationSeconds, current.displayedSeconds + elapsed) };
  }, []);
  const update = useCallback((data: RecordingMediaSnapshot) => {
    if (!recordingId) return;
    setSnapshot(current => {
      // A periodic read can finish after the fresher click-time request.
      if (current?.recordingId === recordingId && current.durationSeconds > data.durationSeconds) return current;
      const now = performance.now();
      const displayedSeconds = smooth
        ? current?.recordingId === recordingId
          ? advance(current, now).displayedSeconds
          : Math.min(data.durationSeconds, Math.max(0,
              data.durationSeconds - INITIAL_SMOOTH_BUFFER_SECONDS,
              recordingMediaClockMemory.get(recordingId) ?? 0))
        : data.durationSeconds;
      return { ...data, recordingId, displayedSeconds, sampledAt: now };
    });
  }, [recordingId, smooth, advance]);
  useEffect(() => {
    if (!smooth || !recordingId || !snapshot || snapshot.recordingId !== recordingId) return;
    if (!recordingMediaClockMemory.has(recordingId) && recordingMediaClockMemory.size >= 128)
      recordingMediaClockMemory.delete(recordingMediaClockMemory.keys().next().value!);
    recordingMediaClockMemory.set(recordingId, snapshot.displayedSeconds);
  }, [snapshot, recordingId, smooth]);
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
    const tick = () => setSnapshot(current => current?.recordingId === recordingId
      ? advance(current, performance.now()) : current);
    const visibleRead = () => { if (smooth) tick(); if (!document.hidden) void read(); };
    void read();
    video?.addEventListener("loadeddata", read);
    document.addEventListener("visibilitychange", visibleRead);
    const timer = window.setInterval(visibleRead, 1000);
    const displayTimer = smooth ? window.setInterval(tick, 250) : undefined;
    return () => {
      disposed = true;
      clearInterval(timer);
      if (displayTimer !== undefined) clearInterval(displayTimer);
      video?.removeEventListener("loadeddata", read);
      document.removeEventListener("visibilitychange", visibleRead);
    };
  }, [recordingId, video, update, smooth, advance]);
  const data = snapshot?.recordingId === recordingId ? snapshot : null;
  return {
    durationSeconds: data ? smooth ? data.displayedSeconds : data.durationSeconds : 0,
    previewOffsetSeconds: data?.previewOffsetSeconds ?? null,
    update,
  };
}
export type RecordingMediaRange = ReturnType<typeof useRecordingMediaRange>;
