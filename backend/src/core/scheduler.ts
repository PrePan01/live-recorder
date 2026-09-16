import { DEFAULT_NOTIFICATION_PREFERENCE, type Platform, type Room } from '../types/index.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import { AppError } from '../types/error.js';
import type { RecorderManager } from './recorder-manager.js';
import type { Services } from './services.js';
import { dueSchedules } from '../api/routes/schedules.js';
import { calculateLivePrediction, coversPredictionWindow, openingEvidenceInWindow } from './live-prediction.js';

const PLATFORMS: Platform[] = ['bilibili', 'douyin'];
const PLATFORM_CHECK_CONCURRENCY = 2;

export class Scheduler {
  private running = false;
  private handles = new Map<Platform, unknown>();
  private dueByPlatform = new Map<Platform, string[]>();
  /** 同一房间的手动与后台检测共用一次上游请求，避免页面切换/连点造成重复探测。 */
  private checking = new Map<string, Promise<void>>();
  /** 已收到抖音明确的凭证失效信号；保存新 Cookie 后才恢复请求。 */
  private douyinCookieExpired = false;
  private predictionsFinalizedAt = 0;
  private forecastDate: string | null = null;
  private forecastRecordedFor = new Set<string>();
  private forecastRetry = new Map<string, { at: number; latestEventId: string | null }>();

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
    if (platform === 'douyin' && this.douyinCookieExpired) return;
    await this.finalizePastPredictions();
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
    const isDouyinQueue = rooms[0]?.platform === 'douyin';
    const worker = async () => {
      while (this.running && (!isDouyinQueue || !this.douyinCookieExpired)) {
        const room = rooms[cursor++];
        if (!room) return;
        await this.checkRoom(room, opts).catch(() => undefined);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PLATFORM_CHECK_CONCURRENCY, rooms.length) }, worker));
  }

  /** 新 Cookie 已落盘，允许后续抖音检测重新发起请求。 */
  resetDouyinCookieFailure(): void {
    this.douyinCookieExpired = false;
  }

  /** 等待已在途的检测完成，供凭证更新后避免复用仍携带旧 Cookie 的请求。 */
  async waitForRoomCheck(roomId: string): Promise<void> {
    await this.checking.get(roomId);
  }

  /**
   * Cookie 更新后的全量复检在后台执行：设置保存不能被平台请求阻塞，
   * 同时会等待携带旧 Cookie 的在途检测收口后再发起新请求。
   */
  async recheckDouyinRoomsAfterCookieUpdate(): Promise<void> {
    const rooms = this.services.rooms.list().filter((room) => room.platform === 'douyin');
    await Promise.all(rooms.map((room) => this.waitForRoomCheck(room.id)));
    this.resetDouyinCookieFailure();
    await Promise.all(rooms.map((room) => this.triggerImmediateCheck(room.id)));
  }

  private markDouyinCookieExpired(): void {
    if (this.douyinCookieExpired) return;
    this.douyinCookieExpired = true;
    const now = this.services.clock.iso();
    for (const room of this.services.rooms.list().filter((item) => item.platform === 'douyin')) {
      const error = new AppError('DOUYIN_COOKIE_EXPIRED', '抖音授权已失效，请到设置页重新授权', {
        roomId: room.id,
        retryable: false,
      }).toObject();
      // 正在录制的房间保留录制状态；lastError 足以让卡片显示 Cookie 已失效。
      if (this.manager.isRoomActive(room.id)) this.services.rooms.setLastError(room.id, error);
      else this.services.rooms.setState(room.id, 'failed', { lastCheckedAt: now, lastError: error });
      this.emitRoom(room.id);
    }
    const alert = this.services.alerts.create({
      level: 'warning',
      source: 'platform',
      message: 'DOUYIN_COOKIE_EXPIRED: 抖音授权已失效，请到设置页重新授权',
      occurredAt: now,
      errorCode: 'DOUYIN_COOKIE_EXPIRED',
    });
    this.services.events.emit({ type: 'alert:created', data: alert });
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
    if (room.platform === 'douyin' && this.douyinCookieExpired) return;
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
    // 同一轮最多有两个并发检测；若另一个房间已确认 Cookie 失效，
    // 不让这个已在途请求的结果覆盖全局失效标记。
    if (room.platform === 'douyin' && this.douyinCookieExpired) return;
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
      this.services.rooms.setCurrentStreamTitle(
        room.id,
        status.status === 'live' ? status.streamTitle ?? null : null,
      );
    }
    if (status.status === 'live' || status.status === 'offline') {
      this.recordCoverage(room.id);
      if (status.status === 'offline') this.recordTodayForecast(room.id);
    }
    if (status.status === 'live') {
      // A confirmed offline→live transition has a narrow polling interval. First
      // discovery while already live is still useful, but is stored as a lower-
      // confidence interval instead of claiming the check time is the start time.
      if (room.lastLiveStatus !== 'live' && status.platformStartedAt) {
        this.services.liveEvents.record(room.id, this.services.clock.iso(), {
          source: 'platform', lowerBoundAt: room.lastLiveStatus === 'offline' ? room.lastCheckedAt : null, platformStartedAt: status.platformStartedAt,
        });
      } else if (room.lastLiveStatus === 'offline') {
        this.services.liveEvents.record(room.id, this.services.clock.iso(), {
          source: 'transition', lowerBoundAt: room.lastCheckedAt,
        });
      } else if (room.lastLiveStatus === null) {
        this.services.liveEvents.record(room.id, this.services.clock.iso(), {
          source: 'initial_live', lowerBoundAt: room.lastCheckedAt ?? room.createdAt,
        });
      }
      const shouldNotifyLiveStarted = room.lastLiveStatus === 'offline'
        && checkedRoom.enabled
        && checkedRoom.liveNotificationEnabled;
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
        if (shouldNotifyLiveStarted) {
          await this.services.notifier.notify('live_started', room.id, { title: checkedRoom.displayName });
        }
        return;
      }
      try {
        const started = await this.manager.maybeStartRecording({ ...checkedRoom, monitorState: 'checking' }, status, opts);
        if (shouldNotifyLiveStarted) {
          await this.services.notifier.notify('live_started', room.id, { title: checkedRoom.displayName, autoRecordingStarted: started });
        }
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
      status.status === 'restricted'
        ? room.platform === 'douyin'
          ? '平台访问受限，请检查抖音授权'
          : '平台访问受限，请检查 Cookie 配置'
        : '平台请求失败',
      { roomId: room.id, retryable: status.status !== 'restricted' },
    ).toObject();
    if (room.platform === 'douyin' && err.code === 'DOUYIN_COOKIE_EXPIRED') {
      this.markDouyinCookieExpired();
      return;
    }
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

  private recordCoverage(roomId: string): void {
    const now = this.services.clock.now();
    const room = this.services.rooms.get(roomId);
    const gap = Math.min(10 * 60_000, Math.max(180_000, this.intervalFor(room?.platform ?? 'bilibili') * 2_000 + 30_000));
    this.services.predictionCalibration.recordCoverage(roomId, localDate(now), this.services.clock.iso(), gap);
  }

  private recordTodayForecast(roomId: string): void {
    const now = this.services.clock.now();
    const today = localDate(now);
    if (this.forecastDate !== today) { this.forecastRecordedFor.clear(); this.forecastRetry.clear(); this.forecastDate = today; }
    const latestEventId = this.services.liveEvents.latestId(roomId);
    const retry = this.forecastRetry.get(roomId);
    if (retry && now < retry.at && retry.latestEventId === latestEventId) return;
    this.forecastRetry.set(roomId, { at: now + 5 * 60_000, latestEventId });
    const from = new Date(now - 60 * 24 * 60 * 60 * 1_000).toISOString();
    const events = this.services.liveEvents.list(roomId, from);
    if (events.length < 2) return;
    const prediction = calculateLivePrediction({
      roomId, events, now, generatedAt: this.services.clock.iso(),
      calibration: this.services.predictionCalibration.profiles([roomId], localDate(now - 60 * 24 * 60 * 60 * 1_000)).get(roomId),
      coverage: this.services.predictionCalibration.intervals([roomId], from).get(roomId),
    });
    // Retry at the current window's end even when the normal throttle has not
    // elapsed, so the next session can be considered without stale dates.
    const end = prediction.windowEndTimestamp ? Date.parse(prediction.windowEndTimestamp) : NaN;
    if (Number.isFinite(end) && end >= now) {
      this.forecastRetry.set(roomId, { at: Math.min(now + 5 * 60_000, end + 1), latestEventId });
    }
    if (prediction.kind !== 'next' || !prediction.rawLikelihood || !prediction.likelihood || !prediction.windowStartTimestamp || !prediction.windowEndTimestamp) return;
    const start = Date.parse(prediction.windowStartTimestamp);
    if (localDate(start) !== today || start <= now) return;
    const key = `${roomId}:${today}:${prediction.windowStartTimestamp}`;
    if (this.forecastRecordedFor.has(key)) return;
    this.services.predictionCalibration.recordForecast({ roomId, targetDate: today, probability: prediction.likelihood, rawProbability: prediction.rawLikelihood,
      windowStartAt: prediction.windowStartTimestamp, windowEndAt: prediction.windowEndTimestamp, generatedAt: this.services.clock.iso() });
    // INSERT OR IGNORE can mean another run already persisted this room/day/window.
    // Either way a concrete forecast exists before the in-memory key is set.
    this.forecastRecordedFor.add(key);
  }

  private async finalizePastPredictions(): Promise<void> {
    const now = this.services.clock.now();
    const today = localDate(now);
    if (now - this.predictionsFinalizedAt < 60_000) return;
    this.predictionsFinalizedAt = now;
    for (const forecast of this.services.predictionCalibration.pendingBefore(today)) {
      if (!forecast.windowStartAt || !forecast.windowEndAt || !forecast.rawProbability) {
        this.services.predictionCalibration.resolve(forecast.id, 'unknown', this.services.clock.iso()); continue;
      }
      const start = Date.parse(forecast.windowStartAt), end = Date.parse(forecast.windowEndAt);
      // Allow the next check to discover an opening near the window's end.
      if (end + 10 * 60_000 > now) continue;
      const events = this.services.liveEvents.listBetween(forecast.roomId, forecast.windowStartAt, new Date(end + 10 * 60_000).toISOString());
      const evidence = events.map(event => openingEvidenceInWindow(event,start,end));
      const opened = evidence.includes('hit');
      const coverage = this.services.predictionCalibration.intervals([forecast.roomId], forecast.windowStartAt).get(forecast.roomId) ?? [];
      const ambiguous = evidence.includes('unknown');
      const outcome = opened ? 'hit' : !ambiguous && coversPredictionWindow(coverage, start, end) ? 'miss' : 'unknown';
      this.services.predictionCalibration.resolve(forecast.id, outcome, this.services.clock.iso());
    }
  }

  /** 开启自动录制后使用最新配置检测；已有录制无需探测，避免改变其状态或停录。 */
  async triggerAutoRecordCheck(roomId: string): Promise<void> {
    if (this.manager.isRoomActive(roomId)) return;
    // 正在进行的检测可能使用旧配置，或仅用于解析名称；完成后重新判断。
    await this.checking.get(roomId);
    const room = this.services.rooms.get(roomId);
    if (!room || this.manager.isRoomActive(roomId)) return;
    if (!(room.autoRecord ?? this.services.settings.load()?.autoRecord ?? true)) return;
    await this.checkRoom(room, { manual: true });
  }

  async triggerImmediateCheck(roomId: string, opts: { nameOnly?: boolean } = {}): Promise<void> {
    const room = this.services.rooms.get(roomId);
    if (!room) return;
    if (room.platform === 'douyin' && this.douyinCookieExpired) return;
    await this.checkRoom(room, { manual: true, ...opts }).catch(() => undefined);
  }
}

function localDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
