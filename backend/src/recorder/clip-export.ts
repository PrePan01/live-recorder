import { spawn } from 'node:child_process';
import { access, stat, unlink } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { resolveBin } from '../utils/ffmpeg.js';
import { runFfmpegTracked, type FfmpegRunOptions } from './ffmpeg-run.js';
import { CLIP_BOUNDARY_TOLERANCE_SECONDS, createFlvSnapshotStream, openFlvClipSource, prepareFlvClipInput, type FlvClipSource } from './flv-clip-input.js';
import { encodeWithFallback } from './hw-encode.js';
import { encodingMode } from './pipeline-ffmpeg.js';
import { encodingWorkQueue, MediaWorkQueue } from './media-work-queue.js';
import { videoPassthroughArgs } from './ffmpeg-capabilities.js';

// 接受并行选区，限制实际读盘/进程并发；管理层的 6 个在途上限保持原样。
const clipWorkQueue = new MediaWorkQueue(2);

export interface ClipExportResult {
  ok: boolean;
  sizeBytes: number;
  stderr: string;
  method?: 'copy' | 'encode';
  actualEncoder?: string | null;
  fallbackReason?: string | null;
}

interface PacketBounds {
  first: number;
  last: number;
  duration: number;
  firstKey: boolean;
}

/** 按包流式检查首末 PTS，内存不随选区时长增长；不读取/解码整个源录像。 */
async function probeBounds(filePath: string, signal?: AbortSignal): Promise<Map<string, PacketBounds> | null> {
  if (signal?.aborted) return null;
  return new Promise(resolve => {
    const child = spawn(resolveBin('ffprobe'), ['-v', 'error', '-show_packets', '-show_streams',
      '-show_entries', 'stream=index,codec_type:packet=stream_index,pts_time,duration_time,flags',
      '-of', 'compact=p=1:nk=0', filePath], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const packets = new Map<string, PacketBounds>();
    const streams = new Map<string, string>();
    let buffer = '';
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const result = new Map<string, PacketBounds>();
      for (const [index, bounds] of packets) {
        const type = streams.get(index);
        if (type === 'video' || type === 'audio') result.set(`${type}:${index}`, bounds);
      }
      resolve(ok && result.size ? result : null);
    };
    const abort = () => { child.kill('SIGKILL'); finish(false); };
    let timer = setTimeout(abort, 30_000);
    signal?.addEventListener('abort', abort, { once: true });
    const line = (raw: string) => {
      const [kind, ...fields] = raw.trim().split('|');
      const values = Object.fromEntries(fields.map(field => {
        const i = field.indexOf('=');
        return [field.slice(0, i), field.slice(i + 1)];
      }));
      if (kind === 'stream') streams.set(values.index!, values.codec_type!);
      if (kind !== 'packet') return;
      const pts = Number(values.pts_time);
      if (!Number.isFinite(pts)) return;
      const duration = Number(values.duration_time);
      const previous = packets.get(values.stream_index!);
      if (!previous) {
        packets.set(values.stream_index!, { first: pts, last: pts,
          duration: Number.isFinite(duration) ? duration : 0, firstKey: Boolean(values.flags?.includes('K')) });
      } else {
        if (pts > previous.last) {
          previous.duration = Number.isFinite(duration) ? duration : Math.min(0.1, pts - previous.last);
          previous.last = pts;
        }
        previous.first = Math.min(previous.first, pts);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      clearTimeout(timer);
      timer = setTimeout(abort, 30_000);
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) line(raw);
    });
    child.on('error', () => finish(false));
    child.on('close', code => { if (buffer) line(buffer); finish(code === 0 && !signal?.aborted); });
  });
}

function accurateCopy(bounds: Map<string, PacketBounds> | null, keyframe: number, start: number, end: number): boolean {
  if (!bounds) return false;
  const video = [...bounds].find(([type]) => type.startsWith('video:'))?.[1];
  if (!video?.firstKey) return false;
  // 用视频首个 IDR 的源 PTS 锚定；同时检查音频与所有映射轨道，留 200ms 安全余量。
  for (const range of bounds.values()) {
    const actualStart = keyframe + range.first - video.first;
    const actualEnd = keyframe + range.last + range.duration - video.first;
    if (range === video) {
      if (Math.abs(actualStart - start) > CLIP_BOUNDARY_TOLERANCE_SECONDS || Math.abs(actualEnd - end) > CLIP_BOUNDARY_TOLERANCE_SECONDS) return false;
      if (Math.abs(actualEnd - actualStart - (end - start)) > CLIP_BOUNDARY_TOLERANCE_SECONDS) return false;
    } else if (actualStart < start - CLIP_BOUNDARY_TOLERANCE_SECONDS || actualEnd > end + CLIP_BOUNDARY_TOLERANCE_SECONDS) return false;
  }
  return true;
}

export async function exportClipFile(
  inputPath: string, outputPath: string, startSecond: number, endSecond: number,
  options: FfmpegRunOptions = {},
): Promise<ClipExportResult> {
  let source: FlvClipSource | null = null;
  try {
    if (!Number.isFinite(startSecond) || !Number.isFinite(endSecond) || startSecond < 0 || endSecond <= startSecond || inputPath === outputPath) {
      return { ok: false, sizeBytes: 0, stderr: 'Invalid clip selection' };
    }
    if (options.signal?.aborted) return { ok: false, sizeBytes: 0, stderr: 'Media job cancelled' };
    source = await openFlvClipSource(inputPath);
    return await clipWorkQueue.run(async () => {
      const copyInput = source ? await prepareFlvClipInput(source, startSecond, endSecond, true) : null;
      if (options.signal?.aborted) throw new Error('Media job cancelled');
      if (copyInput?.copySafe) {
        const res = await runFfmpegTracked(['-y', '-f', 'flv', '-i', 'pipe:0',
          '-t', String(endSecond - copyInput.keyframeSecond), '-map', '0:v?', '-map', '0:a?',
          '-c', 'copy', ...(copyInput.frameRate ? ['-r:v', String(copyInput.frameRate)] : []),
          '-avoid_negative_ts', 'make_zero', outputPath], { ...options, input: copyInput.createStream });
        if (res.ok && accurateCopy(await probeBounds(outputPath, options.signal), copyInput.keyframeSecond, startSecond, endSecond)) {
          const out = await stat(outputPath);
          return { ok: out.size > 0, sizeBytes: out.size, stderr: res.stderr, method: 'copy', actualEncoder: 'copy', fallbackReason: null };
        }
        await unlink(outputPath).catch(() => undefined);
      }
      if (options.signal?.aborted) throw new Error('Media job cancelled');
      // 精确模式始终从目标之前的关键帧开始解码，不把不足 1 秒的精度要求变成盲目 copy。
      const input = source ? await prepareFlvClipInput(source, startSecond, endSecond, false) : null;
      const sourceMoved = source && !(await access(inputPath).then(() => true, () => false));
      const inputArgs = input
        ? ['-copyts', '-f', 'flv', '-i', 'pipe:0', '-ss', String(Math.max(0, startSecond - input.baseSecond))]
        : ['-ss', String(startSecond), '-i', sourceMoved ? 'pipe:0' : inputPath];
      const runOptions = input ? { ...options, input: input.createStream } : sourceMoved
        ? { ...options, input: () => createFlvSnapshotStream(source!) }
        : options;
      const frameSync = input ? await videoPassthroughArgs() : [];
      let res: { ok: boolean; code: number | null; stderr: string } = { ok: false, code: null, stderr: '' };
      const outcome = await encodeWithFallback({
        mode: encodingMode(),
        crf: 23,
        isCancelled: () => options.signal?.aborted ?? false,
        attempt: async (encoder, quality) => {
          await unlink(outputPath).catch(() => undefined);
          let progressed = false;
          const tracked: FfmpegRunOptions = {
            ...runOptions,
            onProgress: (info) => {
              if (info.outTimeMs > 0) progressed = true;
              runOptions.onProgress?.(info);
            },
          };
          res = await encodingWorkQueue.run(() => runFfmpegTracked([
            '-y', ...inputArgs, '-t', String(endSecond - startSecond), '-map', '0:v?', '-map', '0:a?',
            '-c:v', encoder, ...quality,
            '-threads', String(Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))),
            '-c:a', 'aac', '-avoid_negative_ts', 'make_zero',
            ...frameSync,
            outputPath,
          ], tracked), options.signal);
          if (options.signal?.aborted) return '中途失败';
          if (!res.ok) return progressed ? '中途失败' : res.code === null ? '启动失败' : '无进度';
          const bounds = await probeBounds(outputPath, options.signal);
          const duration = endSecond - startSecond;
          const primary = bounds && ([...bounds].find(([type]) => type.startsWith('video:'))?.[1] ?? [...bounds.values()][0]);
          const valid = primary && Math.abs(primary.last + primary.duration - primary.first - duration) <= CLIP_BOUNDARY_TOLERANCE_SECONDS;
          return valid ? null : '产物校验失败';
        },
      });
      const bounds = res.ok ? await probeBounds(outputPath, options.signal) : null;
      // 编码路径保持帧级起点；拒绝 EOF 导致的明显短片，不能把半个选区标为成功。
      const duration = endSecond - startSecond;
      const primary = bounds && ([...bounds].find(([type]) => type.startsWith('video:'))?.[1] ?? [...bounds.values()][0]);
      const valid = primary && Math.abs(primary.last + primary.duration - primary.first - duration) <= CLIP_BOUNDARY_TOLERANCE_SECONDS;
      const out = await stat(outputPath).catch(() => null);
      const ok = res.ok && Boolean(valid && out?.size) && !options.signal?.aborted;
      if (!ok) await unlink(outputPath).catch(() => undefined);
      return { ok, sizeBytes: ok ? out!.size : 0, stderr: res.stderr + (res.ok && !valid ? '\nClip media does not cover the selected interval within 1 second' : ''), method: 'encode', actualEncoder: outcome.actualEncoder, fallbackReason: outcome.fallbackReason };
    }, options.signal);
  } catch (error) {
    if (inputPath !== outputPath) await unlink(outputPath).catch(() => undefined);
    return { ok: false, sizeBytes: 0, stderr: error instanceof Error ? error.message : String(error), actualEncoder: null, fallbackReason: null };
  } finally {
    await source?.close().catch(() => undefined);
  }
}
