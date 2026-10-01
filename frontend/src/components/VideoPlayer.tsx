import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Spin } from "antd";
import mpegts from "mpegts.js";
import { previewWsUrl } from "../api/client";
import { reportError } from "../utils/errorDiagnostics";
import { isPlausibleSeekOffset } from "../utils/recordingTimeline";
import { prepareSeekPlayback } from "../utils/prepareSeekPlayback";

const RETRY_DELAYS_MS = [1_000, 3_000, 5_000];
const STALL_TIMEOUT_MS = 12_000;
const EVENTS = mpegts.Events as unknown as Record<
  "ERROR",
  Parameters<mpegts.Player["on"]>[0]
>;

export interface VideoPlayerProps {
  roomId: string;
  muted?: boolean;
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
  /** 跳播回看源：携带目标时间和解码关键帧时间；空=实时直播。 */
  seek?: { url: string; generation: number; second: number; startSecond: number } | null;
  /** 回看播到已写尾部 →调用方切回实时。 */
  onSeekTail?: () => void;
  /** 回看首帧渲染（松手→首帧掍表打点），携带代际号防旧代际串打点。 */
  onSeekFirstFrame?: (generation: number) => void;
  /** 实时流首帧（切实时段掍表打点）。 */
  onLiveFirstFrame?: () => void;
}

export default function VideoPlayer({
  roomId,
  muted = true,
  platform,
  fill = false,
  onVideoElementChange,
  onStreamAspectRatio,
  aspectRatio,
  seek = null,
  onSeekTail,
  onSeekFirstFrame,
  onLiveFirstFrame,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
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

  // 记录用户通过原生控件调整的音量。流切换时必须先静音才能通过浏览器的
  // 自动播放策略，进入 playing 后再恢复这个偏好。
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

  // 上报流的真实宽高比：元数据就绪时、以及流内分辨率变化（video 的 resize 事件）时都会触发。
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
    // 复用 video，但直播与回看只能由一个播放器持有。
    if (seek) return;
    if (currentRoomIdRef.current !== roomId) {
      currentRoomIdRef.current = roomId;
      hasEverPlayedRef.current = false;
    }
    setState("loading");
    setErrorMsg("");
    if (!mpegts.isSupported()) {
      setState("error");
      setErrorMsg("当前浏览器不支持 MSE，请使用 Chrome/Firefox 观看");
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
      if (playingListener && video)
        video.removeEventListener("playing", playingListener);
      playingListener = null;
      const current = player;
      player = null;
      // mpegts may emit ERROR inside appendMediaSegment, then continue using its
      // controllers. Let that stack finish before destroying those controllers.
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
        { type: "flv", url: previewWsUrl(roomId), isLive: true },
        {
          enableStashBuffer: false,
          liveBufferLatencyChasing: true,
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
        liveFirstFrameRef.current?.();
      };
      videoRef.current.addEventListener("playing", playingListener);
      instance.on(EVENTS.ERROR, (_t, _detail) => {
        // 旧连接在重试期间的异步错误不能销毁新播放器。
        if (player !== instance || disposed) return;
        scheduleReconnect();
      });
      // 切换纯预览/录制流后，play() 已不在原始点击手势中。先静音启动，
      // 避免用户此前取消静音时被浏览器拦截自动播放而卡在 0 秒。
      startMutedForAutoplay();
      instance.load();
      // A synchronous load error may already have scheduled a reconnect.
      if (player !== instance || disposed) return;
      void Promise.resolve(instance.play()).catch(() => undefined);
      // WS 仍连接但无新帧时 mpegts.js 不一定报错。持续检测媒体时间，主动重建连接，避免永久卡帧。
      watchdogTimer = setInterval(() => {
        const video = videoRef.current;
        if (!video || player !== instance) return;
        // 已经正常播放后尊重用户主动暂停；首次加载尚无帧时 video.paused=true，仍必须执行无帧超时恢复。
        if (video.paused && hasPlayed) return;
        if (video.currentTime > lastMediaTime + 0.01) {
          hasPlayed = true;
          lastMediaTime = video.currentTime;
          lastProgressAt = Date.now();
          retry = 0;
          return;
        }
        if (Date.now() - lastProgressAt >= STALL_TIMEOUT_MS)
          scheduleReconnect();
      }, 2_000);
    }

    create();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      destroyPlayer();
    };
    // 回看模式复用同一个 video 元素，实时路径让位（卸掉 mpegts）；
    // 退出回看时本 effect 重跑重建直播流。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, platform, reloadToken, !!seek]);

  // 回看跳播：走 mpegts 同管道（FLV 流；原生 src 在 WKWebView 播不了流式 fMP4）。
  // 代际号防串流：旧代际的迟到事件一律丢弃。
  const seekGenRef = useRef(0);
  useEffect(() => {
    const video = videoRef.current;
    if (!seek || !video) return;
    const gen = seek.generation;
    seekGenRef.current = gen;
    let disposed = false;
    const stale = () => disposed || seekGenRef.current !== gen;
    setState("loading");
    setErrorMsg("");
    const instance = mpegts.createPlayer(
      { type: "flv", url: seek.url, isLive: false },
      {
        enableStashBuffer: false,
        accurateSeek: true,
        lazyLoadMaxDuration: Math.max(180, seek.second - seek.startSecond + 30),
      },
    );
    instance.attachMediaElement(video);
    let positioned = false;
    const onPlaying = () => {
      if (stale() || !positioned) return;
      hasEverPlayedRef.current = true;
      setState("playing");
      onSeekFirstFrame?.(gen);
    };
    const onEnded = () => {
      if (stale() || !positioned) return;
      onSeekTail?.();
    };
    video.addEventListener("playing", onPlaying);
    video.addEventListener("ended", onEnded);
    instance.on(EVENTS.ERROR, () => {
      if (stale()) return;
      // 取证：跳播起流失败必须进诊断包（不只弹 toast），否则复现了也无痕可查。
      reportError(
        "jump-seek",
        new Error(`jump-seek failed gen=${gen} second=${seek.second} start=${seek.startSecond}`),
      );
      setState("error");
      setErrorMsg("跳播起流失败，请重试");
    });
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
        positioned = true;
        // 定位完成后才播放；自动播放被拦时保留原有静音重试。
        void Promise.resolve(instance.play()).catch(() => {
          if (stale()) return;
          video.muted = true;
          void Promise.resolve(instance.play()).catch(() => undefined);
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
      if (!disposed) instance.load();
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(loadFrame);
      stopPreparing();
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("ended", onEnded);
      try {
        video.pause();
      } catch {
        /* 忽略 */
      }
      instance.destroy();
    };
  }, [seek, onSeekTail, onSeekFirstFrame]);

  // 实时首帧回调仅在直播路径生效；effect 依赖保持最小，避免重连风暴。
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
      {state === "loading" && !hasEverPlayedRef.current && (
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
      {state === "error" && (
        <div style={{ padding: 24 }}>
          <Alert
            type="error"
            showIcon
            message="预览不可用"
            description={errorMsg}
            action={<Button size="small" onClick={() => setReloadToken((value) => value + 1)}>重试播放器</Button>}
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
        controls
        muted={muted}
        autoPlay={!seek}
        onCanPlay={() =>
          !seek && setState((current) => (current === "loading" ? "playing" : current))
        }
        onPlaying={() => { if (!seek) setState("playing"); }}
        style={{
          width: "100%",
          // 竖屏墙不预设比例：占满格子，画面按流自己的宽高比留边显示。
          ...(fill
            ? { height: "100%", objectFit: "contain" as const }
            : { aspectRatio: aspectRatio ? String(aspectRatio) : "16 / 9" }),
          display: state === "error" || state === "ended" ? "none" : "block",
        }}
      />
    </div>
  );
}
