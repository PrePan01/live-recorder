// 管理直播预览、预览转录制，以及共享直播流的写入和关闭。
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { type RoomPolicySettings } from "../../config/room-policy.js";
import { BufferedRecordingWriter } from "../../recorder/buffered-writer.js";
import { HighlightBuffer } from "../../recorder/highlight-buffer.js";
import {
  FlvTimestampNormalizer,
  type FlvTagInfo,
} from "../../recorder/stream-recorder.js";
import { recordingFilePath } from "../../storage/file-organizer.js";
import { SeekIndexWriter, endSeekWriter } from "../../storage/seek-index.js";
import { AppError } from "../../types/error.js";
import type { AppSettings, ErrorObject, Room } from "../../types/index.js";
import type { Notifier } from "../notifier.js";
import { type PerformanceTrace } from "../performance-diagnostics.js";
import { writeFailure } from "../recording-failure.js";
import type { Services } from "../services.js";
import { PREVIEW_FRESHNESS_MS, PREVIEW_START_TIMEOUT_MS } from "./constants.js";
import type {
  ActiveSession,
  PreviewSession,
  PreviewSink,
  SharedPreviewRecording,
} from "./types.js";

interface PreviewControllerHost {
  readonly preview: PreviewSink | null;
  readonly active: Map<string, ActiveSession>;
  beginStartupTrace(
    kind: "preview_start" | "recording_start",
    room: Room,
  ): PerformanceTrace;
  settings(): AppSettings;
  readonly highlightBuffers: Map<string, HighlightBuffer>;
  disableHighlightBuffer(roomId: string): Promise<void>;
  enableHighlightBuffer(roomId: string): Promise<{
    availableSeconds: number;
    maxSeconds: number;
    accepting: boolean;
    disabledReason?: string;
  }>;
  handleDisconnect(
    room: Room,
    recordingId: string,
    error: ErrorObject,
    attempt: number,
    endTimestampMs: number,
  ): Promise<void>;
  readonly highlightQualities: WeakMap<HighlightBuffer, string>;
  maybeSeedHighlightBuffer(roomId: string): HighlightBuffer | undefined;
  readonly shuttingDown: boolean;
  handleNaturalEnd(
    room: Room,
    recordingId: string,
    size: number,
    session: ActiveSession,
    attempt: number,
    endTimestampMs: number,
  ): Promise<void>;
  settleRecordingGap(session: ActiveSession, now: number): void;
  createRecordingFile(filePath: string, roomId: string): Promise<void>;
  newSession(
    recordingId: string,
    roomId: string,
    streamSessionId: string | null,
    startedAt: string,
    filePath: string | null,
  ): ActiveSession;
  recordingMediaNow(roomId: string, recordingId: string): number | null;
  /** 将 activeRecording 附加到房间对象，供 API/SSE 输出。 */
  enrichRoom(room: Room, settings?: RoomPolicySettings | null): Room;
  /** 补发 service:status SSE，供前端顶部导航实时显示录制中数量。 */
  emitServiceStatus(): void;
}

export class PreviewController {
  constructor(
    private services: Services,
    private notifier: Notifier,
    private host: PreviewControllerHost,
  ) {}
  // ---- 预览专用拉流（#163：预览=纯观看，不触发录制、不落盘）----
  readonly previewSessions = new Map<string, PreviewSession>();

  readonly previewTransitions = new Set<string>();

  readonly previewStarts = new Map<string, Promise<boolean>>();

  /** 启动窗内换源续试次数（出数后清零）；防一次上游断流踢掉观看端。 */
  readonly previewStartupRetries = new Map<string, number>();

  isPreviewStreaming(roomId: string): boolean {
    return this.previewSessions.has(roomId);
  }

  isPreviewReadyForRecording(roomId: string): boolean {
    const session = this.previewSessions.get(roomId);
    if (!session || session.recording || !session.hasReceivedData) return false;
    const bootstrap = this.host.preview?.recordingBootstrap?.(roomId);
    return Boolean(bootstrap && bootstrap.subarray(0, 3).toString() === "FLV");
  }

  async ensurePreviewStream(roomId: string): Promise<void> {
    const existing = this.previewStarts.get(roomId);
    if (existing) {
      await existing;
      return;
    }
    const start = this.ensurePreviewStreamInner(roomId);
    this.previewStarts.set(roomId, start);
    try {
      await start;
    } finally {
      if (this.previewStarts.get(roomId) === start)
        this.previewStarts.delete(roomId);
    }
  }

  /** 返回是否有人接走这个房间的观看端：false=没有会话也没有在录，调用方负责收口。 */
  private async ensurePreviewStreamInner(roomId: string): Promise<boolean> {
    if (this.services.resetting) return true;
    this.host.preview?.reportProgress?.(
      roomId,
      this.host.active.has(roomId) || this.previewSessions.has(roomId)
        ? "source_ready"
        : "requested",
    );
    this.host.active.get(roomId)?.engine?.setPreviewActive?.(true);
    if (
      this.previewSessions.has(roomId) ||
      this.previewTransitions.has(roomId) ||
      this.host.active.has(roomId)
    )
      return true;
    const room = this.services.rooms.get(roomId);
    if (!room || room.lastLiveStatus !== "live") return false;
    const startupTrace = this.host.beginStartupTrace("preview_start", room);
    try {
      const settings = this.host.settings();
      const cookie = await this.services.platformCookie(room.platform);
      startupTrace.mark("platform_cookie_ready");
      const stream = await this.services
        .adapterFor(room.platform)
        .getStreamUrl(
          room.url,
          room.platform === "youtube" && settings.quality === "original"
            ? "1080p"
            : settings.quality,
          cookie,
        );
      startupTrace.mark("stream_url_ready");
      // getStreamUrl 期间可能已经点击了录制；二次检查避免迟到的 preview-only 流覆盖录制流。
      if (
        this.services.resetting ||
        !this.services.rooms.get(roomId) ||
        this.previewSessions.has(roomId) ||
        this.previewTransitions.has(roomId) ||
        this.host.active.has(roomId)
      ) {
        startupTrace.finish("skipped");
        return (
          this.services.resetting ||
          this.previewSessions.has(roomId) ||
          this.previewTransitions.has(roomId) ||
          this.host.active.has(roomId)
        );
      }
      const engine = this.services.engineFor(room.platform);
      // 启动预算按进展续期：慢速出口下逐段推进的冷启动不该被一刀切总时长收割。
      // 每个阶段/每批数据续一段静默窗，总上限尒住真僵尸。
      const startupSliceMs =
        room.platform === "youtube" ? 45_000 : PREVIEW_START_TIMEOUT_MS;
      const startupHardCapMs =
        room.platform === "youtube" ? 120_000 : startupSliceMs;
      const startupStartedMs = this.services.clock.now();
      let startupTimer: unknown;
      let startupTimedOut = false;
      let gotData = false;
      const armStartupTimer = () => {
        if (gotData) return;
        this.services.clock.clearTimeout(startupTimer);
        const capLeftMs =
          startupHardCapMs - (this.services.clock.now() - startupStartedMs);
        if (capLeftMs <= 0) {
          startupTimedOut = true;
          void engine.stop().catch(() => undefined);
          return;
        }
        startupTimer = this.services.clock.setTimeout(
          () => {
            if (gotData) return;
            startupTimedOut = true;
            void engine.stop().catch(() => undefined);
          },
          Math.min(startupSliceMs, capLeftMs),
        );
      };
      engine.setStartupObserver?.((stage) => {
        if (this.previewSessions.get(roomId)?.engine !== engine) return;
        startupTrace.mark(stage);
        armStartupTimer();
      });
      const session: PreviewSession = {
        ...(stream.streamSessionId
          ? { streamSessionId: stream.streamSessionId }
          : {}),
        engine,
        actualQuality: stream.actualQuality,
        input: stream,
        hasReceivedData: false,
        lastDataAt: this.services.clock.now(),
        done: Promise.resolve(),
        recording: null,
        transitioningToRecording: false,
        startupTrace,
      };
      this.previewSessions.set(roomId, session);
      engine.setDownloadObserver?.((bytes) => {
        session.recording?.session.downloadSpeed.add(
          bytes,
          this.services.clock.now(),
        );
      });
      session.done = (async () => {
        let streamError: ErrorObject | null = null;
        armStartupTimer();
        try {
          const input = { ...stream };
          // Upstream health belongs to the engine; disk and preview consumer
          // waits must not trigger a second, independent disconnect timer.
          for await (const event of engine.start(input, null)) {
            if (event.type === "data") {
              armStartupTimer();
              if (
                room.platform === "youtube" &&
                event.chunk.subarray(0, 3).toString() === "FLV" &&
                this.host.preview?.recordingBootstrap?.(roomId)
              ) {
                this.host.preview.resetRoom(roomId);
                const buffer = this.host.highlightBuffers.get(roomId);
                if (buffer) {
                  await this.host.disableHighlightBuffer(roomId);
                  await this.host.enableHighlightBuffer(roomId);
                }
              }
              session.lastDataAt = this.services.clock.now();
              if (!gotData) {
                gotData = true;
                this.previewStartupRetries.delete(roomId);
                session.hasReceivedData = true;
                session.startupTrace?.finish("ok");
              }
              const sharedRecording = session.recording;
              if (sharedRecording) {
                if (!engine.setDownloadObserver)
                  sharedRecording.session.downloadSpeed.add(
                    event.chunk.length,
                    this.services.clock.now(),
                  );
                try {
                  await this.appendSharedPreviewRecording(
                    sharedRecording,
                    event.chunk,
                    event.receivedAt,
                  );
                } catch (error) {
                  session.recording = null;
                  session.engine.setRecordingActive?.(false);
                  await sharedRecording.bufferedWriter
                    .close()
                    .catch(() => undefined);
                  sharedRecording.writer.destroy();
                  this.abandonSeekIndex(sharedRecording);
                  // 写盘失败不停死录制（PrePan 需求①）：转交写盘恢复策略（退避限次
                  // 自动重启新段、每场封顶、终停带明确原因）。预览帧循环不能被退避
                  // 等待阻塞，这里不等待恢复完成；后续帧已因 session.recording=null 不再写盘。
                  void this.host
                    .handleDisconnect(
                      room,
                      sharedRecording.session.recordingId,
                      writeFailure(error, {
                        roomId,
                        recordingId: sharedRecording.session.recordingId,
                      }).toObject(),
                      0,
                      sharedRecording.session.timestampOffsetMs,
                    )
                    .catch(() => undefined);
                }
              }
              if (this.host.settings().highlightEnabled !== false) {
                // 首开竞态：mkdir 期间首帧可能已丢、enable 时 bootstrap 也可能尚不可用。
                // 当前块不是 FLV 头时先从预览房延迟播种（此前帧已在 broadcastFrame 留底），
                // 再 append 当前块——避免错过唯一一次文件头后永久停在 0 秒。
                const highlight = this.host.highlightBuffers.get(roomId);
                if (highlight)
                  this.host.highlightQualities.set(
                    highlight,
                    session.actualQuality,
                  );
                if (highlight?.awaitingHeader) {
                  const startsFlv =
                    event.chunk.length >= 3 &&
                    event.chunk.subarray(0, 3).toString() === "FLV";
                  if (!startsFlv) {
                    const seeded = this.host.maybeSeedHighlightBuffer(roomId);
                    if (
                      seeded &&
                      !seeded.awaitingHeader &&
                      process.env.LIVE_RECORDER_DEBUG === "1"
                    )
                      console.warn(
                        `[highlight] late seed ok room=…${roomId.slice(-6)}`,
                      );
                  }
                }
                this.host.highlightBuffers.get(roomId)?.append(event.chunk);
              }
              this.host.preview?.broadcastFrame(roomId, event.chunk);
            }
            if (event.type === "error") {
              streamError = event.error;
              if (!gotData)
                session.startupTrace?.finish("failed", event.error.code);
              break;
            }
          }
        } catch (err) {
          streamError =
            err instanceof AppError
              ? err.toObject()
              : (streamError ??
                new AppError("NETWORK_UNAVAILABLE", "预览拉流中断", {
                  roomId,
                  retryable: true,
                }).toObject());
          if (!gotData)
            session.startupTrace?.finish("failed", streamError.code);
        } finally {
          this.services.clock.clearTimeout(startupTimer);
          if (startupTimedOut && !gotData)
            session.startupTrace?.finish("failed", "PREVIEW_START_TIMEOUT");
          if (!gotData && !streamError)
            session.startupTrace?.finish("failed", "STREAM_ENDED_BEFORE_DATA");
          if (this.previewSessions.get(roomId) === session)
            this.previewSessions.delete(roomId);
          let sharedRecording = session.recording;
          let handedOver = false;
          if (sharedRecording) {
            session.recording = null;
            let flushed = true;
            try {
              await this.closeSharedPreviewRecording(sharedRecording);
            } catch (error) {
              flushed = false;
              sharedRecording.writer.destroy();
              this.abandonSeekIndex(sharedRecording);
              // 收尾冲刷写盘失败：同样交写盘恢复策略（重拉续录新段，耗尽才终停）。
              // 此处预览上游流已结束，不会阻塞帧循环，可等待恢复流程启动。
              await this.host.handleDisconnect(
                room,
                sharedRecording.session.recordingId,
                writeFailure(error, {
                  roomId,
                  recordingId: sharedRecording.session.recordingId,
                }).toObject(),
                0,
                sharedRecording.session.timestampOffsetMs,
              );
            }
            if (flushed && !this.host.shuttingDown) {
              handedOver = true;
              const activeSession = sharedRecording.session;
              activeSession.segments = Math.max(1, activeSession.segments);
              activeSession.timestampOffsetMs = Math.max(
                activeSession.timestampOffsetMs,
                sharedRecording.normalizer.lastTimestampMs,
              );
              if (streamError) {
                await this.host.handleDisconnect(
                  room,
                  activeSession.recordingId,
                  streamError ??
                    new AppError(
                      "NETWORK_UNAVAILABLE",
                      "上游数据中断（静默超时）",
                      {
                        roomId,
                        retryable: true,
                      },
                    ).toObject(),
                  0,
                  activeSession.timestampOffsetMs,
                );
              } else {
                await this.host.handleNaturalEnd(
                  room,
                  activeSession.recordingId,
                  activeSession.size,
                  activeSession,
                  0,
                  activeSession.timestampOffsetMs,
                );
              }
            }
          }
          if (!handedOver) {
            // 出画前的上游断流不踢观看端：换新源续试（预算重新起算），真失败才收口。
            const attempts = this.previewStartupRetries.get(roomId) ?? 0;
            const canRetryStartup =
              !gotData &&
              !startupTimedOut &&
              !session.transitioningToRecording &&
              !this.host.shuttingDown &&
              (streamError === null || streamError.retryable !== false) &&
              attempts < 2 &&
              this.services.rooms.get(roomId)?.lastLiveStatus === "live" &&
              (this.host.preview?.hasClients?.(room.id) ?? false);
            if (canRetryStartup) {
              this.previewStartupRetries.set(roomId, attempts + 1);
              console.log(
                `[preview] startup-retry room=…${roomId.slice(-6)} attempt=${attempts + 1} error=${streamError?.code ?? "STREAM_ENDED_BEFORE_DATA"}`,
              );
              // 直接换新源起步：上一次启动的去重承诺可能还在收尾，走 ensurePreviewStream 会被它吞掉。
              void this.ensurePreviewStreamInner(room.id)
                .then((started) => {
                  // 二次起步可能发现已下播/无源：没人接走就按原语义收口，别让观看端干等。
                  if (!started)
                    this.host.preview?.closeRoom(room.id, 4004, "stream_lost");
                })
                .catch(() => undefined);
            } else {
              this.previewStartupRetries.delete(roomId);
              this.host.preview?.closeRoom(
                roomId,
                session.transitioningToRecording ? 1012 : 4004,
                session.transitioningToRecording ? undefined : "stream_lost",
              );
            }
          }
        }
      })();
    } catch (error) {
      startupTrace.finish(
        "failed",
        error instanceof AppError ? error.code : "PREVIEW_START_FAILED",
      );
      // URL resolution can fail before a preview session exists. Release the
      // waiting sockets now so the player retries instead of waiting for its
      // first-frame watchdog. A recording started during resolution owns them.
      if (
        !this.host.active.has(roomId) &&
        !this.previewSessions.has(roomId) &&
        !this.previewTransitions.has(roomId)
      )
        this.host.preview?.closeRoom(roomId, 4004, "stream_lost");
      return true;
    }
    return true;
  }

  /** 停止预览专用拉流（最后一个预览客户端断开时调用）。 */
  async stopPreviewStream(
    roomId: string,
    transitioningToRecording = false,
  ): Promise<void> {
    this.host.active.get(roomId)?.engine?.setPreviewActive?.(false);
    const session = this.previewSessions.get(roomId);
    if (!session) return;
    if (session.engine.hasRecordingConsumers?.()) {
      session.engine.setPreviewActive?.(false);
      return;
    }
    if (session.recording && !transitioningToRecording) return;
    if (transitioningToRecording) session.transitioningToRecording = true;
    await session.engine.stop().catch(() => undefined);
    await session.done.catch(() => undefined);
  }

  private async appendSharedPreviewRecording(
    recording: SharedPreviewRecording,
    chunk: Buffer,
    receivedAt = this.services.clock.now(),
  ): Promise<void> {
    if (recording.writeError) throw recording.writeError;
    const data = Buffer.concat(recording.normalizer.push(Buffer.from(chunk)));
    const tags = recording.pendingTags.splice(0);
    const timestamp = recording.normalizer.lastTimestampMs;
    // Upstream arrival and durable file progress are separate facts.
    this.host.settleRecordingGap(recording.session, receivedAt);
    recording.session.lastDataAt = receivedAt;
    if (!data.length) return;
    await recording.bufferedWriter.write(data, () => {
      recording.session.size += data.length;
      recording.session.timestampOffsetMs = timestamp;
      recording.session.mediaPositionMs = timestamp;
      for (const info of tags)
        recording.seekWriter?.note(
          info.seqHeader
            ? { t: info.ts, b: info.fileOffset, s: 1, k: info.tagType }
            : { t: info.ts, b: info.fileOffset },
        );
    });
  }

  async closeSharedPreviewRecording(
    recording: SharedPreviewRecording,
  ): Promise<void> {
    try {
      const remaining = recording.normalizer.remaining();
      if (remaining.length)
        await recording.bufferedWriter.write(remaining, () => {
          recording.session.size += remaining.length;
        });
      await recording.bufferedWriter.close();
    } finally {
      if (recording.seekWriter) {
        await recording.seekWriter.close();
        if (recording.session.filePath)
          endSeekWriter(recording.session.filePath);
        recording.seekWriter = null;
      }
    }
    console.log(
      `[recording ${new Date().toISOString()}] writer-close file=${recording.session.filePath ?? "-"} bytes=${recording.session.size} lastTs=${recording.session.timestampOffsetMs}ms (shared-preview)`,
    );
  }

  /** 中断/销毁路径的索引写入器收口（best-effort，绝不阻断主流程）。 */
  abandonSeekIndex(recording: SharedPreviewRecording): void {
    if (!recording.seekWriter) return;
    void recording.seekWriter.close();
    if (recording.session.filePath) endSeekWriter(recording.session.filePath);
    recording.seekWriter = null;
  }

  /**
   * 观看中的房间开始录制时复用当前上游流：只新增文件写入器，绝不关闭预览 WebSocket。
   * 返回 false 表示尚未积累足够的 FLV 初始化段/关键帧，调用方回退到既有录制路径。
   */
  async startSharedPreviewRecording(
    room: Room,
    status: { streamSessionId?: string; streamTitle?: string },
    actualQuality: string,
    settings: AppSettings,
    origin: import("../../types/index.js").RecordingOrigin,
    startupTrace?: PerformanceTrace,
  ): Promise<boolean> {
    if (room.platform === "youtube") return false;
    const previewSession = this.previewSessions.get(room.id);
    const bootstrap = this.host.preview?.recordingBootstrap?.(room.id);
    // 共享写入器目前复用 FLV 标签及其时间戳归零逻辑；非 FLV 流沿用原有独立录制路径。
    if (
      !previewSession ||
      previewSession.actualQuality !== settings.quality ||
      previewSession.actualQuality !== actualQuality ||
      previewSession.recording ||
      !bootstrap ||
      bootstrap.subarray(0, 3).toString() !== "FLV"
    )
      return false;

    if (previewSession.streamSessionId)
      status = { ...status, streamSessionId: previewSession.streamSessionId };

    const filePath = recordingFilePath(
      settings.recordingDirectory,
      room.platform,
      room.displayName || room.id,
      this.services.clock.iso(),
      settings.recordingFormat,
      settings.namingRule,
      actualQuality,
      room.id,
    );
    await this.host.createRecordingFile(filePath, room.id);
    startupTrace?.mark("recording_file_ready");
    const recording = this.services.recordings.create({
      roomId: room.id,
      roomName: room.displayName,
      platform: room.platform,
      streamSessionId: status.streamSessionId ?? null,
      streamTitle: status.streamTitle ?? room.displayName,
      quality: actualQuality,
      expectedQuality: settings.quality,
      origin,
    });
    const writer = createWriteStream(filePath, { flags: "a" });
    // 跳播索引：与 runHttp 同链（预览转录制的写盘支路若不接，全程无索引）。
    const seekWriter = await SeekIndexWriter.open(filePath, 0);
    const session = this.host.newSession(
      recording.id,
      room.id,
      status.streamSessionId ?? null,
      recording.startedAt,
      filePath,
    );
    let resolveDone!: () => void;
    session.done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    session.resolveDone = resolveDone;
    const pendingTags: FlvTagInfo[] = [];
    const sharedRecording: SharedPreviewRecording = {
      session,
      writer,
      seekWriter,
      // 预览流的时间戳从打开观看起计算；录制文件须在本次开始处重新归零。
      normalizer: new FlvTimestampNormalizer({
        rebaseFromFirstMedia: true,
        appendBaseBytes: 0,
        ...(seekWriter
          ? {
              onTag: (info: FlvTagInfo) => pendingTags.push(info),
            }
          : {}),
      }),
      pendingTags,
      bufferedWriter: new BufferedRecordingWriter(writer, filePath, {
        directory: this.services.recordingBufferDirectory,
        recordingId: recording.id,
      }),
      writeError: null,
    };
    // A volume can disappear after the successful file creation. Keep an error
    // listener for the whole writer lifetime so that a late EIO is surfaced to
    // the recording flow instead of becoming an unhandled EventEmitter error.
    // 共享链起点：带 filePath，供与收束行配对定位。
    console.log(
      `[recording ${new Date().toISOString()}] writer-open file=${filePath} append=false (shared-preview)`,
    );
    writer.on("error", (error) => {
      sharedRecording.writeError ??= error;
    });

    try {
      await this.appendSharedPreviewRecording(sharedRecording, bootstrap);
    } catch (error) {
      writer.destroy();
      await unlink(filePath).catch(() => undefined);
      const err = writeFailure(error, {
        roomId: room.id,
        recordingId: recording.id,
      });
      const failed = this.services.recordings.update(recording.id, {
        state: "failed",
        endedAt: this.services.clock.iso(),
        failureReason: err.toObject(),
      });
      this.services.events.emit({ type: "recording:updated", data: failed });
      throw err;
    }

    previewSession.engine.setRecordingActive?.(true);
    previewSession.recording = sharedRecording;
    this.host.active.set(room.id, session);
    // 弹幕采集随录制启动（异步起、失败只降级弹幕自身，不阻塞录制路径）。
    {
      this.services.danmaku.startForRecording(
        recording.id,
        filePath,
        room,
        () => this.host.recordingMediaNow(room.id, recording.id),
      );
    }
    this.services.recordings.update(recording.id, {
      state: "recording",
      filePath,
      ...(origin === "floating"
        ? { streamTitle: path.parse(filePath).name }
        : {}),
    });
    this.services.rooms.setState(room.id, "recording", {
      lastCheckedAt: this.services.clock.iso(),
      lastError: null,
    });
    this.services.events.emit({
      type: "room:updated",
      data: this.host.enrichRoom(this.services.rooms.get(room.id)!),
    });
    this.services.events.emit({
      type: "recording:updated",
      data: this.services.recordings.get(recording.id)!,
    });
    this.host.emitServiceStatus();
    await this.notifier.notify("recording_started", room.id, {
      title: room.displayName,
    });
    return true;
  }

  async startRecordingFromExistingPreview(
    room: Room,
    status: { streamSessionId?: string; streamTitle?: string },
    settings: AppSettings,
    origin: import("../../types/index.js").RecordingOrigin,
    startupTrace?: PerformanceTrace,
  ): Promise<boolean> {
    const preview = this.previewSessions.get(room.id);
    if (!preview) return false;
    // 复用前检查上游新鲜度：静默超阈或从未到数据即丢弃并重新取流。
    // 坑点：仅凭「收到过首包」不等于此刻可用，旧上游可能已干涸或被平台过期。
    // 拆掉旧会话返回 false → 调用方自然回退到现解析 getStreamUrl（与手动链同路）。
    const silentMs = this.services.clock.now() - preview.lastDataAt;
    if (!preview.hasReceivedData || silentMs > PREVIEW_FRESHNESS_MS) {
      console.log(
        `[recording ${new Date().toISOString()}] preview-reuse-reject silentMs=${silentMs} hasData=${preview.hasReceivedData} → 拆旧上游回退现解析`,
      );
      this.previewSessions.delete(room.id);
      void preview.engine.stop().catch(() => undefined);
      return false;
    }
    if (preview.actualQuality !== settings.quality) return false;
    return this.startSharedPreviewRecording(
      room,
      status,
      preview.actualQuality,
      settings,
      origin,
      startupTrace,
    );
  }
}
