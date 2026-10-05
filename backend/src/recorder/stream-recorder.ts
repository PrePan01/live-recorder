import type { ReadableStreamReadResult } from "node:stream/web";
import { createWriteStream } from "node:fs";
import { stat, mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { BufferedRecordingWriter, type BufferedWriterOptions, recoverRecordingBuffer } from "./buffered-writer.js";
import { StreamHealth, STREAM_IDLE_MS, MEDIA_IDLE_MS } from "./stream-health.js";
import { AppError } from "../types/error.js";
import type { ErrorObject } from "../types/index.js";
import { SeekIndexWriter, endSeekWriter, removeSeekIndexSidecar } from "../storage/seek-index.js";
import type {
  HlsCursor,
  RecordingEngine,
  RecordingEvent,
  RecordingResumeOptions,
  StreamInput,
} from "./engine.js";

/** 标签信息：跳播定位索引在写盘链顺手记录（关键帧/序列头 → 文件字节偏移）。 */
export interface FlvTagInfo {
  tagType: 8 | 9;
  /** 写入文件的时间戳（归一化后）。 */
  ts: number;
  seqHeader: boolean;
  keyframe: boolean;
  /** 标签在落盘文件中的起始字节偏移。 */
  fileOffset: number;
  byteLen: number;
}

/** 续录选项：文件里已有 FLV 头 + 本段时间戳偏移。 */
export interface FlvNormalizerOptions {
  /** 序列头 ts≈0 而媒体为绝对 PTS（抖音）时，以首个媒体标签为基准。 */
  rebaseFromFirstMedia?: boolean;
  /** New source resumes decoding only after a video keyframe. */
  requireKeyframe?: boolean;
  /** 续录：文件里已有 FLV 头，不再重复写入。 */
  skipHeader?: boolean;
  /** 续录：本段所有时间戳统一加上的偏移（上一段结尾时间戳），保证拼接处播放连续。 */
  offsetMs?: number;
  /** 文件已有的字节长度（续录追加时的偏移基准），供索引计算落盘偏移。 */
  appendBaseBytes?: number;
  /** 关键帧/序列头回调（跳播定位索引）。 */
  onTag?: (info: FlvTagInfo) => void;
}

/**
 * 流式 FLV 标签时间戳归一化：部分 CDN 直播流（如抖音）的媒体标签时间戳是
 * 直播开播以来的绝对 PTS（首帧即可达数千秒）。若直接落盘，播放器按最后一个标签
 * 时间戳计算时长（录 6 分钟显示 1 小时+），且只播得到实际帧。
 *
 * 策略：音频/视频共享【首个媒体标签】（排除 AVC/HEVC/AAC 序列头）扣减归零，
 * 使两条流都从 0 开始、容器时长 = 各自真实跨度（录制时长）。首帧≈0 的正常流（bilibili）透传。
 * 序列头 ts≈0 而媒体为绝对 PTS（抖音）时，基准取首个媒体标签，避免时长虚高（PrePan 复验）。
 * 时间戳按 FLV 规范读写：3 字节大端保存低 24 位，byte7 保存扩展高字节。
 * 兼容任意 chunk 边界（标签可能跨块），可流式处理。
 */
export class FlvTimestampNormalizer {
  private base: number | null = null;
  private epochShift = 0;
  private epochStartedAt = 0;
  private rawByTrack = new Map<number, number>();
  private resetTracks = new Set<number>();
  private lastByTrack = new Map<number, number>();
  private epochByTrack = new Map<number, number>();
  private buffer: Buffer = Buffer.alloc(0);
  private headerEmitted = false;
  /** 本段写出的最大时间戳；上层据此计算下一段续录的时间偏移。 */
  private maxTs = 0;
  /** 本段已产出的字节数（含 FLV 头），配合 appendBaseBytes 得到标签落盘偏移。 */
  private emittedBytes = 0;
  private awaitingKeyframe: boolean;

  constructor(private readonly options: FlvNormalizerOptions = {}) { this.awaitingKeyframe = options.requireKeyframe ?? false; }

  /** 本段最后一个媒体时间戳（毫秒，含续录偏移）。 */
  get hasMedia(): boolean { return this.rawByTrack.size > 0; }

  get lastTimestampMs(): number {
    return this.maxTs;
  }

  private static readTs(buf: Buffer, off: number): number {
    return buf.readUIntBE(off + 4, 3) + buf[off + 7]! * 0x1000000;
  }

  private static writeTs(buf: Buffer, off: number, ts: number): void {
    // FLV 扩展字节存高 8 位，低 24 位仍须保留原值，不能一律写成 0xffffff。
    buf[off + 4] = (ts >>> 16) & 0xff;
    buf[off + 5] = (ts >>> 8) & 0xff;
    buf[off + 6] = ts & 0xff;
    buf[off + 7] = (ts >>> 24) & 0xff;
  }

  /** 是否为 AVC/HEVC/AAC 序列头（编码器配置标签）：不计入时间戳 base——抖音等流序列头 ts≈0 而媒体帧为绝对 PTS。 */
  private isSequenceHeader(tagType: number, offset: number): boolean {
    const ds = this.buffer.readUIntBE(offset + 1, 3);
    if (ds < 2) return false;
    const d0 = this.buffer[offset + 11]!;
    const d1 = this.buffer[offset + 12]!;
    if (tagType === 9) {
      if (d0 & 0x80) return (d0 & 0x0f) === 0;
      const codec = d0 & 0x0f;
      return (codec === 7 || codec === 12) && d1 === 0;
    }
    if (tagType === 8) {
      return d0 >> 4 === 10 && d1 === 0;
    }
    return false;
  }

  /** 返回标签写入文件的时间戳（序列头=原样，媒体帧=归一化后）。 */
  private mediaTag(tagType: number, offset: number): number {
    const rawTs = FlvTimestampNormalizer.readTs(this.buffer, offset);
    const shift = this.options.offsetMs ?? 0;
    if (this.isSequenceHeader(tagType, offset)) {
      const ts = Math.max(shift, this.maxTs);
      FlvTimestampNormalizer.writeTs(this.buffer, offset, ts);
      return ts;
    }
    if (this.base === null) {
      this.base = this.options.rebaseFromFirstMedia || this.options.skipHeader || rawTs > 60_000 ? rawTs : 0;
    }
    const previousRaw = this.rawByTrack.get(tagType);
    if (previousRaw !== undefined && rawTs < previousRaw - 1000) {
      const joinsCurrentEpoch = !this.resetTracks.has(tagType)
        && this.resetTracks.size > 0 && this.maxTs - this.epochStartedAt <= 1000;
      if (!joinsCurrentEpoch) {
        this.resetTracks.clear();
        this.epochShift = previousRaw > 0xf0000000 && rawTs < 0x10000000
          ? (this.epochByTrack.get(tagType) ?? 0) + 0x100000000
          : this.maxTs - shift + this.base - rawTs + 1;
        this.epochStartedAt = this.maxTs;
      }
      this.resetTracks.add(tagType);
      this.epochByTrack.set(tagType, this.epochShift);
    }
    if (previousRaw === undefined) this.epochByTrack.set(tagType, this.epochShift);
    this.rawByTrack.set(tagType, rawTs);
    const ts = Math.max(this.lastByTrack.get(tagType) ?? shift, rawTs - this.base + shift + (this.epochByTrack.get(tagType) ?? 0));
    this.lastByTrack.set(tagType, ts);
    FlvTimestampNormalizer.writeTs(this.buffer, offset, ts);
    if (ts > this.maxTs) this.maxTs = ts;
    return ts;
  }

  /** 只把关键帧与序列头交给索引；偏移=已产出字节 + 续录基准。 */
  private notifyTag(
    tagType: number,
    offset: number,
    tagLen: number,
    ts: number,
  ): void {
    const onTag = this.options.onTag;
    if (!onTag) return;
    const d0 = this.buffer[offset + 11]!;
    const d1 = this.buffer[offset + 12]!;
    const seq = this.isSequenceHeader(tagType, offset);
    const keyframe = !seq && tagType === 9 && ((d0 >> 4) & 7) === 1;
    if (!seq && !keyframe) return;
    onTag({
      tagType: tagType === 8 ? 8 : 9,
      ts,
      seqHeader: seq,
      keyframe,
      fileOffset: (this.options.appendBaseBytes ?? 0) + this.emittedBytes,
      byteLen: tagLen,
    });
  }

  push(chunk: Buffer): Buffer[] {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: Buffer[] = [];
    // FLV 头（9）+ PreviousTagSize0（4）= 13 字节，之后才是标签流。
    // 续录时文件里已有文件头，只消费这 13 字节、不再写入，避免文件中途多出一个头。
    if (!this.headerEmitted && this.buffer.length >= 13) {
      if (!this.options.skipHeader) {
        out.push(this.buffer.subarray(0, 13));
        this.emittedBytes += 13;
      }
      this.headerEmitted = true;
      this.buffer = this.buffer.subarray(13);
    }
    if (!this.headerEmitted) return out;
    let offset = 0;
    while (offset + 11 <= this.buffer.length) {
      const tagType = this.buffer[offset]!;
      const dataSize = this.buffer.readUIntBE(offset + 1, 3);
      const tagLen = 11 + dataSize + 4; // 标签头 + 数据 + PreviousTagSize
      if (offset + tagLen > this.buffer.length) break;
      if (this.awaitingKeyframe && (tagType === 8 || tagType === 9) && !this.isSequenceHeader(tagType, offset)) {
        if (tagType === 9 && dataSize > 0 && ((this.buffer[offset + 11]! >> 4) & 7) === 1) this.awaitingKeyframe = false;
        else { offset += tagLen; continue; }
      }
      if (tagType === 8 || tagType === 9)
        this.notifyTag(tagType, offset, tagLen, this.mediaTag(tagType, offset));
      out.push(this.buffer.subarray(offset, offset + tagLen));
      this.emittedBytes += tagLen;
      offset += tagLen;
    }
    this.buffer = Buffer.from(this.buffer.subarray(offset));
    return out;
  }

  /** 收尾：只返回完整 FLV 标签；丢弃不完整的尾部标签，保证落盘文件结构完整。 */
  remaining(): Buffer {
    if (this.buffer.length === 0) return this.buffer;
    let offset = 0;
    let lastComplete = 0;
    while (offset + 11 <= this.buffer.length) {
      const tagType = this.buffer[offset]!;
      const dataSize = this.buffer.readUIntBE(offset + 1, 3);
      const tagLen = 11 + dataSize + 4;
      if (offset + tagLen > this.buffer.length) break; // 尾部不完整标签：不写入文件
      if (tagType === 8 || tagType === 9)
        this.notifyTag(tagType, offset, tagLen, this.mediaTag(tagType, offset));
      // 收尾段的标签同样计入产出字节：否则多标签时索引偏移不递增，命中即误判失效。
      this.emittedBytes += tagLen;
      offset += tagLen;
      lastComplete = offset;
    }
    const b = Buffer.from(this.buffer.subarray(0, lastComplete));
    this.buffer = Buffer.alloc(0);
    return b;
  }
}

/**
 * 真实录制引擎：HTTP 直拉直播流写入文件，按块产出 data 事件供预览转发；
 * 写入侧用 write stream + drain 背压，预览慢消费不阻塞落盘；断流/停止保留已写部分。
 * FLV 标签时间戳在写盘/转发前归一化（抖音等 CDN 绝对 PTS → 相对），保证时长与可播正确。
 */
export class StreamRecordingEngine implements RecordingEngine {
  private stopped = false;
  private recordingActive = false;
  private controller: AbortController | null = null;
  /** 本段写出的最大媒体时间戳；随 error/completed 上报，供上层计算下一段续录偏移。 */
  private lastTimestampMs = 0;
  private hlsCursor: HlsCursor | undefined;

  constructor(
    private fetcher: typeof fetch = fetch,
    private stallTimeoutMs: number = STREAM_IDLE_MS,
    private writerOptions: BufferedWriterOptions = {},
  ) {}

  setRecordingActive(active: boolean): void { this.recordingActive = active; }

  stop(): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    return Promise.resolve();
  }

  async *start(
    input: StreamInput,
    outputPath?: string | null,
    resume?: RecordingResumeOptions,
  ): AsyncIterable<RecordingEvent> {
    this.stopped = false;
    // 本段一个字节都没拿到就中断时，把传入的偏移原样带回，
    // 避免上层把续录偏移重置为 0、导致下一段时间轴跳回开头。
    this.lastTimestampMs = resume?.timestampOffsetMs ?? 0;
    this.hlsCursor = resume?.hlsCursor;
    try {
      if (input.format === "hls") {
        yield* this.runHls(input, outputPath ?? "", resume);
      } else {
        yield* this.runHttp(input, outputPath ?? null, resume);
      }
    } catch (err) {
      this.controller?.abort();
      const failure = this.toErrorObject(err);
      if (this.stopped) {
        if (failure.code === "RECORDING_WRITE_FAILED" || failure.code === "RECORDING_WRITE_SLOW") throw new AppError(failure.code, failure.message, { retryable: false, ...(failure.details ? { details: failure.details } : {}) });
        return;
      }
      console.log(
        `[recording ${new Date().toISOString()}] capture-failed file=${outputPath ?? "preview-upstream"} err=${this.toErrorObject(err).message}`,
      );
      yield {
        type: "error",
        error: this.toErrorObject(err),
        endTimestampMs: this.lastTimestampMs,
        ...(this.hlsCursor ? { hlsCursor: this.hlsCursor } : {}),
      };
    }
  }

  private async *runHttp(
    input: StreamInput,
    outputPath: string | null,
    resume?: RecordingResumeOptions,
  ): AsyncIterable<RecordingEvent> {
    this.controller = new AbortController();
    let res: Response;
    try {
      res = await this.fetcher(input.url, {
        ...(input.headers ? { headers: input.headers } : {}),
        signal: this.controller!.signal,
      });
    } catch (err) {
      if (this.stopped) return;
      throw toNetworkError(err);
    }
    if (!res.ok || !res.body) {
      throw httpStreamError(res.status, "拉流");
    }
    // 续录：追加写入已有文件；文件里已有 FLV 头时不再重复写入（首段 0 字节时仍需补头）。
    const append = Boolean(resume?.append);
    if (append && outputPath && this.writerOptions.directory) {
      const replayed = await recoverRecordingBuffer(this.writerOptions.directory, outputPath);
      if (replayed) {
        this.lastTimestampMs = Math.max(this.lastTimestampMs, await readFlvEndTimestamp(outputPath));
        await removeSeekIndexSidecar(outputPath);
      }
    }
    const existing =
      append && outputPath ? await stat(outputPath).catch(() => null) : null;
    const ws = outputPath
      ? createWriteStream(outputPath, { flags: append ? "a" : "w" })
      : null;
    const writer = ws && outputPath ? new BufferedRecordingWriter(ws, outputPath, { ...this.writerOptions, baseBytes: existing?.size ?? 0, ...(resume?.recordingId ? { recordingId: resume.recordingId } : {}) }) : null;
    // 写盘链起点：与收束行成对，供比对写入总量与内容时长。
    console.log(
      `[recording ${new Date().toISOString()}] writer-open file=${outputPath ?? "preview-upstream"} append=${append}`,
    );
    // 跳播定位索引：写盘链逐标签顺手记关键帧偏移（追加写、不反压录制；失败只降级索引）。
    const seekWriter = outputPath
      ? await SeekIndexWriter.open(outputPath, existing?.size ?? 0)
      : null;
    const pendingTags: FlvTagInfo[] = [];
    const normalizer = new FlvTimestampNormalizer({
      rebaseFromFirstMedia: true,
      skipHeader: Boolean(existing && existing.size > 0),
      requireKeyframe: Boolean(existing && existing.size > 0),
      offsetMs: this.lastTimestampMs,
      appendBaseBytes: existing?.size ?? 0,
      ...(seekWriter
        ? {
            onTag: (info: FlvTagInfo) => pendingTags.push(info),
          }
        : {}),
    });
    const previewNormalizer = outputPath
      ? new FlvTimestampNormalizer({ rebaseFromFirstMedia: true })
      : null;
    let size = existing?.size ?? 0;
    if (outputPath) yield { type: "file_created", filePath: outputPath };
    const reader = res.body.getReader();
    const health = new StreamHealth(this.stallTimeoutMs, this.stallTimeoutMs === STREAM_IDLE_MS ? MEDIA_IDLE_MS : this.stallTimeoutMs, () => {
      void reader.cancel().catch(() => undefined);
      this.controller?.abort();
    });
    try {
      while (!this.stopped) {
        health.begin();
        let result: ReadableStreamReadResult<Uint8Array>;
        try { result = await reader.read(); } catch (error) { health.check(); throw error; }
        finally { health.pause(); }
        health.check();
        const { done, value } = result;
        if (done) break;
        if (this.stopped) break;
        const receivedAt = Date.now();
        const previousTs = normalizer.lastTimestampMs;
        const chunk = Buffer.from(value);
        // 写盘归一器会原地修改时间戳，观看支路须先处理自己的副本。
        // 每个新上游都发送 FLV 头并从本段起播，绝不沿用文件的续录偏移。
        if (previewNormalizer) {
          for (const part of previewNormalizer.push(Buffer.from(chunk)))
            yield { type: "preview_data", chunk: part };
        }
        const parts = normalizer.push(chunk);
        health.received(normalizer.lastTimestampMs > previousTs, Boolean(outputPath || this.recordingActive) && normalizer.hasMedia);
        const normalized = Buffer.concat(parts);
        const tags = pendingTags.splice(0);
        const timestamp = normalizer.lastTimestampMs;
        const commit = () => {
          size += normalized.length;
          this.lastTimestampMs = timestamp;
          for (const info of tags) seekWriter?.note(info.seqHeader
            ? { t: info.ts, b: info.fileOffset, s: 1, k: info.tagType }
            : { t: info.ts, b: info.fileOffset });
        };
        if (normalized.length) {
          if (writer) await writer.write(normalized, commit); else commit();
          yield { type: "data", chunk: normalized, previewForwarded: Boolean(previewNormalizer), receivedAt, ...(normalizer.hasMedia ? { mediaTimestampMs: timestamp } : {}) };
        }
      }
    } finally {
      health.pause();
      await reader.cancel().catch(() => undefined);
      // 收尾仅保留完整标签，残缺标签不写入文件。
      const previewRest = previewNormalizer?.remaining();
      if (previewRest && previewRest.length > 0)
        yield { type: "preview_data", chunk: previewRest };
      const rest = normalizer.remaining();
      if (rest.length > 0 && !writer?.failed()) {
        if (writer) await writer.write(rest, () => { size += rest.length; this.lastTimestampMs = normalizer.lastTimestampMs; });
        else size += rest.length;
        yield { type: "data", chunk: rest, previewForwarded: Boolean(previewNormalizer) };
      }
      try { if (writer) await writer.close(); }
      finally {
        if (seekWriter && outputPath) { await seekWriter.close(); endSeekWriter(outputPath); }
      }
      // 收束时同帧输出写入字节与最大媒体时间戳：比值异常即写入量与内容时长失配。
      console.log(
        `[recording ${new Date().toISOString()}] writer-close file=${outputPath ?? "preview-upstream"} bytes=${size} lastTs=${this.lastTimestampMs}ms`,
      );
      // 收束日志须在 finally 内：停录走 generator.return() 只执行 finally、其后语句被跳过。
      console.log(
        `[recording ${new Date().toISOString()}] capture-end file=${outputPath ?? "preview-upstream"} ${this.stopped ? "stop-requested" : "source-exhausted"}`,
      );
    }
    if (this.stopped) return;
    yield {
      type: "completed",
      fileSize: size,
      endTimestampMs: this.lastTimestampMs,
    };
  }

  private async *runHls(
    input: StreamInput,
    outputPath: string,
    resume?: RecordingResumeOptions,
  ): AsyncIterable<RecordingEvent> {
    this.controller = new AbortController();
    if (resume?.append && outputPath && this.writerOptions.directory) await recoverRecordingBuffer(this.writerOptions.directory, outputPath);
    const existing = resume?.append ? await stat(outputPath).catch(() => null) : null;
    const ws = outputPath ? createWriteStream(outputPath, { flags: resume?.append ? "a" : "w" }) : null;
    const writer = ws ? new BufferedRecordingWriter(ws, outputPath, { ...this.writerOptions, baseBytes: existing?.size ?? 0, ...(resume?.recordingId ? { recordingId: resume.recordingId } : {}) }) : null;
    let size = existing?.size ?? 0;
    const seen = new Set<string>();
    if (outputPath) yield { type: "file_created", filePath: outputPath };
    let quietMs = 0;
    try {
      while (!this.stopped) {
        const waitingAt = performance.now();
        const text = await this.fetchText(input.url, input.headers);
        quietMs += performance.now() - waitingAt;
        const parsed = parseM3u8(text, input.url);
        if (parsed.mediaSequence !== null && this.hlsCursor &&
            parsed.discontinuitySequence !== this.hlsCursor.discontinuitySequence &&
            parsed.mediaSequence + parsed.segments.length - 1 < this.hlsCursor.sequence) {
          // A new discontinuity epoch can restart sequence numbering.
          this.hlsCursor = undefined;
          seen.clear();
        }
        let downloaded = false;
        for (let i = 0; i < parsed.segments.length; i++) {
          if (this.stopped) return;
          const seg = parsed.segments[i]!;
          const key = parsed.mediaSequence === null ? seg : String(parsed.mediaSequence + i);
          if (seen.has(key) || (parsed.mediaSequence !== null && this.hlsCursor && parsed.mediaSequence + i <= this.hlsCursor.sequence)) continue;
          // Publish complete segments only. A failed or stopped download must
          // never append a partial TS segment and then duplicate it on retry.
          const directory = await mkdtemp(path.join(tmpdir(), "lr-hls-segment-"));
          const stage = await open(path.join(directory, "segment"), "w+");
          try {
            let segmentSize = 0;
            for await (const chunk of this.fetchChunks(seg, input.headers)) {
              if (this.stopped) return;
              let offset = 0;
              while (offset < chunk.length) {
                const written = await stage.write(chunk, offset, chunk.length - offset, segmentSize + offset);
                if (!written.bytesWritten) throw new Error("分片暂存无写入进度");
                offset += written.bytesWritten;
              }
              segmentSize += chunk.length;
              if (segmentSize > 512 * 1024 ** 2) throw new AppError("RECORDING_WRITE_SLOW", "直播分片超过暂存上限", { retryable: false });
            }
            if (this.stopped) return;
            const cursor = parsed.mediaSequence === null ? undefined : { sequence: parsed.mediaSequence + i, discontinuitySequence: parsed.discontinuitySequence };
            if (writer && segmentSize) await writer.writeStagedFile(path.join(directory, "segment"), segmentSize, () => {
              size += segmentSize;
            });
            if (writer && cursor) this.hlsCursor = cursor;
            let offset = 0;
            while (offset < segmentSize) {
              const buffer = Buffer.alloc(Math.min(256 * 1024, segmentSize - offset));
              const read = await stage.read(buffer, 0, buffer.length, offset);
              if (!read.bytesRead) throw new Error("分片暂存读取无进度");
              const chunk = buffer.subarray(0, read.bytesRead);
              if (!writer) size += chunk.length;
              yield { type: "data", chunk };
              offset += chunk.length;
            }
            if (!writer && cursor) this.hlsCursor = cursor;
            seen.add(key);
            downloaded = true;
            quietMs = 0;
          } finally { await stage.close(); await rm(directory, { recursive: true, force: true }); }
        }
        // Retain only the current playlist window; sequence identities survive
        // signed URL changes without growing a set for the whole broadcast.
        const currentKeys = new Set(parsed.segments.map((seg, i) => parsed.mediaSequence === null ? seg : String(parsed.mediaSequence + i)));
        for (const key of seen) if (!currentKeys.has(key)) seen.delete(key);
        if (this.stopped) return;
        if (parsed.ended) break;
        const quietLimit = this.stallTimeoutMs === STREAM_IDLE_MS
          ? Math.max(STREAM_IDLE_MS, parsed.targetDuration ? parsed.targetDuration * 3000 : 30_000)
          : this.stallTimeoutMs;
        if (!downloaded && quietMs >= quietLimit) throw new AppError("NETWORK_UNAVAILABLE", "直播分片持续未更新，正在恢复", {
          retryable: true, details: { trigger: "playlist_stall", quietMs, quietLimit, targetDuration: parsed.targetDuration },
        });
        const pollAt = performance.now();
        await this.waitForPoll(hlsPollIntervalMs(parsed.targetDuration));
        quietMs += performance.now() - pollAt;
      }
    } finally { await writer?.close(); }
    if (this.stopped) return;
    yield { type: "completed", fileSize: size, endTimestampMs: this.lastTimestampMs, ...(this.hlsCursor ? { hlsCursor: this.hlsCursor } : {}) };
  }

  private async waitForPoll(ms: number): Promise<void> {
    const signal = this.controller!.signal;
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  private async fetchResponse(url: string, headers: Record<string, string> | undefined): Promise<Response> {
    const timer = setTimeout(() => this.controller?.abort(), this.stallTimeoutMs);
    try {
      const res = await this.fetcher(url, { ...(headers ? { headers } : {}), signal: this.controller!.signal });
      if (!res.ok || !res.body) throw httpStreamError(res.status, "HLS 拉取");
      return res;
    } finally { clearTimeout(timer); }
  }

  private async fetchText(url: string, headers: Record<string, string> | undefined): Promise<string> {
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of this.fetchChunks(url, headers)) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new AppError("PLATFORM_CHANGED", "直播播放列表过大", { retryable: true });
      parts.push(chunk);
    }
    return Buffer.concat(parts).toString("utf8");
  }

  private async *fetchChunks(url: string, headers: Record<string, string> | undefined): AsyncIterable<Buffer> {
    const res = await this.fetchResponse(url, headers);
    const reader = res.body!.getReader();
    const health = new StreamHealth(this.stallTimeoutMs, this.stallTimeoutMs, () => {
      void reader.cancel().catch(() => undefined); this.controller?.abort();
    });
    health.received(false);
    try {
      while (!this.stopped) {
        health.begin();
        let result: ReadableStreamReadResult<Uint8Array>;
        try { result = await reader.read(); } catch (error) { health.check(); throw error; }
        finally { health.pause(); }
        health.check();
        if (result.done) break;
        health.received(false);
        yield Buffer.from(result.value);
      }
    } finally { health.pause(); await reader.cancel().catch(() => undefined); }
  }

  private toErrorObject(err: unknown): ErrorObject {
    if (err instanceof AppError) return err.toObject();
    if (err instanceof Error && err.name === "AbortError") {
      return new AppError("NETWORK_UNAVAILABLE", "拉流中断", {
        retryable: true,
      }).toObject();
    }
    // 写盘类错误（磁盘满/权限/IO）与网络无关，标为非可重试，让上层直接收尾而不是空等退避。
    const errno = (err as NodeJS.ErrnoException | undefined)?.code;
    if (typeof errno === "string" && WRITE_ERRNO.has(errno)) {
      return new AppError(
        "RECORDING_WRITE_FAILED",
        `写入录像文件失败（${errno}）`,
        { retryable: false, details: { errno } },
      ).toObject();
    }
    return new AppError(
      "NETWORK_UNAVAILABLE",
      "直播流读取失败，正在恢复",
      { retryable: true, details: { trigger: "read_error", errorName: (err as Error)?.name, errno, causeCode: (err as { cause?: NodeJS.ErrnoException })?.cause?.code } },
    ).toObject();
  }
}

/** 写盘失败的系统错误码：命中即说明是磁盘问题，重试拉流不会好。 */
const WRITE_ERRNO = new Set([
  "ENOSPC",
  "EDQUOT",
  "EACCES",
  "EPERM",
  "EIO",
  "EROFS",
  "EMFILE",
  "ENFILE",
  "ENOTDIR",
  "EBUSY",
  "ENOENT",
  "EISDIR",
  "ENODEV",
  "ENXIO",
]);

function toNetworkError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  return new AppError("NETWORK_UNAVAILABLE", "拉流连接失败", { retryable: true, details: { trigger: "request_error", errorName: (err as Error)?.name, errno: (err as NodeJS.ErrnoException)?.code, causeCode: (err as { cause?: NodeJS.ErrnoException })?.cause?.code } });
}

/**
 * 按 HTTP 状态归类拉流失败：地址过期与平台服务异常各自可辨，
 * 而不是一律归成"网络不可用"，否则失败原因对不上用户实际遇到的情况。
 */
function httpStreamError(status: number, what: string): AppError {
  if (status === 401 || status === 403 || status === 410) {
    return new AppError("STREAM_URL_EXPIRED", `${what}失败 HTTP ${status}`, {
      retryable: true,
    });
  }
  if (status >= 500) {
    return new AppError("PLATFORM_SERVER_ERROR", `${what}失败 HTTP ${status}`, {
      retryable: true,
    });
  }
  return new AppError("NETWORK_UNAVAILABLE", `${what}失败 HTTP ${status}`, {
    retryable: true,
  });
}

export function parseM3u8(
  text: string,
  baseUrl: string,
): { segments: string[]; ended: boolean; targetDuration: number | null; mediaSequence: number | null; discontinuitySequence: number } {
  const segments: string[] = [];
  let ended = false;
  let targetDuration: number | null = null;
  let mediaSequence: number | null = null;
  let discontinuitySequence = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const n = Number(line.split(":")[1]);
      if (Number.isSafeInteger(n) && n >= 0) mediaSequence = n;
    }
    if (line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE:")) {
      const n = Number(line.split(":")[1]);
      if (Number.isSafeInteger(n) && n >= 0) discontinuitySequence = n;
    }
    if (line === "#EXT-X-ENDLIST") ended = true;
    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      const d = Number(line.split(":")[1]);
      if (Number.isFinite(d) && d > 0) targetDuration = d;
    }
    if (line.startsWith("#") || line === "") continue;
    segments.push(new URL(line, baseUrl).toString());
  }
  return { segments, ended, targetDuration, mediaSequence, discontinuitySequence };
}

/** #226：HLS 轮询间隔 = min(目标分片时长 × 0.8, 3000ms) 且 ≥1000ms；未知时长回退 3000ms。 */
export function hlsPollIntervalMs(targetDuration: number | null): number {
  if (!targetDuration) return 3000;
  return Math.min(Math.max(Math.round(targetDuration * 800), 1000), 3000);
}

/** Read the complete tail tags after spool replay so the next source starts at
 * the actual file end rather than the pre-error timestamp. */
async function readFlvEndTimestamp(filePath: string): Promise<number> {
  const handle = await open(filePath, "r");
  try {
    const head = Buffer.alloc(3);
    await handle.read(head, 0, 3, 0);
    if (head.toString() !== "FLV") return 0;
    let end = (await handle.stat()).size;
    let timestamp = 0;
    for (let i = 0; i < 64 && end > 13; i++) {
      const previousSize = Buffer.alloc(4);
      await handle.read(previousSize, 0, 4, end - 4);
      const length = previousSize.readUInt32BE(0);
      const start = end - 4 - length;
      if (length < 11 || start < 13) break;
      const tag = Buffer.alloc(11);
      await handle.read(tag, 0, 11, start);
      if (tag.readUIntBE(1, 3) + 11 !== length) break;
      if (tag[0] === 8 || tag[0] === 9) timestamp = Math.max(timestamp, tag.readUIntBE(4, 3) + tag[7]! * 0x1000000);
      end = start;
    }
    return timestamp;
  } finally { await handle.close(); }
}
