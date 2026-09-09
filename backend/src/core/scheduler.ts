import type { Platform, Room } from '../types/index.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import { AppError } from '../types/error.js';
import type { RecorderManager } from './recorder-manager.js';
import type { Services } from './services.js';
import { dueSchedules } from '../api/routes/schedules.js';

const PLATFORMS: Platform[] = ['bilibili', 'douyin'];
const PLATFORM_CHECK_CONCURRENCY = 2;

export class Scheduler {
  private running = false;
  private handles = new Map<Platform, unknown>();
  private dueByPlatform = new Map<Platform, string[]>();
  /** 同一房间的手动与后台检测共用一次上游请求，避免页面切换/连点造成重复探测。 */
  private checking = new Map<string, Promise<void>>();

  constructor(private services: Services, private manager: RecorderManager) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    // 启动后先完成一轮检测，再开始按平台间隔轮询；恢复服务无需额外等待一个周期。
    for (const platform of PLATFORMS) {
      void this.runPlatform(platform)
        .catch((error: unknown) => { console.error(`scheduler ${platform} check failed`, error); })
        .finally(() => this.scheduleNext(platform));
    }
  }

  get isRunning(): boolean { return this.running; }
  get isChecking(): boolean { return this.checking.size > 0; }

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
      void this.runPlatform(platform)
        .catch((error: unknown) => { console.error(`scheduler ${platform} check failed`, error); })
        .finally(() => this.scheduleNext(platform));
    }, ms);
    this.handles.set(platform, handle);
  }

  private async runPlatform(platform: Platform): Promise<void> {
    // #125：先触发到期定时录制计划（跨天/重启恢复由 nextRunAt 持久化保证，离线不建空录制）。
    const now = this.services.clock.now();
    const scheduledRooms = this.dueScheduleChecks(now, platform)
      .map((roomId) => this.services.rooms.get(roomId))
      .filter((room): room is Room => room !== null && !this.manager.isRoomActive(room.id));
    // Due schedules run before ordinary polling, but both retain per-room
    // de-duplication in checkRoom and a bounded per-platform concurrency.
    await this.runChecks(scheduledRooms, { scheduled: true });
    const rooms = this.services.rooms.listEnabled().filter((r) => r.platform === platform);
    await this.runChecks(rooms.filter((room) => !this.manager.isRoomActive(room.id)));
  }

  private async runChecks(rooms: Room[], opts: { scheduled?: boolean } = {}): Promise<void> {
    let cursor = 0;
    const worker = async () => {
      while (this.running) {
        const room = rooms[cursor++];
        if (!room) return;
        await this.checkRoom(room, opts).catch(() => undefined);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PLATFORM_CHECK_CONCURRENCY, rooms.length) }, worker));
  }

  /** 到期计划清单 + 推进 nextRunAt（幂等：重复调用同 now 不会重复触发）。 */
  private dueScheduleChecks(nowMs: number, platform: Platform): string[] {
    // Every platform timer may enter this method at a slightly different
    // millisecond.  Do not key a shared claim to that timestamp: doing so can
    // replace the other platform's already-claimed queue before it consumes
    // it.  Claim all due schedules atomically through dueSchedules, append
    // them to their platform queues, then consume only this platform's queue.
    // dueSchedules advances nextRunAt, so a later scan cannot duplicate a
    // successfully claimed item.
    for (const { roomId } of dueSchedules(this.services, nowMs)) {
      const room = this.services.rooms.get(roomId);
      if (!room) continue;
      const list = this.dueByPlatform.get(room.platform) ?? [];
      if (!list.includes(roomId)) list.push(roomId);
      this.dueByPlatform.set(room.platform, list);
    }
    const result = this.dueByPlatform.get(platform) ?? [];
    this.dueByPlatform.delete(platform);
    return result;
  }

  async checkRoom(room: Room, opts: { manual?: boolean; scheduled?: boolean; nameOnly?: boolean } = {}): Promise<void> {
    if (this.services.resetting) return;
    const pending = this.checking.get(room.id);
    if (pending) return pending;

    const task = this.runCheckRoom(room, opts).finally(() => this.checking.delete(room.id));
    this.checking.set(room.id, task);
    return task;
  }

  private emitRoom(roomId: string): void {
    const room = this.services.rooms.get(roomId);
    if (!room) return;
    this.services.events.emit({ type: 'room:updated', data: this.manager.enrichRoom(room) });
  }

  private async runCheckRoom(room: Room, opts: { manual?: boolean; scheduled?: boolean; nameOnly?: boolean } = {}): Promise<void> {
    const adapter = this.services.adapterFor(room.platform);
    this.services.rooms.setState(room.id, 'checking', { lastCheckedAt: this.services.clock.iso() });
    this.emitRoom(room.id);
    try {
      await this.runCheckRoomInner(room, adapter, opts);
    } catch (err) {
      // 容错：任何意外异常（平台接口变动、DB 缺列等）都不能让房间卡死在 checking——
      // 一律落到 failed + lastError 并补告警，等待下一轮检测恢复。
      const appErr = err instanceof AppError
        ? err
        : new AppError('CHECK_FAILED', `检测异常: ${(err as Error).message ?? String(err)}`, { roomId: room.id, retryable: true });
      this.services.rooms.setState(room.id, 'failed', { lastCheckedAt: this.services.clock.iso(), lastError: appErr.toObject() });
      this.emitRoom(room.id);
      const alert = this.services.alerts.create({ level: 'error', source: 'platform', message: `${appErr.code}: ${appErr.message}`, occurredAt: this.services.clock.iso(), roomId: room.id, errorCode: appErr.code });
      this.services.events.emit({ type: 'alert:created', data: alert });
    }
  }

  private async runCheckRoomInner(room: Room, adapter: PlatformAdapter, opts: { manual?: boolean; scheduled?: boolean; nameOnly?: boolean } = {}): Promise<void> {
    const cookie = await this.services.platformCookie(room.platform);
    const status = await adapter.checkLiveStatus(room.url, cookie);
    // 适配器已从平台响应提取主播昵称；检测成功后持久化并通过 SSE 推送，
    // 让首次只填写链接的房间在刷新后也能保留自动识别的显示名。
    const detectedName = status.displayName?.trim();
    // 仅填补空名称，保留用户手动设置的自定义名称。
    const checkedRoom = detectedName && !room.displayName.trim()
      ? this.services.rooms.update(room.id, { displayName: detectedName })
      : room;
    if (checkedRoom !== room) this.emitRoom(room.id);
    // #128 抖音标题回退加固：记录标题来源/回退标记，SSE 供前端展示回退/占位状态。
    if (status.titleSource) {
      this.services.rooms.setTitleInfo(room.id, { titleSource: status.titleSource, titleFallbackUsed: status.titleFallbackUsed ?? false });
    }
    // #78：记录最近一次检测的直播状态（live/offline/restricted），供监控开播标识。
    if (status.status === 'live' || status.status === 'offline' || status.status === 'restricted') {
      this.services.rooms.setLiveStatus(room.id, status.status);
    }
    if (status.status === 'live') {
      // #162 添加房间仅解析显示名（nameOnly）：识别名称后置 idle，不触发录制（录制仍由正常调度周期按 autoRecord 决定）。
      if (opts.nameOnly) {
        this.services.rooms.setState(room.id, 'idle', { lastCheckedAt: this.services.clock.iso(), lastError: null });
        this.emitRoom(room.id);
        return;
      }
      // 统一语义（#75/#76/#77，QA 定口径）：有效 autoRecord = room.autoRecord ?? settings.autoRecord（默认 true），
      // 统一决定调度器与手动 /check——false 时任何检测（含手动）都不自动开始录制（仅检测更新状态）；
      // true 时检测即自动开始。
      const globalAuto = this.services.settings.load()?.autoRecord ?? true;
      const effectiveAuto = checkedRoom.autoRecord ?? globalAuto;
      if (!effectiveAuto) {
        this.services.rooms.setState(room.id, 'idle', { lastCheckedAt: this.services.clock.iso(), lastError: null });
        this.emitRoom(room.id);
        return;
      }
      try {
        await this.manager.maybeStartRecording({ ...checkedRoom, monitorState: 'checking' }, status, opts);
      } catch (err) {
        const appErr = err instanceof AppError ? err : new AppError('RECORDING_START_FAILED', `启动录制失败: ${(err as Error).message}`, { roomId: room.id, retryable: true });
        this.services.rooms.setState(room.id, 'failed', { lastCheckedAt: this.services.clock.iso(), lastError: appErr.toObject() });
        this.emitRoom(room.id);
        const alert = this.services.alerts.create({ level: 'error', source: 'recorder', message: `${appErr.code}: ${appErr.message}`, occurredAt: this.services.clock.iso(), roomId: room.id, errorCode: appErr.code });
        this.services.events.emit({ type: 'alert:created', data: alert });
      }
      return;
    }
    if (status.status === 'offline') {
      // 下播主动停录：若该房间仍在录制，等待记录完整收口并保留 completed；
      // 只有原本未录制的房间才回到 idle。
      const wasRecording = this.manager.isRoomActive(room.id);
      if (wasRecording) {
        await this.manager.stopRecording(room.id);
      }
      this.services.rooms.setState(room.id, wasRecording ? 'completed' : 'idle', { lastCheckedAt: this.services.clock.iso(), lastError: null });
      this.emitRoom(room.id);
      return;
    }
    const err = status.error ?? new AppError(
      status.status === 'restricted' ? 'PLATFORM_ACCESS_RESTRICTED' : 'NETWORK_UNAVAILABLE',
      status.status === 'restricted' ? '平台访问受限，请检查 Cookie 配置' : '平台请求失败',
      { roomId: room.id, retryable: status.status !== 'restricted' },
    ).toObject();
    this.services.rooms.setState(room.id, 'failed', { lastCheckedAt: this.services.clock.iso(), lastError: err });
    this.emitRoom(room.id);
    const alert = this.services.alerts.create({
      level: status.status === 'restricted' ? 'warning' : 'error',
      source: 'platform',
      message: `${err.code}: ${err.message}`,
      occurredAt: this.services.clock.iso(),
      roomId: room.id,
      errorCode: err.code,
    });
    this.services.events.emit({ type: 'alert:created', data: alert });
  }

  async triggerImmediateCheck(roomId: string, opts: { nameOnly?: boolean } = {}): Promise<void> {
    const room = this.services.rooms.get(roomId);
    if (!room) return;
    await this.checkRoom(room, { manual: true, ...opts }).catch(() => undefined);
  }
}
