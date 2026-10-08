import type { DanmakuGap, DanmakuMessage } from '../types/danmaku';

const SPEED = 0.16;
const ROW_HEIGHT = 28;
const FONT = '18px system-ui, sans-serif';
const PAD = 6;
const CACHE_BYTES = 8 * 1024 * 1024;
interface Sprite { canvas: HTMLCanvasElement; width: number; bytes: number }
interface Bullet { id: string; text: string; tMs: number; width: number; row: number; sprite: Sprite | null | undefined }
export interface RenderInput {
  messages: DanmakuMessage[];
  gaps: DanmakuGap[];
  maxBullets: number;
  opacity: number;
}

/** Text and blur are rasterized once; animation only composites bounded bitmap sprites. */
export class DanmakuRenderer {
  private bullets: Bullet[] = [];
  private cursor = 0;
  private rows: number[] = [];
  private spawned = new Set<string>();
  private messages: DanmakuMessage[] | undefined;
  private cache = new Map<string, Sprite>();
  private cacheBytes = 0;
  private lastTime = NaN;
  private lastOpacity = NaN;
  private dirty = true;
  private painted = false;
  private width = 1;
  private height = 1;
  private dpr = 1;

  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private createCanvas: () => HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D,
    createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')) {
    this.canvas = canvas; this.ctx = ctx; this.createCanvas = createCanvas;
  }

  resize(width: number, height: number, dpr: number) {
    dpr = Math.max(1, Math.min(2, dpr || 1));
    width = Math.max(1, Math.floor(width)); height = Math.max(1, Math.floor(height));
    if (width === this.width && height === this.height && dpr === this.dpr) return;
    if (dpr !== this.dpr) {
      this.cache.clear(); this.cacheBytes = 0;
      for (const bullet of this.bullets) bullet.sprite = undefined;
    }
    this.width = width; this.height = height; this.dpr = dpr;
    this.canvas.width = Math.ceil(width * dpr); this.canvas.height = Math.ceil(height * dpr);
    this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
    this.dirty = true;
  }

  reset() {
    this.bullets = []; this.cursor = 0; this.rows = []; this.spawned.clear();
    this.lastTime = NaN; this.dirty = true;
  }

  private sprite(text: string, width?: number): Sprite | null {
    const existing = this.cache.get(text);
    if (existing) {
      this.cache.delete(text); this.cache.set(text, existing);
      return existing;
    }
    this.ctx.font = FONT;
    const textWidth = width ?? this.ctx.measureText(text).width;
    const pixelWidth = Math.ceil((textWidth + PAD * 2) * this.dpr);
    const pixelHeight = Math.ceil((ROW_HEIGHT + PAD * 2) * this.dpr);
    const bytes = pixelWidth * pixelHeight * 4;
    // Very long messages use the bounded main canvas instead of huge bitmap allocations.
    if (bytes > CACHE_BYTES / 2 || pixelWidth > 8192) return null;
    const pinned = new Set(this.bullets.map(b => b.sprite));
    for (const [key, sprite] of this.cache) {
      if (this.cacheBytes + bytes <= CACHE_BYTES && this.cache.size < 128) break;
      if (pinned.has(sprite)) continue;
      this.cacheBytes -= sprite.bytes; this.cache.delete(key);
    }
    // Active bullets pin their images; fall back rather than exceeding the total budget.
    if (this.cacheBytes + bytes > CACHE_BYTES || this.cache.size >= 128) return null;
    const canvas = this.createCanvas(); canvas.width = pixelWidth; canvas.height = pixelHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.scale(this.dpr, this.dpr); ctx.font = FONT; ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 3;
    ctx.fillText(text, PAD, PAD + 18);
    const result = { canvas, width: textWidth, bytes };
    this.cache.set(text, result); this.cacheBytes += bytes;
    return result;
  }

  render(t: number, input: RenderInput) {
    const { messages, gaps, maxBullets, opacity } = input;
    if (messages !== this.messages) {
      this.messages = messages; this.cursor = 0;
      const ids = new Set([...messages.map(m => m.id), ...this.bullets.map(b => b.id)]);
      for (const id of this.spawned) if (!ids.has(id)) this.spawned.delete(id);
      this.dirty = true;
    }
    if (!Number.isFinite(t)) {
      if (this.painted) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.painted = false; return;
    }
    if (Number.isFinite(this.lastTime) && t < this.lastTime) this.reset();
    if (t === this.lastTime && opacity === this.lastOpacity && !this.dirty) return;
    this.lastTime = t; this.lastOpacity = opacity;
    this.bullets = this.bullets.filter(b => this.width - (t - b.tMs) * SPEED + b.width >= 0);
    while (this.cursor < messages.length && (messages[this.cursor].tMs == null || messages[this.cursor].tMs! <= t)) {
      const m = messages[this.cursor++];
      if (m.tMs == null || m.unmappable || this.spawned.has(m.id)) continue;
      this.spawned.add(m.id);
      if (this.bullets.length >= maxBullets || gaps.some(g => m.tMs! >= g.fromMs && m.tMs! < g.toMs)) continue;
      this.ctx.font = FONT;
      const width = this.ctx.measureText(m.text).width;
      if ((t - m.tMs) * SPEED > this.width + width) continue;
      const rowCount = Math.max(1, Math.floor(this.height / ROW_HEIGHT));
      let row = -1;
      for (let r = 0; r < rowCount; r++) if (this.rows[r] == null || this.rows[r] <= m.tMs) { row = r; break; }
      if (row < 0) continue;
      this.rows[row] = m.tMs + (width + 24) / SPEED;
      this.bullets.push({ id: m.id, text: m.text, tMs: m.tMs, width, row, sprite: this.sprite(m.text, width) });
    }
    // An empty overlay, paused video, or unloaded media need no repeated canvas uploads.
    if (!this.bullets.length && !this.painted) { this.dirty = false; return; }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.save(); this.ctx.scale(this.dpr, this.dpr); this.ctx.globalAlpha = opacity;
    this.ctx.imageSmoothingEnabled = false;
    for (const bullet of this.bullets) {
      const x = Math.round((this.width - (t - bullet.tMs) * SPEED) * this.dpr) / this.dpr;
      const sprite = bullet.sprite !== undefined ? bullet.sprite : (bullet.sprite = this.sprite(bullet.text, bullet.width));
      if (sprite) this.ctx.drawImage(sprite.canvas, x - PAD, bullet.row * ROW_HEIGHT - PAD,
        sprite.canvas.width / this.dpr, sprite.canvas.height / this.dpr);
      else {
        this.ctx.font = FONT; this.ctx.fillStyle = '#fff';
        // Avoid the expensive per-frame blur even for oversized uncached text.
        this.ctx.fillText(bullet.text, x, bullet.row * ROW_HEIGHT + 18);
      }
    }
    this.ctx.restore(); this.painted = this.bullets.length > 0; this.dirty = false;
  }
}
