import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices } from '../../src/core/services.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';
import { MAIL_PASSWORD_KEY, DOUYIN_COOKIE_KEY, OPENLIST_TOKEN_KEY } from '../../src/security/keys.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'lr-reset-test-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const services = buildServices({ dbPath: ':memory:' });
  const { app } = buildApp(services);
  cleanup.push(() => app.close());
  services.settings.save({ ...structuredClone(DEFAULT_SETTINGS), recordingDirectory: dir });
  const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/123', displayName: 'Test' });
  const recording = services.recordings.create({ roomId: room.id, roomName: 'Test', platform: 'bilibili', streamSessionId: 'test', streamTitle: 'Test' });
  const video = path.join(dir, 'video.flv');
  const unrelated = path.join(dir, 'personal.txt');
  await writeFile(video, 'video');
  await writeFile(unrelated, 'unrelated');
  services.recordings.update(recording.id, { state: 'completed', filePath: video });
  services.db.exec(`
    INSERT INTO tags (id, name) VALUES ('tag-test', 'test');
    INSERT INTO room_tags (room_id, tag_id) VALUES ('room-test', 'tag-test');
    INSERT INTO recording_schedules (id, room_id, days_of_week, start_time) VALUES ('schedule-test', 'room-test', '[1]', '12:00');
    INSERT INTO diagnostics (id, code, severity, occurred_at) VALUES ('diag-test', 'test', 'warning', '2026-01-01');
    INSERT INTO diagnostic_actions (id, diagnostic_id, action, idempotency_key, result, performed_at)
      VALUES ('action-test', 'diag-test', 'test', 'test', 'ok', '2026-01-01');
    INSERT INTO upload_jobs (id, recording_id, idempotency_key, status) VALUES ('upload-test', 'rec-test', 'test', 'ok');
    INSERT INTO export_jobs (id, recording_ids, status) VALUES ('export-test', '[]', 'ok');
  `);
  services.db.prepare("INSERT INTO pipeline_runs (id, recording_id, config_snapshot, status) VALUES ('pipeline-test', ?, '{}', 'ok')").run(recording.id);
  services.db.exec("INSERT INTO pipeline_artifacts (id, run_id, step, status) VALUES ('artifact-test', 'pipeline-test', 'verify', 'ok')");
  services.alerts.create({ level: 'warning', source: 'test', message: 'test', occurredAt: '2026-01-01' });
  for (const key of [MAIL_PASSWORD_KEY, DOUYIN_COOKIE_KEY, OPENLIST_TOKEN_KEY]) await services.secretStore.set(key, 'test-secret');
  const reset = (keepRecordings: boolean) => app.inject({
    method: 'POST', url: '/api/v1/settings/reset',
    headers: { host: '127.0.0.1:43120' },
    payload: { confirm: 'RESET', keepRecordings },
  });
  return { app, services, dir, video, unrelated, reset };
}

it('clears application data and credentials while preserving recordings and schema', async () => {
  const { services, video, reset, app } = await fixture();
  const response = await reset(true);
  expect(response.statusCode).toBe(200);
  expect(await readFile(video, 'utf8')).toBe('video');
  expect(services.settings.load()).toBeNull();
  expect(services.rooms.list()).toHaveLength(0);
  expect(services.recordings.list().items).toHaveLength(0);
  for (const key of [MAIL_PASSWORD_KEY, DOUYIN_COOKIE_KEY, OPENLIST_TOKEN_KEY]) expect(await services.secretStore.get(key)).toBeNull();
  const tables = services.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'schema_version'").all() as { name: string }[];
  for (const { name } of tables) expect(services.db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get()).toEqual({ count: 0 });
  expect(services.db.prepare('SELECT COUNT(*) AS count FROM schema_version').get()).toEqual({ count: 19 });
  expect((await app.inject({ url: '/api/v1/health', headers: { host: '127.0.0.1:43120' } })).json().serviceStatus.setupCompleted).toBe(false);
});

it('deletes only tracked files, leaving unrelated files in the same directory', async () => {
  const { reset, video, unrelated, dir } = await fixture();
  expect((await reset(false)).statusCode).toBe(200);
  await expect(readFile(video)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(unrelated, 'utf8')).toBe('unrelated');
  expect(await readdir(dir)).toEqual(['personal.txt']);
});

it('restores staged recordings and credentials when reset fails', async () => {
  const { reset, services, video, dir } = await fixture();
  const originalDelete = services.secretStore.delete.bind(services.secretStore);
  vi.spyOn(services.secretStore, 'delete').mockImplementation(async (key) => {
    if (key === DOUYIN_COOKIE_KEY) throw new Error('keychain unavailable');
    await originalDelete(key);
  });
  expect((await reset(false)).statusCode).toBe(500);
  expect(await readFile(video, 'utf8')).toBe('video');
  expect(services.rooms.list()).toHaveLength(1);
  expect(services.settings.load()).not.toBeNull();
  expect(await services.secretStore.get(MAIL_PASSWORD_KEY)).toBe('test-secret');
  expect((await readdir(dir)).some((name) => name.startsWith('.lr-reset-'))).toBe(false);
  expect(services.resetting).toBe(false);
});

it('rejects reset while background tasks are running', async () => {
  const { reset, services, video } = await fixture();
  vi.spyOn(services.manager, 'busy', 'get').mockReturnValue(true);
  expect((await reset(false)).statusCode).toBe(409);
  expect(services.rooms.list()).toHaveLength(1);
  expect(await readFile(video, 'utf8')).toBe('video');
});

it('requires explicit confirmation and file retention choice', async () => {
  const { app, services } = await fixture();
  const response = await app.inject({ method: 'POST', url: '/api/v1/settings/reset', headers: { host: '127.0.0.1:43120' }, payload: {} });
  expect(response.statusCode).toBe(422);
  expect(services.rooms.list()).toHaveLength(1);
});

it('rejects directory paths without deleting their contents', async () => {
  const { reset, services, dir, unrelated } = await fixture();
  services.db.prepare('UPDATE recordings SET file_path = ?').run(dir);
  expect((await reset(false)).statusCode).toBe(422);
  expect(await readFile(unrelated, 'utf8')).toBe('unrelated');
  expect(services.settings.load()).not.toBeNull();
});

it('blocks concurrent reset and writes until reset finishes', async () => {
  const { app, services, reset } = await fixture();
  const originalGet = services.secretStore.get.bind(services.secretStore);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(services.secretStore, 'get').mockImplementation(async (key) => {
    entered();
    await pending;
    return originalGet(key);
  });
  const first = reset(true).then((response) => response);
  await started;
  try {
    expect((await reset(true)).statusCode).toBe(409);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/rooms', headers: { host: '127.0.0.1:43120' },
      payload: { platform: 'bilibili', url: 'https://live.bilibili.com/999' },
    });
    expect(response.statusCode).toBe(409);
  } finally {
    release();
  }
  expect((await first).statusCode).toBe(200);
});
