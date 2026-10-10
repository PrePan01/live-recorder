import { useCallback, useEffect, useState } from "react";
import type { RecordingMediaRange } from "./useRecordingMediaRange";
import { readPreviewElapsed } from "../utils/previewMediaClock";

export function useRecordingMediaPosition(
  recordingId: string | undefined,
  video: HTMLVideoElement | null,
  display: { mode: "live" | "history"; second?: number; loading?: boolean },
  seek: { recordingId: string; startSecond: number; generation: number } | null,
  clock: RecordingMediaRange,
  frameGeneration: { current: number | null } | null = null,
) {
  const readPosition = useCallback(() => {
    if (!recordingId || display.loading || !video || video.readyState < 2 || video.seeking) return undefined;
    if (seek && (seek.recordingId !== recordingId || frameGeneration?.current !== seek.generation)) return undefined;
    if (display.mode === "history") {
      const elapsed = readPreviewElapsed(video);
      return seek && elapsed != null ? seek.startSecond + elapsed : undefined;
    }
    // The live playhead follows the received recording tail. Capture that same
    // displayed clock, rather than a decoded frame delayed by the preview buffer.
    const position = clock.durationSeconds;
    return Number.isFinite(position) && position > 0 ? position : undefined;
  }, [recordingId, display.loading, display.mode, video, seek, clock.durationSeconds, frameGeneration]);
  // Read synchronously at the click; saving or opening an editor cannot advance it.
  const getPosition = useCallback(async () => {
    const position = readPosition();
    if (position == null) throw new Error("播放位置尚未就绪");
    return position;
  }, [readPosition]);
  const [, setCurrent] = useState<number | undefined>();
  useEffect(() => {
    const report = () => setCurrent(readPosition());
    report();
    if (!video) return;
    const events = ["timeupdate", "loadeddata", "playing", "seeked", "emptied"];
    events.forEach(event => video.addEventListener(event, report));
    return () => events.forEach(event => video.removeEventListener(event, report));
  }, [video, readPosition]);
  return {
    duration: clock.durationSeconds,
    current: readPosition(),
    getPosition,
  };
}
