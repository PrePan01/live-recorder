import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../types/error.js';
import type { AppSettings, ErrorObject, Room } from '../types/index.js';
import { recordingFilePath } from '../storage/file-organizer.js';
import { checkFileIntegrity } from '../recorder/integrity.js';
import { remuxFlvToMp4 } from '../recorder/remux.js';
import type { RecordingEvent } from '../recorder/engine.js';
import type { Notifier } from './notifier.js';
import type { Services } from './services.js';

export interface PreviewSink {
  canAccept(): boolean;
  broadcastFrame(roomId: string, chunk: Buffer): void;
  closeRoom(roomId: string, code: number, reason?: 'ended' | 'stream_lost'): void;
  /** 新录制/新分段开始时清空该房间预览头缓冲，确保下一段流的 FLV 头被重新捕获。 */
  resetRoom(roomId: string): void;
}

/** 录制完成「询问是否保留」待确认超时（#220）：超时未决策默认保留。 */
export const KEEP_CONFIRM_TIMEOUT_MS = 30 * 60 * 1000;

interface ActiveSession {
  recordingId: string;
  roomId: string;
  streamSessionId: string | null;
  stopRequested: boolean;
  size: number;
  startedAt: string;
  /** 当前分段实际使用的引擎；停止时必须作用于这个实例。 */
  engine: import('../recorder/engine.js').RecordingEngine | null;
  /** 手动停止接口等待录制记录和房间状态真正收口，避免响应先于异步生成器退出。 */
  done?: Promise<void>;
  resolveDone?: () => void;
}

interface PreviewSession {
  engine: import('../recorder/engine.js').RecordingEngine;
  done: Promise<void>;
  transitioningToRecording: boolean;
}

export class RecorderManager {
  private active = new Map<string, ActiveSession>();
  preview: PreviewSink | null = null;

  /** 待确认保留的录制 → 超时自动保留定时器（#220）。 */
  private confirmTimers = new Map<string, unknown>();

  constructor(private services: Services, private notifier: Notifier) {}

  settings(): AppSettings {
    const stored = this.services.settings.load();
    return stored ?? ({ ...structuredClone(defaultsLite()) });
  }

  isRoomActive(roomId: string): boolean {
    return this.active.has(roomId);
  }

  activeRoomIds(): string[] {
    return [...this.active.keys()];
  }

  /** 当前录制会话信息（未录制返回 null），供监控总览显示录制时长。 */
  activeRecordingFor(roomId: string): Room['activeRecording'] {
    const session = this.active.get(roomId);
    return session ? { recordingId: session.recordingId, startedAt: session.startedAt } : null;
  }

  /** 将 activeRecording 附加到房间对象，供 API/SSE 输出。 */
  enrichRoom(room: Room): Room {
    return { ...room, activeRecording: this.activeRecordingFor(room.id) };
  }

  /** 补发 service:status SSE，供前端顶部导航实时显示录制中数量。 */
  emitServiceStatus(): void {
    this.services.events.emit({
      type: 'service:status',
      data: {
        state: 'running',
        activeRecordings: this.active.size,
        setupCompleted: Boolean(this.services.settings.load()?.recordingDirectory?.length),
      },
    });
  }

  // ---- 预览专用拉流（#163：预览=纯观看，不触发录制、不落盘）----
  private previewSessions = new Map<string, PreviewSession>();
  private previewTransitions = new Set<string>();

  isPreviewStreaming(roomId: string): boolean {
    return this.previewSessions.has(roomId);
  }

  /**
   * 为开播但未录制的房间启动预览专用拉流（outputPath=null，引擎只产出 data 事件供预览转发，不写文件）。
   * 仅当房间开播、且既无录制会话也无预览会话时启动；后续帧由引擎 data 事件转发到 preview。
   */
  async ensurePreviewStream(roomId: string): Promise<void> {
    if (this.previewSessions.has(roomId) || this.previewTransitions.has(roomId) || this.active.has(roomId)) return;
    const room = this.services.rooms.get(roomId);
    if (!room || room.lastLiveStatus !== 'live') return;
    try {
      const settings = this.settings();
      const cookie = await this.services.platformCookie(room.platform);
      const stream = await this.services.adapterFor(room.platform).getStreamUrl(room.url, settings.quality, cookie);
      // getStreamUrl 期间可能已经点击了录制；二次检查避免迟到的 preview-only 流覆盖录制流。
      if (this.previewSessions.has(roomId) || this.previewTransitions.has(roomId) || this.active.has(roomId)) return;
      const engine = this.services.engineFor();
      const session: PreviewSession = {
        engine,
        done: Promise.resolve(),
        transitioningToRecording: false,
      };
      this.previewSessions.set(roomId, session);
      session.done = (async () => {
        try {
          const input = { url: stream.url, format: stream.format, ...(stream.headers ? { headers: stream.headers } : {}) };
          for await (const event of engine.start(input, null)) {
            if (event.type === 'data') this.preview?.broadcastFrame(roomId, event.chunk);
            if (event.type === 'error') break;
          }
        } catch {
          // 预览拉流异常：静默收束（前端连接错误/重试处理）
        } finally {
          // 只允许当前会话清理自己，避免旧拉流的 finally 误删后来创建的新会话。
          if (this.previewSessions.get(roomId) === session) this.previewSessions.delete(roomId);
          if (session.transitioningToRecording) {
            // 录制会建立一条全新的 FLV 时间线，前端需重连并重建 MSE。
            this.preview?.closeRoom(roomId, 1012);
          } else {
            this.preview?.closeRoom(roomId, 4004, 'stream_lost');
          }
        }
      })();
    } catch {
      // 取流失败：不阻塞，前端按无帧处理
    }
  }

  /** 停止预览专用拉流（最后一个预览客户端断开时调用）。 */
  async stopPreviewStream(roomId: string, transitioningToRecording = false): Promise<void> {
    const session = this.previewSessions.get(roomId);
    if (!session) return;
    if (transitioningToRecording) session.transitioningToRecording = true;
    await session.engine.stop().catch(() => undefined);
    // 旧拉流完全退出之后才能启动录制，否则两套 FLV 数据会交错写入同一个预览连接。
    await session.done.catch(() => undefined);
  }

  /** 调度器发现直播后调用：并发上限、去重、磁盘保护，然后启动录制。manual=手动触发，跳过同场去重以便停止后重录。 */
  async maybeStartRecording(room: Room, status: { streamSessionId?: string; streamTitle?: string }, opts: { manual?: boolean } = {}): Promise<void> {
    if (this.active.has(room.id)) return;
    const settings = this.settings();
    const sessionId = status.streamSessionId ?? null;
    if (!opts.manual && sessionId && this.services.recordings.hasSession(room.id, sessionId)) {
      // 同一场直播已录制过，保持去重但不能遗留“检测中”，否则 UI 会误判预览状态。
      this.services.rooms.setState(room.id, 'idle', { lastCheckedAt: this.services.clock.iso(), lastError: null });
      this.services.events.emit({ type: 'room:updated', data: this.enrichRoom(this.services.rooms.get(room.id)!) });
      return;
    }

    if (this.services.recordings.activeCount() >= settings.maxConcurrentRecordings) {
      const err = new AppError('CONCURRENT_LIMIT_REACHED', '并发录制数已达上限', { roomId: room.id, retryable: true });
      this.raiseAlert('warning', 'recorder', err);
      this.services.rooms.setState(room.id, 'idle', { lastCheckedAt: this.services.clock.iso(), lastError: err });
      return;
    }

    if (settings.recordingDirectory.length > 0) {
      const space = await this.services.diskGuard.inspect(settings.recordingDirectory);
      const total = space.totalBytes || 1;
      const low = space.freeBytes < settings.diskGuard.minFreeBytes || (space.freeBytes / total) * 100 < settings.diskGuard.minFreePercent;
      this.services.events.emit({ type: 'disk:space', data: { directory: settings.recordingDirectory, freeBytes: space.freeBytes, totalBytes: space.totalBytes, low } });
      if (low) {
        const err = new AppError('DISK_SPACE_INSUFFICIENT', '磁盘空间不足', { roomId: room.id, details: { freeBytes: space.freeBytes, minFreeBytes: settings.diskGuard.minFreeBytes } });
        this.raiseAlert('error', 'disk', err);
        await this.notifier.notify('disk_space_low', room.id, { title: room.displayName });
        this.services.rooms.setState(room.id, 'idle', { lastCheckedAt: this.services.clock.iso(), lastError: err });
        return;
      }
    }

    const cookie = await this.services.platformCookie(room.platform);
    const stream = await this.services.adapterFor(room.platform).getStreamUrl(room.url, settings.quality, cookie);
    this.previewTransitions.add(room.id);
    try {
      // “仅预览”与“录制+预览”不能同时向一个房间广播。先完成旧流交接，旧 WS 会重连到录制流。
      await this.stopPreviewStream(room.id, true);
      const filePath = recordingFilePath(settings.recordingDirectory, room.platform, room.displayName || room.id, this.services.clock.iso(), settings.recordingFormat, settings.namingRule, stream.actualQuality, room.id);
      const recording = this.services.recordings.create({
        roomId: room.id,
        roomName: room.displayName,
        platform: room.platform,
        streamSessionId: sessionId,
        streamTitle: status.streamTitle ?? room.displayName,
        quality: stream.actualQuality,
      });
      this.services.rooms.setState(room.id, 'recording', { lastCheckedAt: this.services.clock.iso(), lastError: null });
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      const session: ActiveSession = { recordingId: recording.id, roomId: room.id, streamSessionId: sessionId, stopRequested: false, size: 0, startedAt: recording.startedAt, engine: null, done, resolveDone };
      this.active.set(room.id, session);
      this.services.events.emit({ type: 'room:updated', data: this.enrichRoom(this.services.rooms.get(room.id)!) });
      this.services.events.emit({ type: 'recording:updated', data: recording });
      this.emitServiceStatus();

      void this.runSession(room, recording.id, stream, filePath, session, 0).catch(() => undefined);
    } finally {
      this.previewTransitions.delete(room.id);
    }
  }

  private async runSession(room: Room, recordingId: string, stream: { url: string; format: 'flv' | 'hls'; headers?: Record<string, string> }, filePath: string, session: ActiveSession, attempt: number): Promise<void> {
    const settings = this.settings();
    const engine = this.services.engineFor();
    session.engine = engine;
    this.services.rooms.setState(room.id, 'recording');
    // 新录制/新分段：清空预览头缓冲，让本段流的 FLV 头被重新捕获（跨录制不残留旧头，QA #150）。
    this.preview?.resetRoom(room.id);

    let startedConfirmed = false;
    const pendingTimeout = this.services.clock.setTimeout(() => {
      if (!startedConfirmed) {
        const err = new AppError('RECORDING_START_FAILED', '录制启动超时', { roomId: room.id, recordingId, retryable: true });
        void this.failRecording(room, recordingId, err, 'recorder');
      }
    }, 30_000);

    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      const input = { url: stream.url, format: stream.format, ...(stream.headers ? { headers: stream.headers } : {}) };
      for await (const event of engine.start(input, filePath)) {
        if (session.stopRequested) break;
        switch (event.type) {
          case 'file_created': {
            startedConfirmed = true;
            this.services.recordings.update(recordingId, { state: 'recording', filePath: event.filePath });
            this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(recordingId)! });
            await this.notifier.notify('recording_started', room.id, { title: room.displayName });
            break;
          }
          case 'data': {
            session.size += event.chunk.length;
            this.preview?.broadcastFrame(room.id, event.chunk);
            break;
          }
          case 'stream_format_changed': {
            const info = new AppError('STREAM_FORMAT_CHANGED', '流格式变化，已自动切换', { roomId: room.id, recordingId });
            this.raiseAlert('info', 'recorder', info);
            break;
          }
          case 'completed': {
            await this.handleNaturalEnd(room, recordingId, event.fileSize, session, attempt);
            return;
          }
          case 'error': {
            clearTimeout2(this.services, pendingTimeout);
            await this.handleDisconnect(room, recordingId, event.error, attempt);
            return;
          }
        }
      }
      if (session.stopRequested) {
        await this.completeRecording(room, recordingId, session.size, 'ended');
        return;
      }
      if (!startedConfirmed) {
        const err = new AppError('RECORDING_START_FAILED', '录制启动失败', { roomId: room.id, recordingId, retryable: true });
        await this.failRecording(room, recordingId, err, 'recorder');
        return;
      }
      await this.completeRecording(room, recordingId, session.size, 'ended');
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError('RECORDING_START_FAILED', `录制异常: ${(err as Error).message}`, { roomId: room.id, recordingId, retryable: true });
      await this.failRecording(room, recordingId, appErr, 'recorder');
    } finally {
      clearTimeout2(this.services, pendingTimeout);
    }
  }

  /** 断流重连：5/15/45 秒退避；成功则开新段续录，耗尽则标记失败保留已录部分。 */
  private async handleDisconnect(room: Room, recordingId: string, error: ErrorObject, attempt: number): Promise<void> {
    const settings = this.settings();
    const recording = this.services.recordings.update(recordingId, {
      state: 'reconnecting',
      retryCount: attempt,
    });
    this.services.rooms.setState(room.id, 'reconnecting');
    this.services.events.emit({ type: 'recording:updated', data: recording });
    this.raiseAlert('warning', 'recorder', new AppError('NETWORK_UNAVAILABLE', `断流，第 ${attempt + 1} 次重连等待中`, { roomId: room.id, recordingId, retryable: true }));

    const delay = settings.retry.delaysSeconds[attempt];
    if (delay === undefined || attempt >= settings.retry.maxAttempts) {
      const err = new AppError('STREAM_DISCONNECTED_RECONNECT_EXHAUSTED', '断流重连耗尽', { roomId: room.id, recordingId, retryable: true });
      this.preview?.closeRoom(room.id, 4004, 'stream_lost');
      await this.failRecording(room, recordingId, err, 'recorder');
      return;
    }

    await new Promise<void>((resolve) => {
      this.services.clock.setTimeout(() => resolve(), delay * 1000);
    });
    if (this.active.get(room.id)?.stopRequested) return;
    try {
      const cookie = await this.services.platformCookie(room.platform);
      const stream = await this.services.adapterFor(room.platform).getStreamUrl(room.url, settings.quality, cookie);
      const nextPath = recordingFilePath(settings.recordingDirectory, room.platform, room.displayName || room.id, this.services.clock.iso(), settings.recordingFormat, settings.namingRule, stream.actualQuality, room.id);
      this.services.recordings.update(recordingId, { state: 'completed', endedAt: this.services.clock.iso(), fileSizeBytes: this.active.get(room.id)?.size ?? 0 });
      this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(recordingId)! });
      // 断流续录：当前分段完成即执行分段级收尾（校验/管线/上传/mp4_after 转封装；#220 询问保留时进入待确认）。
      this.finishOrConfirm(recordingId);
      const next = this.services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: room.platform, streamSessionId: recording.streamSessionId, streamTitle: recording.streamTitle, quality: stream.actualQuality });
      const session = this.active.get(room.id);
      if (session) session.recordingId = next.id;
      void this.runSession(room, next.id, stream, nextPath, session ?? { recordingId: next.id, roomId: room.id, streamSessionId: recording.streamSessionId, stopRequested: false, size: 0, startedAt: recording.startedAt, engine: null }, attempt + 1).catch(() => undefined);
    } catch {
      this.preview?.closeRoom(room.id, 4004, 'stream_lost');
      await this.failRecording(room, recordingId, error, 'recorder');
    }
  }

  async stopRecording(roomId: string): Promise<void> {
    const session = this.active.get(roomId);
    if (!session) return;
    session.stopRequested = true;
    await session.engine?.stop();
    await session.done;
  }

  /**
   * 自然结束（流连接断开但房间可能仍开播）：先归档当前分段，再立即重拉流开新段续录，
   * 避免等待调度器下一轮（60s）造成 60s+ 数据缺口。rapid 用于限制连断连拉的快速循环。
   */
  private async handleNaturalEnd(room: Room, recordingId: string, size: number, session: ActiveSession, attempt: number): Promise<void> {
    if (session.stopRequested) {
      await this.completeRecording(room, recordingId, size, 'ended');
      return;
    }
    const settings = this.settings();
    this.services.recordings.update(recordingId, { state: 'completed', endedAt: this.services.clock.iso(), fileSizeBytes: size });
    this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(recordingId)! });
    // 分段完成（续录）：同样执行分段级收尾（校验/管线/上传/mp4_after 转封装），否则中间分段永不转 MP4/上传。
    this.finishOrConfirm(recordingId);

    const rapid = settings.retry.delaysSeconds[attempt] ?? settings.retry.maxAttempts;
    if (attempt >= settings.retry.maxAttempts) {
      await this.completeRecording(room, recordingId, size, 'ended');
      return;
    }
    // 短暂退避后重拉流：连续断连时避免高频空转，正常重连 gap 远小于调度器间隔。
    await new Promise<void>((resolve) => {
      this.services.clock.setTimeout(() => resolve(), Math.min(rapid, 5) * 1000);
    });
    if (this.active.get(room.id)?.stopRequested) {
      await this.completeRecording(room, recordingId, size, 'ended');
      return;
    }
    try {
      const cookie = await this.services.platformCookie(room.platform);
      // 先确认主播仍开播：已下播则正常收口，避免对结束的直播反复重连。
      const live = await this.services.adapterFor(room.platform).checkLiveStatus(room.url, cookie);
      if (live.status !== 'live') {
        await this.completeRecording(room, recordingId, size, 'ended');
        return;
      }
      const stream = await this.services.adapterFor(room.platform).getStreamUrl(room.url, settings.quality, cookie);
      const nextPath = recordingFilePath(settings.recordingDirectory, room.platform, room.displayName || room.id, this.services.clock.iso(), settings.recordingFormat, settings.namingRule, stream.actualQuality, room.id);
      const recording = this.services.recordings.get(recordingId)!;
      const next = this.services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: room.platform, streamSessionId: recording.streamSessionId, streamTitle: recording.streamTitle, quality: stream.actualQuality });
      const cur = this.active.get(room.id);
      if (cur) cur.recordingId = next.id;
      void this.runSession(room, next.id, stream, nextPath, cur ?? { recordingId: next.id, roomId: room.id, streamSessionId: recording.streamSessionId, stopRequested: false, size: 0, startedAt: recording.startedAt, engine: null }, attempt + 1).catch(() => undefined);
    } catch {
      await this.completeRecording(room, recordingId, size, 'ended');
    }
  }

  private async completeRecording(room: Room, recordingId: string, size: number, endReason: 'ended' | 'stream_lost'): Promise<void> {
    // 0 字节录制（流连接后无数据/立即关闭）应标 failed 而非 completed 空文件（QA #165 边界）。
    if (size <= 0) {
      const rec = this.services.recordings.get(recordingId);
      if (rec?.filePath) {
        await unlink(rec.filePath).catch(() => undefined);
      }
      const err = new AppError('RECORDING_EMPTY', '录制文件为空（未获取到流数据）', { roomId: room.id, recordingId, retryable: true });
      await this.failRecording(room, recordingId, err.toObject(), 'recorder');
      return;
    }
    const session = this.active.get(room.id);
    const rec = this.services.recordings.update(recordingId, {
      state: 'completed',
      endedAt: this.services.clock.iso(),
      fileSizeBytes: size,
    });
    this.preview?.closeRoom(room.id, 1000, endReason);
    this.active.delete(room.id);
    this.emitServiceStatus();
    this.services.rooms.setState(room.id, 'completed', { lastCheckedAt: this.services.clock.iso(), lastError: null });
    this.services.events.emit({ type: 'recording:updated', data: rec });
    this.services.events.emit({ type: 'room:updated', data: this.enrichRoom(this.services.rooms.get(room.id)!) });
    session?.resolveDone?.();
    // 异步校验文件完整性，不阻塞录制完成响应（#220 询问保留时进入待确认态挂起管线/上传）。
    this.finishOrConfirm(recordingId);
  }

  /**
   * 分段完成收尾入口（#220）：设置「完成后询问是否保留」开启时，录制完成进入待确认态并挂起
   * 管线/上传（由保留/不保留/超时/重启决定）；关闭时按原流程立即执行分段级收尾。
   */
  private finishOrConfirm(recordingId: string): void {
    if (this.settings().confirmKeepAfterComplete) {
      this.enterPendingConfirmation(recordingId);
    } else {
      this.finishSegmentProcessing(recordingId);
    }
  }

  /** 录制完成进入待确认态：state=awaiting_confirmation，挂起管线/上传，并安排超时自动保留。 */
  private enterPendingConfirmation(recordingId: string): void {
    const rec = this.services.recordings.get(recordingId);
    if (!rec) return;
    this.clearConfirmTimer(recordingId);
    const updated = this.services.recordings.update(recordingId, { state: 'awaiting_confirmation' });
    this.services.events.emit({ type: 'recording:updated', data: updated });
    const handle = this.services.clock.setTimeout(() => this.resumeAfterConfirmation(recordingId), KEEP_CONFIRM_TIMEOUT_MS);
    this.confirmTimers.set(recordingId, handle);
  }

  /**
   * 保留决策（#220）：恢复管线+上传（等价于原分段级收尾）。清除超时定时器；
   * 文件存在 → completed + 收尾；文件缺失 → failed（无法保留）。
   */
  resumeAfterConfirmation(recordingId: string): void {
    this.clearConfirmTimer(recordingId);
    const rec = this.services.recordings.get(recordingId);
    if (!rec) return;
    if (!rec.filePath) {
      const err = new AppError('RECORDING_FILE_CORRUPTED', '待确认录制文件缺失，无法保留', { recordingId, roomId: rec.roomId, retryable: false });
      const failed = this.services.recordings.update(recordingId, { state: 'failed', failureReason: err.toObject() });
      this.services.events.emit({ type: 'recording:updated', data: failed });
      return;
    }
    const updated = this.services.recordings.update(recordingId, { state: 'completed' });
    this.services.events.emit({ type: 'recording:updated', data: updated });
    this.finishSegmentProcessing(recordingId);
  }

  /** 不保留决策（#220）：删除文件 + 删除录制记录，并清除超时定时器。 */
  discardAfterConfirmation(recordingId: string): void {
    this.clearConfirmTimer(recordingId);
    const rec = this.services.recordings.get(recordingId);
    if (!rec) return;
    if (rec.filePath) void unlink(rec.filePath).catch(() => undefined);
    this.services.recordings.remove(recordingId);
  }

  /** 启动恢复（#220）：上次运行遗留的待确认录制按「默认保留」恢复管线/上传。 */
  resumePendingConfirmations(): void {
    const pending = this.services.recordings.list({ pageSize: 100 }).items.filter((r) => r.state === 'awaiting_confirmation');
    for (const rec of pending) {
      this.resumeAfterConfirmation(rec.id);
    }
  }

  private clearConfirmTimer(recordingId: string): void {
    const handle = this.confirmTimers.get(recordingId);
    if (handle !== undefined) {
      this.services.clock.clearTimeout(handle);
      this.confirmTimers.delete(recordingId);
    }
  }

  /**
   * 分段级收尾（分段完成/录制完成共用）：异步完整性校验 + 管线入队（未启用时触发上传）+ mp4_after 转封装。
   * 断流续录的中间分段也必须走这里，否则中间分段永远停在 .flv、也不会上传（PrePan：完成后转 MP4 不可用）。
   */
  private finishSegmentProcessing(recordingId: string): void {
    const rec = this.services.recordings.get(recordingId);
    if (!rec) return;
    if (rec.filePath) this.verifyIntegrity(rec);
    // 后处理管线（V5 Batch2 #114）：enabled 时入队（verify/sidecar/cover/segment/compress/archive）。
    this.services.pipeline.enqueue(recordingId);
    // mp4_after：完成后异步转封装 MP4（管线启用时由 compress 步骤覆盖，跳过此处以免重复）。
    if (this.settings().recordingFormat === 'mp4_after' && rec.filePath && !(this.services.pipeline.pipelineConfig().enabled)) {
      this.remuxToMp4(rec);
    }
  }

  /** mp4_after 格式：录制完成后 ffmpeg remux FLV→MP4，更新 filePath；失败保留 FLV 不阻断。 */
  private remuxToMp4(rec: import('../types/index.js').Recording): void {
    void (async () => {
      try {
        const mp4 = await remuxFlvToMp4(rec.filePath!);
        if (!mp4) return;
        const updated = this.services.recordings.update(rec.id, { filePath: mp4 });
        this.services.events.emit({ type: 'recording:updated', data: updated });
      } catch {
        // 转封装失败/应用关闭：保留 FLV，不阻断。
      }
    })();
  }

  /** ffprobe 异步校验录制文件：verified/failed/pending（缺 ffprobe 或超时），failed 发告警。 */
  private verifyIntegrity(rec: import('../types/index.js').Recording): void {
    void (async () => {
      try {
        const integrity = await checkFileIntegrity(rec.filePath!);
        // 服务可能已关闭（DB 关闭），吞掉该场景错误避免未处理拒绝。
        const updated = this.services.recordings.update(rec.id, { integrity });
        this.services.events.emit({ type: 'recording:updated', data: updated });
        if (integrity === 'failed') {
          this.raiseAlert('warning', 'recorder', new AppError('RECORDING_FILE_CORRUPTED', '录制文件校验失败，可能损坏或截断', { recordingId: rec.id, roomId: rec.roomId, retryable: false }));
        }
      } catch {
        // 应用关闭/校验中途异常：忽略（完整性校验非关键路径）。
      }
    })();
  }

  private async failRecording(room: Room, recordingId: string, err: ErrorObject, source: string): Promise<void> {
    const session = this.active.get(room.id);
    const rec = this.services.recordings.update(recordingId, {
      state: 'failed',
      endedAt: this.services.clock.iso(),
      failureReason: err,
    });
    this.preview?.closeRoom(room.id, 4004, 'stream_lost');
    this.active.delete(room.id);
    this.emitServiceStatus();
    this.services.rooms.setState(room.id, 'failed', { lastCheckedAt: this.services.clock.iso(), lastError: err });
    this.services.events.emit({ type: 'recording:updated', data: rec });
    this.services.events.emit({ type: 'room:updated', data: this.enrichRoom(this.services.rooms.get(room.id)!) });
    session?.resolveDone?.();
    this.raiseAlert('error', source, err);
    await this.notifier.notify('recording_failed', room.id, { title: room.displayName });
  }

  private raiseAlert(level: 'info' | 'warning' | 'error', source: string, err: AppError | ErrorObject): void {
    const alert = this.services.alerts.create({
      level,
      source,
      message: `${err.code}: ${err.message}`,
      occurredAt: this.services.clock.iso(),
      roomId: err.roomId,
      errorCode: err.code,
    });
    this.services.events.emit({ type: 'alert:created', data: alert });
  }
}

function defaultsLite(): AppSettings {
  return {
    recordingDirectory: '',
    maxConcurrentRecordings: 2,
    quality: 'original',
    recordingFormat: 'source_flv',
    autoRecord: true,
    checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
    retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
    diskGuard: { minFreeBytes: 20 * 1024 ** 3, minFreePercent: 10 },
    mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] },
    dedupeWindowMinutes: 30,
    theme: 'system',
    confirmKeepAfterComplete: false,
  };
}

function clearTimeout2(services: Services, handle: unknown): void {
  services.clock.clearTimeout(handle);
}
