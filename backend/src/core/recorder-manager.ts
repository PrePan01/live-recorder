// 协调录制启动和停止，对外提供统一入口，具体工作交给各录制模块。
import { statSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import {
  resolveRoomPolicy,
  roomQuality,
  type RoomPolicySettings,
} from "../config/room-policy.js";
import { HighlightBuffer } from "../recorder/highlight-buffer.js";
import {
  recordingFilePath,
  reserveRecordingPath,
} from "../storage/file-organizer.js";
import { AppError } from "../types/error.js";
import type {
  AppSettings,
  ErrorObject,
  RecordingEndReason,
  Room,
} from "../types/index.js";
import type { Notifier } from "./notifier.js";
import {
  PerformanceDiagnostics,
  type PerformanceTrace,
} from "./performance-diagnostics.js";
import type { HealthProbe } from "./quality-health.js";
import { ClipExportController } from "./recorder/clip-controller.js";
import { RecordingCompletion } from "./recorder/completion-controller.js";
import {
  PREVIEW_FRESHNESS_MS,
  SHUTDOWN_GRACE_MS,
} from "./recorder/constants.js";
import { HighlightController } from "./recorder/highlight-controller.js";
import { PreviewController } from "./recorder/preview-controller.js";
import { RecordingRecovery } from "./recorder/recovery-controller.js";
import { RecordingSessions } from "./recorder/session-controller.js";
import type {
  ActiveSession,
  PreviewSink,
  SharedPreviewRecording,
} from "./recorder/types.js";
import { fileCreateError, writeFailure } from "./recording-failure.js";
import type { Services } from "./services.js";

export class RecorderManager {
  private readonly sessionController: RecordingSessions;
  private readonly previewController: PreviewController;
  private readonly highlightController: HighlightController;
  private readonly clipController: ClipExportController;
  private readonly completionController: RecordingCompletion;
  private readonly recoveryController: RecordingRecovery;

  readonly performance: PerformanceDiagnostics;
  private get active() {
    return this.sessionController.active;
  }
  private get clipExports() {
    return this.clipController.clipExports;
  }
  private get clipProgress() {
    return this.clipController.clipProgress;
  }
  private get clipExportAborts() {
    return this.clipController.clipExportAborts;
  }
  private get clipExportJobs() {
    return this.clipController.clipExportJobs;
  }
  /** Prevent manual and scheduler starts from both passing the async preflight. */
  private starting = new Set<string>();
  private backgroundTasks = 0;
  /** 正在退出：只等写流落盘，不再收尾/通知/跑后处理（状态交给下次启动的恢复流程）。 */
  private shuttingDown = false;

  get busy(): boolean {
    return (
      this.active.size > 0 ||
      this.starting.size > 0 ||
      this.backgroundTasks > 0 ||
      this.clipExportJobs.size > 0 ||
      this.youtubeFinalizations.size > 0
    );
  }

  async resetIdleState(): Promise<void> {
    await Promise.all(
      [...this.previewSessions.keys()].map((id) => this.stopPreviewStream(id)),
    );
    await Promise.all(
      [...this.highlightBuffers.keys()].map((id) =>
        this.disableHighlightBuffer(id),
      ),
    );
  }

  /**
   * 退出前收尾：停掉所有正在拉流的会话并等写流落盘关闭，避免最后几秒数据还没写进文件就退出了。
   * 这里刻意不写库、不发通知、不起后处理：进程马上消失，记录状态交给下次启动的恢复流程统一收口
   * （标记为"服务重启中断"，并重跑校验 / mp4_after 转封装 / 管线 / 上传）。
   */
  async shutdown(): Promise<void> {
    await this.services.clipQueueManager?.shutdown();
    this.shuttingDown = true;
    const pending: Promise<void>[] = [this.services.danmaku.shutdown()];
    for (const abort of this.clipExportAborts.values()) abort.abort();
    pending.push(...this.clipExportJobs.values());
    for (const session of [...this.active.values()]) {
      session.wakeReconnect?.();
      pending.push(
        session.engine?.stop().catch(() => undefined) ?? Promise.resolve(),
      );
      const pull = session.pullDone;
      // 等这一路拉流真正退出：写流在它的 finally 里 flush + close。
      if (pull) pending.push(pull.catch(() => undefined));
    }
    for (const preview of [...this.previewSessions.values()]) {
      pending.push(preview.engine.stop().catch(() => undefined));
      pending.push(preview.done.catch(() => undefined));
    }
    // 退出绝不能被某个不响应 stop() 的拉流卡住：到点即放手。
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => {
        setTimeout(resolve, SHUTDOWN_GRACE_MS).unref();
      }),
    ]);
  }

  /** 启动恢复用：把上次退出时中断、还没跑过收尾流程的录制重新交给收尾（校验 / 转封装 / 管线 / 上传）。 */
  resumeRecoveredProcessing(recordingId: string): void {
    this.finishSegmentProcessing(recordingId);
  }
  clearPendingConfirmations(): void {
    return this.completionController.clearPendingConfirmations();
  }
  preview: PreviewSink | null = null;
  private get confirmTimers() {
    return this.completionController.confirmTimers;
  }
  private get highlightBuffers() {
    return this.highlightController.highlightBuffers;
  }
  private get highlightQualities() {
    return this.highlightController.highlightQualities;
  }
  private get pendingHighlightConfirmations() {
    return this.highlightController.pendingHighlightConfirmations;
  }
  private get highlightExportJobs() {
    return this.highlightController.highlightExportJobs;
  }

  constructor(
    private services: Services,
    private notifier: Notifier,
  ) {
    this.performance = new PerformanceDiagnostics(services.clock);

    const manager = this;

    this.sessionController = new RecordingSessions(services, notifier, {
      enrichRoom: (...args) => this.enrichRoom(...args),
      settings: (...args) => this.settings(...args),
      get previewSessions() {
        return manager.previewSessions;
      },
      settingsForRecording: (...args) => this.settingsForRecording(...args),
      get preview() {
        return manager.preview;
      },
      handleDisconnect: (...args) => this.handleDisconnect(...args),
      raiseAlert: (...args) => this.raiseAlert(...args),
      handleNaturalEnd: (...args) => this.handleNaturalEnd(...args),
      get shuttingDown() {
        return manager.shuttingDown;
      },
      ensurePreviewStream: (...args) => this.ensurePreviewStream(...args),
      emitServiceStatus: (...args) => this.emitServiceStatus(...args),
      finishOrConfirm: (...args) => this.finishOrConfirm(...args),
    });

    this.previewController = new PreviewController(services, notifier, {
      get preview() {
        return manager.preview;
      },
      get active() {
        return manager.active;
      },
      beginStartupTrace: (...args) => this.beginStartupTrace(...args),
      settings: (...args) => this.settings(...args),
      get highlightBuffers() {
        return manager.highlightBuffers;
      },
      disableHighlightBuffer: (...args) => this.disableHighlightBuffer(...args),
      enableHighlightBuffer: (...args) => this.enableHighlightBuffer(...args),
      handleDisconnect: (...args) => this.handleDisconnect(...args),
      get highlightQualities() {
        return manager.highlightQualities;
      },
      maybeSeedHighlightBuffer: (...args) =>
        this.maybeSeedHighlightBuffer(...args),
      get shuttingDown() {
        return manager.shuttingDown;
      },
      handleNaturalEnd: (...args) => this.handleNaturalEnd(...args),
      settleRecordingGap: (...args) => this.settleRecordingGap(...args),
      createRecordingFile: (...args) => this.createRecordingFile(...args),
      newSession: (...args) => this.newSession(...args),
      recordingMediaNow: (...args) => this.recordingMediaNow(...args),
      enrichRoom: (...args) => this.enrichRoom(...args),
      emitServiceStatus: (...args) => this.emitServiceStatus(...args),
    });

    this.highlightController = new HighlightController(services, {
      get active() {
        return manager.active;
      },
      settings: (...args) => this.settings(...args),
      get previewSessions() {
        return manager.previewSessions;
      },
      get preview() {
        return manager.preview;
      },
      enterPendingConfirmation: (...args) =>
        this.enterPendingConfirmation(...args),
      finishOrConfirm: (...args) => this.finishOrConfirm(...args),
      resumeAfterConfirmation: (...args) =>
        this.resumeAfterConfirmation(...args),
      discardAfterConfirmation: (...args) =>
        this.discardAfterConfirmation(...args),
      clearConfirmTimer: (...args) => this.clearConfirmTimer(...args),
    });

    this.clipController = new ClipExportController(services, {
      get shuttingDown() {
        return manager.shuttingDown;
      },
      finishSegmentProcessing: (...args) =>
        this.finishSegmentProcessing(...args),
    });

    this.completionController = new RecordingCompletion(services, {
      settings: (...args) => this.settings(...args),
      get pendingHighlightConfirmations() {
        return manager.pendingHighlightConfirmations;
      },
      cancelClipExport: (...args) => this.cancelClipExport(...args),
      failHighlightExport: (...args) => this.failHighlightExport(...args),
      get shuttingDown() {
        return manager.shuttingDown;
      },
    });

    this.recoveryController = new RecordingRecovery(services, {
      get active() {
        return manager.active;
      },
      finishInterrupted: (...args) => this.finishInterrupted(...args),
      settingsForRecording: (...args) => this.settingsForRecording(...args),
      get shuttingDown() {
        return manager.shuttingDown;
      },
      completeRecording: (...args) => this.completeRecording(...args),
      raiseAlert: (...args) => this.raiseAlert(...args),
      enrichRoom: (...args) => this.enrichRoom(...args),
      runSession: (...args) => this.runSession(...args),
    });
  }

  settings(): AppSettings {
    const stored = this.services.settings.load();
    return stored ?? { ...structuredClone(defaultsLite()) };
  }

  private beginStartupTrace(
    kind: "preview_start" | "recording_start",
    room: Room,
  ): PerformanceTrace {
    const trace = this.performance.begin(kind, room);
    this.preview?.reportProgress?.(room.id, "requested");
    return {
      mark: (stage) => {
        trace.mark(stage);
        this.preview?.reportProgress?.(room.id, stage);
      },
      finish: (outcome, code) => {
        trace.finish(outcome, code);
        if (outcome === "ok")
          this.preview?.reportProgress?.(room.id, "source_ready");
      },
    };
  }

  private settingsForRecording(
    room: Room,
    session?: ActiveSession,
  ): AppSettings {
    const settings = this.settings();
    const currentRoom = this.services.rooms.get(room.id) ?? room;
    return {
      ...settings,
      quality: session?.expectedQuality ?? roomQuality(currentRoom, settings),
    };
  }
  isRoomActive(roomId: string): boolean {
    return this.sessionController.isRoomActive(roomId);
  }

  isRoomStarting(roomId: string): boolean {
    return this.starting.has(roomId);
  }

  shouldPreventSystemSleep(): boolean {
    return (
      !this.shuttingDown &&
      this.settings().preventSleepWhileRecording !== false &&
      (this.active.size > 0 || this.starting.size > 0)
    );
  }
  private get systemSleepIntervals() {
    return this.sessionController.systemSleepIntervals;
  }
  recordSystemSleep(startedAt: number, endedAt: number): void {
    return this.sessionController.recordSystemSleep(startedAt, endedAt);
  }
  private settleRecordingGap(session: ActiveSession, now: number): void {
    return this.sessionController.settleRecordingGap(session, now);
  }
  private newSession(
    recordingId: string,
    roomId: string,
    streamSessionId: string | null,
    startedAt: string,
    filePath: string | null,
  ): ActiveSession {
    return this.sessionController.newSession(
      recordingId,
      roomId,
      streamSessionId,
      startedAt,
      filePath,
    );
  }
  activeRoomIds(): string[] {
    return this.sessionController.activeRoomIds();
  }
  recordingDownloadBytesPerSecond(): number {
    return this.sessionController.recordingDownloadBytesPerSecond();
  }
  private recordingMediaNow(
    roomId: string,
    recordingId: string,
  ): number | null {
    return this.sessionController.recordingMediaNow(roomId, recordingId);
  }
  recordingMarkerTail(roomId: string, recordingId: string): number | null {
    return this.sessionController.recordingMarkerTail(roomId, recordingId);
  }
  recordingPreviewOffsetSeconds(
    roomId: string,
    recordingId: string,
  ): number | null {
    return this.sessionController.recordingPreviewOffsetSeconds(
      roomId,
      recordingId,
    );
  }
  recordingMediaTailSeconds(
    roomId: string,
    recordingId: string,
  ): number | null {
    return this.sessionController.recordingMediaTailSeconds(
      roomId,
      recordingId,
    );
  }
  activeRecordingFor(roomId: string): Room["activeRecording"] {
    return this.sessionController.activeRecordingFor(roomId);
  }

  /** 将 activeRecording 附加到房间对象，供 API/SSE 输出。 */
  enrichRoom(
    room: Room,
    settings: RoomPolicySettings | null = this.services.settings.load(),
  ): Room {
    const liveRoomUrl = this.services
      .adapterFor(room.platform)
      .getRoomPageUrl?.(room.url);
    return {
      ...room,
      ...(liveRoomUrl ? { liveRoomUrl } : {}),
      activeRecording: this.activeRecordingFor(room.id),
      // 生效值+来源随房间出口回传：与执行侧同一函数同一规则（resolveRoomPolicy）。
      effective: resolveRoomPolicy(room, settings),
      enabledPlans: {
        schedule: this.services.schedules.hasEnabledForRoom(room.id),
        keyword: this.services.keywordPlans.hasEnabledForRoom(room.id),
      },
    };
  }

  /** 列表共用一个配置快照，避免每个房间都查询和解析全局配置。 */
  enrichRooms(rooms: Room[]): Room[] {
    const settings = this.services.settings.load();
    return rooms.map((room) => this.enrichRoom(room, settings));
  }

  emitRoomUpdate(roomId: string): void {
    const room = this.services.rooms.get(roomId);
    if (room) this.services.events.emit({ type: "room:updated", data: this.enrichRoom(room) });
  }

  /** 补发 service:status SSE，供前端顶部导航实时显示录制中数量。 */
  emitServiceStatus(): void {
    this.services.events.emit({
      type: "service:status",
      data: {
        state: "running",
        activeRecordings: this.active.size,
        setupCompleted: Boolean(
          this.services.settings.load()?.recordingDirectory?.length,
        ),
      },
    });
  }
  private get previewSessions() {
    return this.previewController.previewSessions;
  }
  private get previewTransitions() {
    return this.previewController.previewTransitions;
  }
  private get previewStarts() {
    return this.previewController.previewStarts;
  }
  private get previewStartupRetries() {
    return this.previewController.previewStartupRetries;
  }
  private get highlightCleanup() {
    return this.highlightController.highlightCleanup;
  }
  isPreviewStreaming(roomId: string): boolean {
    return this.previewController.isPreviewStreaming(roomId);
  }
  isPreviewReadyForRecording(roomId: string): boolean {
    return this.previewController.isPreviewReadyForRecording(roomId);
  }
  enableHighlightBuffer(roomId: string): Promise<{
    availableSeconds: number;
    maxSeconds: number;
    accepting: boolean;
    disabledReason?: string;
  }> {
    return this.highlightController.enableHighlightBuffer(roomId);
  }
  private maybeSeedHighlightBuffer(
    roomId: string,
  ): HighlightBuffer | undefined {
    return this.highlightController.maybeSeedHighlightBuffer(roomId);
  }
  disableHighlightBuffer(roomId: string): Promise<void> {
    return this.highlightController.disableHighlightBuffer(roomId);
  }
  private detachHighlightBufferForRecording(roomId: string): void {
    return this.highlightController.detachHighlightBufferForRecording(roomId);
  }
  clearHighlightBuffer(roomId: string): Promise<void> {
    return this.highlightController.clearHighlightBuffer(roomId);
  }
  disableAllHighlightBuffers(): Promise<void> {
    return this.highlightController.disableAllHighlightBuffers();
  }
  highlightStatus(roomId: string): {
    enabled: boolean;
    availableSeconds: number;
    maxSeconds: number;
    accepting: boolean;
    disabledReason?: string;
  } {
    return this.highlightController.highlightStatus(roomId);
  }
  exportHighlight(
    roomId: string,
    lookbackSeconds: number,
  ): Promise<{ recordingId: string; availableSeconds: number }> {
    return this.highlightController.exportHighlight(roomId, lookbackSeconds);
  }
  deferHighlightConfirmation(
    recordingId: string,
    keep: boolean,
    fileName?: string,
  ): boolean {
    return this.highlightController.deferHighlightConfirmation(
      recordingId,
      keep,
      fileName,
    );
  }
  cancelHighlightExport(recordingId: string): Promise<boolean> {
    return this.highlightController.cancelHighlightExport(recordingId);
  }
  private failHighlightExport(
    recordingId: string,
    roomId: string,
    filePath: string,
    error: unknown,
  ): Promise<void> {
    return this.highlightController.failHighlightExport(
      recordingId,
      roomId,
      filePath,
      error,
    );
  }
  ensurePreviewStream(roomId: string): Promise<void> {
    return this.previewController.ensurePreviewStream(roomId);
  }
  stopPreviewStream(
    roomId: string,
    transitioningToRecording = false,
  ): Promise<void> {
    return this.previewController.stopPreviewStream(
      roomId,
      transitioningToRecording,
    );
  }
  private closeSharedPreviewRecording(
    recording: SharedPreviewRecording,
  ): Promise<void> {
    return this.previewController.closeSharedPreviewRecording(recording);
  }
  private abandonSeekIndex(recording: SharedPreviewRecording): void {
    return this.previewController.abandonSeekIndex(recording);
  }
  private startSharedPreviewRecording(
    room: Room,
    status: { streamSessionId?: string; streamTitle?: string },
    actualQuality: string,
    settings: AppSettings,
    origin: import("../types/index.js").RecordingOrigin,
    startupTrace?: PerformanceTrace,
  ): Promise<boolean> {
    return this.previewController.startSharedPreviewRecording(
      room,
      status,
      actualQuality,
      settings,
      origin,
      startupTrace,
    );
  }
  private startRecordingFromExistingPreview(
    room: Room,
    status: { streamSessionId?: string; streamTitle?: string },
    settings: AppSettings,
    origin: import("../types/index.js").RecordingOrigin,
    startupTrace?: PerformanceTrace,
  ): Promise<boolean> {
    return this.previewController.startRecordingFromExistingPreview(
      room,
      status,
      settings,
      origin,
      startupTrace,
    );
  }

  private async createRecordingFile(
    filePath: string,
    roomId: string,
  ): Promise<void> {
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      const file = await open(filePath, "w");
      await file.close();
    } catch (error) {
      throw fileCreateError(error, roomId);
    }
  }

  /** 启动期磁盘检查：发 disk:space 事件，低空间只告警不拦截。与取流并行，建文件前必须 await。 */
  private async inspectDiskForStartup(
    settings: AppSettings,
    room: Room,
    startupTrace: PerformanceTrace,
  ): Promise<void> {
    try {
      if (settings.recordingDirectory.length > 0) {
        const space = await this.services.diskGuard.inspect(
          settings.recordingDirectory,
        );
        const total = space.totalBytes || 1;
        const low =
          space.freeBytes < settings.diskGuard.minFreeBytes ||
          (space.freeBytes / total) * 100 < settings.diskGuard.minFreePercent;
        this.services.events.emit({
          type: "disk:space",
          data: {
            directory: settings.recordingDirectory,
            freeBytes: space.freeBytes,
            totalBytes: space.totalBytes,
            low,
          },
        });
        // 空间不足只提醒、不拦下录制：能不能录由实际写入决定。用户宁可先录下来再清理，
        // 也不要在开播那一刻被挡在门外——录制本身是核心能力，等清理完直播可能已经结束了。
        // 真的写不进去时，写入失败会给出明确原因（磁盘满/权限等）。
        if (low) {
          const err = new AppError("DISK_SPACE_INSUFFICIENT", "磁盘空间不足", {
            roomId: room.id,
            details: {
              freeBytes: space.freeBytes,
              minFreeBytes: settings.diskGuard.minFreeBytes,
            },
          });
          this.raiseAlert("error", "disk", err);
          await this.notifier.notify("disk_space_low", room.id, {
            title: room.displayName,
          });
        }
      }
      // 归档盘守卫（best-effort）：归档目录在另一块盘时，满盘会让分片搬运/归档写入失败，
      // 此前只查录像目录、归档盘无人看。与录像目录同卷时上面的检查已覆盖，跳过。
      await this.inspectArchiveDiskGuard(settings, room);
      startupTrace.mark("storage_checks_ready");
    } catch (error) {
      startupTrace.mark("storage_checks_ready");
      throw error;
    }
  }

  /** 归档目录空间检查——绝不抛错（守卫自身故障或目录未建都不影响录制启动）。 */
  private async inspectArchiveDiskGuard(
    settings: AppSettings,
    room: Room,
  ): Promise<void> {
    try {
      const dir = settings.pipeline?.archiveDirectory?.trim();
      if (!dir || dir.length === 0) return;
      if (settings.recordingDirectory) {
        try {
          if (statSync(dir).dev === statSync(settings.recordingDirectory).dev)
            return;
        } catch {
          // 归档目录尚未创建：仍按路径检查（diskGuard 自行容错）。
        }
      }
      const space = await this.services.diskGuard.inspect(dir);
      const total = space.totalBytes || 1;
      const low =
        space.freeBytes < settings.diskGuard.minFreeBytes ||
        (space.freeBytes / total) * 100 < settings.diskGuard.minFreePercent;
      this.services.events.emit({
        type: "disk:space",
        data: {
          directory: dir,
          freeBytes: space.freeBytes,
          totalBytes: space.totalBytes,
          low,
        },
      });
      if (low) {
        const err = new AppError(
          "DISK_SPACE_INSUFFICIENT",
          "归档目录所在磁盘空间不足",
          {
            roomId: room.id,
            details: {
              freeBytes: space.freeBytes,
              minFreeBytes: settings.diskGuard.minFreeBytes,
            },
          },
        );
        this.raiseAlert("error", "disk", err);
        await this.notifier.notify("disk_space_low", room.id, {
          title: room.displayName,
        });
      }
    } catch {
      // best-effort：见方法注释。
    }
  }

  /** 调度器发现直播后调用：并发上限、本次开播周期去重、磁盘保护，然后启动录制。manual=手动触发，可在本次直播中显式重录。 */
  async maybeStartRecording(
    room: Room,
    status: { streamSessionId?: string; streamTitle?: string },
    opts: {
      manual?: boolean;
      scheduled?: boolean;
      liveStartedAt?: string | null;
      douyinAuthorizationRevision?: number;
      origin?: import("../types/index.js").RecordingOrigin;
    } = {},
  ): Promise<boolean> {
    const startupTrace = this.beginStartupTrace("recording_start", room);
    if (this.services.resetting) {
      startupTrace.finish("skipped");
      return false;
    }
    // PrePan 钦定边界（2026-09-29）：写盘自动恢复尝试期间用户手动点录制 →
    // 自动重启立即让位，旧场收口（内容保留）后由手动录制接管，绝不两路冲突。
    const recovering = this.active.get(room.id);
    if (opts.manual && recovering?.writeRestartPending) {
      recovering.writeRestartCancelled = true;
      await recovering.writeRestartDone?.catch(() => undefined);
    }
    if (this.active.has(room.id) || this.starting.has(room.id)) {
      startupTrace.finish("skipped");
      return false;
    }
    if (this.recordingsHeld() >= this.settings().maxConcurrentRecordings) {
      const err = new AppError(
        "CONCURRENT_LIMIT_REACHED",
        "录制达到最大并发数量，请在设置内增加最大并发",
        { roomId: room.id, retryable: true },
      );
      this.raiseAlert("warning", "recorder", err);
      this.services.rooms.setState(room.id, "idle", {
        lastCheckedAt: this.services.clock.iso(),
        lastError: err,
      });
      startupTrace.finish("skipped", "CONCURRENT_LIMIT_REACHED");
      return false;
    }
    this.starting.add(room.id);
    try {
      return await this.maybeStartRecordingInternal(
        room,
        status,
        opts,
        startupTrace,
      );
    } catch (error) {
      startupTrace.finish(
        "failed",
        error instanceof AppError ? error.code : "RECORDING_START_FAILED",
      );
      throw error;
    } finally {
      this.starting.delete(room.id);
    }
  }

  /** 已占用的录制额度：已落库的在录 + 正在启动但尚未产生录制行的房间。 */
  private recordingsHeld(): number {
    let starting = 0;
    for (const id of this.starting) if (!this.active.has(id)) starting += 1;
    return this.services.recordings.activeCount() + starting;
  }

  private async maybeStartRecordingInternal(
    room: Room,
    status: { streamSessionId?: string; streamTitle?: string },
    opts: {
      manual?: boolean;
      scheduled?: boolean;
      liveStartedAt?: string | null;
      douyinAuthorizationRevision?: number;
      origin?: import("../types/index.js").RecordingOrigin;
    } = {},
    startupTrace: PerformanceTrace,
  ): Promise<boolean> {
    this.detachHighlightBufferForRecording(room.id);
    startupTrace.mark("highlight_buffer_stopped");
    const settings = this.settingsForRecording(room);
    let sessionId = status.streamSessionId ?? null;
    if (
      !opts.manual &&
      !opts.scheduled &&
      opts.liveStartedAt &&
      this.services.recordings.hasRecordingSince(room.id, opts.liveStartedAt)
    ) {
      // 本次开播已录制过（例如用户手动停止），保持去重但不能遗留“检测中”。
      this.services.rooms.setState(room.id, "idle", {
        lastCheckedAt: this.services.clock.iso(),
        lastError: null,
      });
      this.services.events.emit({
        type: "room:updated",
        data: this.enrichRoom(this.services.rooms.get(room.id)!),
      });
      startupTrace.finish("skipped", "ALREADY_RECORDED");
      return false;
    }

    // 磁盘检查与后续取流并行发起；低空间告警仍必须在任何建文件之前生效，
    // 因此所有会创建文件的路径都会先 await 这里返回的 promise。
    const diskCheckReady = this.inspectDiskForStartup(
      settings,
      room,
      startupTrace,
    );
    // 提前路径（取流抛错/被并发抢占）可能不再 await：先挂空 catch 防未处理拒绝，
    // 真正需要磁盘结果的路径仍 await 原 promise 以保留失败语义。
    void diskCheckReady.catch(() => undefined);

    const origin = opts.origin ?? (opts.manual ? "manual" : "automatic");
    // 已有预览会话：先等磁盘告警落地再尝试复用（复用会建文件），避免时序回退。
    if (this.previewSessions.has(room.id)) {
      await diskCheckReady;
      if (
        await this.startRecordingFromExistingPreview(
          room,
          status,
          settings,
          origin,
          startupTrace,
        )
      ) {
        startupTrace.mark("reused_preview_stream");
        startupTrace.finish("ok");
        return true;
      }
    }

    const nativePreview = this.previewSessions.get(room.id);
    const nativeEngine =
      room.platform === "youtube" &&
      nativePreview?.input &&
      nativePreview.hasReceivedData &&
      this.services.clock.now() - nativePreview.lastDataAt <=
        PREVIEW_FRESHNESS_MS &&
      (!status.streamSessionId ||
        status.streamSessionId === nativePreview.streamSessionId)
        ? nativePreview.engine.forkRecording?.(settings.quality)
        : null;
    if (room.platform === "youtube" && !nativeEngine)
      await this.stopPreviewStream(room.id, true);
    let nativeEngineStarted = false;
    let stream: import("../platform/adapter.js").StreamUrlResult;
    if (nativeEngine && nativePreview?.input) {
      stream = {
        ...nativePreview.input,
        actualQuality:
          settings.quality === "original"
            ? "original"
            : nativePreview.input.actualQuality,
      };
      startupTrace.mark("reused_native_source");
    } else {
      const cookie = await this.services.platformCookie(room.platform);
      startupTrace.mark("platform_cookie_ready");
      const adapter = this.services.adapterFor(room.platform);
      const detectedStream = room.platform === "douyin" &&
        opts.douyinAuthorizationRevision === this.services.douyinAuthorization.revision
        ? adapter.getStreamUrlFromStatus?.(room.url, settings.quality, cookie, status)
        : undefined;
      stream = detectedStream ?? await adapter.getStreamUrl(room.url, settings.quality, cookie);
    }
    sessionId = stream.streamSessionId ?? sessionId;
    startupTrace.mark("stream_url_ready");
    // The stream lookup is asynchronous. A scheduler/manual request may have
    // claimed this room while it was in flight; never create a second session
    // or report a successful manual start in that case.
    if (this.active.has(room.id)) {
      await nativeEngine?.stop();
      startupTrace.finish("skipped");
      return false;
    }
    // 自此可能创建文件：磁盘检查（含低空间告警/通知）必须已完成。
    await diskCheckReady;
    // 仅复用目标画质一致且已有关键帧缓存的观看流；否则保留观看并独立录制。
    if (
      await this.startSharedPreviewRecording(
        room,
        status,
        stream.actualQuality,
        settings,
        origin,
        startupTrace,
      )
    ) {
      startupTrace.finish("ok");
      return true;
    }
    this.previewTransitions.add(room.id);
    try {
      // 独立录制保留已有观看会话；previewTransitions 阻止迟到的观看取流覆盖它。
      if (this.active.has(room.id)) {
        startupTrace.finish("skipped");
        return false;
      }
      let filePath = recordingFilePath(
        settings.recordingDirectory,
        room.platform,
        room.displayName || room.id,
        this.services.clock.iso(),
        settings.recordingFormat,
        settings.namingRule,
        stream.actualQuality,
        room.id,
      );
      if (room.platform === "youtube")
        filePath = await reserveRecordingPath(filePath);
      await this.createRecordingFile(filePath, room.id);
      startupTrace.mark("recording_file_ready");
      // 悬浮录制的历史标题使用最终文件基名，确保它和设置里的命名规则完全一致。
      const streamTitle =
        opts.origin === "floating"
          ? path.parse(filePath).name
          : (status.streamTitle ?? room.displayName);
      const recording = this.services.recordings.create({
        roomId: room.id,
        roomName: room.displayName,
        platform: room.platform,
        streamSessionId: sessionId,
        streamTitle,
        quality: stream.actualQuality,
        expectedQuality: settings.quality,
        origin: opts.origin ?? (opts.manual ? "manual" : "automatic"),
      });
      this.services.rooms.setState(room.id, "recording", {
        lastCheckedAt: this.services.clock.iso(),
        lastError: null,
      });
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const session = this.newSession(
        recording.id,
        room.id,
        sessionId,
        recording.startedAt,
        filePath,
      );
      session.done = done;
      session.resolveDone = resolveDone;
      session.startupTrace = startupTrace;
      this.active.set(room.id, session);
      this.services.events.emit({
        type: "room:updated",
        data: this.enrichRoom(this.services.rooms.get(room.id)!),
      });
      this.services.events.emit({ type: "recording:updated", data: recording });
      this.emitServiceStatus();
      await this.notifier.notify("recording_started", room.id, {
        title: room.displayName,
      });

      const run = this.runSession(
        room,
        recording.id,
        stream,
        filePath,
        session,
        0,
        nativeEngine ?? undefined,
      );
      nativeEngineStarted = true;
      session.pullDone = run;
      void run.catch(() => undefined);
      return true;
    } finally {
      this.previewTransitions.delete(room.id);
      if (nativeEngine && !nativeEngineStarted) await nativeEngine.stop();
    }
  }
  private runSession(
    room: Room,
    recordingId: string,
    stream: {
      url: string;
      format: "flv" | "hls" | "youtube";
      youtube?: NonNullable<
        import("../recorder/engine.js").StreamInput["youtube"]
      >;
      headers?: Record<string, string>;
    },
    filePath: string,
    session: ActiveSession,
    attempt: number,
    existingEngine?: import("../recorder/engine.js").RecordingEngine,
  ): Promise<void> {
    return this.sessionController.runSession(
      room,
      recordingId,
      stream,
      filePath,
      session,
      attempt,
      existingEngine,
    );
  }
  private handleDisconnect(
    room: Room,
    recordingId: string,
    error: ErrorObject,
    attempt: number,
    endTimestampMs: number,
  ): Promise<void> {
    return this.recoveryController.handleDisconnect(
      room,
      recordingId,
      error,
      attempt,
      endTimestampMs,
    );
  }
  private finishInterrupted(
    room: Room,
    recordingId: string,
    err: AppError,
    preservePreview = false,
  ): Promise<void> {
    return this.sessionController.finishInterrupted(
      room,
      recordingId,
      err,
      preservePreview,
    );
  }
  healthProbe(): HealthProbe[] {
    return this.sessionController.healthProbe();
  }

  /** 删除联动兜底：停捕获拆链并清房间录制态。 */
  async stopActiveSessionForDeletion(recordingId: string): Promise<void> {
    const entry = [...this.active.entries()].find(
      ([, s]) => s.recordingId === recordingId,
    );
    if (!entry) return;
    const [roomId, session] = entry;
    session.stopRequested = true;
    session.wakeReconnect?.();
    session.requestedEndReason = "stopped";
    const previewSession = this.previewSessions.get(roomId);
    const sharedRecording = previewSession?.recording;
    if (previewSession && sharedRecording?.session === session) {
      previewSession.recording = null;
      previewSession.engine.setRecordingActive?.(false);
      try {
        await this.closeSharedPreviewRecording(sharedRecording);
      } catch {
        sharedRecording.writer.destroy();
        this.abandonSeekIndex(sharedRecording);
      }
    }
    this.active.delete(roomId);
    const room = this.services.rooms.get(roomId);
    if (room) {
      this.services.rooms.setState(roomId, "idle", {
        lastCheckedAt: this.services.clock.iso(),
        lastError: null,
      });
      this.services.events.emit({
        type: "room:updated",
        data: this.enrichRoom(this.services.rooms.get(roomId)!),
      });
    }
  }

  async stopRecording(
    roomId: string,
    endReason: RecordingEndReason = "stopped",
  ): Promise<void> {
    const session = this.active.get(roomId);
    if (!session) return;
    session.stopRequested = true;
    session.wakeReconnect?.();
    session.requestedEndReason = endReason;
    {
      const room = this.services.rooms.get(roomId);
      if (room) {
        this.services.rooms.setAutoRecordStopped(
          room.id,
          room.liveStartedAt ?? this.services.clock.iso(),
        );
      }
    }
    const previewSession = this.previewSessions.get(roomId);
    const sharedRecording = previewSession?.recording;
    if (previewSession && sharedRecording?.session === session) {
      previewSession.recording = null;
      previewSession.engine.setRecordingActive?.(false);
      const room = this.services.rooms.get(roomId)!;
      try {
        await this.closeSharedPreviewRecording(sharedRecording);
        await this.completeRecording(
          room,
          session.recordingId,
          session.size,
          "ended",
          { preservePreview: true, endReason },
        );
        // 弹窗已关闭时共享上游流仍会为录制持续到这里；录制结束后没有观看者就收掉它。
        if (!this.preview?.hasClients(roomId))
          await this.stopPreviewStream(roomId);
      } catch (error) {
        sharedRecording.writer.destroy();
        this.abandonSeekIndex(sharedRecording);
        await this.failRecording(
          room,
          session.recordingId,
          writeFailure(error, {
            roomId,
            recordingId: session.recordingId,
          }).toObject(),
          "recorder",
          true,
        );
      }
      return;
    }
    await session.engine?.stop();
    await session.done;
  }
  canStartClipExport(): boolean {
    return this.clipController.canStartClipExport();
  }
  cancelClipExport(recordingId: string): void {
    return this.clipController.cancelClipExport(recordingId);
  }
  clipExportProgress(recordingId: string): number | null {
    return this.clipController.clipExportProgress(recordingId);
  }
  exportClip(
    recordingId: string,
    startSecond: number,
    endSecond: number,
    name: string,
    opts: {
      /** 队列面放行：已完成录制的已录区间可导（停录不取消已提交的落地面）；直接 API 仍仅录中。 */
      allowCompleted?: boolean;
      /** 编码策略快照（队列提交时定格）；缺省=全局设置。 */
      encodeMode?: "auto" | "software";
      /** 队列路径：等导出链完成再返回（写点落定后 clip 行含编码面真值）。 */
      awaitCompletion?: boolean;
      signal?: AbortSignal;
      onCreated?: (clipId: string) => void;
    } = {},
  ): Promise<{
    source: import("../types/index.js").Recording;
    clip: import("../types/index.js").Recording;
  }> {
    return this.clipController.exportClip(
      recordingId,
      startSecond,
      endSecond,
      name,
      opts,
    );
  }
  private handleNaturalEnd(
    room: Room,
    recordingId: string,
    size: number,
    session: ActiveSession,
    attempt: number,
    endTimestampMs: number,
  ): Promise<void> {
    return this.recoveryController.handleNaturalEnd(
      room,
      recordingId,
      size,
      session,
      attempt,
      endTimestampMs,
    );
  }
  private completeRecording(
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
    return this.sessionController.completeRecording(
      room,
      recordingId,
      size,
      endReason,
      options,
    );
  }
  private finishOrConfirm(recordingId: string, forceConfirm = false): void {
    return this.completionController.finishOrConfirm(recordingId, forceConfirm);
  }
  private enterPendingConfirmation(recordingId: string): void {
    return this.completionController.enterPendingConfirmation(recordingId);
  }
  resumeAfterConfirmation(recordingId: string): void {
    return this.completionController.resumeAfterConfirmation(recordingId);
  }
  discardAfterConfirmation(recordingId: string): void {
    return this.completionController.discardAfterConfirmation(recordingId);
  }
  resumePendingConfirmations(): void {
    return this.completionController.resumePendingConfirmations();
  }
  private clearConfirmTimer(recordingId: string): void {
    return this.completionController.clearConfirmTimer(recordingId);
  }
  private get youtubeFinalizations() {
    return this.completionController.youtubeFinalizations;
  }
  private finishSegmentProcessing(recordingId: string): void {
    return this.completionController.finishSegmentProcessing(recordingId);
  }
  private failRecording(
    room: Room,
    recordingId: string,
    err: ErrorObject,
    source: string,
    preservePreview = false,
  ): Promise<void> {
    return this.sessionController.failRecording(
      room,
      recordingId,
      err,
      source,
      preservePreview,
    );
  }

  private raiseAlert(
    level: "info" | "warning" | "error",
    source: string,
    err: AppError | ErrorObject,
  ): void {
    const alert = this.services.alerts.create({
      level,
      source,
      message: err.message,
      occurredAt: this.services.clock.iso(),
      roomId: err.roomId,
      errorCode: err.code,
      retryable: err.retryable,
    });
    this.services.events.emit({ type: "alert:created", data: alert });
  }
}

function defaultsLite(): AppSettings {
  return {
    recordingDirectory: "",
    maxConcurrentRecordings: 2,
    quality: "original",
    recordingFormat: "source_flv",
    autoRecord: false,
    checkIntervalSec: {
      default: 60,
      bilibili: 60,
      douyin: 120,
      xiaohongshu: 120,
    },
    retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
    diskGuard: { minFreeBytes: 20 * 1024 ** 3, minFreePercent: 10 },
    mail: {
      enabled: false,
      host: "",
      port: 465,
      secure: true,
      username: "",
      from: "",
      recipients: [],
    },
    dedupeWindowMinutes: 30,
    theme: "system",
    floatingRecorderSize: 36,
    confirmAfterComplete: false,
  };
}

export { validateClipName } from "./clip-validation.js";
export {
  GAP_ROW_MIN_MS,
  HIGHLIGHT_EXPORT_IDLE_TIMEOUT_MS,
  KEEP_CONFIRM_TIMEOUT_MS,
  RECONNECT_ALERT_AFTER_MS,
  RECONNECT_CHAIN_SEC,
} from "./recorder/constants.js";
export type { PreviewSink, SharedPreviewRecording } from "./recorder/types.js";

export { isStallCause } from "./recorder/session-controller.js";
