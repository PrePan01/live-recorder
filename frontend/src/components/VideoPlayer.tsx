import { useEffect, useRef, useState } from 'react';
import { Alert, Spin } from 'antd';
import mpegts from 'mpegts.js';
import { previewWsUrl } from '../api/client';

const RETRY_DELAYS_MS = [1_000, 3_000, 5_000];
const STALL_TIMEOUT_MS = 12_000;
const EVENTS = mpegts.Events as unknown as Record<
  'ERROR',
  Parameters<mpegts.Player['on']>[0]
>;

export interface VideoPlayerProps {
  roomId: string;
  muted?: boolean;
  /** 平台：douyin 无 Cookie 受限时加载超时给明确提示 */
  platform?: 'bilibili' | 'douyin';
}

export default function VideoPlayer({ roomId, muted = true, platform }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'loading' | 'playing' | 'ended' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!mpegts.isSupported()) {
      setState('error');
      setErrorMsg('当前浏览器不支持 MSE，请使用 Chrome/Firefox 观看');
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

    const destroyPlayer = () => {
      if (playingListener && videoRef.current) videoRef.current.removeEventListener('playing', playingListener);
      playingListener = null;
      const current = player;
      player = null;
      current?.destroy();
    };

    const scheduleReconnect = () => {
      if (disposed || timer) return;
      destroyPlayer();
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      setState('loading');
      setErrorMsg('');
      const delay = RETRY_DELAYS_MS[Math.min(retry, RETRY_DELAYS_MS.length - 1)]!;
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
        { type: 'flv', url: previewWsUrl(roomId), isLive: true },
        { enableStashBuffer: false, liveBufferLatencyChasing: true },
      );
      player = instance;
      instance.attachMediaElement(videoRef.current);
      playingListener = () => {
        hasPlayed = true;
        lastProgressAt = Date.now();
        retry = 0;
      };
      videoRef.current.addEventListener('playing', playingListener);
      instance.on(EVENTS.ERROR, (_t, _detail) => {
        // 旧连接在重试期间的异步错误不能销毁新播放器。
        if (player !== instance || disposed) return;
        scheduleReconnect();
      });
      instance.load();
      void instance.play()?.catch?.(() => undefined);
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
        if (Date.now() - lastProgressAt >= STALL_TIMEOUT_MS) scheduleReconnect();
      }, 2_000);
    }

    create();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      destroyPlayer();
    };
  }, [roomId, platform]);

  return (
    <div style={{ position: 'relative', background: '#000', borderRadius: 8, overflow: 'hidden' }}>
      {state === 'loading' && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 1, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <Spin description="连接预览流…" />
        </div>
      )}
      {state === 'error' && (
        <div style={{ padding: 24 }}>
          <Alert type="error" showIcon message="预览不可用" description={errorMsg} />
        </div>
      )}
      {state === 'ended' && (
        <div style={{ padding: 24 }}>
          <Alert type="info" showIcon message="本场录制已结束" />
        </div>
      )}
      <video
        ref={videoRef}
        controls
        muted={muted}
        autoPlay
        onCanPlay={() => setState((current) => (current === 'loading' ? 'playing' : current))}
        onPlaying={() => setState('playing')}
        style={{
          width: '100%',
          aspectRatio: '16 / 9',
          display: state === 'error' || state === 'ended' ? 'none' : 'block',
        }}
      />
    </div>
  );
}
