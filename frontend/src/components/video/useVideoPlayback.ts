import { resetPreviewMediaClock, setLiveMediaOrigin, readPreviewElapsed } from "../../utils/previewMediaClock";
import mpegts from "mpegts.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { previewWsUrl } from "../../api/client";
import { reportError } from "../../utils/errorDiagnostics";
import { livePreviewConfig } from "../../utils/livePreviewConfig";
import { prepareSeekPlayback } from "../../utils/prepareSeekPlayback";
import { isPlausibleSeekOffset } from "../../utils/recordingTimeline";
import { seekPlaybackConfig } from "../../utils/seekPlaybackConfig";
import { watchSeekPlayback } from "../../utils/seekPlaybackHealth";
import {
  holdVideoFrame,
  releaseVideoFrame,
  waitForVideoFrame,
} from "../../utils/videoFrameTransition";

import type { VideoPlayerProps } from "./types";
const RETRY_DELAYS_MS = [1_000, 3_000, 5_000];
const STALL_TIMEOUT_MS = 12_000;
const EVENTS = mpegts.Events as unknown as Record<
  "ERROR" | "LOADING_COMPLETE",
  Parameters<mpegts.Player["on"]>[0]
>;

export function useVideoPlayback({
  roomId,
  muted = true,
  thumbnail = false,
  onPreviewError,
  platform,
  onVideoElementChange,
  onStreamAspectRatio,
  preserveFrameOnSwitch = false,
  seek = null,
  onSeekTail,
  onSeekFirstFrame,
  onSeekError,
  onLiveFirstFrame,
}: VideoPlayerProps) {
  const liveFirstFrameRef = useRef(onLiveFirstFrame);
  liveFirstFrameRef.current = onLiveFirstFrame;
  // 回调随父组件刷新而变化，不代表回看源变化，不能触发销毁/重新加载。
  const seekCallbacksRef = useRef({ onSeekTail, onSeekFirstFrame, onSeekError });
  seekCallbacksRef.current = { onSeekTail, onSeekFirstFrame, onSeekError };
  const isSeeking = Boolean(seek);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewErrorRef = useRef(onPreviewError);
  previewErrorRef.current = onPreviewError;
  const transitionRef = useRef<HTMLCanvasElement>(null);
  const holdFrame = useCallback(() => {
    if (preserveFrameOnSwitch && videoRef.current && transitionRef.current)
      holdVideoFrame(videoRef.current, transitionRef.current);
  }, [preserveFrameOnSwitch]);
  const releaseFrame = useCallback(() => {
    if (transitionRef.current) releaseVideoFrame(transitionRef.current);
  }, []);
  const attachVideoRef = useCallback(
    (element: HTMLVideoElement | null) => {
      videoRef.current = element;
      onVideoElementChange?.(element);
    },
    [onVideoElementChange],
  );
  // 重连时保留同一个 video 元素，避免清空用户已调整的音量和当前画面。
  const hasEverPlayedRef = useRef(false);
  const currentRoomIdRef = useRef(roomId);
  const audioPreferenceRef = useRef({ muted, volume: 1 });
  const temporarilyMutedRef = useRef(false);
  const [state, setState] = useState<"loading" | "playing" | "ended" | "error">(
    "loading",
  );
  const [errorMsg, setErrorMsg] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  // 记录音量
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const rememberAudioPreference = () => {
      if (!temporarilyMutedRef.current) {
        audioPreferenceRef.current = {
          muted: video.muted,
          volume: video.volume,
        };
      }
    };
    rememberAudioPreference();
    video.addEventListener("volumechange", rememberAudioPreference);
    return () =>
      video.removeEventListener("volumechange", rememberAudioPreference);
  }, []);

  // 真实宽高比
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !onStreamAspectRatio) return;
    const report = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        onStreamAspectRatio(video.videoWidth / video.videoHeight);
      }
    };
    report();
    video.addEventListener("loadedmetadata", report);
    video.addEventListener("resize", report);
    return () => {
      video.removeEventListener("loadedmetadata", report);
      video.removeEventListener("resize", report);
    };
  }, [onStreamAspectRatio]);

  useEffect(() => {
    if (isSeeking) return;
    if (currentRoomIdRef.current !== roomId) {
      currentRoomIdRef.current = roomId;
      hasEverPlayedRef.current = false;
      releaseFrame();
    }
    setState("loading");
    setErrorMsg("");
    if (!mpegts.isSupported()) {
      setState("error");
      setErrorMsg("当前浏览器不支持 MSE，请使用 Chrome/Firefox 观看");
      if (thumbnail) previewErrorRef.current?.();
      return;
    }
    let player: mpegts.Player | null = null;
    let retry = 0;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let lastMediaTime = -1;
    let lastProgressAt = Date.now();
    let hasPlayed = false;
    let playingListener: (() => void) | null = null;
    let stopWaitingForFrame: (() => void) | null = null;

    const video = videoRef.current;
    const startMutedForAutoplay = () => {
      if (!video) return;
      if (!temporarilyMutedRef.current) {
        audioPreferenceRef.current = {
          muted: video.muted,
          volume: video.volume,
        };
      }
      temporarilyMutedRef.current = true;
      video.muted = true;
    };
    const restoreAudioPreference = () => {
      if (!video || !temporarilyMutedRef.current) return;
      const { muted: preferredMuted, volume } = audioPreferenceRef.current;
      temporarilyMutedRef.current = false;
      video.volume = volume;
      video.muted = preferredMuted;
    };
    const destroyPlayer = (deferred = false) => {
      stopWaitingForFrame?.();
      stopWaitingForFrame = null;
      if (playingListener && video)
        video.removeEventListener("playing", playingListener);
      playingListener = null;
      const current = player;
      if (current) holdFrame();
      player = null;
      if (video) resetPreviewMediaClock(video);
      if (deferred) queueMicrotask(() => current?.destroy());
      else current?.destroy();
    };

    const scheduleReconnect = () => {
      if (disposed || timer) return;
      destroyPlayer(true);
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      if (thumbnail) {
        setState("error");
        previewErrorRef.current?.();
        return;
      }
      if (retry >= RETRY_DELAYS_MS.length) {
        setState("error");
        setErrorMsg("预览连接连续失败，请单独重试播放器。后台录制不受影响。");
        return;
      }
      setState("loading");
      const delay =
        RETRY_DELAYS_MS[Math.min(retry, RETRY_DELAYS_MS.length - 1)]!;
      retry += 1;
      timer = setTimeout(() => {
        timer = null;
        create();
      }, delay);
    };

    function create() {
      if (disposed || !videoRef.current) return;
      destroyPlayer();
      const clockVideo = videoRef.current;
      resetPreviewMediaClock(clockVideo);
      lastMediaTime = videoRef.current.currentTime;
      lastProgressAt = Date.now();
      hasPlayed = false;
      const instance = mpegts.createPlayer(
        {
          type: "flv",
          url: previewWsUrl(roomId),
          isLive: true,
          ...(thumbnail ? { hasAudio: false } : {}),
        },
        livePreviewConfig(thumbnail, thumbnail ? undefined : (origin) => setLiveMediaOrigin(clockVideo, origin)),
      );
      player = instance;
      instance.attachMediaElement(videoRef.current);
      playingListener = () => {
        hasPlayed = true;
        hasEverPlayedRef.current = true;
        restoreAudioPreference();
        lastProgressAt = Date.now();
        retry = 0;
        if (!stopWaitingForFrame) {
          stopWaitingForFrame = waitForVideoFrame(
            videoRef.current!,
            () => {
              releaseFrame();
              liveFirstFrameRef.current?.();
            },
            () => !disposed && player === instance,
          );
        }
      };
      videoRef.current.addEventListener("playing", playingListener);
      instance.on(EVENTS.ERROR, (_t, _detail) => {
        if (player !== instance || disposed) return;
        reportError(
          "live-preview",
          new Error(`播放器错误 type=${String(_t)} detail=${String(_detail)}`),
        );
        scheduleReconnect();
      });
      instance.on(EVENTS.LOADING_COMPLETE, () => {
        if (player !== instance || disposed) return;
        scheduleReconnect();
      });
      startMutedForAutoplay();
      instance.load();
      if (player !== instance || disposed) return;
      void Promise.resolve(instance.play()).catch(() => undefined);
      watchdogTimer = setInterval(() => {
        const video = videoRef.current;
        if (!video || player !== instance) return;
        if (video.paused && hasPlayed) return;
        if (video.currentTime > lastMediaTime + 0.01) {
          hasPlayed = true;
          lastMediaTime = video.currentTime;
          lastProgressAt = Date.now();
          retry = 0;
          return;
        }
        if (Date.now() - lastProgressAt >= STALL_TIMEOUT_MS) {
          reportError(
            "live-preview-stall",
            new Error(`无帧超时 played=${hasPlayed} retry=${retry}`),
          );
          scheduleReconnect();
        }
      }, 2_000);
    }

    create();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      destroyPlayer();
    };
  }, [
    roomId,
    platform,
    reloadToken,
    isSeeking,
    thumbnail,
    holdFrame,
    releaseFrame,
  ]);

  const seekGenRef = useRef(0);
  useEffect(() => {
    const video = videoRef.current;
    if (!seek || !video) return;
    resetPreviewMediaClock(video);
    const gen = seek.generation;
    seekGenRef.current = gen;
    let disposed = false;
    let failed = false;
    const stale = () => disposed || failed || seekGenRef.current !== gen;
    setState("loading");
    setErrorMsg("");
    const instance = mpegts.createPlayer(
      { type: "flv", url: seek.url, isLive: false },
      seekPlaybackConfig,
    );
    instance.attachMediaElement(video);
    let destroyed = false;
    const destroySeekPlayer = () => {
      if (destroyed) return;
      destroyed = true;
      try {
        instance.destroy();
      } catch (error) {
        reportError("jump-seek-destroy", error);
      }
    };
    let positioned = false;
    let stopWaitingForFrame: (() => void) | null = null;
    const elapsed = () => readPreviewElapsed(video) ?? 0;
    const fail = (reason: string) => {
      if (stale()) return;
      const second =
        positioned && hasFrame ? seek.startSecond + elapsed() : seek.second;
      failed = true;
      health.stop();
      stopPreparing();
      stopWaitingForFrame?.();
      reportError(
        "jump-seek",
        new Error(
          `${reason} gen=${gen} second=${seek.second} start=${seek.startSecond}`,
        ),
      );
      destroySeekPlayer();
      releaseFrame();
      setState("error");
      setErrorMsg("回看加载失败，请重试");
      seekCallbacksRef.current.onSeekError?.(gen, second);
    };
    let hasFrame = false;
    const health = watchSeekPlayback(video, fail, () => !stale());
    const onPlaying = () => {
      if (stale() || !positioned) return;
      hasEverPlayedRef.current = true;
      setState("playing");
      if (!stopWaitingForFrame) {
        stopWaitingForFrame = waitForVideoFrame(
          video,
          () => {
            hasFrame = true;
            health.presented();
            releaseFrame();
            seekCallbacksRef.current.onSeekFirstFrame?.(gen, elapsed());
          },
          () => !stale(),
        );
      }
    };
    const onEnded = () => {
      if (stale() || !positioned) return;
      seekCallbacksRef.current.onSeekTail?.();
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("ended", onEnded);
    instance.on(EVENTS.ERROR, (_type, detail) =>
      fail(`player error: ${String(detail)}`),
    );
    // 吸附偏移超 GOP 量级=索引错乱信号：不等永不可能的缓冲覆盖，按流起点放行并留诊断。
    const offsetPlausible = isPlausibleSeekOffset(
      seek.second,
      seek.startSecond,
    );
    if (!offsetPlausible)
      reportError(
        "jump-seek-index",
        new Error(
          `index skew gen=${gen} second=${seek.second} start=${seek.startSecond}`,
        ),
      );
    const stopPreparing = prepareSeekPlayback(
      video,
      offsetPlausible ? seek.second - seek.startSecond : 0,
      () => {
        if (stale()) return;
        elapsed();
        positioned = true;
        // 定位完成后才播放；自动播放被拦时保留原有静音重试。
        void Promise.resolve(instance.play()).catch(() => {
          if (stale()) return;
          video.muted = true;
          void Promise.resolve(instance.play()).catch(() =>
            fail("autoplay failed"),
          );
        });
      },
      () => !stale(),
      () => {
        // 看狗放行：定位超时从缓冲起点起播（误差不超一个 GOP），留诊断痕。
        reportError(
          "jump-seek-watchdog",
          new Error(`seek fallback gen=${gen} second=${seek.second}`),
        );
      },
    );
    // 载入延迟到下一帧：StrictMode 双跑 effect 时首帧载入被取消，同一目标只发一次起流。
    const loadFrame = requestAnimationFrame(() => {
      if (stale()) return;
      try {
        instance.load();
      } catch (error) {
        fail(`load failed: ${String(error)}`);
      }
    });
    return () => {
      disposed = true;
      health.stop();
      cancelAnimationFrame(loadFrame);
      stopWaitingForFrame?.();
      holdFrame();
      stopPreparing();
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("ended", onEnded);
      try {
        video.pause();
      } catch {
        /* 忽略 */
      }
      destroySeekPlayer();
    };
  }, [
    seek,
    holdFrame,
    releaseFrame,
    reloadToken,
  ]);

  return {
    attachVideoRef,
    transitionRef,
    state,
    setState,
    errorMsg,
    setReloadToken,
    hasEverPlayedRef,
  };
}
