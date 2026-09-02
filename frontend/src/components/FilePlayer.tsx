import { useEffect, useRef, useState } from 'react';
import { Alert, Spin } from 'antd';
import mpegts from 'mpegts.js';

const EVENTS = mpegts.Events as unknown as Record<'ERROR', Parameters<mpegts.Player['on']>[0]>;

export default function FilePlayer({ url, filePath }: { url: string; filePath?: string | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'loading' | 'playing' | 'ended' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  const isMp4 = typeof filePath === 'string' && /\.mp4$/i.test(filePath);

  useEffect(() => {
    if (isMp4) return;
    if (!mpegts.isSupported()) {
      setState('error');
      setErrorMsg('当前浏览器不支持 MSE，请使用 Chrome/Firefox 播放');
      return;
    }
    let player: mpegts.Player | null = null;
    let disposed = false;
    const videoEl = videoRef.current;

    const create = () => {
      if (disposed || !videoEl) return;
      const instance = mpegts.createPlayer(
        { type: 'flv', url, isLive: false },
        { enableStashBuffer: false },
      );
      player = instance;
      instance.attachMediaElement(videoEl);
      instance.on(EVENTS.ERROR, (_t, _d) => {
        if (player === instance) {
          instance.destroy();
          player = null;
        }
        if (!disposed) {
          setState('error');
          setErrorMsg('视频加载失败或格式不受支持');
        }
      });
      instance.load();
      void instance.play()?.catch?.(() => undefined);
    };

    create();
    return () => {
      disposed = true;
      // 卸载时先停止播放再销毁，避免 mpegts 内部 fetch/请求在销毁中途被中止产生未捕获 AbortError。
      try {
        videoEl?.pause();
      } catch {
        /* 忽略 */
      }
      player?.destroy();
    };
  }, [url, isMp4]);

  return (
    <div style={{ position: 'relative', background: '#000', borderRadius: 8, overflow: 'hidden' }}>
      {state === 'loading' && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 1, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <Spin description="加载视频…" />
        </div>
      )}
      {state === 'error' && (
        <div style={{ padding: 24 }}>
          <Alert type="error" showIcon message="播放失败" description={errorMsg} />
        </div>
      )}
      <video
        ref={videoRef}
        controls
        src={isMp4 ? url : undefined}
        onCanPlay={() => setState((current) => (current === 'loading' ? 'playing' : current))}
        onPlaying={() => setState('playing')}
        onEnded={() => setState('ended')}
        onError={() => {
          if (isMp4) {
            setState('error');
            setErrorMsg('视频加载失败或格式不受支持');
          }
        }}
        style={{
          width: '100%',
          aspectRatio: '16 / 9',
          display: state === 'error' ? 'none' : 'block',
        }}
      />
    </div>
  );
}
