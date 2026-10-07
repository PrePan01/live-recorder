import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Spin } from "antd";
import mpegts from "mpegts.js";
import { previewWsUrl } from "../api/client";
import { reportError } from "../utils/errorDiagnostics";
import { isPlausibleSeekOffset } from "../utils/recordingTimeline";
import { prepareSeekPlayback } from "../utils/prepareSeekPlayback";
import { watchSeekPlayback } from "../utils/seekPlaybackHealth";
import { seekPlaybackConfig } from "../utils/seekPlaybackConfig";
import {
  holdVideoFrame,
  releaseVideoFrame,
  waitForVideoFrame,
} from "../utils/videoFrameTransition";

const RETRY_DELAYS_MS = [1_000, 3_000, 5_000];
const STALL_TIMEOUT_MS = 12_000;
const EVENTS = mpegts.Events as unknown as Record<
  "ERROR" | "LOADING_COMPLETE",
  Parameters<mpegts.Player["on"]>[0]
>;

export interface VideoPlayerProps {
  roomId: string;
  muted?: boolean;
  /** Hover cover: silent, no controls/retries, bounded buffers. */
  thumbnail?: boolean;
  onPreviewError?: () => void;
  /** 平台：douyin 无 Cookie 受限时加载超时给明确提示 */
  platform?: "bilibili" | "douyin";
  /** 竖屏墙：不写死宽高比，画面撑满容器高度并按真实比例显示。 */
  fill?: boolean;
  /** 直播墙窗口模式中供重复格子镜像主画面。 */
  onVideoElementChange?: (element: HTMLVideoElement | null) => void;
  /** 预览弹窗：上报流的真实宽高比（宽/高），供容器按真实比例排版。 */
  onStreamAspectRatio?: (ratio: number) => void;
  /** 预览弹窗：fill 未开启时用于排版的宽高比；不传保持 16:9（直播墙不动）。 */
  aspectRatio?: number;
  /** 预览切流期间保留最后一帧，直到新源真正呈现画面。 */
  preserveFrameOnSwitch?: boolean;
  /** 跳播回看源：携带目标时间和解码关键帧时间；空=实时直播。 */
  seek?: {
    url: string;
    generation: number;
    second: number;
    startSecond: number;
  } | null;
  /** 回看播到已写尾部 →调用方切回实时。 */
  onSeekTail?: () => void;
  /** 回看首帧渲染（松手→首帧掍表打点），携带代际号防旧代际串打点。 */
  onSeekFirstFrame?: (generation: number, elapsed: number) => void;
  /** 失败必须释放父级在途状态；重试重新预热快照，而不是复用已过期的 URL。 */
  onSeekError?: (generation: number, second: number) => void;
  onSeekRetry?: () => void;
  /** 实时流首帧（切实时段掍表打点）。 */
  onLiveFirstFrame?: () => void;
}

export default function VideoPlayer({
  roomId,
  muted = true,
  thumbnail = false,
  onPreviewError,
  platform,
  fill = false,
  onVideoElementChange,
  onStreamAspectRatio,
  aspectRatio,
  preserveFrameOnSwitch = false,
  seek = null,
  onSeekTail,
  onSeekFirstFrame,
  onSeekError,
  onSeekRetry,
  onLiveFirstFrame,
}: VideoPlayerProps) {
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
    if (seek) return;
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
        {
          enableStashBuffer: false,
          liveBufferLatencyChasing: true,
          enableWorker: !thumbnail,
          fixAudioTimestampGap: false,
          ...(thumbnail
            ? {
                autoCleanupSourceBuffer: true,
                autoCleanupMaxBackwardDuration: 10,
                autoCleanupMinBackwardDuration: 5,
              }
            : {}),
        },
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
  }, [roomId, platform, reloadToken, !!seek, thumbnail]);

  const seekGenRef = useRef(0);
  useEffect(() => {
    const video = videoRef.current;
    if (!seek || !video) return;
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
    let mediaStart: number | null = null;
    const elapsed = () => {
      if (video.buffered.length) mediaStart ??= video.buffered.start(0);
      return Math.max(0, video.currentTime - (mediaStart ?? video.currentTime));
    };
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
      onSeekError?.(gen, second);
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
            onSeekFirstFrame?.(gen, elapsed());
          },
          () => !stale(),
        );
      }
    };
    const onEnded = () => {
      if (stale() || !positioned) return;
      onSeekTail?.();
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
    onSeekTail,
    onSeekFirstFrame,
    onSeekError,
    holdFrame,
    releaseFrame,
    reloadToken,
  ]);

  const liveFirstFrameRef = useRef(onLiveFirstFrame);
  liveFirstFrameRef.current = onLiveFirstFrame;

  return (
    <div
      style={{
        position: "relative",
        background: "#000",
        overflow: "hidden",
        ...(fill ? { height: "100%" } : null),
      }}
    >
      {!thumbnail && state === "loading" && !hasEverPlayedRef.current && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 1,
            display: "grid",
            placeItems: "center",
            pointerEvents: "none",
          }}
        >
          <Spin description="连接预览流…" />
        </div>
      )}
      {!thumbnail && state === "error" && (
        <div style={{ padding: 24 }}>
          <Alert
            type="error"
            showIcon
            message="预览不可用"
            description={errorMsg}
            action={
              <Button
                size="small"
                onClick={() => {
                  if (seek && onSeekRetry) onSeekRetry();
                  else setReloadToken((value) => value + 1);
                }}
              >
                重试播放器
              </Button>
            }
          />
        </div>
      )}
      {state === "ended" && (
        <div style={{ padding: 24 }}>
          <Alert type="info" showIcon message="本场录制已结束" />
        </div>
      )}
      <video
        ref={attachVideoRef}
        controls={!thumbnail}
        muted={thumbnail || muted}
        playsInline
        autoPlay={!seek}
        onCanPlay={() =>
          !seek &&
          setState((current) => (current === "loading" ? "playing" : current))
        }
        onPlaying={() => {
          if (!seek) setState("playing");
        }}
        style={{
          width: "100%",
          ...(fill
            ? { height: "100%", objectFit: "contain" as const }
            : { aspectRatio: aspectRatio ? String(aspectRatio) : "16 / 9" }),
          display: state === "error" || state === "ended" ? "none" : "block",
        }}
      />
      {preserveFrameOnSwitch && (
        <canvas
          ref={transitionRef}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            background: "#000",
            pointerEvents: "none",
            display: "none",
            visibility:
              state === "error" || state === "ended" ? "hidden" : "visible",
          }}
        />
      )}
    </div>
  );
}
