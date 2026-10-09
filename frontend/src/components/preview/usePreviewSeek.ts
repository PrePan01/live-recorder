import type { VideoPlayerProps } from "../video/types";
import { App } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchRecordings,
  prewarmRecordingSeek,
  recordingSeekStreamUrl,
} from "../../api/recordings";
import { useRecordingStore } from "../../stores/recordingStore";
import { ApiError } from "../../types/error";
import { describeError } from "../../utils/errorMap";
import { observePreviewProgress } from "../../utils/observePreviewProgress";
import { isPlausibleSeekOffset } from "../../utils/recordingTimeline";
import { retrySeekRequest } from "../../utils/retrySeekRequest";

export function usePreviewSeek(
  roomId: string,
  activeRecordingId: string | undefined,
  trackElapsedSeconds: number,
  previewVideo: HTMLVideoElement | null,
) {
  const { message } = App.useApp();
  const [seekPlayback, setSeekPlayback] = useState<NonNullable<
    VideoPlayerProps["seek"]
  > | null>(null);
  const seekGenRef = useRef(0);
  const seekMarkRef = useRef<string | null>(null);
  const [seekActualStart, setSeekActualStart] = useState<{
    generation: number;
    second: number;
  } | null>(null);
  useEffect(() => {
    if (!seekActualStart) return;
    const timer = window.setTimeout(() => setSeekActualStart(null), 2000);
    return () => window.clearTimeout(timer);
  }, [seekActualStart]);
  const previewFrameGenerationRef = useRef<number | null>(null);
  const requestedPlaybackRef = useRef(seekPlayback);
  requestedPlaybackRef.current = seekPlayback;
  const [displayPreview, setDisplayPreview] = useState<{
    mode: "live" | "history";
    second?: number;
    loading?: boolean;
  }>({ mode: "live" });
  useEffect(() => {
    if (!previewVideo || !seekPlayback) return;
    const generation = seekPlayback.generation;
    return observePreviewProgress(
      previewVideo,
      (elapsed) => {
        if (generation !== requestedPlaybackRef.current?.generation) return;
        setDisplayPreview((current) =>
          current.loading
            ? current
            : {
                mode: "history",
                second: isPlausibleSeekOffset(
                  seekPlayback.second,
                  seekPlayback.startSecond,
                )
                  ? seekPlayback.startSecond + elapsed
                  : undefined,
              },
        );
      },
      () => previewFrameGenerationRef.current === generation,
    );
  }, [previewVideo, seekPlayback]);
  const recordingSnapshot = useRecordingStore((s) =>
    activeRecordingId ? s.recordingSnapshots[activeRecordingId] : undefined,
  );
  const setRecordingSnapshot = useRecordingStore((s) => s.setRecordingSnapshot);
  const seekIndexState = recordingSnapshot?.seekIndexState ?? "ready";

  useEffect(() => {
    if (!activeRecordingId) return;
    void fetchRecordings({ roomId, pageSize: 10 })
      .then((res) => {
        const rec = res.items.find((item) => item.id === activeRecordingId);
        if (rec) setRecordingSnapshot(rec);
      })
      .catch(() => undefined);
  }, [activeRecordingId, roomId, setRecordingSnapshot]);

  const seekRequestRef = useRef<AbortController | null>(null);
  const seekIntentRef = useRef<AbortController | null>(null);
  const seekRecoveryRef = useRef(0);
  const seekFailureSecondRef = useRef<number | null>(null);
  const seekRecoveryTimerRef = useRef<number | null>(null);
  const displayPreviewRef = useRef(displayPreview);
  displayPreviewRef.current = displayPreview;
  const handleSeekIntent = useCallback(
    (second: number) => {
      if (!activeRecordingId) return;
      seekIntentRef.current?.abort();
      const controller = new AbortController();
      seekIntentRef.current = controller;
      void prewarmRecordingSeek(activeRecordingId, second, {
        signal: controller.signal,
      }).catch(() => undefined);
    },
    [activeRecordingId],
  );
  const lastSeekCommitRef = useRef<{
    target: number | "live";
  } | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const handleSeekCommit = useCallback(
    (target: number | "live", indicatorSecond?: number, recovery = false) => {
      // 同目标在途即忽略（状态语义去重，不按时间窗）：双柄同帧/事件重发/内核再请求
      // 都不再产生第二次起流。
      const lastCommit = lastSeekCommitRef.current;
      if (lastCommit && lastCommit.target === target) {
        if (indicatorSecond != null)
          setDisplayPreview((current) => ({
            ...current,
            second: indicatorSecond,
          }));
        return;
      }
      lastSeekCommitRef.current = { target };
      pendingSeekRef.current = null;
      seekRequestRef.current?.abort();
      seekIntentRef.current?.abort();
      if (seekRecoveryTimerRef.current != null)
        window.clearTimeout(seekRecoveryTimerRef.current);
      seekRecoveryTimerRef.current = null;
      if (!recovery) seekRecoveryRef.current = 0;
      seekFailureSecondRef.current = null;
      const controller = new AbortController();
      seekRequestRef.current = controller;
      if (target === "live") {
        seekGenRef.current += 1;
        if (requestedPlaybackRef.current) {
          setDisplayPreview((current) => ({
            ...current,
            second:
              indicatorSecond ??
              (current.mode === "live" && !current.loading
                ? trackElapsedSeconds
                : current.second),
            loading: true,
          }));
        } else setDisplayPreview({ mode: "live" });
        setSeekPlayback(null);
        try {
          performance.mark("lr-seek:to-live");
        } catch {
          /* 性能 API 不可用时静默 */
        }
        return;
      }
      if (!activeRecordingId) return;
      const generation = ++seekGenRef.current;
      setDisplayPreview((current) => ({
        ...current,
        second:
          indicatorSecond ??
          (current.mode === "live" && !current.loading
            ? trackElapsedSeconds
            : current.second),
        loading: true,
      }));
      seekMarkRef.current = `lr-seek:pointerup-${generation}`;
      try {
        performance.mark(seekMarkRef.current);
      } catch {
        /* 性能 API 不可用时静默 */
      }
      // 先取得解码起点，再把目标与起点一起交给播放器完成准确定位。
      void retrySeekRequest(
        () =>
          prewarmRecordingSeek(activeRecordingId, target, {
            signal: controller.signal,
            prepareStream: true,
          }),
        controller.signal,
      )
        .then((res) => {
          if (generation !== seekGenRef.current) return;
          if (res?.startSecond == null || !Number.isFinite(res.startSecond)) {
            throw new Error("回看定位信息缺失，请重试");
          }
          setSeekPlayback({
            url: recordingSeekStreamUrl(
              activeRecordingId,
              target,
              res.streamToken,
            ),
            generation,
            second: target,
            startSecond: res.startSecond,
          });
        })
        .catch((error: unknown) => {
          if (generation !== seekGenRef.current || controller.signal.aborted)
            return;
          lastSeekCommitRef.current = null;
          if (
            error instanceof ApiError &&
            error.retryable &&
            error.code === "RECORDING_START_FAILED"
          ) {
            pendingSeekRef.current = target;
            setDisplayPreview((current) => ({ ...current, loading: false }));
            return;
          }
          setDisplayPreview((current) => ({ ...current, loading: false }));
          message.error(
            error instanceof ApiError
              ? describeError(error.code, error.message)
              : error instanceof Error
                ? error.message
                : "回看定位失败，请重试",
          );
        });
    },
    [activeRecordingId, message, trackElapsedSeconds],
  );
  const handleSeekTail = useCallback(() => {
    seekRequestRef.current?.abort();
    if (seekRecoveryTimerRef.current != null)
      window.clearTimeout(seekRecoveryTimerRef.current);
    seekRecoveryTimerRef.current = null;
    lastSeekCommitRef.current = null;
    seekGenRef.current += 1;
    setSeekPlayback(null);
    setDisplayPreview((current) => ({ ...current, loading: true }));
    pendingSeekRef.current = null;
  }, []);
  const handleSeekCommitRef = useRef(handleSeekCommit);
  useEffect(() => {
    handleSeekCommitRef.current = handleSeekCommit;
  });
  useEffect(() => {
    if (seekIndexState !== "ready") return;
    const target = pendingSeekRef.current;
    if (target == null) return;
    pendingSeekRef.current = null;
    lastSeekCommitRef.current = null;
    handleSeekCommitRef.current(target);
  }, [seekIndexState]);
  useEffect(() => {
    lastSeekCommitRef.current = null;
    pendingSeekRef.current = null;
    seekRecoveryRef.current = 0;
    seekFailureSecondRef.current = null;
    setSeekPlayback(null);
    setDisplayPreview({ mode: "live" });
    return () => {
      seekGenRef.current += 1;
      seekRequestRef.current?.abort();
      seekIntentRef.current?.abort();
      if (seekRecoveryTimerRef.current != null)
        window.clearTimeout(seekRecoveryTimerRef.current);
      seekRecoveryTimerRef.current = null;
    };
  }, [activeRecordingId]);
  const handleSeekError = useCallback((generation: number, second: number) => {
    if (generation !== seekGenRef.current) return;
    lastSeekCommitRef.current = null;
    pendingSeekRef.current = null;
    seekFailureSecondRef.current = second;
    setDisplayPreview((current) => ({ ...current, loading: false }));
    // 短暂读取/解码故障最多自动恢复两次，恢复的是当前回看位置，不跳回最初的落点。
    if (seekRecoveryRef.current >= 2) return;
    const delay = [500, 1500][seekRecoveryRef.current++];
    seekRecoveryTimerRef.current = window.setTimeout(() => {
      seekRecoveryTimerRef.current = null;
      if (generation !== seekGenRef.current) return;
      handleSeekCommitRef.current(
        Math.max(0, Math.floor(second)),
        undefined,
        true,
      );
    }, delay);
  }, []);
  const handleSeekRetry = useCallback(() => {
    const playback = requestedPlaybackRef.current;
    if (!playback) return;
    lastSeekCommitRef.current = null;
    handleSeekCommitRef.current(
      Math.floor(
        seekFailureSecondRef.current ??
          displayPreviewRef.current.second ??
          playback.second,
      ),
    );
  }, []);
  const handleSeekFirstFrame = useCallback(
    (generation: number, elapsed: number) => {
      if (generation !== seekGenRef.current) return;
      lastSeekCommitRef.current = null;
      previewFrameGenerationRef.current = generation;
      const playback = requestedPlaybackRef.current;
      if (playback?.generation === generation) {
        const actualSecond = playback.startSecond + elapsed;
        setDisplayPreview({ mode: "history", second: actualSecond });
        setSeekActualStart({ generation, second: actualSecond });
      }
      if (!seekMarkRef.current) return;
      try {
        performance.measure(
          `lr-seek:to-first-frame-${generation}`,
          seekMarkRef.current,
        );
      } catch {
        /* 性能 API 不可用时静默 */
      }
      seekMarkRef.current = null;
    },
    [],
  );

  return {
    seekPlayback,
    seekActualStart,
    seekIndexState,
    displayPreview,
    setDisplayPreview,
    previewFrameGenerationRef,
    requestedPlaybackRef,
    lastSeekCommitRef,
    handleSeekIntent,
    handleSeekCommit,
    handleSeekTail,
    handleSeekError,
    handleSeekRetry,
    handleSeekFirstFrame,
  };
}
