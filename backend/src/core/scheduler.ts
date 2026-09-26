import { type ErrorObject, type Platform, type Room } from "../types/index.js";
import type { PlatformAdapter } from "../platform/adapter.js";
import { AppError } from "../types/error.js";
import type { RecorderManager } from "./recorder-manager.js";
import type { Services } from "./services.js";
import { dueSchedules } from "../api/routes/schedules.js";
import {
  calculateLivePrediction,
  coversPredictionWindow,
  openingEvidenceInWindow,
  recordingCoverageIntervals,
  type PredictionCoverageInterval,
} from "./live-prediction.js";

const PLATFORMS: Platform[] = ["bilibili", "douyin"];
/**
 * 开播检测平台级上限
 */
const PLATFORM_CHECK_CONCURRENCY: Record<Platform, number> = {
  bilibili: 6,
  douyin: 3,
};

export class Scheduler {
  private running = false;
  private handles = new Map<Platform, unknown>();
  private dueByPlatform = new Map<Platform, string[]>();
  /** 同一房间的手动与后台检测共用一次上游请求，避免页面切换/连点造成重复探测。 */
  private checking = new Map<string, Promise<void>>();
  /** 全量检测任务：页面反复刷新时合并到这一个任务，避免重复排完整队列。 */
  private enabledRoomChecks: Promise<void> | null = null;
  /** 已收到抖音明确的凭证失效信号；保存新 Cookie 后才恢复请求。 */
  private douyinCookieExpired = false;
  private predictionsFinalizedAt = 0;
  private forecastDate: string | null = null;
  private forecastRecordedFor = new Set<string>();
  private forecastRetry = new Map<
    string,
    { at: number; latestEventId: string | null }
  >();

  constructor(
    private services: Services,
    private manager: RecorderManager,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    // 启动后先完成一轮检测，再开始按平台间隔轮询；恢复服务无需额外等待一个周期。
    for (const platform of PLATFORMS) {
      void this.runPlatform(platform)
        .catch((error: unknown) => {
          console.error(`scheduler ${platform} check failed`, error);
        })
        .finally(() => this.scheduleNext(platform));
    }
  }

  get isRunning(): boolean {
    return this.running;
  }
  get isChecking(): boolean {
    return this.checking.size > 0;
  }

  stop(): void {
    this.running = false;
    for (const [platform, handle] of this.handles) {
      this.services.clock.clearTimeout(handle);
      this.handles.delete(platform);
    }
  }

  intervalFor(platform: Platform): number {
    const ci = this.services.settings.load()?.checkIntervalSec ?? {
      default: 60,
      bilibili: 60,
      douyin: 120,
    };
    return ci[platform] ?? ci.default;
  }

  private scheduleNext(platform: Platform): void {
    if (!this.running) return;
    const ms = this.intervalFor(platform) * 1000;
    const handle = this.services.clock.setTimeout(() => {
      void this.runPlatform(platform)
        .catch((error: unknown) => {
          console.error(`scheduler ${platform} check failed`, error);
        })
        .finally(() => this.scheduleNext(platform));
    }, ms);
    this.handles.set(platform, handle);
  }

  private async runPlatform(platform: Platform): Promise<void> {
    if (platform === "douyin" && this.douyinCookieExpired) return;
    await this.finalizePastPredictions();
    // #125：先触发到期定时录制计划（跨天/重启恢复由 nextRunAt 持久化保证，离线不建空录制）。
    const now = this.services.clock.now();
    const scheduledRooms = this.dueScheduleChecks(now, platform)
      .map((roomId) => this.services.rooms.get(roomId))
      .filter(
        (room): room is Room =>
          room !== null && !this.manager.isRoomActive(room.id),
      );
    // Due schedules run before ordinary polling, but both retain per-room
    // de-duplication in checkRoom and a bounded per-platform concurrency.
    await this.runChecks(scheduledRooms, { scheduled: true });
    const rooms = this.services.rooms
      .listEnabled()
      .filter((r) => r.platform === platform);
    await this.runChecks(
      rooms.filter((room) => !this.manager.isRoomActive(room.id)),
    );
  }

  private async runChecks(
    rooms: Room[],
    opts: { scheduled?: boolean; allowWhenStopped?: boolean } = {},
  ): Promise<void> {
    let cursor = 0;
    const isDouyinQueue = rooms[0]?.platform === "douyin";
    const worker = async () => {
      while (
        (this.running || opts.allowWhenStopped) &&
        (!isDouyinQueue || !this.douyinCookieExpired)
      ) {
        const room = rooms[cursor++];
        if (!room) return;
        await this.checkRoom(room, opts).catch(() => undefined);
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            PLATFORM_CHECK_CONCURRENCY[rooms[0]?.platform ?? "bilibili"],
            rooms.length,
          ),
        },
        worker,
      ),
    );
  }

  /**
   * 提交全量开播检测，不等待队列清空。监控页只需快速恢复可交互状态，检测
   * 结果会通过 SSE 推送；若同步等待，房间较多时很容易超过前端请求超时。
   */
  queueEnabledRoomChecks(): { queued: number; alreadyRunning: boolean } {
    if (this.enabledRoomChecks) return { queued: 0, alreadyRunning: true };
    const rooms = this.services.rooms
      .listEnabled()
      .filter((room) => !this.manager.isRoomActive(room.id));
    const task = Promise.all(
      PLATFORMS.map((platform) =>
        this.runChecks(
          rooms.filter((room) => room.platform === platform),
          { allowWhenStopped: true },
        ),
      ),
    ).then(() => undefined);
    this.enabledRoomChecks = task;
    void task
      .catch((error: unknown) => {
        console.error("queued enabled-room checks failed", error);
      })
      .finally(() => {
        if (this.enabledRoomChecks === task) this.enabledRoomChecks = null;
      });
    return { queued: rooms.length, alreadyRunning: false };
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
    const rooms = this.services.rooms
      .list()
      .filter((room) => room.platform === "douyin");
    await Promise.all(rooms.map((room) => this.waitForRoomCheck(room.id)));
    this.resetDouyinCookieFailure();
    await Promise.all(rooms.map((room) => this.triggerImmediateCheck(room.id)));
  }

  /**
   * B站授权更新后的复检：B站 的登录态只影响可选清晰度档位，不会返回凭证失效错误，
   * 因此无需抖音那样的熔断复位，仅等待旧 Cookie 的在途请求收口后重新发起检测。
   */
  async recheckBilibiliRoomsAfterCookieUpdate(): Promise<void> {
    const rooms = this.services.rooms
      .list()
      .filter((room) => room.platform === "bilibili");
    await Promise.all(rooms.map((room) => this.waitForRoomCheck(room.id)));
    await Promise.all(rooms.map((room) => this.triggerImmediateCheck(room.id)));
  }

  private markDouyinCookieExpired(): void {
    if (this.douyinCookieExpired) return;
    this.douyinCookieExpired = true;
    const now = this.services.clock.iso();
    for (const room of this.services.rooms
      .list()
      .filter((item) => item.platform === "douyin")) {
      const error = new AppError(
        "DOUYIN_COOKIE_EXPIRED",
        "抖音授权已失效，请到设置页重新授权",
        {
          roomId: room.id,
          retryable: false,
        },
      ).toObject();
      // 正在录制的房间保留录制状态；lastError 足以让卡片显示 Cookie 已失效。
      if (this.manager.isRoomActive(room.id))
        this.services.rooms.setLastError(room.id, error);
      else
        this.services.rooms.setState(room.id, "failed", {
          lastCheckedAt: now,
          lastError: error,
        });
      this.emitRoom(room.id);
    }
    const alert = this.services.alerts.create({
      level: "warning",
      source: "platform",
      message: "抖音授权已失效，请到设置页重新授权",
      occurredAt: now,
      errorCode: "DOUYIN_COOKIE_EXPIRED",
      retryable: false,
    });
    this.services.events.emit({ type: "alert:created", data: alert });
  }

  /** 到期计划清单 + 推进 nextRunAt（幂等：重复调用同 now 不会重复触发）。 */
  private dueScheduleChecks(nowMs: number, platform: Platform): string[] {
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

  async checkRoom(
    room: Room,
    opts: { manual?: boolean; scheduled?: boolean; nameOnly?: boolean } = {},
  ): Promise<void> {
    if (this.services.resetting) return;
    if (room.platform === "douyin" && this.douyinCookieExpired) return;
    const pending = this.checking.get(room.id);
    if (pending) return pending;

    const task = this.runCheckRoom(room, opts).finally(() =>
      this.checking.delete(room.id),
    );
    this.checking.set(room.id, task);
    return task;
  }

  private emitRoom(roomId: string): void {
    const room = this.services.rooms.get(roomId);
    if (!room) return;
    this.services.events.emit({
      type: "room:updated",
      data: this.manager.enrichRoom(room),
    });
  }

  /** 平台整体暂不可用时收敛为一个平台级事件，避免一个轮询批次按房间数刷屏。 */
  private createCheckAlert(
    room: Room,
    error: ErrorObject,
    level: "warning" | "error",
  ): void {
    const platformWide =
      room.platform === "douyin" && error.code === "NETWORK_UNAVAILABLE";
    const alert = this.services.alerts.createOrRefresh({
      level,
      source: "platform",
      message: platformWide ? `抖音：${error.message}` : error.message,
      occurredAt: this.services.clock.iso(),
      ...(platformWide ? {} : { roomId: room.id }),
      errorCode: error.code,
      retryable: error.retryable ?? null,
    });
    this.services.events.emit({ type: "alert:created", data: alert });
  }

  private resolveRoomAlerts(roomId: string): void {
    for (const alert of this.services.alerts.resolveForRoom(
      roomId,
      "platform",
    )) {
      this.services.events.emit({ type: "alert:updated", data: alert });
    }
  }

  /** 检测失败不能掩盖仍由 RecorderManager 持有的活动录制会话。 */
  private setCheckFailure(roomId: string, error: ErrorObject): void {
    if (this.manager.isRoomActive(roomId)) {
      this.services.rooms.setLastError(roomId, error);
    } else {
      this.services.rooms.setState(roomId, "failed", {
        lastCheckedAt: this.services.clock.iso(),
        lastError: error,
      });
    }
    this.emitRoom(roomId);
  }

  private async runCheckRoom(
    room: Room,
    opts: { manual?: boolean; scheduled?: boolean; nameOnly?: boolean } = {},
  ): Promise<void> {
    const adapter = this.services.adapterFor(room.platform);
    // 手动/全量复检也可能命中正在录制的房间。录制会话仍由 manager 持有，
    // 不能仅为检测而把对外状态降为 checking，否则前端会丢失「停止」入口。
    this.services.rooms.setState(
      room.id,
      this.manager.isRoomActive(room.id) ? "recording" : "checking",
      { lastCheckedAt: this.services.clock.iso() },
    );
    this.emitRoom(room.id);
    try {
      await this.runCheckRoomInner(room, adapter, opts);
    } catch (err) {
      // 容错：任何意外异常（平台接口变动、DB 缺列等）都不能让房间卡死在 checking——
      // 一律落到 failed + lastError 并补告警，等待下一轮检测恢复。
      const appErr =
        err instanceof AppError
          ? err
          : new AppError(
              "CHECK_FAILED",
              `检测异常: ${(err as Error).message ?? String(err)}`,
              { roomId: room.id, retryable: true },
            );
      this.setCheckFailure(room.id, appErr.toObject());
      this.createCheckAlert(room, appErr.toObject(), "error");
    }
  }

  private async runCheckRoomInner(
    room: Room,
    adapter: PlatformAdapter,
    opts: { manual?: boolean; scheduled?: boolean; nameOnly?: boolean } = {},
  ): Promise<void> {
    const cookie = await this.services.platformCookie(room.platform);
    const status = await adapter.checkLiveStatus(room.url, cookie);
    // 同一轮最多有两个并发检测；若另一个房间已确认 Cookie 失效，
    // 不让这个已在途请求的结果覆盖全局失效标记。
    if (room.platform === "douyin" && this.douyinCookieExpired) return;
    // 适配器已从平台响应提取主播昵称/头像；检测成功后持久化并通过 SSE 推送，
    // 让首次只填写链接的房间在刷新后也能保留自动识别的显示名与头像。
    const detectedName = status.displayName?.trim();
    const detectedAvatar = status.avatarUrl?.trim() || null;
    // 名称仅填补空（保留用户自定义）；头像仅平台给出新值时更新，缺失/失败不清空已有值（兼容历史+静默降级）。
    const patch: Partial<Pick<Room, "displayName" | "avatarUrl">> = {};
    if (detectedName && !room.displayName.trim())
      patch.displayName = detectedName;
    if (detectedAvatar && detectedAvatar !== room.avatarUrl)
      patch.avatarUrl = detectedAvatar;
    const checkedRoom =
      Object.keys(patch).length > 0
        ? this.services.rooms.update(room.id, patch)
        : room;
    if (checkedRoom !== room) this.emitRoom(room.id);
    // #128 抖音标题回退加固：记录标题来源/回退标记，SSE 供前端展示回退/占位状态。
    if (status.titleSource) {
      this.services.rooms.setTitleInfo(room.id, {
        titleSource: status.titleSource,
        titleFallbackUsed: status.titleFallbackUsed ?? false,
      });
    }
    // #78：记录最近一次检测的直播状态（live/offline/restricted），供监控开播标识。
    const checkedAt = this.services.clock.iso();
    const isOpening =
      status.status === "live" && room.lastLiveStatus !== "live";
    if (
      status.status === "live" ||
      status.status === "offline" ||
      status.status === "restricted"
    ) {
      this.services.rooms.setLiveStatus(
        room.id,
        status.status,
        isOpening ? checkedAt : undefined,
      );
      this.services.rooms.setCurrentStreamTitle(
        room.id,
        status.status === "live" ? (status.streamTitle ?? null) : null,
      );
      this.services.rooms.setAvailableQualities(
        room.id,
        status.status === "live" ? (status.availableQualities ?? []) : [],
      );
    }
    if (status.status === "live" || status.status === "offline") {
      this.resolveRoomAlerts(room.id);
      this.recordCoverage(room.id);
      if (status.status === "offline") this.recordTodayForecast(room.id);
    }
    if (status.status === "live") {
      if (this.manager.isRoomActive(room.id)) {
        this.services.rooms.setState(room.id, "recording", {
          lastCheckedAt: this.services.clock.iso(),
          lastError: null,
        });
        this.emitRoom(room.id);
        return;
      }
      if (room.lastLiveStatus !== "live" && status.platformStartedAt) {
        this.services.liveEvents.record(room.id, this.services.clock.iso(), {
          source: "platform",
          lowerBoundAt:
            room.lastLiveStatus === "offline" ? room.lastCheckedAt : null,
          platformStartedAt: status.platformStartedAt,
        });
      } else if (room.lastLiveStatus === "offline") {
        this.services.liveEvents.record(room.id, this.services.clock.iso(), {
          source: "transition",
          lowerBoundAt: room.lastCheckedAt,
        });
      } else if (room.lastLiveStatus === null) {
        this.services.liveEvents.record(room.id, this.services.clock.iso(), {
          source: "initial_live",
          lowerBoundAt: room.lastCheckedAt ?? room.createdAt,
        });
      }
      const shouldNotifyLiveStarted =
        room.lastLiveStatus === "offline" &&
        checkedRoom.enabled &&
        checkedRoom.liveNotificationEnabled;
      // #162 添加房间仅解析显示名（nameOnly）：识别名称后置 idle，不触发录制（录制仍由正常调度周期按 autoRecord 决定）。
      if (opts.nameOnly) {
        this.services.rooms.setState(room.id, "idle", {
          lastCheckedAt: this.services.clock.iso(),
          lastError: null,
        });
        this.emitRoom(room.id);
        return;
      }
      const globalAuto = this.services.settings.load()?.autoRecord ?? false;
      const effectiveAuto = checkedRoom.autoRecord ?? globalAuto;
      const autoStoppedThisSession = Boolean(
        checkedRoom.autoRecordStoppedSession,
      );
      if (!effectiveAuto || autoStoppedThisSession) {
        this.services.rooms.setState(room.id, "idle", {
          lastCheckedAt: this.services.clock.iso(),
          lastError: null,
        });
        this.emitRoom(room.id);
        if (shouldNotifyLiveStarted) {
          await this.services.notifier.notify("live_started", room.id, {
            title: checkedRoom.displayName,
          });
        }
        return;
      }
      try {
        const refreshedRoom = this.services.rooms.get(room.id) ?? checkedRoom;
        const started = await this.manager.maybeStartRecording(
          { ...refreshedRoom, monitorState: "checking" },
          status,
          { ...opts, liveStartedAt: refreshedRoom.liveStartedAt },
        );
        if (shouldNotifyLiveStarted) {
          await this.services.notifier.notify("live_started", room.id, {
            title: checkedRoom.displayName,
            autoRecordingStarted: started,
          });
        }
      } catch (err) {
        const appErr =
          err instanceof AppError
            ? err
            : new AppError(
                "RECORDING_START_FAILED",
                `启动录制失败: ${(err as Error).message}`,
                { roomId: room.id, retryable: true },
              );
        this.setCheckFailure(room.id, appErr.toObject());
        const alert = this.services.alerts.createOrRefresh({
          level: "error",
          source: "recorder",
          message: appErr.message,
          occurredAt: this.services.clock.iso(),
          roomId: room.id,
          errorCode: appErr.code,
          retryable: appErr.retryable,
        });
        this.services.events.emit({ type: "alert:created", data: alert });
      }
      return;
    }
    if (status.status === "offline") {
      if (this.manager.isRoomActive(room.id)) return;
      this.services.rooms.setState(room.id, "idle", {
        lastCheckedAt: this.services.clock.iso(),
        lastError: null,
      });
      this.emitRoom(room.id);
      return;
    }
    const err =
      status.error ??
      new AppError(
        status.status === "restricted"
          ? "PLATFORM_ACCESS_RESTRICTED"
          : "NETWORK_UNAVAILABLE",
        status.status === "restricted"
          ? room.platform === "douyin"
            ? "平台访问受限，请检查抖音授权"
            : "平台访问受限，请检查B站授权"
          : "平台请求失败",
        { roomId: room.id, retryable: status.status !== "restricted" },
      ).toObject();
    if (room.platform === "douyin" && err.code === "DOUYIN_COOKIE_EXPIRED") {
      this.markDouyinCookieExpired();
      return;
    }
    this.setCheckFailure(room.id, err);
    this.createCheckAlert(
      room,
      err,
      status.status === "restricted" ? "warning" : "error",
    );
  }

  private recordCoverage(roomId: string): void {
    const now = this.services.clock.now();
    const room = this.services.rooms.get(roomId);
    const gap = Math.min(
      10 * 60_000,
      Math.max(
        180_000,
        this.intervalFor(room?.platform ?? "bilibili") * 2_000 + 30_000,
      ),
    );
    this.services.predictionCalibration.recordCoverage(
      roomId,
      localDate(now),
      this.services.clock.iso(),
      gap,
    );
  }

  private recordTodayForecast(roomId: string): void {
    const now = this.services.clock.now();
    const today = localDate(now);
    if (this.forecastDate !== today) {
      this.forecastRecordedFor.clear();
      this.forecastRetry.clear();
      this.forecastDate = today;
    }
    const latestEventId = this.services.liveEvents.latestId(roomId);
    const retry = this.forecastRetry.get(roomId);
    if (retry && now < retry.at && retry.latestEventId === latestEventId)
      return;
    this.forecastRetry.set(roomId, { at: now + 5 * 60_000, latestEventId });
    const from = new Date(now - 60 * 24 * 60 * 60 * 1_000).toISOString();
    const events = this.services.liveEvents.list(roomId, from);
    if (events.length < 2) return;
    const prediction = calculateLivePrediction({
      roomId,
      events,
      now,
      generatedAt: this.services.clock.iso(),
      calibration: this.services.predictionCalibration
        .profiles([roomId], localDate(now - 60 * 24 * 60 * 60 * 1_000))
        .get(roomId),
      coverage: this.coverageWithRecordings(roomId, from, now),
    });
    // Retry at the current window's end even when the normal throttle has not
    // elapsed, so the next session can be considered without stale dates.
    const end = prediction.windowEndTimestamp
      ? Date.parse(prediction.windowEndTimestamp)
      : NaN;
    if (Number.isFinite(end) && end >= now) {
      this.forecastRetry.set(roomId, {
        at: Math.min(now + 5 * 60_000, end + 1),
        latestEventId,
      });
    }
    if (
      prediction.kind !== "next" ||
      !prediction.rawLikelihood ||
      !prediction.likelihood ||
      !prediction.windowStartTimestamp ||
      !prediction.windowEndTimestamp
    )
      return;
    const start = Date.parse(prediction.windowStartTimestamp);
    if (localDate(start) !== today || start <= now) return;
    const key = `${roomId}:${today}:${prediction.windowStartTimestamp}`;
    if (this.forecastRecordedFor.has(key)) return;
    this.services.predictionCalibration.recordForecast({
      roomId,
      targetDate: today,
      probability: prediction.likelihood,
      rawProbability: prediction.rawLikelihood,
      windowStartAt: prediction.windowStartTimestamp,
      windowEndAt: prediction.windowEndTimestamp,
      generatedAt: this.services.clock.iso(),
    });
    this.forecastRecordedFor.add(key);
  }

  /**
   * 监控覆盖 + 录制区间。录制中主播已经在播，期间不会再有新的开播，
   * 因此录制区间等价于同等强度的覆盖——自动录制会暂停轮询，不补上这一段，
   * 同一场提前开播会因为「有没有开自动录制」得到两种判定。
   */
  private coverageWithRecordings(
    roomId: string,
    from: string,
    now: number,
  ): PredictionCoverageInterval[] {
    const recordings = this.services.db
      .prepare(
        "SELECT started_at AS startedAt, ended_at AS endedAt FROM recordings WHERE room_id = ? AND started_at >= ? ORDER BY started_at",
      )
      .all(roomId, from) as Array<{
      startedAt: string;
      endedAt: string | null;
    }>;
    return [
      ...(this.services.predictionCalibration
        .intervals([roomId], from)
        .get(roomId) ?? []),
      ...recordingCoverageIntervals(recordings, now),
    ];
  }

  private async finalizePastPredictions(): Promise<void> {
    const now = this.services.clock.now();
    const today = localDate(now);
    if (now - this.predictionsFinalizedAt < 60_000) return;
    this.predictionsFinalizedAt = now;
    // 同一批里同房间只查一次录制。
    const coverageCache = new Map<string, PredictionCoverageInterval[]>();
    const coverageFor = (roomId: string): PredictionCoverageInterval[] => {
      const cached = coverageCache.get(roomId);
      if (cached) return cached;
      const from60 = new Date(now - 60 * 24 * 60 * 60 * 1_000).toISOString();
      const merged = this.coverageWithRecordings(roomId, from60, now);
      coverageCache.set(roomId, merged);
      return merged;
    };
    for (const forecast of this.services.predictionCalibration.pendingBefore(
      today,
    )) {
      if (
        !forecast.windowStartAt ||
        !forecast.windowEndAt ||
        !forecast.rawProbability
      ) {
        this.services.predictionCalibration.resolve(
          forecast.id,
          "unknown",
          this.services.clock.iso(),
        );
        continue;
      }
      const start = Date.parse(forecast.windowStartAt),
        end = Date.parse(forecast.windowEndAt);
      // Allow the next check to discover an opening near the window's end.
      if (end + 10 * 60_000 > now) continue;
      const events = this.services.liveEvents.listBetween(
        forecast.roomId,
        forecast.windowStartAt,
        new Date(end + 10 * 60_000).toISOString(),
      );
      const evidence = events.map((event) =>
        openingEvidenceInWindow(event, start, end),
      );
      const opened = evidence.includes("hit");
      const coverage = coverageFor(forecast.roomId);
      const ambiguous = evidence.includes("unknown");
      const outcome = opened
        ? "hit"
        : !ambiguous && coversPredictionWindow(coverage, start, end)
          ? "miss"
          : "unknown";
      this.services.predictionCalibration.resolve(
        forecast.id,
        outcome,
        this.services.clock.iso(),
      );
    }
  }

  /** 开启自动录制后使用最新配置检测；已有录制无需探测，避免改变其状态或停录。 */
  async triggerAutoRecordCheck(roomId: string): Promise<void> {
    if (this.manager.isRoomActive(roomId)) return;
    // 正在进行的检测可能使用旧配置，或仅用于解析名称；完成后重新判断。
    await this.checking.get(roomId);
    const room = this.services.rooms.get(roomId);
    if (!room || this.manager.isRoomActive(roomId)) return;
    if (!(
      room.autoRecord ??
      this.services.settings.load()?.autoRecord ??
      false
    ))
      return;
    await this.checkRoom(room);
  }

  async triggerImmediateCheck(
    roomId: string,
    opts: { nameOnly?: boolean } = {},
  ): Promise<void> {
    const room = this.services.rooms.get(roomId);
    if (!room) return;
    if (room.platform === "douyin" && this.douyinCookieExpired) return;
    await this.checkRoom(room, opts).catch(() => undefined);
  }
}

function localDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
