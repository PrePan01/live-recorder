// 保存活动录制会话，消费媒体事件，并处理缺口记录、完成和失败收尾。
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { type RoomPolicySettings } from "../../config/room-policy.js";
import { finalizeYoutube, youtubeSize } from "../../recorder/youtube-media.js";
import { AppError } from "../../types/error.js";
import type {
  AppSettings,
  ErrorObject,
  RecordingEndReason,
  Room,
} from "../../types/index.js";
import { DownloadSpeed } from "../download-speed.js";
import type { Notifier } from "../notifier.js";
import type { HealthProbe } from "../quality-health.js";
import {
  failureText,
  humanizeFailure,
  isWriteFailure,
  withReasonCategory,
} from "../recording-failure.js";
import type { Services } from "../services.js";
import {
  GAP_ROW_MIN_MS,
  START_TIMEOUT_MS,
  TAIL_SILENCE_MIN_MS,
} from "./constants.js";
import type { ActiveSession, PreviewSession, PreviewSink } from "./types.js";

interface RecordingSessionsHost {
  /** 将 activeRecording 附加到房间对象，供 API/SSE 输出。 */
  enrichRoom(room: Room, settings?: RoomPolicySettings | null): Room;
  settings(): AppSettings;
  readonly previewSessions: Map<string, PreviewSession>;
  settingsForRecording(room: Room, session?: ActiveSession): AppSettings;
  readonly preview: PreviewSink | null;
  handleDisconnect(
    room: Room,
    recordingId: string,
    error: ErrorObject,
    attempt: number,
    endTimestampMs: number,
  ): Promise<void>;
  raiseAlert(
    level: "info" | "warning" | "error",
    source: string,
    err: AppError | ErrorObject,
  ): void;
  handleNaturalEnd(
    room: Room,
    recordingId: string,
    size: number,
    session: ActiveSession,
    attempt: number,
    endTimestampMs: number,
  ): Promise<void>;
  readonly shuttingDown: boolean;
  ensurePreviewStream(roomId: string): Promise<void>;
  /** 补发 service:status SSE，供前端顶部导航实时显示录制中数量。 */
  emitServiceStatus(): void;
  finishOrConfirm(recordingId: string, forceConfirm?: boolean): void;
}

export class RecordingSessions {
  constructor(
    private services: Services,
    private notifier: Notifier,
    private host: RecordingSessionsHost,
  ) {}
  readonly active = new Map<string, ActiveSession>();

  systemSleepIntervals: Array<{ startedAt: number; endedAt: number }> = [];

  isRoomActive(roomId: string): boolean {
    return this.active.has(roomId);
  }

  /** 只以原生系统睡眠通知归因，不能把长时间网络中断猜成系统休眠。 */
  recordSystemSleep(startedAt: number, endedAt: number): void {
    const existing = this.systemSleepIntervals.find(
      (interval) => interval.startedAt === startedAt,
    );
    if (existing) existing.endedAt = endedAt;
    else this.systemSleepIntervals.push({ startedAt, endedAt });
    this.systemSleepIntervals = this.systemSleepIntervals.slice(-64);
    const changed = this.services.recordings.markSystemSleepGaps(
      new Date(startedAt).toISOString(),
      new Date(endedAt).toISOString(),
    );
    for (const session of this.active.values()) {
      if (Date.parse(session.startedAt) >= endedAt) continue;
      if (session.lastDataAt < endedAt) {
        session.gapStartAt ??= session.lastDataAt;
      } else if (
        !changed.includes(session.recordingId) &&
        session.gapStartAt === null
      ) {
        // 唤醒后媒体先到、原生通知稍后送达时，补记确实发生过的睡眠，避免共享预览支路漏记。
        const missingMs =
          endedAt - Math.max(startedAt, Date.parse(session.startedAt));
        if (missingMs > 0) {
          this.services.recordings.insertGap({
            recordingId: session.recordingId,
            startedAt: new Date(startedAt).toISOString(),
            endedAt: new Date(endedAt).toISOString(),
            missingMs,
            kind: "system_sleep",
          });
          session.missingMs += missingMs;
          this.services.recordings.update(session.recordingId, {
            missingMs: session.missingMs,
          });
          changed.push(session.recordingId);
        }
      }
    }
    for (const id of changed) {
      const recording = this.services.recordings.get(id);
      if (recording)
        this.services.events.emit({
          type: "recording:updated",
          data: recording,
        });
    }
  }

  private isSystemSleepGap(startedAt: number, endedAt: number): boolean {
    return this.systemSleepIntervals.some(
      (interval) =>
        interval.startedAt < endedAt && interval.endedAt > startedAt,
    );
  }

  settleRecordingGap(session: ActiveSession, now: number): void {
    // kind 分名：连接断/源停吐/休眠/尾部四值（悬停原因可辨，判不出=粗归因不猜）。
    if (session.gapStartAt === null) return;
    const gapMs = Math.max(0, now - session.gapStartAt);
    session.missingMs += gapMs;
    if (gapMs >= GAP_ROW_MIN_MS) {
      this.services.recordings.insertGap({
        recordingId: session.recordingId,
        startedAt: new Date(session.gapStartAt).toISOString(),
        endedAt: new Date(now).toISOString(),
        missingMs: gapMs,
        kind: this.isSystemSleepGap(session.gapStartAt, now)
          ? "system_sleep"
          : isStallCause(session.gapCause)
            ? "source_stall"
            : "stream_disconnect",
        evidence: JSON.stringify({
          gapStartAt: session.gapStartAt,
          size: session.size,
          cause: session.gapCause,
          mediaPositionMs: session.mediaPositionMs,
        }),
      });
    }
    session.gapStartAt = null;
    delete session.reconnectSince;
    session.recoveringAlerted = false;
    delete session.reconnectAlertCodes;
    // 取到地址或打开文件不代表恢复；收到媒体后再同步记录与监控卡片。
    const recording = this.services.recordings.update(session.recordingId, {
      state: "recording",
      failureReason: null,
    });
    this.services.rooms.setState(session.roomId, "recording", {
      lastError: null,
    });
    const room = this.services.rooms.get(session.roomId);
    if (room)
      this.services.events.emit({
        type: "room:updated",
        data: this.host.enrichRoom(room),
      });
    this.services.events.emit({ type: "recording:updated", data: recording });
  }

  /** 新建录制会话：续录/缺失时长相关的状态集中在这里初始化。 */
  newSession(
    recordingId: string,
    roomId: string,
    streamSessionId: string | null,
    startedAt: string,
    filePath: string | null,
  ): ActiveSession {
    const now = this.services.clock.now();
    return {
      downloadSpeed: new DownloadSpeed(),
      recordingId,
      expectedQuality: (this.services.recordings.get(recordingId)
        ?.expectedQuality ??
        this.host.settings().quality) as import("../../types/index.js").Quality,
      roomId,
      streamSessionId,
      stopRequested: false,
      size: 0,
      startedAt,
      engine: null,
      filePath,
      segments: 0,
      timestampOffsetMs: 0,
      lastDataAt: now,
      gapStartAt: null,
      missingMs: 0,
      writeRestartCount: 0,
      writeRestartPending: false,
      writeRestartCancelled: false,
      lastRecoveryAt: now,
      generation: 0,
      pullDone: null,
      handingOff: false,
    };
  }

  activeRoomIds(): string[] {
    return [...this.active.keys()];
  }

  recordingDownloadBytesPerSecond(): number {
    const now = this.services.clock.now();
    let speed = 0;
    for (const session of this.active.values()) {
      speed += session.downloadSpeed.bytesPerSecond(now);
    }
    return speed;
  }

  recordingMediaNow(roomId: string, recordingId: string): number | null {
    const session = this.active.get(roomId);
    if (
      !session ||
      session.recordingId !== recordingId ||
      session.gapStartAt !== null ||
      session.stopRequested
    )
      return null;
    return session.mediaPositionMs ?? null;
  }

  /** 标记采用文件媒体时间；断流期间沿用最后收到的媒体位置。 */
  recordingMarkerTail(roomId: string, recordingId: string): number | null {
    const session = this.active.get(roomId);
    if (!session || session.recordingId !== recordingId) return null;
    if (session.mediaPositionMs != null)
      return Math.floor(session.mediaPositionMs / 1000);
    if (session.size === 0) return 0;
    // 无媒体时钟的源按有效接收时间估计，扣除已结束和正在发生的断流。
    const now = this.services.clock.now();
    const pendingGap =
      session.gapStartAt == null ? 0 : Math.max(0, now - session.gapStartAt);
    return Math.max(
      0,
      Math.floor(
        (now - Date.parse(session.startedAt) - session.missingMs - pendingGap) /
          1000,
      ),
    );
  }

  recordingPreviewOffsetSeconds(
    roomId: string,
    recordingId: string,
  ): number | null {
    const session = this.active.get(roomId);
    if (!session || session.recordingId !== recordingId) return null;
    const preview = this.host.previewSessions.get(roomId);
    const shared = preview?.recording;
    // Independent upstreams have distinct media clocks; never claim a zero offset.
    if (preview && !shared) {
      const offset = session.engine?.recordingPreviewOffsetMs?.();
      return offset == null ? null : offset / 1000;
    }
    if (!shared || shared.session !== session)
      return session.previewOffsetMs == null
        ? null
        : session.previewOffsetMs / 1000;
    const offset = shared.normalizer.timestampOffsetMs;
    return offset == null ? null : offset / 1000;
  }

  recordingMediaTailSeconds(
    roomId: string,
    recordingId: string,
  ): number | null {
    const session = this.active.get(roomId);
    if (!session || session.recordingId !== recordingId) return null;
    // Range boundaries must use received media, including the last frame during reconnects.
    return Math.max(0, (session.mediaPositionMs ?? 0) / 1000);
  }

  /** 当前录制会话信息（未录制返回 null），供监控总览显示录制时长。 */
  activeRecordingFor(roomId: string): Room["activeRecording"] {
    const session = this.active.get(roomId);
    return session
      ? { recordingId: session.recordingId, startedAt: session.startedAt }
      : null;
  }

  /** 读取当前健康事实，历史恢复次数不代表当前写入故障。 */
  healthProbe(): HealthProbe[] {
    return [...this.active].map(([roomId, session]) => {
      const rec = this.services.recordings.get(session.recordingId);
      return {
        recordingId: session.recordingId,
        roomId,
        bytes: session.size,
        mediaTsMs: session.mediaPositionMs ?? null,
        lastDataAt: session.lastDataAt,
        writeError:
          session.writeRestartPending ||
          Boolean(this.host.previewSessions.get(roomId)?.recording?.writeError),
        qualityFallback: Boolean(
          rec?.expectedQuality &&
          rec.quality &&
          rec.expectedQuality !== rec.quality,
        ),
        recovering: session.gapStartAt != null || session.writeRestartPending,
        missingMs: session.missingMs,
        dataIntervalMs: session.engine?.expectedDataIntervalMs?.() ?? 0,
      };
    });
  }

  async runSession(
    room: Room,
    recordingId: string,
    stream: {
      url: string;
      format: "flv" | "hls" | "youtube";
      youtube?: NonNullable<
        import("../../recorder/engine.js").StreamInput["youtube"]
      >;
      headers?: Record<string, string>;
    },
    filePath: string,
    session: ActiveSession,
    attempt: number,
    existingEngine?: import("../../recorder/engine.js").RecordingEngine,
  ): Promise<void> {
    const settings = this.host.settingsForRecording(room, session);
    const engine = existingEngine ?? this.services.engineFor(room.platform);
    engine.setStartupObserver?.((stage) => {
      if (session.engine !== engine || session.stopRequested) return;
      session.startupTrace?.mark(stage);
      this.host.preview?.reportProgress?.(room.id, stage);
    });
    engine.setPreviewActive?.(this.host.preview?.hasClients(room.id) ?? false);
    const generation = session.generation;
    session.engine = engine;
    engine.setDownloadObserver?.((bytes) => {
      if (session.generation === generation && !session.stopRequested)
        session.downloadSpeed.add(bytes, this.services.clock.now());
    });
    session.filePath = filePath;
    if (!this.host.previewSessions.has(room.id))
      this.host.preview?.resetRoom(room.id);

    let startedConfirmed = false;
    let gotData = false;
    const pendingTimeout = this.services.clock.setTimeout(
      () => {
        if (!gotData) {
          const err = new AppError(
            "RECORDING_START_TIMEOUT",
            "等待直播数据超时",
            { roomId: room.id, recordingId, retryable: true },
          );
          void this.host.handleDisconnect(
            room,
            recordingId,
            err.toObject(),
            attempt,
            session.timestampOffsetMs,
          );
        }
      },
      room.platform === "youtube" ? 45_000 : START_TIMEOUT_MS,
    );

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      const input = { ...stream };
      // 第 2 段起接着写同一个文件：追加写入 + 时间戳顺延到上一段结尾之后。
      const resume = {
        append: session.segments > 0,
        recordingId,
        timestampOffsetMs: session.timestampOffsetMs,
        ...(session.hlsCursor ? { hlsCursor: session.hlsCursor } : {}),
      };
      for await (const event of engine.start(input, filePath, resume)) {
        if (session.generation !== generation) return;
        if (session.stopRequested) break;
        switch (event.type) {
          case "media_info": {
            const current = this.services.recordings.get(recordingId);
            if (current) {
              const updated = this.services.recordings.update(recordingId, {
                metadata: {
                  durationMs: null,
                  segmentCount: 1,
                  quality: current.quality ?? null,
                  size: session.size,
                  ...current.metadata,
                  source: event.source,
                },
              });
              this.services.events.emit({
                type: "recording:updated",
                data: updated,
              });
            }
            break;
          }
          case "preview_data": {
            if (
              room.platform === "youtube" &&
              event.chunk.subarray(0, 3).toString() === "FLV" &&
              this.host.preview?.recordingBootstrap?.(room.id)
            )
              this.host.preview.resetRoom(room.id);
            if (event.recordingOffsetMs !== undefined)
              session.previewOffsetMs = event.recordingOffsetMs;
            if (!this.host.previewSessions.has(room.id))
              this.host.preview?.broadcastFrame(room.id, event.chunk);
            break;
          }
          case "file_created": {
            session.previewOffsetMs = null;
            startedConfirmed = true;
            this.services.recordings.update(recordingId, {
              state: session.gapStartAt === null ? "recording" : "reconnecting",
              filePath: event.filePath,
            });
            {
              this.services.danmaku.startForRecording(
                recordingId,
                event.filePath,
                room,
                () => this.recordingMediaNow(room.id, recordingId),
              );
            }
            this.services.events.emit({
              type: "recording:updated",
              data: this.services.recordings.get(recordingId)!,
            });
            break;
          }
          case "data": {
            if (!engine.setDownloadObserver)
              session.downloadSpeed.add(
                event.chunk.length,
                this.services.clock.now(),
              );
            if (
              !gotData &&
              (event.mediaTimestampMs !== undefined ||
                this.services.mode === "fake" ||
                stream.format === "hls")
            ) {
              gotData = true;
              this.services.clock.clearTimeout(pendingTimeout);
              session.startupTrace?.finish("ok");
            }
            session.size += event.chunk.length;
            const now = event.receivedAt ?? this.services.clock.now();
            if (
              event.mediaTimestampMs !== undefined ||
              this.services.mode === "fake" ||
              stream.format === "hls"
            ) {
              this.settleRecordingGap(session, now);
            }
            if (event.mediaTimestampMs !== undefined) {
              session.mediaPositionMs = event.mediaTimestampMs;
            }
            session.lastDataAt = now;
            if (!event.previewForwarded) {
              session.previewOffsetMs = 0;
              if (!this.host.previewSessions.has(room.id))
                this.host.preview?.broadcastFrame(room.id, event.chunk);
            }
            break;
          }
          case "stream_format_changed": {
            const info = new AppError(
              "STREAM_FORMAT_CHANGED",
              "流格式变化，已自动切换",
              { roomId: room.id, recordingId },
            );
            this.host.raiseAlert("info", "recorder", info);
            break;
          }
          case "completed": {
            if (event.hlsCursor) session.hlsCursor = event.hlsCursor;
            // 这一路拉流已结束（写流已关闭），接力时无需再等它。
            session.pullDone = null;
            await this.host.handleNaturalEnd(
              room,
              recordingId,
              event.fileSize ?? session.size,
              session,
              attempt,
              event.endTimestampMs ?? session.timestampOffsetMs,
            );
            return;
          }
          case "error": {
            if (event.hlsCursor) session.hlsCursor = event.hlsCursor;
            this.services.clock.clearTimeout(pendingTimeout);
            // 同上：错误事件意味着该路拉流已收尾，写流已关闭。
            session.pullDone = null;
            session.size =
              room.platform === "youtube"
                ? await youtubeSize(filePath)
                : ((await stat(filePath).catch(() => null))?.size ??
                  session.size);
            await this.host.handleDisconnect(
              room,
              recordingId,
              event.error,
              attempt,
              event.endTimestampMs ?? session.timestampOffsetMs,
            );
            return;
          }
        }
      }
      // 已被新的续录会话取代：不在这里收尾，交给接管的那一代会话处理。
      if (session.generation !== generation) return;
      // 退出中：写流已经落盘，记录状态交给下次启动的恢复流程统一收口，这里不再改库、不再跑后处理。
      if (this.host.shuttingDown) return;
      if (session.stopRequested) {
        await this.completeRecording(room, recordingId, session.size, "ended", {
          endReason: session.requestedEndReason ?? "stopped",
        });
        return;
      }
      if (!startedConfirmed) {
        const err = new AppError("RECORDING_START_FAILED", "录制启动失败", {
          roomId: room.id,
          recordingId,
          retryable: true,
        });
        await this.failRecording(room, recordingId, err.toObject(), "recorder");
        session.startupTrace?.finish("failed", err.code);
        return;
      }
      await this.completeRecording(room, recordingId, session.size, "ended");
    } catch (err) {
      if (session.generation !== generation || this.host.shuttingDown) return;
      const appErr =
        err instanceof AppError
          ? err
          : new AppError(
              "RECORDING_START_FAILED",
              `录制异常: ${(err as Error).message}`,
              { roomId: room.id, recordingId, retryable: true },
            );
      session.startupTrace?.finish("failed", appErr.code);
      if (isWriteFailure(appErr.toObject())) {
        session.size =
          room.platform === "youtube"
            ? await youtubeSize(filePath)
            : ((await stat(filePath).catch(() => null))?.size ?? session.size);
        await this.finishInterrupted(room, recordingId, appErr);
        return;
      }
      await this.failRecording(
        room,
        recordingId,
        appErr.toObject(),
        "recorder",
      );
    } finally {
      this.services.clock.clearTimeout(pendingTimeout);
    }
  }

  /**
   * 中断收尾（重连耗尽 / 写盘失败 / 一直拿不到数据）：
   * 文件里有数据 → 标"已完成"并注明中断——几小时的有效录像不该因为最后一段网络中断被整条判失败；
   * 一个字节都没有 → 才按失败处理（不产生一个"已完成"的空文件）。
   */
  async finishInterrupted(
    room: Room,
    recordingId: string,
    err: AppError,
    preservePreview = false,
  ): Promise<void> {
    await this.services.danmaku.stopForRecording(
      recordingId,
      this.active.get(room.id)?.mediaPositionMs,
    );
    const session = this.active.get(room.id);
    const size = session?.size ?? 0;
    // 失败原因落库统一富化（reasonCategory）+落日志（[record] 同 [verify] 款，诊断盲区教训）。
    const failure = withReasonCategory(err.toObject());
    if (size > 0) {
      console.log(
        `[record] 录制中断收尾 ${recordingId}：已录内容保留（${failure.code}）${failure.message}`,
      );
      await this.completeRecording(room, recordingId, size, "stream_lost", {
        preservePreview,
        endReason: "interrupted",
        failure,
      });
      this.host.raiseAlert("error", "recorder", err);
      this.services.events.emit({
        type: "recording:updated",
        data: this.services.recordings.get(recordingId)!,
      });
      await this.notifier.notify("recording_failed", room.id, {
        title: room.displayName,
      });
      return;
    }
    await this.failRecording(
      room,
      recordingId,
      failure,
      "recorder",
      preservePreview,
    );
  }

  async completeRecording(
    room: Room,
    recordingId: string,
    size: number,
    endReason: "ended" | "stream_lost",
    options: {
      preservePreview?: boolean;
      endReason?: RecordingEndReason;
      failure?: ErrorObject | null;
    } = {},
  ): Promise<void> {
    await this.services.danmaku.stopForRecording(
      recordingId,
      this.active.get(room.id)?.mediaPositionMs,
    );
    // 退出中：只放掉会话，不改库、不发通知、不起后处理——状态交给下次启动的恢复流程统一收口。
    if (this.host.shuttingDown) {
      this.active.get(room.id)?.resolveDone?.();
      this.active.delete(room.id);
      return;
    }
    const saved = this.services.recordings.get(recordingId);
    if (
      room.platform === "youtube" &&
      saved?.filePath &&
      this.services.mode === "real"
    ) {
      try {
        await finalizeYoutube(
          saved.filePath,
          this.services.recordingBufferDirectory,
        );
      } catch (error) {
        options.failure =
          error instanceof AppError
            ? error.toObject()
            : new AppError(
                "RECORDING_REMUX_FAILED",
                "YouTube 录像整理失败，原始分段已保留",
              ).toObject();
      }
    }
    if (saved?.filePath)
      size =
        room.platform === "youtube"
          ? await youtubeSize(saved.filePath)
          : ((await stat(saved.filePath).catch(() => null))?.size ?? size);
    // 0 字节录制（流连接后无数据/立即关闭）应标 failed 而非 completed 空文件（QA #165 边界）。
    if (size <= 0) {
      const rec = this.services.recordings.get(recordingId);
      if (rec?.filePath) {
        await unlink(rec.filePath).catch(() => undefined);
      }
      const err = new AppError(
        "RECORDING_EMPTY",
        failureText("RECORDING_EMPTY"),
        { roomId: room.id, recordingId, retryable: true },
      );
      await this.failRecording(
        room,
        recordingId,
        err.toObject(),
        "recorder",
        options.preservePreview ?? false,
      );
      return;
    }
    const session = this.active.get(room.id);
    const endedAtMs = this.services.clock.now();
    const tailMs = tailSilenceMs(session, endedAtMs);
    // 末尾未恢复的缺失也要存证，否则主表累计值会大于历史页中断明细之和。
    if (session && tailMs > 0) {
      this.services.recordings.insertGap({
        recordingId,
        startedAt: new Date(endedAtMs - tailMs).toISOString(),
        endedAt: new Date(endedAtMs).toISOString(),
        missingMs: tailMs,
        kind: this.isSystemSleepGap(endedAtMs - tailMs, endedAtMs)
          ? "system_sleep"
          : "recording_tail",
        evidence: JSON.stringify({ mediaPositionMs: session.mediaPositionMs }),
      });
    }
    const rec = this.services.recordings.update(recordingId, {
      state: "completed",
      endedAt: new Date(endedAtMs).toISOString(),
      fileSizeBytes: size,
      ...(room.platform === "youtube"
        ? {
            metadata: {
              ...saved?.metadata,
              durationMs:
                session?.mediaPositionMs ?? saved?.metadata?.durationMs ?? null,
              segmentCount: (session?.segments ?? 0) + 1,
              quality: saved?.quality ?? null,
              size,
            },
          }
        : {}),
      // 结束原因与缺失时长随录制落库：历史页据此标注"中途缺失 N 秒"，去重据此判断能否续录。
      endReason:
        options.endReason ??
        (endReason === "stream_lost" ? "interrupted" : "natural"),
      // 收尾时若已经静默很久（断网后连接没断、或重连期间），把这段也算进缺失：
      // 否则用户点了停止只会看到一条"手动停止"，完全不知道最后一段没录进去。
      missingMs: Math.round((session?.missingMs ?? 0) + tailMs),
      failureReason: options.failure ?? null,
    });
    const continueYoutubePreview =
      room.platform === "youtube" &&
      options.endReason === "stopped" &&
      this.host.preview?.hasClients(room.id);
    // 中断收尾要用 4004（stream_lost）告知观看端：这不是正常结束，流是断的。
    if (
      !continueYoutubePreview &&
      !options.preservePreview &&
      !this.host.previewSessions.has(room.id)
    )
      this.host.preview?.closeRoom(
        room.id,
        endReason === "stream_lost" ? 4004 : 1000,
        endReason,
      );
    this.active.delete(room.id);
    if (continueYoutubePreview && !this.host.previewSessions.has(room.id)) {
      this.host.preview?.resetRoom(room.id);
      void this.host.ensurePreviewStream(room.id);
    }
    this.host.emitServiceStatus();
    this.services.rooms.setState(room.id, "completed", {
      lastCheckedAt: this.services.clock.iso(),
      lastError: null,
    });
    // #222：confirmAfterComplete 开启时不发中间 completed 事件（只发最终 awaiting_confirmation），避免「已保存通知 + 确认框」弹两次。
    if (!this.host.settings().confirmAfterComplete)
      this.services.events.emit({ type: "recording:updated", data: rec });
    this.services.events.emit({
      type: "room:updated",
      data: this.host.enrichRoom(this.services.rooms.get(room.id)!),
    });
    session?.resolveDone?.();
    // 中断收尾由 finishInterrupted 发"录制失败"通知；这里不能再发一次"录制已结束"，否则用户收到两条互相打架的提醒。
    if (!options.failure)
      await this.notifier.notify("recording_ended", room.id, {
        title: room.displayName,
      });
    // 异步校验文件完整性，不阻塞录制完成响应（#220 询问保留时进入待确认态挂起管线/上传）。
    // A selection export explicitly asks for the completion dialog even when the
    // global "confirm after complete" preference is normally disabled.
    this.host.finishOrConfirm(recordingId, options.endReason === "clip_export");
  }

  async failRecording(
    room: Room,
    recordingId: string,
    err: ErrorObject,
    source: string,
    preservePreview = false,
  ): Promise<void> {
    if (this.host.shuttingDown) {
      this.active.get(room.id)?.resolveDone?.();
      this.active.delete(room.id);
      return;
    }
    const session = this.active.get(room.id);
    const failure = humanizeFailure(err);
    const rec = this.services.recordings.update(recordingId, {
      state: "failed",
      endedAt: this.services.clock.iso(),
      failureReason: failure.toObject(),
    });
    // 失败原因必须落 backend.log（本次事故盲区教训：翻日志查不到为什么停）。
    console.log(
      `[record] 录制失败 ${recordingId}（${failure.code}）：${failure.message}`,
    );
    if (!preservePreview && !this.host.previewSessions.has(room.id))
      this.host.preview?.closeRoom(room.id, 4004, "stream_lost");
    this.active.delete(room.id);
    this.host.emitServiceStatus();
    this.services.rooms.setState(room.id, "failed", {
      lastCheckedAt: this.services.clock.iso(),
      lastError: failure.toObject(),
    });
    this.services.events.emit({ type: "recording:updated", data: rec });
    this.services.events.emit({
      type: "room:updated",
      data: this.host.enrichRoom(this.services.rooms.get(room.id)!),
    });
    session?.resolveDone?.();
    this.host.raiseAlert("error", source, failure);
    await this.notifier.notify("recording_failed", room.id, {
      title: room.displayName,
    });
  }
}

/**
 * 停流合成因判定：连接断（stream_disconnect）与源停吐（source_stall）分名——
 * 悬停原因要能区分「断网」和「主播端没货」两种缺失。
 */
export function isStallCause(
  cause: { message?: string } | null | undefined,
): boolean {
  return Boolean(cause?.message?.includes("静默超时"));
}

/** 计算录制结束时尚未计入缺口的静默时长。 */
function tailSilenceMs(
  session: ActiveSession | undefined,
  now: number,
): number {
  if (!session) return 0;
  const silent = now - session.lastDataAt;
  return silent >= TAIL_SILENCE_MIN_MS ? silent : 0;
}
