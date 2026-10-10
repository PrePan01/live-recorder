import { useEffect, useLayoutEffect, useRef } from 'react';
import type { DanmakuGap, DanmakuMessage } from '../types/danmaku';
import { DanmakuRenderer } from '../utils/danmakuRenderer';
import { DanmakuPlayback } from '../utils/danmakuPlayback';

const EMPTY_GAPS: DanmakuGap[] = [];
interface DanmakuLayerProps {
  messages: DanmakuMessage[];
  gaps?: DanmakuGap[];
  /** Raw media time schedules messages; it never sets running animation positions. */
  getTimeMs: () => number;
  getVideo: () => HTMLVideoElement | null;
  maxBullets?: number;
  opacity?: number;
  visible?: boolean;
  resetKey?: string | number;
}

/** Browser compositor animates each bullet. JS only handles admissions and playback changes. */
export function DanmakuLayer({ messages, gaps = EMPTY_GAPS, getTimeMs, getVideo,
  maxBullets = 60, opacity = 0.9, visible = true, resetKey = 0 }: DanmakuLayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<DanmakuRenderer | null>(null);
  const updateRef = useRef<(() => void) | null>(null);
  const propsRef = useRef({ messages, gaps, getTimeMs, getVideo, maxBullets, opacity });
  useLayoutEffect(() => {
    propsRef.current = { messages, gaps, getTimeMs, getVideo, maxBullets, opacity };
  });
  useLayoutEffect(() => { rendererRef.current?.reset(); }, [resetKey]);
  useLayoutEffect(() => { updateRef.current?.(); });

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !visible) return;
    const renderer = new DanmakuRenderer(container);
    rendererRef.current = renderer;
    const update = () => {
      if (document.hidden) { renderer.setPlaybackRate(0); return; }
      const props = propsRef.current;
      renderer.tick(props.getTimeMs(), props, playback.sample());
    };
    const playback = new DanmakuPlayback(() => propsRef.current.getVideo(), update);
    updateRef.current = update;
    const resize = () => { renderer.resize(container.clientWidth, container.clientHeight); update(); };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    const visibility = () => { if (!document.hidden) renderer.reset(); update(); };
    document.addEventListener('visibilitychange', visibility);
    // No per-frame motion work: a delayed tick delays only new admissions, not active bullets.
    const timer = window.setInterval(update, 50);
    return () => {
      window.clearInterval(timer); observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      playback.destroy(); renderer.destroy();
      rendererRef.current = null; updateRef.current = null;
    };
  }, [visible]);

  return <div ref={containerRef} aria-hidden style={{ position: 'absolute', inset: 0,
    overflow: 'hidden', pointerEvents: 'none', contain: 'layout paint style', display: visible ? undefined : 'none' }} />;
}
