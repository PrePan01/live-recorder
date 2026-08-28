import type { Platform, Room } from '../types/index.js';
import { AppError } from '../types/error.js';
import type { RecorderManager } from './recorder-manager.js';
import type { Services } from './services.js';

const PLATFORMS: Platform[] = ['bilibili', 'douyin'];

export class Scheduler {
  private running = false;
  private handles = new Map<Platform, unknown>();

  constructor(private services: Services, private manager: RecorderManager) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const platform of PLATFORMS) this.scheduleNext(platform);
  }

  stop(): void {
    this.running = false;
    for (const [platform, handle] of this.handles) {
      this.services.clock.clearTimeout(handle);
      this.handles.delete(platform);
    }
  }

  intervalFor(platform: Platform): number {
    const ci = this.services.settings.load()?.checkIntervalSec ?? { default: 60, bilibili: 60, douyin: 120 };
    return ci[platform] ?? ci.default;
  }

  private scheduleNext(platform: Platform): void {
    if (!this.running) return;
    const ms = this.intervalFor(platform) * 1000;
    const handle = this.services.clock.setTimeout(() => {
      void this.runPlatform(platform).finally(() => this.scheduleNext(platform));
    }, ms);
    this.handles.set(platform, handle);
  }

  private async runPlatform(platform: Platform): Promise<void> {
    const rooms = this.services.rooms.listEnabled().filter((r) => r.platform === platform);
    for (const room of rooms) {
      if (!this.running) return;
      if (this.manager.isRoomActive(room.id)) continue;
      await this.checkRoom(room).catch(() => undefined);
    }
  }

  async checkRoom(room: Room): Promise<void> {
    const adapter = this.services.adapterFor(room.platform);
    this.services.rooms.setState(room.id, 'checking', { lastCheckedAt: this.services.clock.iso() });
    const cookie = await this.services.platformCookie(room.platform);
    const status = await adapter.checkLiveStatus(room.url, cookie);
    if (status.status === 'live') {
      try {
        await this.manager.maybeStartRecording({ ...room, monitorState: 'checking' }, status);
      } catch (err) {
        const appErr = err instanceof AppError ? err : new AppError('RECORDING_START_FAILED', `启动录制失败: ${(err as Error).message}`, { roomId: room.id, retryable: true });
        this.services.rooms.setState(room.id, 'failed', { lastCheckedAt: this.services.clock.iso(), lastError: appErr.toObject() });
        this.services.events.emit({ type: 'room:updated', data: this.services.rooms.get(room.id)! });
        const alert = this.services.alerts.create({ level: 'error', source: 'recorder', message: `${appErr.code}: ${appErr.message}`, occurredAt: this.services.clock.iso() });
        this.services.events.emit({ type: 'alert:created', data: alert });
      }
      return;
    }
    if (status.status === 'offline') {
      this.services.rooms.setState(room.id, 'idle', { lastCheckedAt: this.services.clock.iso(), lastError: null });
      this.services.events.emit({ type: 'room:updated', data: this.services.rooms.get(room.id)! });
      return;
    }
    const err = status.error ?? new AppError(
      status.status === 'restricted' ? 'PLATFORM_ACCESS_RESTRICTED' : 'NETWORK_UNAVAILABLE',
      status.status === 'restricted' ? '平台访问受限，请检查 Cookie 配置' : '平台请求失败',
      { roomId: room.id, retryable: status.status !== 'restricted' },
    ).toObject();
    this.services.rooms.setState(room.id, 'failed', { lastCheckedAt: this.services.clock.iso(), lastError: err });
    this.services.events.emit({ type: 'room:updated', data: this.services.rooms.get(room.id)! });
    const alert = this.services.alerts.create({
      level: status.status === 'restricted' ? 'warning' : 'error',
      source: 'platform',
      message: `${err.code}: ${err.message}`,
      occurredAt: this.services.clock.iso(),
    });
    this.services.events.emit({ type: 'alert:created', data: alert });
  }

  async triggerImmediateCheck(roomId: string): Promise<void> {
    const room = this.services.rooms.get(roomId);
    if (!room) return;
    await this.checkRoom(room).catch(() => undefined);
  }
}
