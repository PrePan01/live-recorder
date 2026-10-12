import { normalizeDanmakuScale } from './danmakuPrefs';
import type { DanmakuGap, DanmakuMessage } from '../types/danmaku';

const SPEED = 0.16; // CSS pixels per media millisecond; all lanes share the same speed.
const ROW_HEIGHT = 28;
const GAP = 24;
const MAX_ADMISSIONS = 4;
const MAX_TEXT_WIDTH = 4096;
const MAX_ACTIVE = 80;
// Bound promoted text layers by CSS area as well as count (device scaling is browser-owned).
const MAX_LAYER_AREA = 1024 * 1024;

export interface RenderInput {
  messages: DanmakuMessage[];
  gaps: DanmakuGap[];
  maxBullets: number;
  opacity: number;
  fontScale?: number;
  speedMultiplier?: number;
}
interface Bullet {
  id: string;
  width: number;
  area: number;
  row: number;
  node: HTMLElement;
  animation: Animation;
  fade?: Animation;
}

/** JS schedules admissions only. Transform animations own the entire visible lifetime. */
export class DanmakuRenderer {
  private fontScale = 1;
  private speedMultiplier = 1;
  private get speed() { return SPEED * this.speedMultiplier; }
  private get rowHeight() { return Math.ceil(ROW_HEIGHT * this.fontScale); }
  private get font() { return `${18 * this.fontScale}px system-ui, sans-serif`; }
  private active = new Map<string, Bullet>();
  private rows: (Bullet | undefined)[] = [];
  private seen = new Set<string>();
  private messages: DanmakuMessage[] | undefined;
  private pending: DanmakuMessage[] = [];
  private cursor = 0;
  private restoreTime = NaN;
  private lastTime = NaN;
  private rate = 0;
  private layerArea = 0;
  private width = 1;
  private height = 1;
  private widths = new Map<string, number>();
  private container: HTMLElement;
  private measure: (text: string) => number;

  constructor(container: HTMLElement, measure?: (text: string) => number) {
    this.container = container;
    const ctx = measure ? null : container.ownerDocument.createElement('canvas').getContext('2d');
    this.measure = measure ? text => measure(text) * this.fontScale : text => {
      if (ctx) ctx.font = this.font;
      return ctx?.measureText(text).width ?? text.length * 18 * this.fontScale;
    };
  }

  resize(width: number, height: number) {
    width = Math.max(1, width); height = Math.max(1, height);
    if (width === this.width && height === this.height) return;
    const oldWidth = this.width;
    this.width = width; this.height = height;
    for (const bullet of this.active.values()) {
      if (bullet.row >= this.rowCount()) { this.remove(bullet); continue; }
      if (width === oldWidth) continue;
      // Explicit geometry changes preserve the compositor-owned horizontal position.
      const x = oldWidth - this.age(bullet) * this.speed;
      const effect = bullet.animation.effect as KeyframeEffect;
      effect.setKeyframes(this.keyframes(bullet.width));
      effect.updateTiming({ duration: this.duration(bullet.width) });
      bullet.animation.currentTime = Math.max(0, (width - x) / this.speed);
    }
  }

  reset() {
    for (const bullet of this.active.values()) this.remove(bullet);
    this.rows = []; this.seen.clear(); this.messages = undefined;
    this.pending = []; this.cursor = 0; this.restoreTime = this.lastTime = NaN;
  }

  destroy() { this.reset(); this.widths.clear(); }

  setPlaybackRate(rate: number) {
    rate = Number.isFinite(rate) && rate > 0 ? rate : 0;
    if (rate === this.rate) return;
    this.rate = rate;
    for (const bullet of this.active.values()) {
      if (rate === 0) bullet.animation.pause();
      else {
        bullet.animation.updatePlaybackRate(rate);
        if (bullet.animation.playState === 'paused') bullet.animation.play();
      }
    }
  }

  tick(t: number, input: RenderInput, rate: number) {
    this.configure(input.fontScale, input.speedMultiplier);
    if (!Number.isFinite(t)) {
      this.container.style.visibility = 'hidden'; this.setPlaybackRate(0); return;
    }
    this.container.style.visibility = 'visible';
    this.container.style.opacity = String(Math.max(0, Math.min(1, input.opacity)));
    if (Number.isFinite(this.lastTime) && t < this.lastTime - 250) this.reset();
    this.lastTime = t;
    if (!Number.isFinite(this.restoreTime)) this.restoreTime = t;
    this.setPlaybackRate(rate);
    if (input.messages !== this.messages) {
      this.messages = input.messages;
      const ids = new Set(input.messages.map(m => m.id));
      for (const id of this.seen) if (!ids.has(id) && !this.active.has(id)) this.seen.delete(id);
      // Filter once on a window update, rather than repeatedly walking already played history.
      this.pending = input.messages.filter(m => !this.seen.has(m.id));
      this.cursor = 0;
    }
    // Finished callbacks may be delayed by a long task. Their retained end position is offscreen.
    for (const bullet of this.active.values()) {
      if (bullet.animation.playState === 'finished') this.remove(bullet);
    }
    const limit = Math.min(MAX_ACTIVE, Math.max(0, input.maxBullets));
    while (this.active.size > limit) this.remove(Array.from(this.active.values()).at(-1)!);
    let admitted = 0;
    while (admitted < MAX_ADMISSIONS && this.cursor < this.pending.length) {
      const message = this.pending[this.cursor];
      if (message.tMs != null && message.tMs > t) break;
      this.cursor++;
      if (this.seen.has(message.id)) continue;
      this.seen.add(message.id);
      if (message.tMs == null || message.unmappable || this.active.size >= limit
        || input.gaps.some(g => message.tMs! >= g.fromMs && message.tMs! < g.toMs)) continue;
      const restoring = message.tMs < this.restoreTime;
      const age = restoring ? t - message.tMs : 0;
      // A late delivery starts at the edge; old messages outside the query's visible lifetime expire.
      if ((t - message.tMs) * this.speed > this.width + MAX_TEXT_WIDTH) continue;
      const text = message.text.replace(/[\r\n]/g, ' ');
      let width = this.widths.get(text);
      if (width == null) {
        width = Math.min(MAX_TEXT_WIDTH, Math.ceil(this.measure(text)) + 2);
        if (this.widths.size >= 256) this.widths.delete(this.widths.keys().next().value!);
        this.widths.set(text, width);
      }
      if ((t - message.tMs) * this.speed >= this.width + width) continue;
      if (this.layerArea + width * this.rowHeight > MAX_LAYER_AREA) continue;
      let row = -1;
      for (let r = 0; r < this.rowCount(); r++) {
        const ahead = this.rows[r];
        if (!ahead || (this.age(ahead) - age) * this.speed >= ahead.width + GAP) { row = r; break; }
      }
      if (row < 0) continue;
      this.admit(message.id, text, width, row, age, restoring);
      admitted++;
    }
  }

  /** Retarget only on explicit setting changes, preserving compositor-owned positions. */
  private configure(fontScale: unknown, speedMultiplier: unknown) {
    const font = normalizeDanmakuScale(fontScale);
    const speed = normalizeDanmakuScale(speedMultiplier);
    if (font === this.fontScale && speed === this.speedMultiplier) return;
    const fontChanged = font !== this.fontScale;
    const positioned = Array.from(this.active.values(), bullet => ({
      bullet, x: this.width - this.age(bullet) * this.speed,
    })).sort((a, b) => a.x - b.x);
    this.fontScale = font;
    this.speedMultiplier = speed;
    if (fontChanged) {
      this.widths.clear();
      this.rows = [];
    }
    for (const { bullet, x } of positioned) {
      if (fontChanged) {
        this.layerArea -= bullet.area;
        bullet.width = Math.min(MAX_TEXT_WIDTH, Math.ceil(this.measure(bullet.node.textContent ?? '')) + 2);
        bullet.area = bullet.width * this.rowHeight;
        this.layerArea += bullet.area;
      }
      const effect = bullet.animation.effect as KeyframeEffect;
      effect.setKeyframes(this.keyframes(bullet.width));
      effect.updateTiming({ duration: this.duration(bullet.width) });
      bullet.animation.currentTime = Math.max(0, (this.width - x) / this.speed);
      if (!fontChanged) continue;
      if (x + bullet.width + 6 <= 0 || this.layerArea > MAX_LAYER_AREA) {
        this.remove(bullet); continue;
      }
      let row = -1;
      for (let r = 0; r < this.rowCount(); r++) {
        const ahead = this.rows[r];
        if (!ahead || x - (this.width - this.age(ahead) * this.speed) >= ahead.width + GAP) {
          row = r; break;
        }
      }
      if (row < 0) { this.remove(bullet); continue; }
      bullet.row = row;
      this.rows[row] = bullet;
      Object.assign(bullet.node.style, {
        top: `${row * this.rowHeight}px`, width: `${bullet.width}px`,
        font: this.font, lineHeight: `${this.rowHeight}px`,
      });
    }
  }

  private rowCount() { return Math.max(1, Math.floor(this.height / this.rowHeight)); }
  private age(bullet: Bullet) { return Number(bullet.animation.currentTime ?? 0); }
  private duration(width: number) { return (this.width + width + 6) / this.speed; }
  private keyframes(width: number): Keyframe[] {
    return [{ transform: `translate3d(${this.width}px,0,0)` }, { transform: `translate3d(${-width - 6}px,0,0)` }];
  }
  private admit(id: string, text: string, width: number, row: number, age: number, restoring: boolean) {
    const node = this.container.ownerDocument.createElement('span');
    node.textContent = text;
    node.className = 'lr-danmaku-bullet';
    Object.assign(node.style, {
      position: 'absolute', left: '0', top: `${row * this.rowHeight}px`, width: `${width}px`,
      font: this.font, lineHeight: `${this.rowHeight}px`, whiteSpace: 'pre', color: '#fff',
      textShadow: '0 1px 2px rgba(0,0,0,.7)', pointerEvents: 'none', userSelect: 'none',
      overflow: 'hidden', textOverflow: 'ellipsis', willChange: 'transform',
      transform: `translate3d(${this.width}px,0,0)`,
    });
    this.container.appendChild(node);
    const animation = node.animate(this.keyframes(width), {
      duration: this.duration(width), easing: 'linear', fill: 'both',
    });
    animation.playbackRate = this.rate || 1;
    if (age > 0) animation.currentTime = age;
    if (this.rate === 0) animation.pause();
    const bullet: Bullet = { id, width, area: width * this.rowHeight, row, node, animation };
    if (restoring) bullet.fade = node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, fill: 'forwards' });
    this.active.set(id, bullet); this.rows[row] = bullet;
    this.layerArea += width * this.rowHeight;
    animation.onfinish = () => this.remove(bullet);
  }
  private remove(bullet: Bullet) {
    if (!this.active.delete(bullet.id)) return;
    this.layerArea -= bullet.area;
    if (this.rows[bullet.row] === bullet) this.rows[bullet.row] = undefined;
    bullet.animation.onfinish = null;
    bullet.animation.cancel(); bullet.fade?.cancel(); bullet.node.remove();
  }
}
