import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { exportConfigToPath } from '../../src/api/routes/config.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';

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
    expect(path.dirname(res.json().directories[0].path)).toBe(base);
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
  it('round-trips shared room tags and unassigned tags through a backup file', async () => {
    const source = newServices();
    const first = source.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/101', displayName: 'first' });
    const second = source.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/102', displayName: 'second' });
    const shared = source.tags.create({ name: '游戏', color: '#123456' });
    const extra = source.tags.create({ name: '关注', color: '#abcdef' });
    source.tags.create({ name: '未使用', color: '#654321' });
    source.tags.setRoomTags(first.id, [shared.id, extra.id]);
    source.tags.setRoomTags(second.id, [shared.id]);
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-tags-backup-'));
    const file = await exportConfigToPath(source, path.join(dir, 'backup'));
    const { config } = JSON.parse(await readFile(file, 'utf8'));
    expect(config.tags).toHaveLength(3);
    expect(config.rooms.find((r: { id: string }) => r.id === first.id).tags).toHaveLength(2);

    const target = newServices();
    const { app } = buildApp(target);
    // Only restore rooms/tags here; settings have separate validation coverage.
    const payload = { config: { rooms: config.rooms, tags: config.tags } };
    for (let i = 0; i < 2; i += 1) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/config/import', headers: HOST, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json().importedRooms).toBe(i === 0 ? 2 : 0);
      expect(target.tags.list().map(({ name, color }) => ({ name, color }))).toEqual(
        source.tags.list().map(({ name, color }) => ({ name, color })),
      );
      const rooms = target.rooms.list();
      expect(rooms.find((r) => r.url === first.url)?.tags.map((t) => t.name).sort()).toEqual(['关注', '游戏']);
      expect(rooms.find((r) => r.url === second.url)?.tags.map((t) => t.name)).toEqual(['游戏']);
      expect(rooms.find((r) => r.url === first.url)?.id).not.toBe(first.id);
      expect(target.tags.findByName('游戏')?.id).not.toBe(shared.id);
    }
    source.db.close();
    await app.close();
  });

  it('restores inline tags from old backups onto existing rooms without overwriting local tags', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/103', displayName: 'local' });
    const local = services.tags.create({ name: 'local', color: '#111111' });
    const shared = services.tags.create({ name: 'shared', color: '#222222' });
    services.tags.setRoomTags(room.id, [local.id]);
    const payload = { config: { rooms: [{
      platform: room.platform, url: room.url, displayName: 'backup',
      tags: [
        { id: local.id, name: 'SHARED', color: '#ffffff' },
        { id: shared.id, name: 'new', color: '#123456' },
        { name: 'new', color: '#123456' },
        null, { name: '' }, { name: 42 },
      ],
    }] } };
    for (let i = 0; i < 2; i += 1) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/config/import', headers: HOST, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ importedRooms: 0, skippedRooms: 1 });
    }
    expect(services.rooms.get(room.id)?.displayName).toBe('local');
    expect(services.tags.tagsForRoom(room.id).map((t) => t.name)).toEqual(['local', 'new', 'shared']);
    expect(services.tags.get(shared.id)?.color).toBe('#222222');
    expect(services.tags.findByName('new')?.color).toBe('#123456');
    // Backups predating tags must leave local associations intact.
    const legacy = await app.inject({ method: 'POST', url: '/api/v1/config/import', headers: HOST,
      payload: { config: { rooms: [{ platform: room.platform, url: room.url }] } } });
    expect(legacy.statusCode).toBe(200);
    expect(services.tags.tagsForRoom(room.id)).toHaveLength(3);
    await app.close();
  });

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

  it('restores completed recording metadata so dashboard statistics survive export/import', async () => {
    const source = newServices();
    const { app: sourceApp } = buildApp(source);
    source.settings.save({ ...structuredClone(DEFAULT_SETTINGS), recordingDirectory: await mkdtemp(path.join(tmpdir(), 'lr-stats-backup-')) });
    const room = source.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/88', displayName: '统计房间' });
    const recording = source.recordings.create({
      roomId: room.id,
      roomName: room.displayName,
      platform: room.platform,
      streamSessionId: 'session-88',
      streamTitle: '历史直播',
    });
    source.recordings.update(recording.id, {
      state: 'completed',
      endedAt: '2026-09-12T10:30:00.000Z',
      fileSizeBytes: 4096,
    });
    source.db.prepare('UPDATE recordings SET started_at = ?, created_at = ? WHERE id = ?')
      .run('2026-09-12T10:00:00.000Z', '2026-09-12T10:00:00.000Z', recording.id);

    const config = (await sourceApp.inject({ method: 'GET', url: '/api/v1/config/export', headers: HOST })).json().config;
    expect(config.recordings.rooms[0].recordings).toHaveLength(1);

    const target = newServices();
    const { app: targetApp } = buildApp(target);
    const imported = await targetApp.inject({ method: 'POST', url: '/api/v1/config/import', headers: HOST, payload: { config } });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().recordings).toEqual({ matchedRooms: 1, skippedRooms: 0, recordings: 1 });

    const stats = await targetApp.inject({
      method: 'GET',
      url: '/api/v1/stats/recordings?from=2026-09-12T00:00:00.000Z&to=2026-09-12T23:59:59.999Z',
      headers: HOST,
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().totals).toMatchObject({ recordings: 1, completed: 1, bytes: 4096, durationMs: 1_800_000 });

    await sourceApp.close();
    await targetApp.close();
  });

  it('export-file keeps the native save dialog out of tests', async () => {
    const { app } = buildApp(newServices());
    const res = await app.inject({ method: 'POST', url: '/api/v1/config/export-file', headers: HOST });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, saved: false, path: null, reason: 'cancelled' });
    await app.close();
  });

  it('writes the exported config to the chosen path with a .json suffix', async () => {
    const services = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-export-'));
    services.alerts.create({ level: 'warning', source: 'disk', message: '空间低', occurredAt: '2026-08-28T00:00:00.000Z' });

    const written = await exportConfigToPath(services, path.join(dir, 'backup'));
    expect(path.basename(written)).toBe('backup.json');
    const parsed = JSON.parse(await readFile(written, 'utf8'));
    expect(parsed.config.version).toBe(1);
    expect(parsed.config.alerts).toHaveLength(1);

    const kept = await exportConfigToPath(services, path.join(dir, 'again.JSON'));
    expect(path.basename(kept)).toBe('again.JSON');
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
