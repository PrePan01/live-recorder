import { useEffect, useRef } from 'react';
import type { DanmakuGap, DanmakuMessage } from '../types/danmaku';
import { DanmakuRenderer } from '../utils/danmakuRenderer';

const EMPTY_GAPS: DanmakuGap[] = [];

interface DanmakuLayerProps {
  /** 按媒体时间升序的弹幕（时间轴查询结果即可）。 */
  messages: DanmakuMessage[];
  /** 弹幕采集自身的缺失区间：区间内消息不叠加（与视频缺口是两套账）。 */
  gaps?: DanmakuGap[];
  /** 当前媒体时间（毫秒）取值器；由父层接 video.currentTime，层内不自走时钟。 */
  getTimeMs: () => number;
  /** 同屏最大条数（密度档位映射）。 */
  maxBullets?: number;
  opacity?: number;
  visible?: boolean;
  /** 跳播等换表事件：变化即清屏重生；仅 messages 轮询换表不清屏（已播弹幕继续飘）。 */
  resetKey?: string | number;
}

/**
 * 弹幕飘屏层：纯画布叠加，位置完全由媒体时间推导——
 * 媒体时间冻结（暂停）弹幕即停，倍速推进快慢天然跟随，跳播由调用方换参清屏。
 */
export function DanmakuLayer({
  messages,
  gaps = EMPTY_GAPS,
  getTimeMs,
  maxBullets = 60,
  opacity = 0.9,
  visible = true,
  resetKey = 0,
}: DanmakuLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<DanmakuRenderer | null>(null);
  const propsRef = useRef({ messages, gaps, getTimeMs, maxBullets, opacity });
  propsRef.current = { messages, gaps, getTimeMs, maxBullets, opacity };
  useEffect(() => { rendererRef.current?.reset(); }, [resetKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!visible) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    const renderer = new DanmakuRenderer(canvas, ctx);
    rendererRef.current = renderer;
    let raf = 0;
    let disposed = false;
    let lastFrame = -Infinity;
    const resize = () => {
      const parent = canvas.parentElement;
      if (parent) renderer.resize(parent.clientWidth, parent.clientHeight, window.devicePixelRatio);
    };
    resize();
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    const frame = (timestamp: number) => {
      if (disposed) return;
      // 120/144Hz 显示器也只绘制最多 60 次/秒，位置仍由媒体时间决定。
      if (!document.hidden && timestamp - lastFrame >= 1000 / 60 - 0.5) {
        lastFrame = timestamp;
        renderer.render(propsRef.current.getTimeMs(), propsRef.current);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      rendererRef.current = null;
    };
  }, [visible]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
    />
  );
}
