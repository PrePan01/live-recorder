import type { PlatformAdapter, Quality } from '../platform/adapter.js';
import type { RecordingEngine } from '../recorder/engine.js';
import type { DiskGuard } from '../storage/disk-guard.js';
import type { Mailer } from '../mail/mailer.js';
import type { SecretStore } from '../security/secret-store.js';
import type { Clock } from './clock.js';
import { SystemClock } from './clock.js';
import { AppEventBus } from './events.js';
import { MemorySecretStore } from '../security/memory-store.js';
import { KeytarSecretStore } from '../security/keychain-store.js';
import { MAIL_PASSWORD_KEY, DOUYIN_COOKIE_KEY } from '../security/keys.js';
import { FakePlatformAdapter } from '../platform/fake-adapter.js';
import { BilibiliAdapter } from '../platform/bilibili.js';
import { DouyinAdapter } from '../platform/douyin.js';
import { FakeRecordingEngine } from '../recorder/fake-engine.js';
import { StreamRecordingEngine } from '../recorder/stream-recorder.js';
import { FakeDiskGuard } from '../storage/disk-guard.js';
import { FakeMailer } from '../mail/mailer.js';
import { SmtpMailer } from '../mail/smtp-mailer.js';
import { openDatabase, type DB } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { RoomRepository } from '../db/repositories/room.repo.js';
import { RecordingRepository } from '../db/repositories/recording.repo.js';
import { SettingsRepository } from '../db/repositories/settings.repo.js';
import { AlertRepository } from '../db/repositories/alert.repo.js';
import { TagRepository } from '../db/repositories/tag.repo.js';
import { DiagnosticRepository } from '../db/repositories/diagnostic.repo.js';
import { ScheduleRepository } from '../db/repositories/schedule.repo.js';
import os from 'node:os';
import path from 'node:path';
import { Notifier } from './notifier.js';
import { RecorderManager } from './recorder-manager.js';
import { Scheduler } from './scheduler.js';
import { PipelineManager } from './pipeline-manager.js';
import { UploadManager } from './upload-manager.js';
import { ExportManager } from './export-manager.js';

export type AdapterMode = 'fake' | 'real';

export interface Services {
  mode: AdapterMode;
  startedAt: number;
  events: AppEventBus;
  clock: Clock;
  db: DB;
  rooms: RoomRepository;
  recordings: RecordingRepository;
  settings: SettingsRepository;
  alerts: AlertRepository;
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
  scheduler: Scheduler;
  pipeline: PipelineManager;
  uploader: UploadManager;
  exporter: ExportManager;
  adapterFor(platform: 'bilibili' | 'douyin'): PlatformAdapter;
  engineFor(): RecordingEngine;
  /** 平台会话凭证（v1.3：抖音 Cookie），非该平台返回 undefined。 */
  platformCookie(platform: 'bilibili' | 'douyin'): Promise<string | undefined>;
}

export interface BuildOptions {
  mode?: AdapterMode;
  dbPath?: string;
  clock?: Clock;
}

export function defaultDataDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'live-recorder');
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? home, 'live-recorder');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'live-recorder');
}

/**
 * 依赖装配。阶段 B 全部 fake；阶段 C 的 real 模式在此接入真实适配器、
 * 引擎、keytar SecretStore 与 nodemailer Mailer。
 */
export function buildServices(opts: BuildOptions = {}): Services {
  const mode: AdapterMode = opts.mode ?? (process.env.RECORDING_ADAPTER === 'real' ? 'real' : 'fake');
  const dbPath = opts.dbPath ?? process.env.LIVE_RECORDER_DB ?? path.join(defaultDataDir(), 'live-recorder.db');
  const db = openDatabase(dbPath);
  runMigrations(db);
  const clock = opts.clock ?? new SystemClock();
  const fakeAdapter = new FakePlatformAdapter();
  const fakeEngine = new FakeRecordingEngine(clock);

  const adapters = mode === 'real'
    ? { bilibili: new BilibiliAdapter() as PlatformAdapter, douyin: new DouyinAdapter() as PlatformAdapter }
    : { bilibili: fakeAdapter, douyin: fakeAdapter };

  const useKeychain = mode === 'real';
  const secretStore: SecretStore = useKeychain ? new KeytarSecretStore() : new MemorySecretStore();

  const tags = new TagRepository(db);

  const services: Services = {
    mode,
    startedAt: clock.now(),
    events: new AppEventBus(),
    clock,
    db,
    tags,
    rooms: new RoomRepository(db, tags),
    recordings: new RecordingRepository(db),
    settings: new SettingsRepository(db),
    alerts: new AlertRepository(db),
    diagnostics: new DiagnosticRepository(db),
    schedules: new ScheduleRepository(db),
    statsCache: undefined,
    secretStore,
    diskGuard: new FakeDiskGuard(),
    mailer: undefined as unknown as Mailer,
    adapterFor: (platform) => adapters[platform],
    engineFor: () => (mode === 'real' ? new StreamRecordingEngine() : fakeEngine),
    platformCookie: async (platform) => (platform === 'douyin' ? (await secretStore.get(DOUYIN_COOKIE_KEY)) ?? undefined : undefined),
    notifier: undefined as unknown as Notifier,
    manager: undefined as unknown as RecorderManager,
    scheduler: undefined as unknown as Scheduler,
    pipeline: undefined as unknown as PipelineManager,
    uploader: undefined as unknown as UploadManager,
    exporter: undefined as unknown as ExportManager,
  };
  services.mailer = useKeychain
    ? new SmtpMailer(() => services.secretStore.get(MAIL_PASSWORD_KEY))
    : new FakeMailer(() => clock.iso());
  services.notifier = new Notifier(
    services.mailer,
    clock,
    services.alerts,
    () => services.settings.load()?.mail ?? null,
    () => (services.settings.load()?.dedupeWindowMinutes ?? 30) * 60 * 1000,
  );
  services.manager = new RecorderManager(services, services.notifier);
  services.scheduler = new Scheduler(services, services.manager);
  services.pipeline = new PipelineManager(services);
  services.uploader = new UploadManager(services);
  services.exporter = new ExportManager(services);
  return services;
}

export type { Quality };
