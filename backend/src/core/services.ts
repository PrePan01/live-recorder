import { QmsgQueue } from '../notifications/qmsg.js';
import { QMSG_KEY } from '../security/keys.js';
import { YoutubeAdapter } from "../platform/youtube.js";
import { YoutubeRecordingEngine } from "../recorder/youtube-recorder.js";
import { YOUTUBE_COOKIE_KEY } from "../security/keys.js";
import { saveXiaohongshuSource } from '../platform/xiaohongshu-source-store.js';
import type { PlatformAdapter, Quality } from "../platform/adapter.js";
import { VerificationQueue } from "./verification-queue.js";
import { XiaohongshuNativeBroker } from "../platform/xiaohongshu-native.js";
import { XiaohongshuAdapter } from "../platform/xiaohongshu.js";
import { DanmakuManager } from "../danmaku/manager.js";
import { QualityHealthService } from "./quality-health.js";
import { ClipQueueManager } from "./clip-queue.js";
import { ClipQueueRepo } from "../db/repositories/clip-queue.repo.js";
import type { RecordingEngine } from "../recorder/engine.js";
import type { DiskGuard } from "../storage/disk-guard.js";
import type { Mailer } from "../mail/mailer.js";
import type { SecretStore } from "../security/secret-store.js";
import type { Clock } from "./clock.js";
import { SystemClock } from "./clock.js";
import { AppEventBus } from "./events.js";
import { MemorySecretStore } from "../security/memory-store.js";
import { KeytarSecretStore } from "../security/keychain-store.js";
import {
  MAIL_PASSWORD_KEY,
  DOUYIN_COOKIE_KEY,
  BILIBILI_COOKIE_KEY,
  XIAOHONGSHU_COOKIE_KEY,
} from "../security/keys.js";
import { FakePlatformAdapter } from "../platform/fake-adapter.js";
import { BilibiliAdapter } from "../platform/bilibili.js";
import { DouyinAdapter } from "../platform/douyin.js";
import { FakeRecordingEngine } from "../recorder/fake-engine.js";
import { StreamRecordingEngine } from "../recorder/stream-recorder.js";
import { FakeDiskGuard } from "../storage/disk-guard.js";
import { FakeMailer } from "../mail/mailer.js";
import { SmtpMailer } from "../mail/smtp-mailer.js";
import { openDatabase, type DB } from "../db/connection.js";
import {
  ensureCriticalColumns,
  runMigrations,
} from "../db/migrations/index.js";
import { RoomRepository } from "../db/repositories/room.repo.js";
import { RecordingRepository } from "../db/repositories/recording.repo.js";
import { RecordingMarkerRepository } from "../db/repositories/recording-marker.repo.js";
import { SettingsRepository } from "../db/repositories/settings.repo.js";
import { AlertRepository } from "../db/repositories/alert.repo.js";
import { TagRepository } from "../db/repositories/tag.repo.js";
import { DiagnosticRepository } from "../db/repositories/diagnostic.repo.js";
import { ScheduleRepository } from "../db/repositories/schedule.repo.js";
import { LiveEventRepository } from "../db/repositories/live-event.repo.js";
import { PredictionCalibrationRepository } from "../db/repositories/prediction-calibration.repo.js";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { Notifier } from "./notifier.js";
import { RecorderManager } from "./recorder-manager.js";
import { Scheduler } from "./scheduler.js";
import { PipelineManager } from "./pipeline-manager.js";
import { UploadManager } from "./upload-manager.js";
import { ExportManager } from "./export-manager.js";
import { SeekService } from "./seek-service.js";
import { notificationPreference } from "../api/routes/notifications.js";

export type AdapterMode = "fake" | "real";

export interface Services {
  qmsg: QmsgQueue;
  resetting?: boolean;
  xhsNative: XiaohongshuNativeBroker;
  mode: AdapterMode;
  startedAt: number;
  events: AppEventBus;
  clock: Clock;
  db: DB;
  rooms: RoomRepository;
  recordings: RecordingRepository;
  recordingMarkers: RecordingMarkerRepository;
  liveEvents: LiveEventRepository;
  predictionCalibration: PredictionCalibrationRepository;
  settings: SettingsRepository;
  alerts: AlertRepository;
  verificationQueue: import("./verification-queue.js").VerificationQueue;
  tags: TagRepository;
  diagnostics: DiagnosticRepository;
  schedules: ScheduleRepository;
  /** V5 统计短缓存（服务端聚合，TTL 5s，键=查询参数）。 */
  statsCache: { key: string; cachedAt: number; body: unknown } | undefined;
  secretStore: SecretStore;
  diskGuard: DiskGuard;
  mailer: Mailer;
  notifier: Notifier;
  manager: RecorderManager;
  danmaku: DanmakuManager;
  quality: QualityHealthService;
  clipQueue: ClipQueueRepo;
  clipQueueManager: ClipQueueManager;
  scheduler: Scheduler;
  pipeline: PipelineManager;
  uploader: UploadManager;
  exporter: ExportManager;
  /** 跳播服务（正在录的这条：索引状态/预热/起流）。 */
  seek: SeekService;
  adapterFor(platform: "bilibili" | "douyin" | "xiaohongshu" | "youtube"): PlatformAdapter;
  engineFor(platform?: "bilibili" | "douyin" | "xiaohongshu" | "youtube"): RecordingEngine;
  recordingBufferDirectory: string;
  /** 平台会话凭证（v1.3：抖音 Cookie；B站 Cookie），非该平台返回 undefined。 */
  platformCookie(platform: "bilibili" | "douyin" | "xiaohongshu" | "youtube"): Promise<string | undefined>;
}

export interface BuildOptions {
  mode?: AdapterMode;
  dbPath?: string;
  clock?: Clock;
}

export function productionDataDir(): string {
  const home = os.homedir();
  if (process.platform === "darwin")
    return path.join(home, "Library", "Application Support", "live-recorder");
  if (process.platform === "win32")
    return path.join(process.env.APPDATA || home, "live-recorder");
  return path.join(
    process.env.XDG_DATA_HOME || path.join(home, ".local", "share"),
    "live-recorder",
  );
}

/** #224 P0 深度防御：开发环境（mode=development）下数据/状态路径不得指向生产数据目录，否则启动即拒。 */
export function assertDevelopmentPathIsIsolated(
  target: string,
  label: string,
  mode: "development" | "production",
): void {
  if (mode === "production") return;
  const targetAbs = path.resolve(target);
  const prodAbs = path.resolve(productionDataDir());
  if (targetAbs === prodAbs || targetAbs.startsWith(prodAbs + path.sep)) {
    throw new Error(
      `${label}指向生产数据目录：${target}（开发环境必须使用独立数据目录）`,
    );
  }
}

export function defaultDataDir(): string {
  // 显式隔离覆盖（开发环境与本地安装客户端数据隔离，PrePan #219）：优先使用 LIVE_RECORDER_DATA_DIR，
  // 否则退回系统默认应用数据目录。dev 覆盖不得指向生产目录（#224 P0 防呆）。
  const override = process.env.LIVE_RECORDER_DATA_DIR;
  if (override && override.length > 0) {
    assertDevelopmentPathIsIsolated(
      override,
      "开发环境数据目录",
      "development",
    );
    return override;
  }
  return productionDataDir();
}

/**
 * 依赖装配。阶段 B 全部 fake；阶段 C 的 real 模式在此接入真实适配器、
 * 引擎、keytar SecretStore 与 nodemailer Mailer。
 */
export function buildServices(opts: BuildOptions = {}): Services {
  const mode: AdapterMode =
    opts.mode ?? (process.env.RECORDING_ADAPTER === "real" ? "real" : "fake");
  const dbPath =
    opts.dbPath ??
    process.env.LIVE_RECORDER_DB ??
    path.join(defaultDataDir(), "live-recorder.db");
  const db = openDatabase(dbPath);
  try {
    runMigrations(db);
    ensureCriticalColumns(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const clock = opts.clock ?? new SystemClock();
  const fakeEngine = new FakeRecordingEngine(clock);

  const xhsNative = new XiaohongshuNativeBroker();
  const adapters =
    mode === "real"
      ? {
          youtube: new YoutubeAdapter(undefined, {
            load: url => (db.prepare('SELECT channel_url FROM youtube_sources WHERE input_url = ?').get(url) as { channel_url: string } | undefined)?.channel_url,
            save: (url, channel) => { db.prepare('INSERT INTO youtube_sources (input_url,channel_url) VALUES (?,?) ON CONFLICT(input_url) DO UPDATE SET channel_url=excluded.channel_url').run(url, channel); },
          }) as PlatformAdapter,
          bilibili: new BilibiliAdapter() as PlatformAdapter,
          douyin: new DouyinAdapter() as PlatformAdapter,
          xiaohongshu: new XiaohongshuAdapter(fetch, {
            load: profile => (db.prepare('SELECT room_url FROM xiaohongshu_sources WHERE profile_url = ?').get(profile) as { room_url: string } | undefined)?.room_url,
            save: (profile, url) => saveXiaohongshuSource(db, profile, url),
            profileForRoom: url => (db.prepare('SELECT profile_url FROM xiaohongshu_sources WHERE room_url = ?').get(url) as { profile_url: string } | undefined)?.profile_url,
            loadProfile: profile => (db.prepare('SELECT profile_request_url FROM xiaohongshu_sources WHERE profile_url = ?').get(profile) as { profile_request_url?: string } | undefined)?.profile_request_url,
            saveProfile: (profile, url) => { db.prepare('INSERT INTO xiaohongshu_sources (profile_url, room_url, profile_request_url) VALUES (?, ?, ?) ON CONFLICT(profile_url) DO UPDATE SET profile_request_url=excluded.profile_request_url').run(profile, '', url); },
          }, (url, signal, cookie) => {
            const session = /(?:^|;\s*)web_session=([^;\s]+)/.exec(cookie ?? '')?.[1];
            return xhsNative.request(url, signal, session ? createHash('sha256').update(session).digest('hex') : undefined);
          }) as PlatformAdapter,
        }
      : {
          youtube: new FakePlatformAdapter("youtube") as PlatformAdapter,
          bilibili: new FakePlatformAdapter("bilibili") as PlatformAdapter,
          douyin: new FakePlatformAdapter("douyin") as PlatformAdapter,
          xiaohongshu: new FakePlatformAdapter("xiaohongshu") as PlatformAdapter,
        };

  const useKeychain = mode === "real";
  const secretStore: SecretStore = useKeychain
    ? new KeytarSecretStore()
    : new MemorySecretStore();

  const tags = new TagRepository(db);

  const services: Services = {
    mode,
    qmsg: undefined as unknown as QmsgQueue,
    xhsNative,
    startedAt: clock.now(),
    events: new AppEventBus(),
    clock,
    db,
    tags,
    rooms: new RoomRepository(db, tags),
    recordings: new RecordingRepository(db),
    recordingMarkers: new RecordingMarkerRepository(db),
    liveEvents: new LiveEventRepository(db),
    predictionCalibration: new PredictionCalibrationRepository(db),
    settings: new SettingsRepository(db),
    alerts: new AlertRepository(db),
    verificationQueue:
      undefined as unknown as import("./verification-queue.js").VerificationQueue,
    diagnostics: new DiagnosticRepository(db),
    schedules: new ScheduleRepository(db),
    statsCache: undefined,
    secretStore,
    diskGuard: new FakeDiskGuard(),
    mailer: undefined as unknown as Mailer,
    adapterFor: (platform) => adapters[platform],
    recordingBufferDirectory:
      mode === "real"
        ? path.join(
            process.platform === "darwin"
              ? path.join(os.homedir(), "Library", "Caches")
              : process.platform === "win32"
                ? process.env.LOCALAPPDATA || os.tmpdir()
                : path.join(os.homedir(), ".cache"),
            "live-recorder",
            "recording-buffer",
            createHash("sha256")
              .update(path.resolve(dbPath))
              .digest("hex")
              .slice(0, 16),
          )
        : path.join(
            dbPath === ":memory:"
              ? os.tmpdir()
              : path.dirname(path.resolve(dbPath)),
            "recording-buffer",
          ),
    engineFor: (platform) =>
      mode === "real"
        ? platform === "youtube" ? new YoutubeRecordingEngine({ directory: services.recordingBufferDirectory }, services.settings.load()?.encodingMode ?? "auto") : new StreamRecordingEngine(fetch, undefined, {
            directory: services.recordingBufferDirectory,
          })
        : fakeEngine,
    platformCookie: async (platform) => {
      if (platform === "youtube") return (await secretStore.get(YOUTUBE_COOKIE_KEY)) ?? undefined;
      if (platform === "douyin")
        return (await secretStore.get(DOUYIN_COOKIE_KEY)) ?? undefined;
      // B站未登录时服务端只提供 720p 及以下档位，登录 Cookie（SESSDATA）是获取蓝光/原画的唯一途径。
      if (platform === "bilibili")
        return (await secretStore.get(BILIBILI_COOKIE_KEY)) ?? undefined;
      if (platform === "xiaohongshu") return (await secretStore.get(XIAOHONGSHU_COOKIE_KEY)) ?? undefined;
      return undefined;
    },
    notifier: undefined as unknown as Notifier,
    manager: undefined as unknown as RecorderManager,
    danmaku: undefined as unknown as DanmakuManager,
    quality: undefined as unknown as QualityHealthService,
    clipQueue: undefined as unknown as ClipQueueRepo,
    clipQueueManager: undefined as unknown as ClipQueueManager,
    scheduler: undefined as unknown as Scheduler,
    pipeline: undefined as unknown as PipelineManager,
    uploader: undefined as unknown as UploadManager,
    exporter: undefined as unknown as ExportManager,
    seek: undefined as unknown as SeekService,
  };
  services.mailer = useKeychain
    ? new SmtpMailer(() => services.secretStore.get(MAIL_PASSWORD_KEY))
    : new FakeMailer(() => clock.iso());
  services.qmsg = new QmsgQueue(clock, () => secretStore.get(QMSG_KEY), mode === 'real' ? undefined : async () => {}, () => {
    const alert = services.alerts.createOrRefresh({ level: 'warning', source: 'qmsg', message: 'QQ 推送队列已满', occurredAt: clock.iso(), retryable: false });
    services.events.emit({ type: 'alert:created', data: alert });
  });
  services.notifier = new Notifier(
    services.mailer,
    clock,
    services.alerts,
    () => services.settings.load()?.mail ?? null,
    () => notificationPreference(services),
    services.events,
    () => notificationPreference(services).dedupeWindowMinutes * 60 * 1000,
    services.qmsg,
    () => services.settings.load()?.qmsg?.enabled ?? false,
    roomId => { const room = services.rooms.get(roomId); return Boolean(room?.enabled && room.liveNotificationEnabled); },
  );
  services.manager = new RecorderManager(services, services.notifier);
  services.danmaku = new DanmakuManager(services);
  services.quality = new QualityHealthService(services);
  services.clipQueue = new ClipQueueRepo(services.db, clock);
  services.clipQueueManager = new ClipQueueManager(services);
  services.scheduler = new Scheduler(services, services.manager);
  services.pipeline = new PipelineManager(services);
  services.uploader = new UploadManager(services);
  services.exporter = new ExportManager(services);
  services.seek = new SeekService(services);
  services.verificationQueue = new VerificationQueue(services);
  services.clipQueueManager.reconcileOnBoot();
  return services;
}

export type { Quality };
