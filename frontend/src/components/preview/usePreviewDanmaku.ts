import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDanmakuWindow } from "../../api/danmakuWindow";
import { fetchRecordingGaps } from "../../api/recordings";
import { useLiveDanmaku } from "../../hooks/useLiveDanmaku";
import { useStreamHealth } from "../../hooks/useStreamHealth";
import { useDanmakuPrefsStore } from "../../stores/danmakuPrefsStore";
import {
  selectDanmakuStatus,
  useDanmakuStore,
} from "../../stores/danmakuStore";
import type { DanmakuGap, DanmakuMessage } from "../../types/danmaku";
import type { RecordingGap } from "../../types/recording";

import type { RefObject } from "react";
import type { VideoPlayerProps } from "../video/types";

export function usePreviewDanmaku(
  roomId: string,
  activeRecordingId: string | undefined,
  seekPlayback: VideoPlayerProps["seek"],
  previewVideo: HTMLVideoElement | null,
  previewFrameGenerationRef: RefObject<number | null>,
) {
  // 显示偏好与回看共用；隐藏时释放直播订阅，录制采集独立继续。
  const {
    visible: danmakuVisible,
    opacity: danmakuOpacity,
    density: danmakuDensity,
    setVisible: setDanmakuVisible,
    setOpacity: setDanmakuOpacity,
    setDensity: setDanmakuDensity,
  } = useDanmakuPrefsStore();
  const liveDanmaku = useLiveDanmaku(
    roomId,
    danmakuVisible && !seekPlayback,
    previewVideo,
  );
  const [danmakuMessages, setDanmakuMessages] = useState<DanmakuMessage[]>([]);
  const [trackGaps, setTrackGaps] = useState<RecordingGap[]>([]);
  const streamHealth = useStreamHealth(activeRecordingId);
  useEffect(() => {
    if (!activeRecordingId) return undefined;
    let cancelled = false;
    const load = () => {
      void fetchRecordingGaps(activeRecordingId)
        .then((gaps) => {
          if (!cancelled) setTrackGaps(gaps);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeRecordingId]);
  const [danmakuGaps, setDanmakuGaps] = useState<DanmakuGap[]>([]);
  const danmakuStatus = useDanmakuStore((s) =>
    selectDanmakuStatus(s, activeRecordingId),
  );
  const displayedDanmakuStatus = seekPlayback
    ? danmakuStatus
    : liveDanmaku.status;
  const danmakuAnchorRef = useRef<number | null>(null);
  const getDanmakuTimeMs = useCallback((): number => {
    if (!seekPlayback || !previewVideo || !previewVideo.buffered.length)
      return NaN;
    if (previewFrameGenerationRef.current !== seekPlayback.generation)
      return NaN;
    if (danmakuAnchorRef.current == null)
      danmakuAnchorRef.current = previewVideo.buffered.start(0);
    return (
      (seekPlayback.startSecond +
        previewVideo.currentTime -
        danmakuAnchorRef.current) *
      1000
    );
  }, [seekPlayback, previewVideo, previewFrameGenerationRef]);
  useEffect(() => {
    danmakuAnchorRef.current = null;
    setDanmakuMessages([]);
    setDanmakuGaps([]);
    if (!activeRecordingId || !seekPlayback || !danmakuVisible)
      return undefined;
    const controller = new AbortController();
    let running = false;
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const nowMs = getDanmakuTimeMs();
        if (!Number.isFinite(nowMs)) return;
        const data = await fetchDanmakuWindow(
          activeRecordingId,
          Math.max(0, nowMs - 15_000),
          nowMs + 30_000,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setDanmakuMessages(data.messages);
        setDanmakuGaps(data.gaps ?? []);
        if (data.status) useDanmakuStore.getState().applyStatus(data.status);
      } catch {
        /* Next poll retries transient errors. */
      } finally {
        running = false;
      }
    };
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 2500);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [
    activeRecordingId,
    getDanmakuTimeMs,
    seekPlayback,
    previewVideo,
    danmakuVisible,
  ]);

  return {
    danmakuVisible,
    danmakuOpacity,
    danmakuDensity,
    setDanmakuVisible,
    setDanmakuOpacity,
    setDanmakuDensity,
    liveDanmaku,
    danmakuMessages,
    danmakuGaps,
    trackGaps,
    streamHealth,
    displayedDanmakuStatus,
    getDanmakuTimeMs,
  };
}
