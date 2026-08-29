import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';

const HOST = { host: '127.0.0.1:43120' };

function newServices(): Services {
  return buildServices({ dbPath: ':memory:', clock: new FakeClock() });
}

describe('v1.4 browse-directories', () => {
  it('lists subdirectories of an absolute path with parent', async () => {
    const { app } = buildApp(newServices());
    const base = await mkdtemp(path.join(tmpdir(), 'lr-browse-'));
    await mkdir(path.join(base, 'subA'));
    await mkdir(path.join(base, 'subB'));
    const res = await app.inject({ method: 'GET', url: `/api/v1/settings/browse-directories?path=${encodeURIComponent(base)}`, headers: HOST });
    expect(res.statusCode).toBe(200);
    const names = res.json().directories.map((d: { name: string }) => d.name);
    expect(names).toEqual(expect.arrayContaining(['subA', 'subB']));
    expect(res.json().path).toBe(path.resolve(base));
    expect(res.json().directories[0].path).toMatch(new RegExp(`^${base}`));
    await app.close();
  });

  it('rejects relative paths and returns 404 for missing directories', async () => {
    const { app } = buildApp(newServices());
    const rel = await app.inject({ method: 'GET', url: '/api/v1/settings/browse-directories?path=relative/foo', headers: HOST });
    expect(rel.statusCode).toBe(422);
    expect(rel.json().error.code).toBe('DIRECTORY_NOT_WRITABLE');

    const missing = await app.inject({ method: 'GET', url: `/api/v1/settings/browse-directories?path=${encodeURIComponent('/definitely/not/here-' + Date.now())}`, headers: HOST });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('RESOURCE_NOT_FOUND');
    expect(missing.json().error.details?.resource).toBe('directory');
    await app.close();
  });

  it('pick-directory is a no-op under test (VITEST)', async () => {
    const { app } = buildApp(newServices());
    const res = await app.inject({ method: 'POST', url: '/api/v1/settings/pick-directory', headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().directory).toBeNull();
    await app.close();
  });
});

describe('v1.4 config export/import', () => {
  it('exports settings/rooms/alerts with secrets masked as hasXxx flags', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    await services.secretStore.set('mail.password', 'secret-pass');
    await services.secretStore.set('douyin.cookie', 'sessionid=x');
    services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'A' });
    services.alerts.create({ level: 'warning', source: 'disk', message: '空间低', occurredAt: '2026-08-28T00:00:00.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/v1/config/export', headers: HOST });
    expect(res.statusCode).toBe(200);
    const config = res.json().config;
    expect(config.version).toBe(1);
    expect(config.settings.mail.passwordSet).toBe(true);
    expect(config.settings.douyinCookie.hasCookie).toBe(true);
    expect(JSON.stringify(config)).not.toMatch(/secret-pass|sessionid=x/);
    expect(config.rooms).toHaveLength(1);
    expect(config.alerts).toHaveLength(1);
    await app.close();
  });

  it('imports settings and rooms, skipping duplicates', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-import-'));
    services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'existing' });

    const res = await app.inject({
      method: 'POST', url: '/api/v1/config/import', headers: HOST,
      payload: {
        config: {
          settings: {
            recordingDirectory: dir,
            maxConcurrentRecordings: 2,
            quality: 'original',
            checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
            retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
            diskGuard: { minFreeBytes: 0, minFreePercent: 0 },
            mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] },
          },
          rooms: [
            { platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'dup' },
            { platform: 'douyin', url: 'https://live.douyin.com/9', displayName: 'new' },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().appliedSettings).toBe(true);
    expect(res.json().importedRooms).toBe(1);
    expect(res.json().skippedRooms).toBe(1);
    expect(services.settings.load()?.recordingDirectory).toBe(dir);
    expect(services.rooms.list().some((r) => r.url === 'https://live.douyin.com/9')).toBe(true);
    await app.close();
  });

  it('rejects invalid settings on import', async () => {
    const { app } = buildApp(newServices());
    const res = await app.inject({
      method: 'POST', url: '/api/v1/config/import', headers: HOST,
      payload: { config: { settings: { recordingDirectory: '/tmp/vids', maxConcurrentRecordings: 99 } } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('CONFIG_INVALID');
    await app.close();
  });

  it('rejects missing config payload', async () => {
    const { app } = buildApp(newServices());
    const res = await app.inject({ method: 'POST', url: '/api/v1/config/import', headers: HOST, payload: {} });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('CONFIG_LOAD_FAILED');
    await app.close();
  });
});