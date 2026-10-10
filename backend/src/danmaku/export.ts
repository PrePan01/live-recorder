import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { AppError, type ErrorCode } from '../types/error.js';
import { AssRenderer, validSubtitleMessage, srtHeader, srtText } from './subtitle-renderer.js';
import type { DanmakuGap, DanmakuMessage } from './types.js';

export interface DanmakuExportOptions {
  directory: string;
  durationMs: number;
  width: number;
  height: number;
  opacity: number;
  density: number;
}
/** Compatibility helper for small callers; file export uses the streaming worker. */
export function renderDanmakuSubtitles(messages: DanmakuMessage[], gaps: DanmakuGap[], options: Omit<DanmakuExportOptions, 'directory'>) {
  const timed = messages.filter(m => validSubtitleMessage(m, gaps, options)).sort((a, b) => a.tMs! - b.tMs!);
  const ass = new AssRenderer(options);
  const assLines = [ass.header()];
  const srt: string[] = [];
  let group = 0;
  for (let i = 0; i < timed.length; i++) {
    const m = timed[i]!, start = Math.floor(m.tMs!);
    if (!i || Math.floor(timed[i - 1]!.tMs!) !== start) {
      let next = i + 1;
      while (next < timed.length && Math.floor(timed[next]!.tMs!) === start) next++;
      if (i) srt.push('\n');
      srt.push(srtHeader(++group, start, timed[next]?.tMs == null ? Infinity : Math.floor(timed[next]!.tMs!), options.durationMs));
    }
    srt.push(srtText(m.text) + '\n');
    const line = ass.line(m);
    if (line) assLines.push(line);
  }
  return { srt: srt.join(''), ass: assLines.join(''), count: timed.length, assCount: ass.count };
}

export interface DanmakuExportResult { assPath: string; srtPath: string; count: number; assCount: number }
// A single worker plus two waiting requests bounds CPU, memory and disk pressure.
let pending = 0;
let tail: Promise<unknown> = Promise.resolve();
export function exportDanmakuFiles(recordingFilePath: string, options: DanmakuExportOptions): Promise<DanmakuExportResult> {
  if (pending >= 3) return Promise.reject(new AppError('SERVICE_UNAVAILABLE', '弹幕导出任务较多，请稍后重试'));
  pending++;
  const task = tail.then(() => new Promise<DanmakuExportResult>((resolve, reject) => {
    const source = import.meta.url.endsWith('.ts');
    const url = new URL(source ? './export-worker.ts' : './export-worker.js', import.meta.url);
    if (!existsSync(url)) { reject(new Error('Danmaku export worker is missing')); return; }
    const worker = new Worker(url, { workerData: { recordingFilePath, options }, execArgv: source ? ['--import', 'tsx'] : [] });
    worker.once('message', (message: { result?: DanmakuExportResult; error?: { code: ErrorCode; message: string } }) => {
      if (message.error) reject(new AppError(message.error.code, message.error.message));
      else if (message.result) resolve(message.result);
      else reject(new Error('Invalid danmaku export response'));
    });
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`Danmaku export worker exited (${code})`)); else reject(new Error('Danmaku export worker exited without a result')); });
  })).finally(() => { pending--; });
  tail = task.catch(() => undefined);
  return task;
}
