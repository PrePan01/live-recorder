import { useEffect, useRef, useState } from 'react';
import { Alert, Spin } from 'antd';
import mpegts from 'mpegts.js';

const EVENTS = mpegts.Events as unknown as Record<'PLAYING' | 'ERROR' | 'RECOVERED', Parameters<mpegts.Player['on']>[0]>;

export default function FilePlayer({ url }: { url: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'loading' | 'playing' | 'ended' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!mpegts.isSupported()) {
      setState('error');
      setErrorMsg('当前浏览器不支持 MSE，请使用 Chrome/Firefox 播放');
      return;
    }
    let player: mpegts.Player | null = null;
    let disposed = false;

    const create = () => {
      if (disposed || !videoRef.current) return;
      player = mpegts.createPlayer(
        { type: 'flv', url, isLive: false },
        { enableStashBuffer: false },
      );
      player.attachMediaElement(videoRef.current);
      player.on(EVENTS.PLAYING, () => setState('playing'));
      player.on(EVENTS.ERROR, (_t, _d) => {
        player?.destroy();
        player = null;
        if (!disposed) {
          setState('error');
          setErrorMsg('视频加载失败或格式不受支持');
        }
      });
      player.load();
      void player.play()?.catch?.(() => undefined);
    };

    create();
    return () => {
      disposed = true;
      player?.destroy();
    };
  }, [url]);

  return (
    <div style={{ position: 'relative', background: '#000', borderRadius: 8, overflow: 'hidden' }}>
      {state === 'loading' && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <Spin tip="加载视频…" />
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
        style={{
          width: '100%',
          aspectRatio: '16 / 9',
          display: state === 'error' ? 'none' : 'block',
        }}
      />
    </div>
  );
}