import { useEffect, useRef, useState } from 'react';
import { Alert, Spin } from 'antd';
import mpegts from 'mpegts.js';
import { previewWsUrl } from '../api/client';

const MAX_RETRY = 3;
const RETRY_DELAYS_MS = [1_000, 3_000, 5_000];
const EVENTS = mpegts.Events as unknown as Record<
  'ERROR',
  Parameters<mpegts.Player['on']>[0]
>;

export interface VideoPlayerProps {
  roomId: string;
  muted?: boolean;
}

export default function VideoPlayer({ roomId, muted = true }: VideoPlayerProps) {
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

    const create = () => {
      if (disposed || !videoRef.current) return;
      const instance = mpegts.createPlayer(
        { type: 'flv', url: previewWsUrl(roomId), isLive: true },
        { enableStashBuffer: false, liveBufferLatencyChasing: true },
      );
      player = instance;
      instance.attachMediaElement(videoRef.current);
      instance.on(EVENTS.ERROR, (_t, _detail) => {
        // 旧连接在重试期间的异步错误不能销毁新播放器。
        if (player === instance) {
          instance.destroy();
          player = null;
        }
        if (disposed) return;
        if (retry >= MAX_RETRY) {
          setState('error');
          setErrorMsg('预览连接异常（重试 3 次后放弃）');
          return;
        }
        setState('loading');
        timer = setTimeout(create, RETRY_DELAYS_MS[retry]);
        retry += 1;
      });
      instance.load();
      void instance.play()?.catch?.(() => undefined);
    };

    create();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      player?.destroy();
    };
  }, [roomId]);

  return (
    <div style={{ position: 'relative', background: '#000', borderRadius: 8, overflow: 'hidden' }}>
      {state === 'loading' && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 1, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <Spin tip="连接预览流…" />
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
