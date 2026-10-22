import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { PassThrough } from "node:stream";
import type {
  RecordingEngine,
  RecordingEvent,
  StreamInput,
  RecordingResumeOptions,
} from "./engine.js";
import { AppError } from "../types/error.js";
import {
  youtubeArguments,
  spawnYoutube,
  terminateYoutube,
  youtubeError,
} from "../platform/youtube-runtime.js";
import { resolveBin } from "../utils/ffmpeg.js";
import { trackFfmpeg } from "./ffmpeg-registry.js";
import {
  BufferedRecordingWriter,
  type BufferedWriterOptions,
} from "./buffered-writer.js";
import { MatroskaLiveParser } from "./matroska-live.js";
import {
  readYoutubeParts,
  saveYoutubeParts,
  youtubeSize,
} from "./youtube-media.js";
import { FlvTimestampNormalizer } from "./stream-recorder.js";
import { youtubeDirectInputs, youtubeSelectedHls } from "./youtube-source.js";
import { YoutubeHlsSource } from "./youtube-hls-source.js";
import { YoutubeNativeRecordingEngine } from "./youtube-native-recorder.js";
import {
  detectPreviewHwEncoder,
  encoderQualityArgs,
  softwareEncodeArgs,
} from "./hw-encode.js";

export class YoutubeRecordingEngine implements RecordingEngine {
  private stopped = false;
  private running = false;
  private source: ChildProcess | null = null;
  private remux: ChildProcess | null = null;
  private preview: ChildProcess | null = null;
  private wantsPreview = false;
  private activatePreview: (() => void) | undefined;
  private previewEpoch = 0;
  private observer: ((bytes: number) => void) | undefined;
  private startupObserver: ((stage: string) => void) | undefined;
  private inputAbort: AbortController | undefined;
  private hlsSource: YoutubeHlsSource | undefined;
  private nativeParser: MatroskaLiveParser | undefined;
  private nativeInput: StreamInput | undefined;
  private outputRecording = false;
  private previewOriginMs: number | null = null;
  private readonly nativeFollowers = new Set<PassThrough>();
  constructor(
    private readonly writerOptions: BufferedWriterOptions = {},
    private readonly encodingMode: "auto" | "software" = "auto",
  ) {}
  hasRecordingConsumers(): boolean { return this.nativeFollowers.size > 0; }
  forkRecording(quality: string): RecordingEngine | null {
    const parser = this.nativeParser, input = this.nativeInput;
    if (!this.running || this.outputRecording || this.nativeFollowers.size ||
        !parser || !input?.youtube || this.previewOriginMs === null) return null;
    const limits: Record<string, number> = { '1080p': 1080, '720p': 720, '540p': 540, '360p': 360 };
    try {
      if (quality !== 'original' && !limits[quality]) return null;
      const info = JSON.parse(input.youtube.snapshot?.json ?? '{}') as { formats?: Array<{ height?: number }> };
      const heights = (info.formats ?? []).map(f => f.height ?? 0).filter(height => height > 0);
      const eligible = quality === 'original' ? heights : heights.filter(height => height <= limits[quality]!);
      const expected = Math.max(0, ...eligible);
      if (!expected || parser.height !== expected) return null;
    } catch { return null; }
    const bootstrap = parser.recordingBootstrap();
    if (!bootstrap) return null;
    const stream = new PassThrough({ highWaterMark: 256 * 1024 });
    stream.on('error', () => {});
    this.nativeFollowers.add(stream);
    this.wantsPreview = true;
    stream.once('close', () => {
      this.nativeFollowers.delete(stream);
      if (!this.nativeFollowers.size && !this.wantsPreview && this.running) void this.stop();
    });
    stream.write(bootstrap);
    const originMs = parser.recordingStartMs;
    return new YoutubeNativeRecordingEngine(this.writerOptions, stream, originMs,
      active => this.setPreviewActive(active),
      () => this.previewOriginMs === null ? null : this.previewOriginMs - originMs);
  }
  setDownloadObserver(observer: (bytes: number) => void): void {
    this.observer = observer;
  }
  setStartupObserver(observer: (stage: string) => void): void { this.startupObserver = observer; }
  setPreviewActive(active: boolean): void {
    this.wantsPreview = active;
    if (!active) {
      this.previewEpoch++;
      const previous = this.preview;
      this.preview = null;
      previous?.kill("SIGKILL");
    }
    else this.activatePreview?.();
  }
  expectedDataIntervalMs(): number {
    return 10_000;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    this.inputAbort?.abort();
    void this.hlsSource?.close();
    if (this.source) {
      const source = this.source;
      terminateYoutube(source);
      const timer = setTimeout(() => terminateYoutube(source, true), 2000);
      timer.unref();
      source.once("close", () => clearTimeout(timer));
    }
    this.preview?.kill("SIGKILL");
    this.remux?.kill("SIGKILL");
  }
  async *start(
    input: StreamInput,
    outputPath?: string | null,
    resume?: RecordingResumeOptions,
  ): AsyncIterable<RecordingEvent> {
    if (!input.youtube)
      throw new AppError("CONFIG_INVALID", "缺少 YouTube 媒体来源");
    this.stopped = false;
    this.inputAbort = new AbortController();
    const offset = resume?.timestampOffsetMs ?? 0;
    let timestamp = offset,
      bytes = 0,
      stderr = "",
      failure: Error | null = null;
    // A viewer can join between upstream fragments. Keep a bounded, decodable
    // GOP even when recording started without a viewer.
    const parser = new MatroskaLiveParser(true);
    this.nativeParser = parser;
    this.nativeInput = input;
    this.outputRecording = Boolean(outputPath);
    const pending: Array<{ epoch: number; event: RecordingEvent }> = [];
    let pendingBytes = 0;
    let wake: (() => void) | undefined;
    const notify = () => {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };
    let metadataSent = false;
    const parts = outputPath ? await readYoutubeParts(outputPath) : [];
    if (
      outputPath &&
      resume?.append &&
      !parts.length &&
      (await stat(outputPath).catch(() => null))?.size
    )
      parts.push({ path: outputPath, offsetMs: 0, durationMs: offset });
    const target = outputPath
      ? parts.length
        ? `${outputPath}.part-${parts.length}.mkv`
        : outputPath
      : null;
    const part = target
      ? { path: target, offsetMs: offset, durationMs: 0 }
      : null;
    if (part && outputPath) {
      parts.push(part);
      await saveYoutubeParts(outputPath, parts);
    }
    const auth = await youtubeArguments(input.youtube.cookie, input.youtube.snapshot);
    if (this.stopped) {
      await auth.dispose();
      return;
    }
    const tracks = youtubeSelectedHls(input.youtube);
    if (tracks) {
      try {
        this.hlsSource = await YoutubeHlsSource.open(tracks, this.inputAbort.signal,
          stage => this.startupObserver?.(stage));
      } catch {
        await auth.dispose();
        if (!this.stopped) yield { type: 'error', error: youtubeError('HLS input initialization').toObject(), endTimestampMs: offset };
        return;
      }
      if (this.stopped) { await this.hlsSource.close(); await auth.dispose(); return; }
    }
    this.running = true;
    const startedMs = Date.now();
    const ws = target ? createWriteStream(target, { flags: "w" }) : null;
    const writer =
      ws && target
        ? new BufferedRecordingWriter(ws, target, { ...this.writerOptions,
            ...(resume?.recordingId ? { recordingId: resume.recordingId } : {}) })
        : null;
    // Attach before any async startup work; late disk errors must never be unhandled.
    ws?.on("error", (error) => {
      failure = new AppError(
        "RECORDING_WRITE_FAILED",
        "录像写入失败，已保留有效分段",
        {
          retryable: false,
          details: { errno: (error as NodeJS.ErrnoException).code },
        },
      );
      this.source && terminateYoutube(this.source, true);
    });
    let previewFailedHardware = false;
    let previewStarting = false;
    const startPreview = async () => {
      if (
        this.preview ||
        previewStarting ||
        !parser.header ||
        this.stopped ||
        !this.running
      )
        return;
      previewStarting = true;
      try {
        const copy = parser.canCopyToFlv;
        const hardware =
          !copy && this.encodingMode === "auto" && !previewFailedHardware
            ? await detectPreviewHwEncoder()
            : null;
        if (this.stopped || !this.running || (outputPath && !this.wantsPreview))
          return;
        // Resolve after hardware detection so startup includes every cluster
        // received during that await, starting from a video keyframe.
        const bootstrap = parser.recordingBootstrap();
        if (!bootstrap) return;
        const startMs = offset + parser.recordingStartMs;
        const child = spawn(
          resolveBin("ffmpeg"),
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            "2",
            "-analyzeduration",
            // This pipe already carries our validated Matroska tracks and
            // codec private data. Do not wait for a second HLS burst merely
            // to estimate frame rate; transcode preview uses an explicit fps.
            "100000",
            "-probesize",
            "262144",
            "-fpsprobesize",
            "0",
            "-i",
            "pipe:0",
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            ...(copy
              ? ["-c", "copy"]
              : [
                  "-vf",
                  "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
                  ...(hardware
                    ? ["-c:v", hardware, ...encoderQualityArgs(hardware, 23)]
                    : softwareEncodeArgs(23, "ultrafast")),
                  "-pix_fmt",
                  "yuv420p",
                  "-threads",
                  "2",
                  "-c:a",
                  "aac",
                  "-b:a",
                  "128k",
                ]),
            "-flush_packets",
            "1",
            "-f",
            "flv",
            "pipe:1",
          ],
          { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
        );
        this.preview = child;
        this.startupObserver?.('preview_encoder_started');
        console.log(`[youtube-recorder] preview-encoder path=${copy ? "copy" : "transcode"} hw=${hardware !== null} video=${parser.videoCodec ?? "?"} audio=${parser.audioCodec ?? "?"} started=+${Date.now() - startedMs}ms`);
        const epoch = this.previewEpoch;
        this.previewOriginMs = startMs;
        const untrack = trackFfmpeg(child);
        const normalizer = new FlvTimestampNormalizer({
          rebaseFromFirstMedia: true,
        });
        const done = () => {
          untrack();
          if (this.preview !== child) return;
          this.preview = null;
          if (hardware) previewFailedHardware = true;
          if (hardware && ((!outputPath && !this.nativeFollowers.size) || this.wantsPreview))
            this.activatePreview?.();
        };
        let previewStderr = "";
        child.once("error", done);
        child.once("close", (code) => {
          // 秒退且无出数=启动卡死最常见的形态（探测预算/输入格式），退出码与 stderr 必须落日志。
          if (this.preview === child)
            console.log(`[youtube-recorder] preview-encoder exit code=${code} +${Date.now() - startedMs}ms stderr=${previewStderr.slice(-300)}`);
          done();
        });
        child.stdin.on("error", () => {});
        child.stderr.on("data", (chunk: Buffer) => {
          previewStderr = (previewStderr + chunk.toString()).slice(-2048);
        });
        let previewProgressSent = false;
        child.stdout.on("data", (data: Buffer) => {
          if (this.stopped || this.preview !== child || epoch !== this.previewEpoch) return;
          const chunk = Buffer.concat(normalizer.push(Buffer.from(data)));
          if (!chunk.length) return;
          if (!previewProgressSent) {
            previewProgressSent = true;
            console.log(`[youtube-recorder] preview-first-byte +${Date.now() - startedMs}ms`);
            this.startupObserver?.('preview_media_ready');
          }
          if (pendingBytes + chunk.length > 4 * 1024 * 1024) {
            child.kill("SIGKILL");
            return;
          }
          pendingBytes += chunk.length;
          pending.push({ epoch, event: outputPath
              ? { type: "preview_data", chunk, recordingOffsetMs: startMs }
              : { type: "data", chunk } });
          notify();
        });
        child.stdin.write(bootstrap);
      } finally {
        previewStarting = false;
      }
    };
    this.activatePreview = () => { void startPreview().catch(() => {}); };
    const outputArgs = [
      ...(/^(?:aac|mp4a)/i.test(input.youtube.audioCodec ?? 'aac') ? ['-bsf:a', 'aac_adtstoasc'] : []),
      '-f', 'mp4', '-strict', '-2', '-movflags',
      '+frag_keyframe+delay_moov+default_base_moof', '-frag_duration', '1000000',
    ];
    const directInputs = this.hlsSource
      ? this.hlsSource.inputs.flatMap(url => ['-http_proxy', '', '-rw_timeout', '15000000', '-i', url])
      : youtubeDirectInputs(input.youtube, auth.args);
    const child = directInputs ? spawnYoutube([
      '-hide_banner', '-loglevel', 'error', ...directInputs,
      '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', ...outputArgs, 'pipe:1',
    ], resolveBin('ffmpeg')) : spawnYoutube([
      ...auth.args,
      "--no-playlist",
      "--no-live-from-start",
      "--retries",
      "0",
      "--fragment-retries",
      "0",
      "--socket-timeout",
      "15",
      "--ffmpeg-location",
      resolveBin("ffmpeg"),
      "--downloader",
      "ffmpeg",
      // yt-dlp's socket timeout does not configure its external FFmpeg process.
      // Bound each network I/O so a stalled connection can enter normal recovery.
      "--downloader-args",
      "ffmpeg_i:-rw_timeout 15000000",
      "--downloader-args",
      // AAC in YouTube HLS has no AudioSpecificConfig until the first packet.
      // A non-seekable Matroska header cannot be repaired later. Delay the fMP4
      // initialization until the bitstream filter has supplied it, then copy
      // packets into Matroska locally. Neither stage encodes the source.
      `ffmpeg_o:${outputArgs.join(' ')}`,
      "-f",
      input.youtube.formatSelector,
      "-o",
      "-",
      ...(auth.args.includes("--load-info-json") ? [] : ["--", input.url]),
    ]);
    this.source = child;
    this.startupObserver?.('youtube_source_process_started');
    const remux = spawn(resolveBin('ffmpeg'), [
      '-hide_banner', '-loglevel', 'error', '-threads', '1',
      '-analyzeduration', '1000000', '-probesize', '1048576',
      '-i', 'pipe:0', '-map', '0:v?', '-map', '0:a?', '-c', 'copy',
      '-f', 'matroska', '-cluster_time_limit', '1000', '-cluster_size_limit', '2097152',
      '-flush_packets', '1', 'pipe:1',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.remux = remux;
    const untrackRemux = trackFfmpeg(remux);
    remux.stdin.on('error', () => {});
    child.stdout.pipe(remux.stdin);
    let exitCode: number | null = null,
      closed = false;
    const sourceClosed = new Promise<void>((resolve) => {
      child.once("error", (error: NodeJS.ErrnoException) => {
        failure = youtubeError("", error.code === "ENOENT");
        resolve();
      });
      child.once("close", (code) => {
        exitCode = code;
        closed = true;
        console.log(`[youtube-recorder] source exit code=${code} +${Date.now() - startedMs}ms stderr=${stderr.slice(-300)}`);
        if (code !== null && code !== 0 && !this.stopped &&
            (!failure || (failure instanceof AppError && failure.code === 'RECORDING_REMUX_FAILED'))) {
          failure = youtubeError(stderr);
        }
        resolve();
      });
    });
    const remuxClosed = new Promise<void>(resolve => {
      remux.once('error', () => {
        untrackRemux();
        failure = new AppError('RECORDING_REMUX_FAILED', '无法启动 YouTube 无损封装进程');
        terminateYoutube(child, true);
        resolve();
      });
      remux.once('close', code => {
        untrackRemux();
        if (code !== 0 && !this.stopped && !failure) {
          failure = new AppError('RECORDING_REMUX_FAILED', 'YouTube 无损封装失败，已保留有效分段', { retryable: true });
          terminateYoutube(child, true);
        }
        resolve();
      });
    });
    const closedPromise = Promise.all([sourceClosed, remuxClosed]);
    remux.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    let lastData = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastData > 45_000) {
        failure = youtubeError("stall");
        terminateYoutube(child, true);
        remux.kill('SIGKILL');
      }
    }, 5000);
    let lastManifest = Date.now();
    // One bounded source read in flight; preview output wakes the consumer
    // independently instead of waiting for the next upstream HLS fragment.
    const reader = remux.stdout[Symbol.asyncIterator]();
    let nextSource: IteratorResult<Buffer> | undefined;
    let readFailure: unknown;
    const readNext = () => {
      void reader.next().then(result => {
        nextSource = result;
        notify();
      }, error => {
        readFailure = error;
        notify();
      });
    };
    try {
      if (outputPath) yield { type: "file_created", filePath: outputPath };
      readNext();
      while (!this.stopped) {
        if (!nextSource && !readFailure && !pending.length)
          await new Promise<void>(resolve => { wake = resolve; });
        const previewEvents = pending.splice(0);
        for (const { epoch, event } of previewEvents) {
          if (event.type === "data" || event.type === "preview_data")
            pendingBytes -= event.chunk.length;
          if (epoch !== this.previewEpoch) continue;
          yield event;
        }
        if (this.stopped) break;
        if (readFailure) throw readFailure;
        if (!nextSource) continue;
        const result = nextSource;
        nextSource = undefined;
        if (result.done) break;
        const data = result.value;
        if (!bytes) {
          console.log(`[youtube-recorder] source-first-byte +${Date.now() - startedMs}ms`);
          this.startupObserver?.('youtube_native_stream_ready');
        }
        lastData = Date.now();
        this.observer?.(data.length);
        await writer?.write(data);
        bytes += data.length;
        const clusters = parser.push(data);
        for (const cluster of clusters) {
          for (const follower of this.nativeFollowers) {
            if (follower.readableLength + follower.writableLength + cluster.length > 8 * 1024 * 1024)
              follower.destroy(new AppError('RECORDING_WRITE_SLOW', '录像消费持续阻塞，已保留有效数据', { retryable: true }));
            else follower.write(cluster);
          }
        }
        if (outputPath && parser.videoCodec && !metadataSent) {
          metadataSent = true;
          yield {
            type: "media_info",
            source: {
              width: parser.width,
              height: parser.height,
              videoCodec: parser.videoCodec,
              audioCodec: parser.audioCodec,
            },
          };
        }
        timestamp = offset + parser.timestampMs;
        if (part) part.durationMs = Math.max(0, timestamp - offset);
        if (part && outputPath && Date.now() - lastManifest > 5000) {
          await saveYoutubeParts(outputPath, parts);
          lastManifest = Date.now();
        }
        if (outputPath)
          yield {
            type: "data",
            chunk: data,
            previewForwarded: true,
            ...(clusters.length ? { mediaTimestampMs: timestamp } : {}),
            receivedAt: lastData,
          };
        for (const cluster of clusters) {
          if ((!outputPath && (!this.nativeFollowers.size || this.wantsPreview)) || this.wantsPreview) {
            if (!this.preview) {
              this.activatePreview();
              // Startup already feeds the complete GOP in this batch.
              // Feeding older clusters afterwards would move timestamps backwards.
              break;
            }
            else if (
              (this.preview.stdin?.writableLength ?? 0) + cluster.length >
              8 * 1024 * 1024
            )
              this.preview.kill("SIGKILL");
            else this.preview.stdin?.write(cluster);
          }
        }
        readNext();
      }
      if (!this.stopped) await closedPromise;
    } catch (error) {
      failure =
        error instanceof AppError
          ? error
          : new AppError("NETWORK_UNAVAILABLE", "YouTube 媒体读取中断", {
              retryable: true,
            });
    } finally {
      this.running = false;
      this.activatePreview = undefined;
      clearInterval(watchdog);
      terminateYoutube(child, true);
      remux.kill('SIGKILL');
      this.preview?.kill("SIGKILL");
      this.preview = null;
      for (const follower of this.nativeFollowers) {
        if (failure) follower.destroy(failure); else follower.end();
      }
      this.nativeFollowers.clear();
      await this.hlsSource?.close();
      this.hlsSource = undefined;
      try {
        await writer?.close();
        if (part && outputPath) {
          part.durationMs = Math.max(part.durationMs, timestamp - offset);
          await saveYoutubeParts(outputPath, parts);
        }
      } finally {
        await Promise.race([
          closedPromise,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 3000);
            timer.unref();
          }),
        ]);
        await auth.dispose();
        this.source = null;
        this.remux = null;
      }
    }
    if (this.stopped) return;
    if (failure || exitCode !== 0 || !closed) {
      yield {
        type: "error",
        error: (failure instanceof AppError
          ? failure
          : youtubeError(stderr)
        ).toObject(),
        endTimestampMs: timestamp,
      };
    } else
      yield {
        type: "completed",
        fileSize: outputPath ? await youtubeSize(outputPath) : bytes,
        endTimestampMs: timestamp,
      };
  }
}
