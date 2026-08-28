import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../types/error.js';
import type { AppSettings, ErrorObject, Room } from '../types/index.js';
import { recordingFilePath } from '../storage/file-organizer.js';
import type { RecordingEvent } from '../recorder/engine.js';
import type { Notifier } from './notifier.js';
import type { Services } from './services.js';

export interface PreviewSink {
  canAccept(): boolean;
  broadcastFrame(roomId: string, chunk: Buffer): void;
  closeRoom(roomId: string, code: number, reason?: 'ended' | 'stream_lost'): void;
}

interface ActiveSession {
  recordingId: string;
  roomId: string;
  streamSessionId: string | null;
  stopRequested: boolean;
  size: number;
  startedAt: string;
}

export class RecorderManager {
  private active = new Map<string, ActiveSession>();
  preview: PreviewSink | null = null;

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

  /** 调度器发现直播后调用：并发上限、去重、磁盘保护，然后启动录制。manual=手动触发，跳过同场去重以便停止后重录。 */
  async maybeStartRecording(room: Room, status: { streamSessionId?: string; streamTitle?: string }, opts: { manual?: boolean } = {}): Promise<void> {
    if (this.active.has(room.id)) return;
    const settings = this.settings();
    const sessionId = status.streamSessionId ?? null;
    if (!opts.manual && sessionId && this.services.recordings.hasSession(room.id, sessionId)) {
      // 同一场直播已录制过，保持去重但不能遗留“检测中”，否则 UI 会误判预览状态。
      this.services.rooms.setState(room.id, 'idle', { lastCheckedAt: this.services.clock.iso(), lastError: null });
      this.services.events.emit({ type: 'room:updated', data: this.services.rooms.get(room.id)! });
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
    const filePath = recordingFilePath(settings.recordingDirectory, room.platform, room.displayName || room.id, this.services.clock.iso());
    const recording = this.services.recordings.create({
      roomId: room.id,
      platform: room.platform,
      streamSessionId: sessionId,
      streamTitle: status.streamTitle ?? room.displayName,
      quality: stream.actualQuality,
    });
    this.services.rooms.setState(room.id, 'recording', { lastCheckedAt: this.services.clock.iso(), lastError: null });
    const session: ActiveSession = { recordingId: recording.id, roomId: room.id, streamSessionId: sessionId, stopRequested: false, size: 0, startedAt: recording.startedAt };
    this.active.set(room.id, session);
    this.services.events.emit({ type: 'room:updated', data: this.enrichRoom(this.services.rooms.get(room.id)!) });
    this.services.events.emit({ type: 'recording:updated', data: recording });

    void this.runSession(room, recording.id, stream, filePath, session, 0);
  }

  private async runSession(room: Room, recordingId: string, stream: { url: string; format: 'flv' | 'hls'; headers?: Record<string, string> }, filePath: string, session: ActiveSession, attempt: number): Promise<void> {
    const settings = this.settings();
    const engine = this.services.engineFor();
    this.services.rooms.setState(room.id, 'recording');

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
            await this.completeRecording(room, recordingId, event.fileSize, 'ended');
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
      const nextPath = recordingFilePath(settings.recordingDirectory, room.platform, room.displayName || room.id, this.services.clock.iso());
      this.services.recordings.update(recordingId, { state: 'completed', endedAt: this.services.clock.iso(), fileSizeBytes: this.active.get(room.id)?.size ?? 0 });
      this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(recordingId)! });
      const next = this.services.recordings.create({ roomId: room.id, platform: room.platform, streamSessionId: recording.streamSessionId, streamTitle: recording.streamTitle, quality: stream.actualQuality });
      const session = this.active.get(room.id);
      if (session) session.recordingId = next.id;
      void this.runSession(room, next.id, stream, nextPath, session ?? { recordingId: next.id, roomId: room.id, streamSessionId: recording.streamSessionId, stopRequested: false, size: 0, startedAt: recording.startedAt }, attempt + 1);
    } catch {
      this.preview?.closeRoom(room.id, 4004, 'stream_lost');
      await this.failRecording(room, recordingId, error, 'recorder');
    }
  }

  async stopRecording(roomId: string): Promise<void> {
    const session = this.active.get(roomId);
    if (!session) return;
    session.stopRequested = true;
    await this.services.engineFor().stop();
  }

  private async completeRecording(room: Room, recordingId: string, size: number, endReason: 'ended' | 'stream_lost'): Promise<void> {
    const rec = this.services.recordings.update(recordingId, {
      state: 'completed',
      endedAt: this.services.clock.iso(),
      fileSizeBytes: size,
    });
    this.preview?.closeRoom(room.id, 1000, endReason);
    this.active.delete(room.id);
    this.services.rooms.setState(room.id, 'completed', { lastCheckedAt: this.services.clock.iso(), lastError: null });
    this.services.events.emit({ type: 'recording:updated', data: rec });
    this.services.events.emit({ type: 'room:updated', data: this.services.rooms.get(room.id)! });
  }

  private async failRecording(room: Room, recordingId: string, err: ErrorObject, source: string): Promise<void> {
    const rec = this.services.recordings.update(recordingId, {
      state: 'failed',
      endedAt: this.services.clock.iso(),
      failureReason: err,
    });
    this.preview?.closeRoom(room.id, 4004, 'stream_lost');
    this.active.delete(room.id);
    this.services.rooms.setState(room.id, 'failed', { lastCheckedAt: this.services.clock.iso(), lastError: err });
    this.services.events.emit({ type: 'recording:updated', data: rec });
    this.services.events.emit({ type: 'room:updated', data: this.services.rooms.get(room.id)! });
    this.raiseAlert('error', source, err);
    await this.notifier.notify('recording_failed', room.id, { title: room.displayName });
  }

  private raiseAlert(level: 'info' | 'warning' | 'error', source: string, err: AppError | ErrorObject): void {
    const alert = this.services.alerts.create({ level, source, message: `${err.code}: ${err.message}`, occurredAt: this.services.clock.iso() });
    this.services.events.emit({ type: 'alert:created', data: alert });
  }
}

function defaultsLite(): AppSettings {
  return {
    recordingDirectory: '',
    maxConcurrentRecordings: 2,
    quality: 'original',
    checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
    retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
    diskGuard: { minFreeBytes: 20 * 1024 ** 3, minFreePercent: 10 },
    mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] },
    dedupeWindowMinutes: 30,
  };
}

function clearTimeout2(services: Services, handle: unknown): void {
  services.clock.clearTimeout(handle);
}
