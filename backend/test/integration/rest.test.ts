import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';

function newServices(): Services {
  return buildServices({ dbPath: ':memory:', clock: new FakeClock() });
}

describe('REST contract v1.1 (fake stack)', () => {
  it('health + service status', async () => {
    const app = buildApp(newServices());
    const res = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: '127.0.0.1:43120' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().serviceStatus.state).toBe('running');
    expect(res.json().serviceStatus.setupCompleted).toBe(false);

    const status = await app.inject({ method: 'GET', url: '/api/v1/service/status', headers: { host: '127.0.0.1:43120' } });
    expect(status.json().serviceStatus.setupCompleted).toBe(false);
    await app.close();
  });

  it('rejects non-local host and unknown origin, allows dev origin when configured', async () => {
    const app = buildApp(newServices(), { extraOrigins: ['http://localhost:5173'] });
    const badHost = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: 'evil.example.com' } });
    expect(badHost.statusCode).toBe(403);
    const badOrigin = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: '127.0.0.1:43120', origin: 'http://evil.example.com' } });
    expect(badOrigin.statusCode).toBe(403);
    const devOrigin = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: '127.0.0.1:43120', origin: 'http://localhost:5173' } });
    expect(devOrigin.statusCode).toBe(200);
    await app.close();
  });

  it('rooms CRUD with 409/422 and enable toggle', async () => {
    const services = newServices();
    const app = buildApp(services);
    const created = await app.inject({
      method: 'POST', url: '/api/v1/rooms', headers: { host: '127.0.0.1:43120' },
      payload: { platform: 'bilibili', url: 'https://live.bilibili.com/123?spm=x', displayName: '主播' },
    });
    expect(created.statusCode).toBe(201);
    const room = created.json().room;
    expect(room.url).toBe('https://live.bilibili.com/123');

    const dup = await app.inject({
      method: 'POST', url: '/api/v1/rooms', headers: { host: '127.0.0.1:43120' },
      payload: { platform: 'bilibili', url: 'https://live.bilibili.com/123#t', displayName: 'dup' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('ROOM_LINK_DUPLICATE');
    expect(dup.json().error.retryable).toBe(false);

    const invalid = await app.inject({
      method: 'POST', url: '/api/v1/rooms', headers: { host: '127.0.0.1:43120' },
      payload: { platform: 'youtube', url: 'https://yt.live/1' },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.code).toBe('ROOM_LINK_INVALID');

    const list = await app.inject({ method: 'GET', url: '/api/v1/rooms', headers: { host: '127.0.0.1:43120' } });
    expect(list.json().rooms).toHaveLength(1);

    const off = await app.inject({
      method: 'PATCH', url: `/api/v1/rooms/${room.id}/enable`, headers: { host: '127.0.0.1:43120' },
      payload: { enabled: false },
    });
    expect(off.json().room.monitorState).toBe('disabled');

    const check = await app.inject({ method: 'POST', url: `/api/v1/rooms/${room.id}/check`, headers: { host: '127.0.0.1:43120' } });
    expect(check.statusCode).toBe(200);
    expect(check.json().ok).toBe(true);

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/rooms/${room.id}`, headers: { host: '127.0.0.1:43120' } });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe('');
    await app.close();
  });

  it('settings: password write-only, passwordSet derived, validate-directory semantics', async () => {
    const services = newServices();
    const app = buildApp(services);
    const get = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: { host: '127.0.0.1:43120' } });
    expect(get.statusCode).toBe(200);
    expect(get.json().settings.mail.passwordSet).toBe(false);
    expect(get.json().settings.checkIntervalSec).toEqual({ default: 60, bilibili: 60, douyin: 120 });
    expect(JSON.stringify(get.json())).not.toContain('password":');

    const dir = await mkdtemp(path.join(tmpdir(), 'lr-set-'));
    const put = await app.inject({
      method: 'PUT', url: '/api/v1/settings', headers: { host: '127.0.0.1:43120' },
      payload: {
        recordingDirectory: dir,
        maxConcurrentRecordings: 2,
        quality: 'original',
        checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
        retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
        diskGuard: { minFreeBytes: 1024, minFreePercent: 5 },
        mail: { enabled: true, host: 'smtp.x.com', port: 465, secure: true, username: 'u', from: 'f', recipients: ['a@b.c'], password: 'secret' },
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.mail.passwordSet).toBe(true);

    const afterPut = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: { host: '127.0.0.1:43120' } });
    expect(JSON.stringify(afterPut.json())).not.toContain('secret');

    const validate = await app.inject({
      method: 'POST', url: '/api/v1/settings/validate-directory', headers: { host: '127.0.0.1:43120' },
      payload: { directory: dir },
    });
    expect(validate.json().ok).toBe(true);
    const validateBad = await app.inject({
      method: 'POST', url: '/api/v1/settings/validate-directory', headers: { host: '127.0.0.1:43120' },
      payload: { directory: 'relative/path' },
    });
    expect(validateBad.statusCode).toBe(422);
    expect(validateBad.json().error.code).toBe('DIRECTORY_NOT_WRITABLE');

    const smtpOk = await app.inject({ method: 'POST', url: '/api/v1/settings/test-smtp', headers: { host: '127.0.0.1:43120' } });
    expect(smtpOk.json().ok).toBe(true);
    (services.mailer as { failNext: boolean }).failNext = true;
    const smtpFail = await app.inject({ method: 'POST', url: '/api/v1/settings/test-smtp', headers: { host: '127.0.0.1:43120' } });
    expect(smtpFail.statusCode).toBe(502);
    expect(smtpFail.json().error.code).toBe('SMTP_SEND_FAILED');
    expect(smtpFail.json().error.retryable).toBe(true);
    await app.close();
  });

  it('recordings pagination + open, alerts flow', async () => {
    const services = newServices();
    const app = buildApp(services);
    const room = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/1', displayName: 'd' });
    const rec = services.recordings.create({ roomId: room.id, platform: 'douyin', streamSessionId: 's1', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'recording', filePath: '/tmp/x.mkv' });

    const list = await app.inject({ method: 'GET', url: '/api/v1/recordings?pageSize=1&page=1', headers: { host: '127.0.0.1:43120' } });
    expect(list.json().total).toBe(1);
    expect(list.json().items[0].state).toBe('recording');
    expect(list.json().items[0]).not.toHaveProperty('quality');

    const open = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec.id}/open`, headers: { host: '127.0.0.1:43120' } });
    expect(open.json().ok).toBe(true);
    const openBad = await app.inject({ method: 'POST', url: '/api/v1/recordings/rec_none/open', headers: { host: '127.0.0.1:43120' } });
    expect(openBad.statusCode).toBe(400);
    expect(openBad.json().error.code).toBe('RECORDING_FILE_CORRUPTED');

    const alert = services.alerts.create({ level: 'warning', source: 'disk', message: '空间不足', occurredAt: services.clock.iso() });
    const alerts = await app.inject({ method: 'GET', url: '/api/v1/alerts?unresolvedOnly=1', headers: { host: '127.0.0.1:43120' } });
    expect(alerts.json().alerts).toHaveLength(1);
    const read = await app.inject({ method: 'PATCH', url: `/api/v1/alerts/${alert.id}`, headers: { host: '127.0.0.1:43120' } });
    expect(read.json().alert.resolved).toBe(true);
    services.alerts.create({ level: 'info', source: 'recorder', message: '降级', occurredAt: services.clock.iso() });
    const readAll = await app.inject({ method: 'POST', url: '/api/v1/alerts/read-all', headers: { host: '127.0.0.1:43120' } });
    expect(readAll.json().ok).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/v1/alerts?unresolvedOnly=1', headers: { host: '127.0.0.1:43120' } })).json().alerts).toHaveLength(0);
    await app.close();
  });
});
