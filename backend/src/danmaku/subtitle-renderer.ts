import type { DanmakuExportOptions } from './export.js';
import type { DanmakuGap, DanmakuMessage } from './types.js';

const pad = (n: number, length = 2) => String(n).padStart(length, '0');
function timestamp(ms: number, ass = false): string {
  const ticks = Math.floor(ms / (ass ? 10 : 1));
  const unit = ass ? 100 : 1000;
  const seconds = Math.floor(ticks / unit);
  return `${ass ? Math.floor(seconds / 3600) : pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}${ass ? '.' : ','}${pad(ticks % unit, ass ? 2 : 3)}`;
}
function clean(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
}
export type SubtitleOptions = Omit<DanmakuExportOptions, 'directory'>;
export function validSubtitleMessage(m: DanmakuMessage, gaps: DanmakuGap[], options: SubtitleOptions): boolean {
  return m.tMs !== null && Number.isFinite(m.tMs) && m.tMs >= 0 && m.tMs < options.durationMs && !m.unmappable && !!clean(m.text) && !gaps.some(g => m.tMs! >= g.fromMs && m.tMs! < g.toMs);
}
export function srtHeader(index: number, start: number, next: number, duration: number): string {
  return `${index}\n${timestamp(start)} --> ${timestamp(Math.min(duration, start + 3000, next))}\n`;
}
export function srtText(text: string): string { return clean(text).replace(/\n+/g, '\n'); }
export class AssRenderer {
  private fontSize: number;
  private lineHeight: number;
  private freeAt: number[];
  private speed: number;
  private activeEnds: number[] = [];
  count = 0;
  constructor(private options: SubtitleOptions) {
    this.fontSize = Math.max(12, Math.round(options.height / 30));
    this.lineHeight = Math.ceil(this.fontSize * 1.55);
    const rows = Math.max(1, Math.floor(options.height / this.lineHeight));
    this.freeAt = Array<number>(rows).fill(0);
    this.speed = options.width / 6; // Cross the picture in six seconds.
  }
  header(): string {
    const alpha = Math.round((1 - this.options.opacity) * 255).toString(16).padStart(2, '0').toUpperCase();
    const color = `&H${alpha}FFFFFF`;
    return [
      '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${this.options.width}`, `PlayResY: ${this.options.height}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
      '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: Danmaku,sans-serif,${this.fontSize},${color},${color},&H80000000,&HFF000000,0,0,0,0,100,100,0,0,1,1,0,7,0,0,0,1`, '',
      '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ].join("\n") + "\n";
  }
  line(m: DanmakuMessage): string | null {
    const start = Math.floor(m.tMs! / 10) * 10;
    this.activeEnds = this.activeEnds.filter(end => end > start);
    if (this.activeEnds.length >= this.options.density) return null;
    const row = this.freeAt.findIndex(t => t <= start);
    if (row < 0) return null;
    const text = clean(m.text).replace(/\n/g, ' ');
    // Conservative width estimate without a platform-specific font dependency.
    const width = Math.ceil(Array.from(text).reduce((n, c) => n + (/^[\x00-\x7f]$/.test(c) ? 0.65 : 1), 0) * this.fontSize);
    const travelMs = Math.ceil((this.options.width + width) / this.speed * 1000 / 10) * 10;
    const end = Math.min(Math.floor(this.options.durationMs / 10) * 10, start + travelMs);
    if (end <= start) return null;
    this.freeAt[row] = start + (width + this.fontSize) / this.speed * 1000;
    this.activeEnds.push(end);
    const escaped = text.replace(/\\/g, '＼').replace(/{/g, '｛').replace(/}/g, '｝');
    const y = row * this.lineHeight;
    const result = `Dialogue: 0,${timestamp(start, true)},${timestamp(end, true)},Danmaku,,0,0,0,,{\\move(${this.options.width},${y},${-width},${y},0,${travelMs})}${escaped}`;
    this.count++;
    return result + "\n";
  }
}
