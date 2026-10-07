import { useEffect, useRef } from 'react';
import type { DanmakuGap, DanmakuMessage } from '../types/danmaku';

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

interface Bullet {
  id: string;
  text: string;
  /** 出现时的媒体时间。 */
  tMs: number;
  textWidth: number;
  row: number;
}

interface LayerState {
  bullets: Bullet[];
  cursor: number;
  rowBusyUntil: number[];
  spawned: Set<string>;
}

const PX_PER_MS = 0.16;
const ROW_HEIGHT = 28;
const FONT_SIZE = 18;
const MIN_GAP_BETWEEN = 24;

function inGap(gaps: DanmakuGap[], tMs: number): boolean {
  return gaps.some((g) => tMs >= g.fromMs && tMs < g.toMs);
}

/**
 * 弹幕飘屏层：纯画布叠加，位置完全由媒体时间推导——
 * 媒体时间冻结（暂停）弹幕即停，倍速推进快慢天然跟随，跳播由调用方换参清屏。
 */
export function DanmakuLayer({
  messages,
  gaps = [],
  getTimeMs,
  maxBullets = 60,
  opacity = 0.9,
  visible = true,
  resetKey = 0,
}: DanmakuLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<LayerState>({
    bullets: [],
    cursor: 0,
    rowBusyUntil: [],
    spawned: new Set(),
  });
  const propsRef = useRef({ messages, gaps, getTimeMs, maxBullets, opacity, visible });
  propsRef.current = { messages, gaps, getTimeMs, maxBullets, opacity, visible };

  // 换表引用变化：游标归零重扫，已播的按 id 去重（轮询滑窗不清屏）。
  useEffect(() => {
    stateRef.current.cursor = 0;
  }, [messages]);

  // 跳播等硬换表：清屏重生。
  useEffect(() => {
    stateRef.current.bullets = [];
    stateRef.current.cursor = 0;
    stateRef.current.spawned.clear();
    stateRef.current.rowBusyUntil = [];
  }, [resetKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let disposed = false;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(parent.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(parent.clientHeight * dpr));
      canvas.style.width = `${parent.clientWidth}px`;
      canvas.style.height = `${parent.clientHeight}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);

    const frame = () => {
      if (disposed) return;
      const { messages: msgs, gaps: gp, getTimeMs: now, maxBullets: cap, opacity: op, visible: vis } = propsRef.current;
      const t = now();
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;
      const st = stateRef.current;

      // 新弹幕入列：游标只前进（消息表按媒体时间升序；重扫时按 id 去重）。
      while (st.cursor < msgs.length && msgs[st.cursor].tMs <= t) {
        const m = msgs[st.cursor];
        st.cursor += 1;
        if (m.unmappable || inGap(gp, m.tMs)) continue;
        if (st.spawned.has(m.id)) continue;
        if (st.bullets.length >= cap) continue;
        st.spawned.add(m.id);
        ctx.font = `${FONT_SIZE}px system-ui, sans-serif`;
        const textWidth = ctx.measureText(m.text).width;
        // 行分配：选第一条尾部已让出画面的行；都占着就丢弃（密度上限语义）。
        const rows = Math.max(1, Math.floor(height / ROW_HEIGHT));
        let row = -1;
        for (let r = 0; r < rows; r += 1) {
          if (st.rowBusyUntil[r] == null || st.rowBusyUntil[r] < t) {
            row = r;
            break;
          }
        }
        if (row < 0) continue;
        // 行内前后间距：按当前速度换算成媒体时间毫秒。
        st.rowBusyUntil[row] = t + (width + textWidth + MIN_GAP_BETWEEN) / PX_PER_MS;
        st.bullets.push({ id: m.id, text: m.text, tMs: m.tMs, textWidth, row });
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (vis) {
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.font = `${FONT_SIZE}px system-ui, sans-serif`;
        ctx.fillStyle = `rgba(255,255,255,${op})`;
        ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.shadowBlur = 3;
        const alive: Bullet[] = [];
        for (const b of st.bullets) {
          const x = width - (t - b.tMs) * PX_PER_MS;
          if (x + b.textWidth < 0) continue;
          alive.push(b);
          ctx.fillText(b.text, x, b.row * ROW_HEIGHT + FONT_SIZE);
        }
        st.bullets = alive;
        ctx.restore();
      } else {
        st.bullets = [];
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
    />
  );
}
