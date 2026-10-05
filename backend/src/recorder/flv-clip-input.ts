import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { loadSeekIndex, lookupSeekEntry, pickFeedSeqHeaders, type SeekEntry } from '../storage/seek-index.js';

const READ_CHUNK = 256 * 1024;
const MAX_TAG = 16 * 1024 * 1024;
/** 业务要求 <1s，预留 200ms 给容器时间基与音视频帧边界。 */
export const CLIP_BOUNDARY_TOLERANCE_SECONDS = 0.8;

export interface FlvClipSource {
  filePath: string;
  handle: Awaited<ReturnType<typeof open>>;
  index: Awaited<ReturnType<typeof loadSeekIndex>>;
  tail: number;
  frameRate?: number;
  originSecond?: number;
  close: () => Promise<void>;
}

async function* readBytes(handle: Awaited<ReturnType<typeof open>>, from: number, to: number): AsyncGenerator<Buffer> {
  for (let position = from; position < to;) {
    const bytes = Buffer.alloc(Math.min(READ_CHUNK, to - position));
    const result = await handle.read(bytes, 0, bytes.length, position);
    if (!result.bytesRead) return;
    position += result.bytesRead;
    yield bytes.subarray(0, result.bytesRead);
  }
}

export function createFlvSnapshotStream(source: FlvClipSource): Readable {
  return Readable.from(readBytes(source.handle, 0, source.tail));
}

/** 入队前固定文件身份与尾界，录制结束改名或用户删除源记录不会换掉已提交的媒体。 */
export async function openFlvClipSource(filePath: string): Promise<FlvClipSource | null> {
  if (!/\.flv$/i.test(filePath)) return null;
  const handle = await open(filePath, 'r');
  try {
    const tail = (await handle.stat()).size;
    const index = await loadSeekIndex(filePath);
    const frameRate = await readFrameRate(handle);
    const originSecond = await readMediaOrigin(handle, tail);
    return { filePath, handle, tail, index, ...(frameRate ? { frameRate } : {}),
      ...(originSecond === undefined ? {} : { originSecond }), close: () => handle.close() };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function timestamp(tag: Buffer): number {
  return (tag.readUIntBE(4, 3) + tag[7]! * 0x1000000) >>> 0;
}

function setTimestamp(tag: Buffer, ms: number): void {
  tag.writeUIntBE(ms & 0xffffff, 4, 3);
  tag[7] = (ms >>> 24) & 255;
}

function compositionTime(tag: Buffer): number {
  const raw = tag.readUIntBE(13, 3);
  return raw & 0x800000 ? raw - 0x1000000 : raw;
}

async function readTag(handle: Awaited<ReturnType<typeof open>>, offset: number): Promise<Buffer> {
  const head = Buffer.alloc(11);
  if ((await handle.read(head, 0, 11, offset)).bytesRead !== 11) throw new Error('Incomplete FLV tag');
  const length = 15 + head.readUIntBE(1, 3);
  if (length > MAX_TAG) throw new Error('Invalid FLV tag');
  const tag = Buffer.alloc(length);
  if ((await handle.read(tag, 0, length, offset)).bytesRead !== length || tag.readUInt32BE(length - 4) !== length - 4) {
    throw new Error('Incomplete FLV tag');
  }
  return tag;
}

/** 保留输入 AMF 数值属性 framerate，避免截取后 FFmpeg 把 60fps 估成 62.5fps。 */
async function readFrameRate(handle: Awaited<ReturnType<typeof open>>): Promise<number | undefined> {
  try {
    const metadata = await readTag(handle, 13);
    if (metadata[0] !== 18) return undefined;
    const field = Buffer.concat([Buffer.from([0, 9]), Buffer.from('framerate'), Buffer.from([0])]);
    const position = metadata.indexOf(field, 11);
    if (position < 0 || position + field.length + 8 > metadata.length - 4) return undefined;
    const value = metadata.readDoubleBE(position + field.length);
    return Number.isFinite(value) && value > 0 && value <= 240 ? value : undefined;
  } catch { return undefined; }
}

/** 与 FFmpeg 一样用首个媒体 PTS 定义相对时间轴；序列头的 0 时间戳不属于媒体。 */
async function readMediaOrigin(handle: Awaited<ReturnType<typeof open>>, tail: number): Promise<number | undefined> {
  const header = Buffer.alloc(13);
  if ((await handle.read(header, 0, 13, 0)).bytesRead !== 13 || header.toString('ascii', 0, 3) !== 'FLV') return undefined;
  const needAudio = Boolean(header[4]! & 4);
  const needVideo = Boolean(header[4]! & 1);
  let audio: number | undefined;
  let video: number | undefined;
  for (let position = 13; position + 16 <= tail && position < 1024 * 1024;) {
    const tag = Buffer.alloc(16);
    if ((await handle.read(tag, 0, 16, position)).bytesRead !== 16) return undefined;
    const size = 15 + tag.readUIntBE(1, 3);
    if (size > MAX_TAG || position + size > tail) return undefined;
    if (tag[0] === 8 && audio === undefined && ((tag[11]! >> 4) !== 10 || tag[12] === 1)) audio = timestamp(tag);
    if (tag[0] === 9 && video === undefined && (tag[11]! & 15) === 7 && tag[12] === 1) video = timestamp(tag) + compositionTime(tag);
    if ((!needAudio || audio !== undefined) && (!needVideo || video !== undefined)) {
      const pts = [audio, video].filter((value): value is number => value !== undefined);
      return pts.length ? Math.min(...pts) / 1000 : undefined;
    }
    position += size;
  }
  return undefined;
}

export interface FlvClipInput {
  /** 归零基准是关键帧 DTS，精确模式按相对 PTS 剪裁。 */
  baseSecond: number;
  keyframeSecond: number;
  copySafe: boolean;
  frameRate?: number;
  createStream: () => Readable;
}

/** 只信任与真实字节严格匹配的索引。失效/不支持的 FLV 交回标准 FFmpeg 路径。 */
export async function prepareFlvClipInput(
  source: FlvClipSource, startSecond: number, endSecond: number, preferCopy: boolean,
): Promise<FlvClipInput | null> {
  try {
    const { entries, seqs } = source.index;
    if (!entries.length) return null;
    const origin = source.originSecond;
    if (origin === undefined) return null;
    const target = (startSecond + origin) * 1000;
    const previous = lookupSeekEntry(entries, target);
    if (!previous) return null;
    let entry = previous;
    if (preferCopy) {
      const next = entries.find(candidate => candidate.t > target);
      if (next && next.t - target < target - previous.t && next.t < (endSecond + origin) * 1000) entry = next;
    }
    const handle = source.handle;
    let prefix: Buffer;
    let tag: Buffer;
    const tail = source.tail;
    let nalSize = 0;
    const frameRate = source.frameRate;
    {
      const head = Buffer.alloc(13);
      if ((await handle.read(head, 0, 13, 0)).bytesRead !== 13 || head.toString('ascii', 0, 3) !== 'FLV' || head.readUInt32BE(5) !== 9) return null;
      tag = await readTag(handle, entry.b);
      // 索引时间与字节必须逐毫秒一致；不沿用跳播的 1.5s 容差。
      if (tag[0] !== 9 || tag[11] !== 0x17 || tag[12] !== 1 || timestamp(tag) !== entry.t) return null;
      const headers = pickFeedSeqHeaders(seqs, entry.b);
      if (!headers.some(header => header.k === 9)) return null;
      const parts: Buffer[] = [head];
      for (const header of headers) {
        const sequence = await readTag(handle, header.b);
        if (sequence[0] !== header.k || sequence[12] !== 0) return null;
        if (header.k === 9) {
          if (sequence[11] !== 0x17 || sequence.length < 25) return null;
          nalSize = (sequence[20]! & 3) + 1;
        }
        setTimestamp(sequence, 0);
        parts.push(sequence);
      }
      prefix = Buffer.concat(parts);
    }
    const pts = entry.t + compositionTime(tag);
    let idr = false;
    // FLV keyframe 标记可能属于 open GOP；只有真实 IDR 才允许无损复制起播。
    for (let offset = 16; nalSize && offset + nalSize < tag.length - 4;) {
      const size = tag.readUIntBE(offset, nalSize);
      offset += nalSize;
      if (size <= 0 || offset + size > tag.length - 4) break;
      if ((tag[offset]! & 31) === 5) idr = true;
      offset += size;
    }
    const changes = seqs.some(sequence => sequence.b > entry.b && sequence.t <= (endSecond + origin) * 1000);
    const copySafe = idr && !changes && Math.abs(pts / 1000 - origin - startSecond) <= CLIP_BOUNDARY_TOLERANCE_SECONDS && pts / 1000 - origin < endSecond;
    return {
      baseSecond: entry.t / 1000 - origin,
      keyframeSecond: pts / 1000 - origin,
      copySafe,
      ...(frameRate ? { frameRate } : {}),
      createStream: () => Readable.from(readSelection(handle, prefix, entry, tail, endSecond + origin)),
    };
  } catch {
    return null;
  }
}

/** 不限播放速率、按背压馈送；冻结尾界，裁掉在录文件尚未写完的尾标签。 */
async function* readSelection(handle: Awaited<ReturnType<typeof open>>, prefix: Buffer, entry: SeekEntry, to: number, endSecond: number): AsyncGenerator<Buffer> {
  yield prefix;
  let carry: Buffer = Buffer.alloc(0);
    for await (const chunk of readBytes(handle, entry.b, to)) {
      const bytes = carry.length ? Buffer.concat([carry, chunk as Buffer]) : chunk as Buffer;
      let offset = 0;
      const output: Buffer[] = [];
      while (offset + 11 <= bytes.length) {
        const length = 15 + bytes.readUIntBE(offset + 1, 3);
        if (length > MAX_TAG) throw new Error('Invalid FLV tag');
        if (offset + length > bytes.length) break;
        const tag = bytes.subarray(offset, offset + length);
        if (tag.readUInt32BE(length - 4) !== length - 4) throw new Error('Invalid FLV tag size');
        const ms = timestamp(tag);
        if (ms > (endSecond + 2) * 1000) {
          if (output.length) yield Buffer.concat(output);
          return;
        }
        if ((tag[0] === 8 || tag[0] === 9) && ms >= entry.t) {
          const rebased = Buffer.from(tag);
          setTimestamp(rebased, ms - entry.t);
          output.push(rebased);
        }
        offset += length;
      }
      if (output.length) yield Buffer.concat(output);
      carry = Buffer.from(bytes.subarray(offset));
    }
}
