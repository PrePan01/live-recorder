import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { openDatabase } from '../../src/db/connection.js';
import { currentSchemaVersion, runMigrations } from '../../src/db/migrations/index.js';
import { RecordingRepository } from '../../src/db/repositories/recording.repo.js';
import { RoomRepository } from '../../src/db/repositories/room.repo.js';
import { FakeMailer } from '../../src/mail/mailer.js';
import { FakePlatformAdapter } from '../../src/platform/fake-adapter.js';
import type { ErrorCode, ErrorObject } from '../../src/types/index.js';
import { AppError, httpStatusFor } from '../../src/types/error.js';

const V12_CODES: ErrorCode[] = [
  'ROOM_LINK_INVALID',
  'ROOM_LINK_DUPLICATE',
  'PLATFORM_ACCESS_RESTRICTED',
  'PLATFORM_CHANGED',
  'DIRECTORY_NOT_WRITABLE',
  'DISK_SPACE_INSUFFICIENT',
  'CONCURRENT_LIMIT_REACHED',
  'RECORDING_START_FAILED',
  'STREAM_DISCONNECTED_RECONNECT_EXHAUSTED',
  'SMTP_SEND_FAILED',
  'SERVICE_UNAVAILABLE',
  'NETWORK_UNAVAILABLE',
  'RECORDING_FILE_CORRUPTED',
  'CONFIG_LOAD_FAILED',
  'STREAM_FORMAT_CHANGED',
  'PREVIEW_LIMIT_REACHED',
  'PREVIEW_NOT_RECORDING',
  'QUALITY_DOWNGRADED',
  'RESOURCE_NOT_FOUND',
];

const HOST = { host: '127.0.0.1:43120' };

function newServices(): Services {
  return buildServices({ dbPath: ':memory:', clock: new FakeClock() });
}

function expectEnvelope(err: ErrorObject): void {
  expect(typeof err.code).toBe('string');
  expect(typeof err.message).toBe('string');
  expect(err.roomId === null || typeof err.roomId === 'string').toBe(true);
  expect(err.recordingId === null || typeof err.recordingId === 'string').toBe(true);
  expect(typeof err.occurredAt).toBe('string');
  expect(typeof err.retryable).toBe('boolean');
}

describe('B-E7 error code catalog (v1.2, 19 codes)', () => {
  it('defines exactly the v1.2 19-code catalog with contract HTTP status', () => {
    expect(V12_CODES).toHaveLength(19);
    for (const code of V12_CODES) {
      const err = new AppError(code, '测试', {}).toObject();
      expect(err.code).toBe(code);
      expect(err.retryable).toBe(false);
      expect(err.roomId).toBeNull();
      expect(err.recordingId).toBeNull();
      expect(err.occurredAt).toBeTruthy();
    }
    expect(httpStatusFor('ROOM_LINK_INVALID')).toBe(422);
    expect(httpStatusFor('ROOM_LINK_DUPLICATE')).toBe(409);
    expect(httpStatusFor('DIRECTORY_NOT_WRITABLE')).toBe(422);
    expect(httpStatusFor('DISK_SPACE_INSUFFICIENT')).toBe(409);
    expect(httpStatusFor('CONCURRENT_LIMIT_REACHED')).toBe(409);
    expect(httpStatusFor('SMTP_SEND_FAILED')).toBe(502);
    expect(httpStatusFor('SERVICE_UNAVAILABLE')).toBe(503);
    expect(httpStatusFor('CONFIG_LOAD_FAILED')).toBe(500);
    expect(httpStatusFor('RESOURCE_NOT_FOUND')).toBe(404);
  });

  it('HTTP-mappable codes return contract status and a valid error envelope', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    let res = await app.inject({ method: 'POST', url: '/api/v1/rooms', headers: HOST, payload: { platform: 'youtube', url: 'x' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('ROOM_LINK_INVALID');
    expectEnvelope(res.json().error);

    await app.inject({ method: 'POST', url: '/api/v1/rooms', headers: HOST, payload: { platform: 'bilibili', url: 'https://live.bilibili.com/7001', displayName: 'A' } });
    res = await app.inject({ method: 'POST', url: '/api/v1/rooms', headers: HOST, payload: { platform: 'bilibili', url: 'https://live.bilibili.com/7001', displayName: 'B' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ROOM_LINK_DUPLICATE');

    res = await app.inject({ method: 'POST', url: '/api/v1/settings/validate-directory', headers: HOST, payload: { directory: '../escape' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('DIRECTORY_NOT_WRITABLE');

    (services.mailer as FakeMailer).failNext = true;
    res = await app.inject({ method: 'POST', url: '/api/v1/settings/test-smtp', headers: HOST });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('SMTP_SEND_FAILED');
    expect(res.json().error.retryable).toBe(true);

    res = await app.inject({ method: 'DELETE', url: '/api/v1/rooms/room_none', headers: HOST });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('RESOURCE_NOT_FOUND');
    expect(res.json().error.details?.resource).toBe('room');

    res = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: 'evil.example.com' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SERVICE_UNAVAILABLE');
    await app.close();
  });

  it('runtime codes surface via room.lastError and alert channels', async () => {
    const clock = new FakeClock();
    const services = buildServices({ dbPath: ':memory:', clock });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-b7-restricted-'));
    const { app } = buildApp(services);
    const put = await app.inject({
      method: 'PUT', url: '/api/v1/settings', headers: HOST,
      payload: {
        recordingDirectory: dir,
        maxConcurrentRecordings: 2,
        checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
        retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
        diskGuard: { minFreeBytes: 0, minFreePercent: 0 },
        mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] },
      },
    });
    expect(put.statusCode).toBe(200);

    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'restricted' }]);
    const created = await app.inject({
      method: 'POST', url: '/api/v1/rooms', headers: HOST,
      payload: { platform: 'bilibili', url: 'https://live.bilibili.com/7002', displayName: 'R' },
    });
    const roomId = created.json().room.id;
    await app.inject({ method: 'POST', url: `/api/v1/rooms/${roomId}/check`, headers: HOST });

    const room = services.rooms.get(roomId)!;
    expect(room.monitorState).toBe('failed');
    expect(room.lastError?.code).toBe('PLATFORM_ACCESS_RESTRICTED');
    expect(room.lastError?.retryable).toBe(false);
    expect(services.alerts.list().some((a) => a.message.includes('PLATFORM_ACCESS_RESTRICTED'))).toBe(true);
    await app.close();
  });
});

describe('B-E7 409 race', () => {
  it('concurrent duplicate creation yields exactly one 201 and one 409 with the real roomId', async () => {
    const { app } = buildApp(newServices());
    const payload = { platform: 'bilibili', url: 'https://live.bilibili.com/8001', displayName: 'R' };
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/rooms', headers: HOST, payload }),
      app.inject({ method: 'POST', url: '/api/v1/rooms', headers: HOST, payload }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const ok = a.statusCode === 201 ? a : b;
    const conflict = a.statusCode === 409 ? a : b;
    expect(conflict.json().error.code).toBe('ROOM_LINK_DUPLICATE');
    expect(conflict.json().error.roomId).toBe(ok.json().room.id);
    expect(conflict.json().error.retryable).toBe(false);
    await app.close();
  });
});

describe('B-E7 migration upgrade', () => {
  it('reopens an on-disk DB, applies nothing new and preserves data', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'lr-mig-')), 'live-recorder.db');
    let db = openDatabase(file);
    expect(runMigrations(db)).toBe(1);
    const room = new RoomRepository(db).create({ platform: 'bilibili', url: 'https://live.bilibili.com/9000', displayName: '旧数据' });
    const rec = new RecordingRepository(db).create({ roomId: room.id, platform: 'bilibili', streamSessionId: 'sx', streamTitle: '旧录制' });
    expect(currentSchemaVersion(db)).toBe(1);
    db.close();

    db = openDatabase(file);
    expect(currentSchemaVersion(db)).toBe(1);
    expect(runMigrations(db)).toBe(0);
    expect(currentSchemaVersion(db)).toBe(1);
    const rooms = new RoomRepository(db);
    expect(rooms.list()).toHaveLength(1);
    expect(rooms.get(room.id)?.displayName).toBe('旧数据');
    expect(new RecordingRepository(db).get(rec.id)?.streamTitle).toBe('旧录制');
    db.close();
  });
});