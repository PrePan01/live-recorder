import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { PassThrough } from 'node:stream';
import { AppError } from '../types/error.js';
import { BufferedRecordingWriter, type BufferedWriterOptions } from './buffered-writer.js';
import type { RecordingEngine, RecordingEvent, RecordingResumeOptions, StreamInput } from './engine.js';
import { MatroskaLiveParser } from './matroska-live.js';
import { readYoutubeParts, saveYoutubeParts, youtubeSize } from './youtube-media.js';

/** A writer subscribed to an existing native source. No network or media process
 * is created; only Cluster timecodes are rebased for the new recording clock. */
export class YoutubeNativeRecordingEngine implements RecordingEngine {
  private stopped = false;
  private startupObserver: ((stage: string) => void) | undefined;
  private downloadObserver: ((bytes: number) => void) | undefined;
  constructor(private readonly options: BufferedWriterOptions, private readonly stream: PassThrough,
    private readonly originMs: number, private readonly previewActive: (active: boolean) => void,
    private readonly previewOffset: () => number | null) {}
  setStartupObserver(observer: (stage: string) => void): void { this.startupObserver = observer; }
  setDownloadObserver(observer: (bytes: number) => void): void { this.downloadObserver = observer; }
  setPreviewActive(active: boolean): void { this.previewActive(active); }
  recordingPreviewOffsetMs(): number | null { return this.previewOffset(); }
  expectedDataIntervalMs(): number { return 10_000; }
  async stop(): Promise<void> { this.stopped = true; this.stream.destroy(); }

  async *start(_input: StreamInput, outputPath?: string | null, resume?: RecordingResumeOptions): AsyncIterable<RecordingEvent> {
    if (!outputPath) throw new AppError('CONFIG_INVALID', '原生录像写入器缺少目标文件');
    const offset = resume?.timestampOffsetMs ?? 0;
    let timestamp = offset;
    const parts = await readYoutubeParts(outputPath);
    if (resume?.append && !parts.length && (await stat(outputPath).catch(() => null))?.size)
      parts.push({ path: outputPath, offsetMs: 0, durationMs: offset });
    const target = parts.length ? `${outputPath}.part-${parts.length}.mkv` : outputPath;
    const part = { path: target, offsetMs: offset, durationMs: 0 };
    parts.push(part);
    await saveYoutubeParts(outputPath, parts);
    const file = createWriteStream(target, { flags: 'w' });
    const writer = new BufferedRecordingWriter(file, target, { ...this.options,
      ...(resume?.recordingId ? { recordingId: resume.recordingId } : {}) });
    let failure: AppError | undefined;
    file.on('error', error => {
      failure = new AppError('RECORDING_WRITE_FAILED', '录像写入失败，已保留有效分段',
        { details: { errno: (error as NodeJS.ErrnoException).code }, retryable: false });
      this.stream.destroy();
    });
    const parser = new MatroskaLiveParser();
    let initialized = false, lastManifest = Date.now();
    try {
      this.startupObserver?.('reused_native_source');
      yield { type: 'file_created', filePath: outputPath };
      if (this.stream.destroyed && !this.stopped) throw new Error('Native source ended before attachment');
      for await (const bytes of this.stream) {
        if (this.stopped) break;
        const clusters = parser.push(Buffer.from(bytes));
        if (!initialized && parser.header) {
          initialized = true;
          await writer.write(parser.header);
          yield { type: 'media_info', source: { width: parser.width, height: parser.height,
            videoCodec: parser.videoCodec, audioCodec: parser.audioCodec } };
          yield { type: 'data', chunk: parser.header, previewForwarded: true };
        }
        for (const cluster of clusters) {
          const chunk = parser.rebaseCluster(cluster, this.originMs);
          await writer.write(chunk);
          this.downloadObserver?.(chunk.length);
          timestamp = Math.max(timestamp, offset + parser.timestampMs - this.originMs);
          part.durationMs = Math.max(0, timestamp - offset);
          yield { type: 'data', chunk, mediaTimestampMs: timestamp, previewForwarded: true, receivedAt: Date.now() };
        }
        if (Date.now() - lastManifest >= 5000) {
          await saveYoutubeParts(outputPath, parts); lastManifest = Date.now();
        }
      }
    } catch (error) {
      if (!this.stopped) failure ??= error instanceof AppError ? error
        : new AppError('NETWORK_UNAVAILABLE', '共享的 YouTube 媒体来源中断', { retryable: true });
    } finally {
      this.stream.destroy();
      try { await writer.close(); }
      catch (error) { failure ??= new AppError('RECORDING_WRITE_FAILED', '录像冲刷失败，已保留暂存数据', { retryable: false }); }
      await saveYoutubeParts(outputPath, parts);
    }
    if (failure) yield { type: 'error', error: failure.toObject(), endTimestampMs: timestamp };
    else yield { type: 'completed', fileSize: await youtubeSize(outputPath), endTimestampMs: timestamp };
  }
}
