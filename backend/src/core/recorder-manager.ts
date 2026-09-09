import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { AppError } from '../types/error.js';
import type { AppSettings, ErrorObject, Room } from '../types/index.js';
import { recordingFilePath } from '../storage/file-organizer.js';
import { checkFileIntegrity } from '../recorder/integrity.js';
import { remuxFlvToMp4 } from '../recorder/remux.js';
import type { RecordingEvent } from '../recorder/engine.js';
import { FlvTimestampNormalizer } from '../recorder/stream-recorder.js';
import { HighlightBuffer } from '../recorder/highlight-buffer.js';
import type { Notifier } from './notifier.js';
import type { Services } from './services.js';

export interface PreviewSink {
  canAccept(): boolean;
  broadcastFrame(roomId: string, chunk: Buffer): void;
  closeRoom(roomId: string, code: number, reason?: 'ended' | 'stream_lost'): void;
  /** 新录制/新分段开始时清空该房间预览头缓冲，确保下一段流的 FLV 头被重新捕获。 */
  resetRoom(roomId: string): void;
  /** 获取可从关键帧开始写入录制文件的预览数据，不中断已连接的预览客户端。 */
  recordingBootstrap?(roomId: string): Buffer | null;
}

/** 录制完成「询问是否保留」待确认超时（#220）：超时未决策默认保留（PM 方案 10 分钟）。 */
export const KEEP_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;
/** 共享录制写盘不得反压预览流；达到上限时停止该录制而非卡住观看。 */
const MAX_SHARED_RECORDING_PENDING_BYTES = 8 * 1024 * 1024;

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
  recording: SharedPreviewRecording | null;
  /** 仅供没有可复用 bootstrap 时走旧交接路径。 */
  transitioningToRecording: boolean;
}

interface SharedPreviewRecording {
  session: ActiveSession;
  writer: WriteStream;
  normalizer: FlvTimestampNormalizer;
  pendingWrites: Buffer[];
  pendingWriteBytes: number;
  writePump: Promise<void> | null;
  writeError: Error | null;
}

export class RecorderManager {
  private active = new Map<string, ActiveSession>();
  private backgroundTasks = 0;

  get busy(): boolean { return this.active.size > 0 || this.backgroundTasks > 0; }

  async resetIdleState(): Promise<void> {
    await Promise.all([...this.previewSessions.keys()].map((id) => this.stopPreviewStream(id)));
    await Promise.all([...this.highlightBuffers.keys()].map((id) => this.disableHighlightBuffer(id)));
  }

  clearPendingConfirmations(): void {
    for (const id of this.confirmTimers.keys()) this.clearConfirmTimer(id);
  }
  preview: PreviewSink | null = null;

  /** 待确认保留的录制 → 超时自动保留定时器（#220）。 */
  private confirmTimers = new Map<string, unknown>();
  /** Explicit normal-preview highlight caches. Live-wall clients never create these. */
  private highlightBuffers = new Map<string, HighlightBuffer>();

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

  async enableHighlightBuffer(roomId: string): Promise<{ availableSeconds: number; maxSeconds: number; accepting: boolean; disabledReason?: string }> {
    if (this.active.has(roomId)) throw new AppError('RECORDING_NOT_AVAILABLE', '实时录制中无需使用精彩时刻', { roomId });
    const room = this.services.rooms.get(roomId);
    if (!room || room.lastLiveStatus !== 'live') throw new AppError('RECORDING_NOT_AVAILABLE', '直播间未开播，无法启用精彩时刻', { roomId });
    const settings = this.settings();
    if (settings.highlightEnabled === false) throw new AppError('RECORDING_NOT_AVAILABLE', '精彩时刻功能未开启', { roomId });
    if (!settings.recordingDirectory) throw new AppError('DIRECTORY_NOT_WRITABLE', '请先配置录像保存目录', { roomId });
    let buffer = this.highlightBuffers.get(roomId);
    if (buffer && !buffer.isAccepting) {
      await buffer.clear();
      this.highlightBuffers.delete(roomId);
      buffer = undefined;
    }
    if (!buffer) {
      const dir = path.join(settings.recordingDirectory, '.live-recorder-cache', roomId);
      buffer = new HighlightBuffer(dir, settings.highlightBufferSeconds ?? 300);
      await buffer.start();
      this.highlightBuffers.set(roomId, buffer);
      // 共享预览流在停止录制后不会重新发送 FLV 文件头。用预览缓存的初始化段和
      // 关键帧播种精彩时刻缓存，否则新缓存会永远等待一个不会再出现的文件头。
      const bootstrap = this.preview?.recordingBootstrap?.(roomId);
      if (bootstrap) buffer.append(bootstrap);
    } else {
      buffer.setRetainSeconds(settings.highlightBufferSeconds ?? 300);
    }
    return { availableSeconds: buffer.availableSeconds(), maxSeconds: settings.highlightBufferSeconds ?? 300, accepting: buffer.isAccepting, ...(buffer.backpressureReason ? { disabledReason: buffer.backpressureReason } : {}) };
  }

  async disableHighlightBuffer(roomId: string): Promise<void> {
    const buffer = this.highlightBuffers.get(roomId);
    if (!buffer) return;
    this.highlightBuffers.delete(roomId);
    await buffer.clear();
  }

  /** 清空内容但保留当前观看的缓存会话，后续预览帧会立即重新累计。 */
  async clearHighlightBuffer(roomId: string): Promise<void> {
    const buffer = this.highlightBuffers.get(roomId);
    if (!buffer) throw new AppError('RECORDING_NOT_AVAILABLE', '精彩时刻缓存未启用', { roomId });
    await buffer.reset();
  }

  async disableAllHighlightBuffers(): Promise<void> {
    await Promise.all([...this.highlightBuffers.keys()].map((id) => this.disableHighlightBuffer(id)));
  }

  highlightStatus(roomId: string): { enabled: boolean; availableSeconds: number; maxSeconds: number; accepting: boolean; disabledReason?: string } {
    const buffer = this.highlightBuffers.get(roomId);
    return {
      enabled: Boolean(buffer),
      availableSeconds: buffer?.availableSeconds() ?? 0,
      maxSeconds: this.settings().highlightBufferSeconds ?? 300,
      accepting: buffer?.isAccepting ?? false,
      ...(buffer?.backpressureReason ? { disabledReason: buffer.backpressureReason } : {}),
    };
  }

  async exportHighlight(roomId: string, lookbackSeconds: number): Promise<{ recordingId: string; availableSeconds: number }> {
    if (this.active.has(roomId)) throw new AppError('RECORDING_NOT_AVAILABLE', '实时录制中无需使用精彩时刻', { roomId });
    const room = this.services.rooms.get(roomId);
    const buffer = this.highlightBuffers.get(roomId);
    if (this.settings().highlightEnabled === false) throw new AppError('RECORDING_NOT_AVAILABLE', '精彩时刻功能未开启', { roomId });
    if (!room || !buffer) throw new AppError('RECORDING_NOT_AVAILABLE', '请先在普通观看窗口中等待精彩时刻缓存', { roomId });
    const maxSeconds = this.settings().highlightBufferSeconds ?? 300;
    if (!Number.isInteger(lookbackSeconds) || lookbackSeconds < 1 || lookbackSeconds > maxSeconds) throw new AppError('CONFIG_INVALID', `回溯时长需为 1 秒至 ${maxSeconds} 秒`, { roomId });
    const availableSeconds = buffer.availableSeconds();
    if (availableSeconds < 1) throw new AppError('RECORDING_NOT_AVAILABLE', '精彩时刻缓存尚未就绪', { roomId });
    const settings = this.settings();
    const recording = this.services.recordings.create({ roomId, roomName: room.displayName, platform: room.platform, streamSessionId: null, streamTitle: `精彩时刻｜${room.displayName}`, quality: settings.quality, expectedQuality: settings.quality });
    const base = recordingFilePath(settings.recordingDirectory, room.platform, room.displayName || room.id, recording.startedAt, settings.recordingFormat, settings.namingRule, settings.quality, room.id);
    const parsed = path.parse(base);
    const filePath = path.join(parsed.dir, `${parsed.name}_highlight_${recording.id}${parsed.ext}`);
    void (async () => {
      try {
        const result = await buffer.exportTo(filePath, Math.min(lookbackSeconds, availableSeconds));
        // A highlight is copied from an already-buffered stream, so export
        // itself takes only milliseconds.  Persist the clip's media interval
        // rather than that copy interval; history, stats and CSV all derive
        // duration from startedAt/endedAt.
        const endedAt = this.services.clock.iso();
        const startedAt = new Date(new Date(endedAt).getTime() - result.actualSeconds * 1_000).toISOString();
        const completed = this.services.recordings.update(recording.id, { state: 'completed', filePath, fileSizeBytes: result.bytes, startedAt, endedAt });
        if (!this.settings().confirmAfterComplete) this.services.events.emit({ type: 'recording:updated', data: completed });
        this.finishOrConfirm(recording.id);
      } catch (error) {
        const err = new AppError('RECORDING_START_FAILED', `精彩时刻导出失败: ${(error as Error).message}`, { roomId, recordingId: recording.id });
        const failed = this.services.recordings.update(recording.id, { state: 'failed', endedAt: this.services.clock.iso(), failureReason: err.toObject() });
        this.services.events.emit({ type: 'recording:updated', data: failed });
      }
    })();
    this.services.events.emit({ type: 'recording:updated', data: recording });
    return { recordingId: recording.id, availableSeconds };
  }

  /**
   * 为开播但未录制的房间启动预览专用拉流（outputPath=null，引擎只产出 data 事件供预览转发，不写文件）。
   * 仅当房间开播、且既无录制会话也无预览会话时启动；后续帧由引擎 data 事件转发到 preview。
   */
  async ensurePreviewStream(roomId: string): Promise<void> {
    if (this.services.resetting) return;
    if (this.previewSessions.has(roomId) || this.previewTransitions.has(roomId) || this.active.has(roomId)) return;
    const room = this.services.rooms.get(roomId);
    if (!room || room.lastLiveStatus !== 'live') return;
    try {
      const settings = this.settings();
      const cookie = await this.services.platformCookie(room.platform);
      const stream = await this.services.adapterFor(room.platform).getStreamUrl(room.url, settings.quality, cookie);
      // getStreamUrl 期间可能已经点击了录制；二次检查避免迟到的 preview-only 流覆盖录制流。
      if (this.services.resetting || !this.services.rooms.get(roomId) || this.previewSessions.has(roomId) || this.previewTransitions.has(roomId) || this.active.has(roomId)) return;
      const engine = this.services.engineFor();
      const session: PreviewSession = {
        engine,
        done: Promise.resolve(),
        recording: null,
        transitioningToRecording: false,
      };
      this.previewSessions.set(roomId, session);
      session.done = (async () => {
        try {
          const input = { url: stream.url, format: stream.format, ...(stream.headers ? { headers: stream.headers } : {}) };
          for await (const event of engine.start(input, null)) {
            if (event.type === 'data') {
              const sharedRecording = session.recording;
              if (sharedRecording) {
                try {
                  await this.appendSharedPreviewRecording(sharedRecording, event.chunk);
                } catch (error) {
                  session.recording = null;
                  sharedRecording.writer.destroy();
                  const err = new AppError('RECORDING_START_FAILED', `录制文件写入失败: ${(error as Error).message}`, { roomId, recordingId: sharedRecording.session.recordingId });
                  await this.failRecording(room, sharedRecording.session.recordingId, err.toObject(), 'recorder', true);
                }
              }
              if (this.settings().highlightEnabled !== false) this.highlightBuffers.get(roomId)?.append(event.chunk);
              this.preview?.broadcastFrame(roomId, event.chunk);
            }
            if (event.type === 'error') break;
          }
        } catch {
          // 预览拉流异常：静默收束（前端连接错误/重试处理）
        } finally {
          // 只允许当前会话清理自己，避免旧拉流的 finally 误删后来创建的新会话。
          if (this.previewSessions.get(roomId) === session) this.previewSessions.delete(roomId);
          const sharedRecording = session.recording;
          if (sharedRecording) {
            session.recording = null;
            try {
              await this.closeSharedPreviewRecording(sharedRecording);
              await this.completeRecording(room, sharedRecording.session.recordingId, sharedRecording.session.size, 'stream_lost');
            } catch (error) {
              sharedRecording.writer.destroy();
              const err = new AppError('RECORDING_START_FAILED', `录制文件写入失败: ${(error as Error).message}`, { roomId, recordingId: sharedRecording.session.recordingId });
              await this.failRecording(room, sharedRecording.session.recordingId, err.toObject(), 'recorder');
            }
          }
          this.preview?.closeRoom(
            roomId,
            session.transitioningToRecording ? 1012 : 4004,
            session.transitioningToRecording ? undefined : 'stream_lost',
          );
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
    await session.done.catch(() => undefined);
    // WebSocket 可能因 mpegts.js 的短暂重连而一度变成“最后一个客户端断开”。
    // 不能在这里清理精彩时刻缓存，否则播放器重连成功后缓存已丢失且前端不会重新启用。
    // 普通观看窗口卸载、关闭总开关、开始实时录制和服务重置会显式清理它。
  }

  private appendSharedPreviewRecording(recording: SharedPreviewRecording, chunk: Buffer): void {
    if (recording.writeError) throw recording.writeError;
    // FlvTimestampNormalizer 会原地改写时间戳；写盘必须处理副本，不能污染仍要
    // 广播给 mpegts 的原始预览帧，否则预览时间轴会在开始录制时跳回 0。
    for (const part of recording.normalizer.push(Buffer.from(chunk))) {
      if (recording.pendingWriteBytes + part.length > MAX_SHARED_RECORDING_PENDING_BYTES) {
        throw new Error('录制磁盘写入过慢');
      }
      recording.session.size += part.length;
      recording.pendingWrites.push(part);
      recording.pendingWriteBytes += part.length;
    }
    this.startSharedWritePump(recording);
  }

  private startSharedWritePump(recording: SharedPreviewRecording): void {
    if (recording.writePump || recording.writeError) return;
    recording.writePump = (async () => {
      while (recording.pendingWrites.length > 0) {
        const part = recording.pendingWrites.shift()!;
        if (!recording.writer.write(part)) await once(recording.writer, 'drain');
        recording.pendingWriteBytes -= part.length;
      }
    })().catch((error) => {
      recording.writeError = error instanceof Error ? error : new Error('录制文件写入失败');
    }).finally(() => {
      recording.writePump = null;
      if (recording.pendingWrites.length > 0 && !recording.writeError) {
        this.startSharedWritePump(recording);
      }
    });
  }

  private async closeSharedPreviewRecording(recording: SharedPreviewRecording): Promise<void> {
    if (recording.writeError) throw recording.writeError;
    const remaining = recording.normalizer.remaining();
    if (remaining.length > 0) {
      if (recording.pendingWriteBytes + remaining.length > MAX_SHARED_RECORDING_PENDING_BYTES) {
        throw new Error('录制磁盘写入过慢');
      }
      recording.session.size += remaining.length;
      recording.pendingWrites.push(remaining);
      recording.pendingWriteBytes += remaining.length;
    }
    this.startSharedWritePump(recording);
    while (recording.writePump) await recording.writePump;
    if (recording.writeError) throw recording.writeError;
    await new Promise<void>((resolve, reject) => {
      recording.writer.once('error', reject);
      recording.writer.end(() => resolve());
    });
  }

  /**
   * 观看中的房间开始录制时复用当前上游流：只新增文件写入器，绝不关闭预览 WebSocket。
   * 返回 false 表示尚未积累足够的 FLV 初始化段/关键帧，调用方回退到既有录制路径。
   */
  private async startSharedPreviewRecording(
    room: Room,
    status: { streamSessionId?: string; streamTitle?: string },
    actualQuality: string,
    settings: AppSettings,
  ): Promise<boolean> {
    const previewSession = this.previewSessions.get(room.id);
    const bootstrap = this.preview?.recordingBootstrap?.(room.id);
    // 共享写入器目前复用 FLV 标签及其时间戳归零逻辑；非 FLV 流沿用原有独立录制路径。
    if (!previewSession || previewSession.recording || !bootstrap || bootstrap.subarray(0, 3).toString() !== 'FLV') return false;

    const recording = this.services.recordings.create({
      roomId: room.id,
      roomName: room.displayName,
      platform: room.platform,
      streamSessionId: status.streamSessionId ?? null,
      streamTitle: status.streamTitle ?? room.displayName,
      quality: actualQuality,
      expectedQuality: settings.quality,
    });
    const filePath = recordingFilePath(
      settings.recordingDirectory,
      room.platform,
      room.displayName || room.id,
      recording.startedAt,
      settings.recordingFormat,
      settings.namingRule,
      actualQuality,
      room.id,
    );
    await mkdir(path.dirname(filePath), { recursive: true });
    const writer = createWriteStream(filePath);
    const session: ActiveSession = {
      recordingId: recording.id,
      roomId: room.id,
      streamSessionId: status.streamSessionId ?? null,
      stopRequested: false,
      size: 0,
      startedAt: recording.startedAt,
      engine: null,
    };
    let resolveDone!: () => void;
    session.done = new Promise<void>((resolve) => { resolveDone = resolve; });
    session.resolveDone = resolveDone;
    const sharedRecording: SharedPreviewRecording = {
      session,
      writer,
      // 预览流的时间戳从打开观看起计算；录制文件须在本次开始处重新归零。
      normalizer: new FlvTimestampNormalizer(true),
      pendingWrites: [],
      pendingWriteBytes: 0,
      writePump: null,
      writeError: null,
    };

    try {
      this.appendSharedPreviewRecording(sharedRecording, bootstrap);
    } catch (error) {
      writer.destroy();
      await unlink(filePath).catch(() => undefined);
      const err = new AppError('RECORDING_START_FAILED', `录制文件初始化失败: ${(error as Error).message}`, { roomId: room.id, recordingId: recording.id });
      const failed = this.services.recordings.update(recording.id, { state: 'failed', endedAt: this.services.clock.iso(), failureReason: err.toObject() });
      this.services.events.emit({ type: 'recording:updated', data: failed });
      throw err;
    }

    previewSession.recording = sharedRecording;
    this.active.set(room.id, session);
    this.services.recordings.update(recording.id, { state: 'recording', filePath });
    this.services.rooms.setState(room.id, 'recording', { lastCheckedAt: this.services.clock.iso(), lastError: null });
    this.services.events.emit({ type: 'room:updated', data: this.enrichRoom(this.services.rooms.get(room.id)!) });
    this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(recording.id)! });
    this.emitServiceStatus();
    await this.notifier.notify('recording_started', room.id, { title: room.displayName });
    return true;
  }

  /** 调度器发现直播后调用：并发上限、去重、磁盘保护，然后启动录制。manual=手动触发，跳过同场去重以便停止后重录。 */
  async maybeStartRecording(room: Room, status: { streamSessionId?: string; streamTitle?: string }, opts: { manual?: boolean } = {}): Promise<void> {
    if (this.services.resetting) return;
    if (this.active.has(room.id)) return;
    await this.disableHighlightBuffer(room.id);
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
    // 已有观看预览时复用它的上游流；只有尚未形成可写入的关键帧缓存时才回退旧路径。
    if (await this.startSharedPreviewRecording(room, status, stream.actualQuality, settings)) return;
    this.previewTransitions.add(room.id);
    try {
      // 无观看预览时维持原有独立录制路径。
      await this.stopPreviewStream(room.id, true);
      const filePath = recordingFilePath(settings.recordingDirectory, room.platform, room.displayName || room.id, this.services.clock.iso(), settings.recordingFormat, settings.namingRule, stream.actualQuality, room.id);
      const recording = this.services.recordings.create({
        roomId: room.id,
        roomName: room.displayName,
        platform: room.platform,
        streamSessionId: sessionId,
        streamTitle: status.streamTitle ?? room.displayName,
        quality: stream.actualQuality,
        expectedQuality: settings.quality,
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
      // #222：confirmAfterComplete 开启时不发中间 completed 事件（只发最终 awaiting_confirmation），避免「已保存通知 + 确认框」弹两次。
      if (!this.settings().confirmAfterComplete) this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(recordingId)! });
      // 断流续录：当前分段完成即执行分段级收尾（校验/管线/上传/mp4_after 转封装；#220 询问保留时进入待确认）。
      this.finishOrConfirm(recordingId);
      const next = this.services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: room.platform, streamSessionId: recording.streamSessionId, streamTitle: recording.streamTitle, quality: stream.actualQuality, expectedQuality: settings.quality });
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
    const previewSession = this.previewSessions.get(roomId);
    const sharedRecording = previewSession?.recording;
    if (previewSession && sharedRecording?.session === session) {
      previewSession.recording = null;
      const room = this.services.rooms.get(roomId)!;
      try {
        await this.closeSharedPreviewRecording(sharedRecording);
        await this.completeRecording(room, session.recordingId, session.size, 'ended', true);
      } catch (error) {
        sharedRecording.writer.destroy();
        const err = new AppError('RECORDING_START_FAILED', `录制文件写入失败: ${(error as Error).message}`, { roomId, recordingId: session.recordingId });
        await this.failRecording(room, session.recordingId, err.toObject(), 'recorder', true);
      }
      return;
    }
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
    // #222：confirmAfterComplete 开启时不发中间 completed 事件（只发最终 awaiting_confirmation），避免「已保存通知 + 确认框」弹两次。
    if (!settings.confirmAfterComplete) this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(recordingId)! });
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
      const next = this.services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: room.platform, streamSessionId: recording.streamSessionId, streamTitle: recording.streamTitle, quality: stream.actualQuality, expectedQuality: settings.quality });
      const cur = this.active.get(room.id);
      if (cur) cur.recordingId = next.id;
      void this.runSession(room, next.id, stream, nextPath, cur ?? { recordingId: next.id, roomId: room.id, streamSessionId: recording.streamSessionId, stopRequested: false, size: 0, startedAt: recording.startedAt, engine: null }, attempt + 1).catch(() => undefined);
    } catch {
      await this.completeRecording(room, recordingId, size, 'ended');
    }
  }

  private async completeRecording(room: Room, recordingId: string, size: number, endReason: 'ended' | 'stream_lost', preservePreview = false): Promise<void> {
    // 0 字节录制（流连接后无数据/立即关闭）应标 failed 而非 completed 空文件（QA #165 边界）。
    if (size <= 0) {
      const rec = this.services.recordings.get(recordingId);
      if (rec?.filePath) {
        await unlink(rec.filePath).catch(() => undefined);
      }
      const err = new AppError('RECORDING_EMPTY', '录制文件为空（未获取到流数据）', { roomId: room.id, recordingId, retryable: true });
      await this.failRecording(room, recordingId, err.toObject(), 'recorder', preservePreview);
      return;
    }
    const session = this.active.get(room.id);
    const rec = this.services.recordings.update(recordingId, {
      state: 'completed',
      endedAt: this.services.clock.iso(),
      fileSizeBytes: size,
    });
    if (!preservePreview) this.preview?.closeRoom(room.id, 1000, endReason);
    this.active.delete(room.id);
    this.emitServiceStatus();
    this.services.rooms.setState(room.id, 'completed', { lastCheckedAt: this.services.clock.iso(), lastError: null });
    // #222：confirmAfterComplete 开启时不发中间 completed 事件（只发最终 awaiting_confirmation），避免「已保存通知 + 确认框」弹两次。
    if (!this.settings().confirmAfterComplete) this.services.events.emit({ type: 'recording:updated', data: rec });
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
    if (this.settings().confirmAfterComplete) {
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
    if (this.services.resetting) {
      this.clearConfirmTimer(recordingId);
      this.confirmTimers.set(recordingId, this.services.clock.setTimeout(() => this.resumeAfterConfirmation(recordingId), 1_000));
      return;
    }
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
    // mp4_after（且管线未启用）：先完成 FLV→MP4 转封装再入队管线/上传——
    // 避免上传抢在转封装前按旧 filePath 把 FLV 传走（PrePan：偶现转 mp4 失败上传的却是 flv）。
    if (this.settings().recordingFormat === 'mp4_after' && rec.filePath && !(this.services.pipeline.pipelineConfig().enabled)) {
      this.backgroundTasks += 1;
      void (async () => {
        const updated = await this.remuxToMp4(rec);
        this.services.events.emit({ type: 'recording:updated', data: updated ?? this.services.recordings.get(recordingId)! });
        this.services.pipeline.enqueue(recordingId);
      })().finally(() => { this.backgroundTasks -= 1; });
      return;
    }
    // 后处理管线（V5 Batch2 #114）：enabled 时入队（verify/sidecar/cover/segment/compress/archive）；未启用时触发上传。
    this.services.pipeline.enqueue(recordingId);
  }

  /** mp4_after 格式：录制完成后 ffmpeg remux FLV→MP4，更新 filePath；失败保留 FLV 不阻断。返回更新后的记录。
   *  #225：失败自动重试（最多 3 次），仍失败则告警，让用户知道上传的将是 FLV，不静默。 */
  private async remuxToMp4(rec: import('../types/index.js').Recording): Promise<import('../types/index.js').Recording | null> {
    const MAX_REMUX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_REMUX_ATTEMPTS; attempt += 1) {
      try {
        const mp4 = await remuxFlvToMp4(rec.filePath!);
        if (mp4) return this.services.recordings.update(rec.id, { filePath: mp4 });
      } catch {
        // 尝试下一次
      }
      if (attempt < MAX_REMUX_ATTEMPTS) {
        await new Promise<void>((resolve) => this.services.clock.setTimeout(resolve, 1_000));
      }
    }
    // 持久失败：告警 + 记录标记，用户能知道上传的是 FLV（不静默）。
    this.raiseAlert('warning', 'recorder', new AppError('RECORDING_REMUX_FAILED', '转 MP4 失败（已重试），将保留并上传源 FLV', { recordingId: rec.id, roomId: rec.roomId, retryable: false }));
    return null;
  }

  /** ffprobe 异步校验录制文件：verified/failed/pending（缺 ffprobe 或超时），failed 发告警。 */
  private verifyIntegrity(rec: import('../types/index.js').Recording): void {
    this.backgroundTasks += 1;
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
    })().finally(() => { this.backgroundTasks -= 1; });
  }

  private async failRecording(room: Room, recordingId: string, err: ErrorObject, source: string, preservePreview = false): Promise<void> {
    const session = this.active.get(room.id);
    const rec = this.services.recordings.update(recordingId, {
      state: 'failed',
      endedAt: this.services.clock.iso(),
      failureReason: err,
    });
    if (!preservePreview) this.preview?.closeRoom(room.id, 4004, 'stream_lost');
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
    confirmAfterComplete: false,
  };
}

function clearTimeout2(services: Services, handle: unknown): void {
  services.clock.clearTimeout(handle);
}
