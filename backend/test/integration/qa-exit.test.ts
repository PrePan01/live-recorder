import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { FakePlatformAdapter } from '../../src/platform/fake-adapter.js';
import { FakeDiskGuard } from '../../src/storage/disk-guard.js';
import type { ErrorObject } from '../../src/types/index.js';

function newServices(): Services {
  return buildServices({ dbPath: ':memory:', clock: new FakeClock() });
}

const HOST = { host: '127.0.0.1:43120' };

async function settle(clock: FakeClock, ms: number): Promise<void> {
  clock.advance(ms);
  await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 10));
}

describe('QA stage-B exit: RESOURCE_NOT_FOUND (v1.2, 7 endpoints)', () => {
  it('PATCH /rooms/:id/enable → 404 RESOURCE_NOT_FOUND', async () => {
    const { app } = buildApp(newServices());
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/rooms/room_none/enable', headers: HOST, payload: { enabled: false } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('RESOURCE_NOT_FOUND');
    expect(res.json().error.details?.resource).toBe('room');
    expect(res.json().error.retryable).toBe(false);
    await app.close();
  });

  it('POST /rooms/:id/check → 404 RESOURCE_NOT_FOUND', async () => {
    const { app } = buildApp(newServices());
    const res = await app.inject({ method: 'POST', url: '/api/v1/rooms/room_none/check', headers: HOST });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('RESOURCE_NOT_FOUND');
    expect(res.json().error.details?.resource).toBe('room');
    await app.close();
  });

  it('POST /rooms/:id/stop-recording → 404 RESOURCE_NOT_FOUND when room missing', async () => {
    const { app } = buildApp(newServices());
    const res = await app.inject({ method: 'POST', url: '/api/v1/rooms/room_none/stop-recording', headers: HOST });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('RESOURCE_NOT_FOUND');
    await app.close();
  });

  it('PATCH /alerts/:id → 404 RESOURCE_NOT_FOUND', async () => {
    const { app } = buildApp(newServices());
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/alerts/alert_none', headers: HOST });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('RESOURCE_NOT_FOUND');
    expect(res.json().error.details?.resource).toBe('alert');
    await app.close();
  });

  it('error envelope carries all six required fields and no password leak', async () => {
    const { app } = buildApp(newServices());
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/rooms/room_none', headers: HOST });
    const err = res.json().error as ErrorObject;
    expect(err.code).toBe('RESOURCE_NOT_FOUND');
    expect(typeof err.message).toBe('string');
    expect(err.roomId).toBe('room_none');
    expect(err.recordingId).toBeNull();
    expect(typeof err.occurredAt).toBe('string');
    expect(err.retryable).toBe(false);
    expect(JSON.stringify(res.json())).not.toMatch(/password|cookie|authorization/i);
    await app.close();
  });
});

describe('QA stage-B exit: security', () => {
  it('validate-directory rejects relative and traversal paths', async () => {
    const { app } = buildApp(newServices());
    for (const dir of ['../escape', 'relative/path', 'foo/../../bar']) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/settings/validate-directory', headers: HOST, payload: { directory: dir } });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('DIRECTORY_NOT_WRITABLE');
    }
    await app.close();
  });

  it('rejects non-local host and foreign origin', async () => {
    const { app } = buildApp(newServices());
    const badHost = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: 'evil.example.com' } });
    expect(badHost.statusCode).toBe(403);
    const badOrigin = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { ...HOST, origin: 'http://evil.example.com' } });
    expect(badOrigin.statusCode).toBe(403);
    const allowed = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { ...HOST, origin: 'http://127.0.0.1:43120' } });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it('open rejects non-table recording ids (no arbitrary path)', async () => {
    const { app } = buildApp(newServices());
    const res = await app.inject({ method: 'POST', url: '/api/v1/recordings/rec_none/open', headers: HOST });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('RESOURCE_NOT_FOUND');
    await app.close();
  });

  it('v1.3: douyin cookie is write-only via PUT and never echoed', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-qa-cookie-'));
    const base = {
      recordingDirectory: dir,
      maxConcurrentRecordings: 2,
      checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
      retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
      diskGuard: { minFreeBytes: 0, minFreePercent: 0 },
      mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] },
    };

    const before = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: HOST });
    expect(before.json().settings.douyinCookie.hasCookie).toBe(false);
    expect(JSON.stringify(before.json())).not.toContain('sessionid');

    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings', headers: HOST, payload: { ...base, douyinCookie: 'sessionid=abc123' } });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.douyinCookie.hasCookie).toBe(true);
    expect(JSON.stringify(put.json())).not.toContain('sessionid=abc123');

    const after = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: HOST });
    expect(after.json().settings.douyinCookie.hasCookie).toBe(true);
    expect(JSON.stringify(after.json())).not.toContain('sessionid');

    const clear = await app.inject({ method: 'PUT', url: '/api/v1/settings', headers: HOST, payload: { ...base, douyinCookie: '' } });
    expect(clear.json().settings.douyinCookie.hasCookie).toBe(false);
    await app.close();
  });

  it('v1.3: no/expired cookie on restricted douyin room maps to PLATFORM_ACCESS_RESTRICTED + warning alert', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-qa-cookie-rest-'));
    (services.adapterFor('douyin') as FakePlatformAdapter).setScript([
      { status: 'restricted', error: { code: 'PLATFORM_ACCESS_RESTRICTED', message: '平台访问受限，请检查 Cookie 配置', roomId: null, recordingId: null, occurredAt: services.clock.iso(), retryable: false } },
    ]);
    await app.inject({
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
    const created = await app.inject({
      method: 'POST', url: '/api/v1/rooms', headers: HOST,
      payload: { platform: 'douyin', url: 'https://live.douyin.com/9003', displayName: 'Cookie受限' },
    });
    const roomId = created.json().room.id;

    await app.inject({ method: 'POST', url: `/api/v1/rooms/${roomId}/check`, headers: HOST });
    const room = services.rooms.get(roomId)!;
    expect(room.monitorState).toBe('failed');
    expect(room.lastError?.code).toBe('PLATFORM_ACCESS_RESTRICTED');
    expect(room.lastError?.retryable).toBe(false);
    const alert = services.alerts.list().find((a) => a.message.includes('PLATFORM_ACCESS_RESTRICTED'));
    expect(alert).toBeDefined();
    expect(alert!.level).toBe('warning');
    await app.close();
  });
});

describe('QA stage-B exit: fake full-stack happy path', () => {
  it('add room → immediate check → live → recording file created → completes', async () => {
    const clock = new FakeClock();
    const services = buildServices({ dbPath: ':memory:', clock });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-qa-exit-'));
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

    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([
      { status: 'live', streamSessionId: 'sess_qa1', streamTitle: 'QA 冒烟' },
    ]);

    const created = await app.inject({
      method: 'POST', url: '/api/v1/rooms', headers: HOST,
      payload: { platform: 'bilibili', url: 'https://live.bilibili.com/9001', displayName: 'QA 主播' },
    });
    expect(created.statusCode).toBe(201);
    const roomId = created.json().room.id;

    const check = await app.inject({ method: 'POST', url: `/api/v1/rooms/${roomId}/check`, headers: HOST });
    expect(check.statusCode).toBe(200);
    expect(check.json().ok).toBe(true);

    const rec = services.recordings.list({ roomId }).items[0]!;
    expect(rec.streamSessionId).toBe('sess_qa1');
    expect(rec.filePath).toBeNull();

    for (let i = 0; i < 10 && services.recordings.get(rec.id)!.state !== 'recording'; i += 1) {
      await settle(clock, 500);
    }
    expect(services.recordings.get(rec.id)!.state).toBe('recording');
    expect(services.recordings.get(rec.id)!.filePath).toMatch(new RegExp(`^${dir}/bilibili/`));

    for (let i = 0; i < 12 && services.recordings.get(rec.id)!.state !== 'completed'; i += 1) {
      await settle(clock, 500);
    }
    expect(services.recordings.get(rec.id)!.state).toBe('completed');
    expect(services.recordings.get(rec.id)!.fileSizeBytes).toBeGreaterThan(13);
    expect(services.rooms.get(roomId)!.monitorState).toBe('completed');

    const list = await app.inject({ method: 'GET', url: `/api/v1/recordings?roomId=${roomId}`, headers: HOST });
    expect(list.json().items[0].state).toBe('completed');
    expect(list.json().items[0].filePath).not.toBeNull();
    await app.close();
  });

  it('disk space low blocks new recording with DISK_SPACE_INSUFFICIENT and alert', async () => {
    const clock = new FakeClock();
    const services = buildServices({ dbPath: ':memory:', clock });
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-qa-guard-'));
    const { app } = buildApp(services);
    (services.diskGuard as FakeDiskGuard).setSpace({ freeBytes: 512, totalBytes: 100 * 1024 ** 3 });

    await app.inject({
      method: 'PUT', url: '/api/v1/settings', headers: HOST,
      payload: {
        recordingDirectory: dir,
        maxConcurrentRecordings: 2,
        checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
        retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
        diskGuard: { minFreeBytes: 20 * 1024 ** 3, minFreePercent: 10 },
        mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] },
      },
    });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'live', streamSessionId: 'sess_qa2' }]);
    const created = await app.inject({
      method: 'POST', url: '/api/v1/rooms', headers: HOST,
      payload: { platform: 'bilibili', url: 'https://live.bilibili.com/9002', displayName: 'L' },
    });
    const roomId = created.json().room.id;

    await app.inject({ method: 'POST', url: `/api/v1/rooms/${roomId}/check`, headers: HOST });
    const room = services.rooms.get(roomId)!;
    expect(room.monitorState).toBe('idle');
    expect(room.lastError?.code).toBe('DISK_SPACE_INSUFFICIENT');
    expect(services.recordings.list({ roomId }).items).toHaveLength(0);
    expect(services.alerts.list().some((a) => a.message.includes('DISK_SPACE_INSUFFICIENT'))).toBe(true);
    await app.close();
  });
});