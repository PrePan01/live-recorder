import type { PlatformAdapter, Quality } from '../platform/adapter.js';
import type { RecordingEngine } from '../recorder/engine.js';
import type { DiskGuard } from '../storage/disk-guard.js';
import type { Mailer } from '../mail/mailer.js';
import type { SecretStore } from '../security/secret-store.js';
import type { Clock } from './clock.js';
import { SystemClock } from './clock.js';
import { AppEventBus } from './events.js';
import { MemorySecretStore } from '../security/memory-store.js';
import { FakePlatformAdapter } from '../platform/fake-adapter.js';
import { FakeRecordingEngine } from '../recorder/fake-engine.js';
import { FakeDiskGuard } from '../storage/disk-guard.js';
import { FakeMailer } from '../mail/mailer.js';
import { openDatabase, type DB } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { RoomRepository } from '../db/repositories/room.repo.js';
import { RecordingRepository } from '../db/repositories/recording.repo.js';
import { SettingsRepository } from '../db/repositories/settings.repo.js';
import { AlertRepository } from '../db/repositories/alert.repo.js';
import os from 'node:os';
import path from 'node:path';
import { Notifier } from './notifier.js';
import { RecorderManager } from './recorder-manager.js';
import { Scheduler } from './scheduler.js';

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
  secretStore: SecretStore;
  diskGuard: DiskGuard;
  mailer: Mailer;
  notifier: Notifier;
  manager: RecorderManager;
  scheduler: Scheduler;
  adapterFor(platform: 'bilibili' | 'douyin'): PlatformAdapter;
  engineFor(): RecordingEngine;
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

  if (mode === 'real') {
    // 阶段 C 接入（C-C1~C-C4）。阶段 B 明确未实现，避免误用。
    throw new Error('real adapter mode is not implemented until stage C');
  }

  const services: Services = {
    mode,
    startedAt: clock.now(),
    events: new AppEventBus(),
    clock,
    db,
    rooms: new RoomRepository(db),
    recordings: new RecordingRepository(db),
    settings: new SettingsRepository(db),
    alerts: new AlertRepository(db),
    secretStore: new MemorySecretStore(),
    diskGuard: new FakeDiskGuard(),
    mailer: new FakeMailer(() => clock.iso()),
    adapterFor: () => fakeAdapter,
    engineFor: () => fakeEngine,
    notifier: undefined as unknown as Notifier,
    manager: undefined as unknown as RecorderManager,
    scheduler: undefined as unknown as Scheduler,
  };
  services.notifier = new Notifier(
    services.mailer,
    clock,
    services.alerts,
    () => services.settings.load()?.mail ?? null,
    () => (services.settings.load()?.dedupeWindowMinutes ?? 30) * 60 * 1000,
  );
  services.manager = new RecorderManager(services, services.notifier);
  services.scheduler = new Scheduler(services, services.manager);
  return services;
}

export type { Quality };
