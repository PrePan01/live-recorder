import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { FakePlatformAdapter } from '../../src/platform/fake-adapter.js';
import { AppError } from '../../src/types/error.js';

function newServices(): Services {
  return buildServices({ dbPath: ':memory:', clock: new FakeClock() });
}

describe('REST contract v1.1 (fake stack)', () => {
  it('health + service status', async () => {
    const { app } = buildApp(newServices());
    const res = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: '127.0.0.1:43120' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().serviceStatus.state).toBe('running');
    expect(res.json().serviceStatus.setupCompleted).toBe(false);

    const status = await app.inject({ method: 'GET', url: '/api/v1/service/status', headers: { host: '127.0.0.1:43120' } });
    expect(status.json().serviceStatus.setupCompleted).toBe(false);
    await app.close();
  });

  it('service self-check returns per-item status without leaking secrets', async () => {
    const { app } = buildApp(newServices());
    const res = await app.inject({ method: 'GET', url: '/api/v1/service/self-check', headers: { host: '127.0.0.1:43120' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(5);
    const keys = body.items.map((i: { key: string }) => i.key);
    expect(keys).toEqual(expect.arrayContaining(['backend', 'smtp', 'cookie', 'disk', 'writable']));
    for (const item of body.items) {
      expect(['ok', 'fail', 'warn']).toContain(item.status);
      expect(typeof item.detail).toBe('string');
      expect(typeof item.fixHint).toBe('string');
      // 不泄漏 Cookie/密码明文
      const raw = JSON.stringify(item);
      expect(raw).not.toMatch(/SESSDATA|buvid3|password|@|smtp\./i);
    }
    await app.close();
  });

  it('rejects non-local host and unknown origin, allows dev origin when configured', async () => {
    const { app } = buildApp(newServices(), { extraOrigins: ['http://localhost:5173'] });
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
    const { app } = buildApp(services);
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
    expect(dup.json().error.roomId).toBe(room.id);
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
    const delUnknown = await app.inject({ method: 'DELETE', url: '/api/v1/rooms/room_none', headers: { host: '127.0.0.1:43120' } });
    expect(delUnknown.statusCode).toBe(404);
    expect(delUnknown.json().error.code).toBe('RESOURCE_NOT_FOUND');
    const patchUnknown = await app.inject({ method: 'PATCH', url: '/api/v1/rooms/room_none', headers: { host: '127.0.0.1:43120' }, payload: { displayName: 'x' } });
    expect(patchUnknown.statusCode).toBe(404);
    await app.close();
  });

  it('favorites a room and surfaces activeRecording in room responses', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const created = await app.inject({
      method: 'POST', url: '/api/v1/rooms', headers: { host: '127.0.0.1:43120' },
      payload: { platform: 'bilibili', url: 'https://live.bilibili.com/456', displayName: '收藏' },
    });
    const room = created.json().room;
    expect(room.favorited).toBe(false);
    expect(room.activeRecording).toBeNull();

    const fav = await app.inject({
      method: 'PATCH', url: `/api/v1/rooms/${room.id}/favorite`, headers: { host: '127.0.0.1:43120' },
      payload: { favorited: true },
    });
    expect(fav.json().room.favorited).toBe(true);

    const badFav = await app.inject({
      method: 'PATCH', url: `/api/v1/rooms/${room.id}/favorite`, headers: { host: '127.0.0.1:43120' },
      payload: { favorited: 'yes' },
    });
    expect(badFav.statusCode).toBe(422);

    const list = await app.inject({ method: 'GET', url: '/api/v1/rooms', headers: { host: '127.0.0.1:43120' } });
    expect(list.json().rooms.find((r: { id: string }) => r.id === room.id).favorited).toBe(true);

    services.rooms.setState(room.id, 'recording');
    await services.manager.maybeStartRecording(services.rooms.get(room.id)!, { streamSessionId: 's9' });
    const during = await app.inject({ method: 'GET', url: '/api/v1/rooms', headers: { host: '127.0.0.1:43120' } });
    const active = during.json().rooms.find((r: { id: string }) => r.id === room.id).activeRecording;
    expect(active).not.toBeNull();
    expect(active.recordingId).toMatch(/^rec_/);
    expect(active.startedAt).toBeTruthy();

    // #40：录制中收藏，SSE room:updated 应带 activeRecording，不覆盖前端时长显示
    const sseRooms: Array<{ activeRecording: unknown; favorited: boolean }> = [];
    const unsub = services.events.on((e) => {
      if (e.type === 'room:updated' && 'favorited' in e.data) sseRooms.push(e.data as { activeRecording: unknown; favorited: boolean });
    });
    const favDuring = await app.inject({
      method: 'PATCH', url: `/api/v1/rooms/${room.id}/favorite`, headers: { host: '127.0.0.1:43120' },
      payload: { favorited: true },
    });
    expect(favDuring.json().room.favorited).toBe(true);
    const emitted = sseRooms[sseRooms.length - 1];
    expect(emitted.favorited).toBe(true);
    expect(emitted.activeRecording).not.toBeNull();
    expect(emitted.activeRecording).toMatchObject({ recordingId: active.recordingId });
    unsub();

    await services.manager.stopRecording(room.id);
    await new Promise((r) => setTimeout(r, 50));
    await app.close();
  });

  it('batch adds rooms with partial success (valid+duplicate+invalid mixed)', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    // 预置一个现库房间，验证去重。
    await app.inject({
      method: 'POST', url: '/api/v1/rooms', headers: { host: '127.0.0.1:43120' },
      payload: { platform: 'bilibili', url: 'https://live.bilibili.com/777', displayName: '已有' },
    });

    const res = await app.inject({
      method: 'POST', url: '/api/v1/rooms/batch', headers: { host: '127.0.0.1:43120' },
      payload: {
        urls: [
          'https://live.bilibili.com/778?x=1',   // 新增 bilibili（规范化去 query）
          'https://live.douyin.com/100',          // 新增 douyin
          'https://live.bilibili.com/777',        // 现库重复
          'https://live.bilibili.com/778',        // 批内重复
          'https://example.com/bad',              // 无效
          '',                                     // 空行
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.succeeded).toHaveLength(2);
    expect(body.failed).toHaveLength(4);
    expect(body.succeeded.map((r: { url: string }) => r.url).sort()).toEqual([
      'https://live.bilibili.com/778',
      'https://live.douyin.com/100',
    ].sort());
    expect(body.failed.some((f: { url: string; reason: string }) => f.url === 'https://live.bilibili.com/777' && f.reason.includes('已存在'))).toBe(true);
    expect(body.failed.some((f: { url: string }) => f.url === 'https://live.bilibili.com/778' && f.reason.includes('已存在'))).toBe(true);
    expect(body.failed.some((f: { url: string }) => f.url === 'https://example.com/bad')).toBe(true);

    // 批量后现库共 3 个（1 已有 + 2 新增）。
    const list = await app.inject({ method: 'GET', url: '/api/v1/rooms', headers: { host: '127.0.0.1:43120' } });
    expect(list.json().rooms).toHaveLength(3);

    const badReq = await app.inject({
      method: 'POST', url: '/api/v1/rooms/batch', headers: { host: '127.0.0.1:43120' },
      payload: { urls: [] },
    });
    expect(badReq.statusCode).toBe(422);
    await app.close();
  });

  it('settings expose recordingFormat and validate allowed values (#60)', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-fmt-'));
    const base = {
      recordingDirectory: dir,
      maxConcurrentRecordings: 2,
      quality: 'original',
      recordingFormat: 'source_flv',
      checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
      retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
      diskGuard: { minFreeBytes: 0, minFreePercent: 0 },
      mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] },
      dedupeWindowMinutes: 30,
    };

    const put = await app.inject({ method: 'PUT', url: '/api/v1/settings', headers: { host: '127.0.0.1:43120' }, payload: base });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.recordingFormat).toBe('source_flv');

    const putMp4 = await app.inject({ method: 'PUT', url: '/api/v1/settings', headers: { host: '127.0.0.1:43120' }, payload: { ...base, recordingFormat: 'mp4_after' } });
    expect(putMp4.statusCode).toBe(200);
    expect(putMp4.json().settings.recordingFormat).toBe('mp4_after');

    const bad = await app.inject({ method: 'PUT', url: '/api/v1/settings', headers: { host: '127.0.0.1:43120' }, payload: { ...base, recordingFormat: 'avi' } });
    expect(bad.statusCode).toBe(500);
    expect(bad.json().error.code).toBe('CONFIG_LOAD_FAILED');
    await app.close();
  });

  it('settings: password write-only, passwordSet derived, validate-directory semantics', async () => {
    const services = newServices();
    const { app } = buildApp(services);
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

  it('settings: douyin cookie is writable, never echoed and reports hasCookie (v1.3)', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-cookie-'));
    const base = {
      recordingDirectory: dir,
      maxConcurrentRecordings: 2,
      quality: 'original' as const,
      checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
      retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
      diskGuard: { minFreeBytes: 1024, minFreePercent: 5 },
      mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] },
    };
    const before = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: { host: '127.0.0.1:43120' } });
    expect(before.json().settings.douyinCookie.hasCookie).toBe(false);

    const put = await app.inject({
      method: 'PUT', url: '/api/v1/settings', headers: { host: '127.0.0.1:43120' },
      payload: { ...base, douyinCookie: 'sessionid=abc123;ttwid=xyz' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.douyinCookie.hasCookie).toBe(true);
    expect(JSON.stringify(put.json())).not.toContain('abc123');

    const after = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: { host: '127.0.0.1:43120' } });
    expect(after.json().settings.douyinCookie.hasCookie).toBe(true);
    expect(JSON.stringify(after.json())).not.toContain('sessionid');
    expect(services.settings.getRaw('settings')).not.toContain('douyinCookie');

    const clear = await app.inject({
      method: 'PUT', url: '/api/v1/settings', headers: { host: '127.0.0.1:43120' },
      payload: { ...base, douyinCookie: '' },
    });
    expect(clear.json().settings.douyinCookie.hasCookie).toBe(false);
    await app.close();
  });

  it('recordings pagination + open, alerts flow', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const room = services.rooms.create({ platform: 'douyin', url: 'https://live.douyin.com/1', displayName: 'd' });
    const rec = services.recordings.create({ roomId: room.id, platform: 'douyin', streamSessionId: 's1', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'recording', filePath: '/tmp/x.mkv' });

    const list = await app.inject({ method: 'GET', url: '/api/v1/recordings?pageSize=1&page=1', headers: { host: '127.0.0.1:43120' } });
    expect(list.json().total).toBe(1);
    expect(list.json().items[0].state).toBe('recording');
    // 未记录 quality 的记录不输出该字段；有 quality 的记录会输出（见 history 用例）。
    expect(list.json().items[0]).not.toHaveProperty('quality');

    const open = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec.id}/open`, headers: { host: '127.0.0.1:43120' } });
    expect(open.json().ok).toBe(true);
    const openBad = await app.inject({ method: 'POST', url: '/api/v1/recordings/rec_none/open', headers: { host: '127.0.0.1:43120' } });
    expect(openBad.statusCode).toBe(404);
    expect(openBad.json().error.code).toBe('RESOURCE_NOT_FOUND');

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

  it('history: quality output, date filter, rename (file sync), delete (file remove, tolerant)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-hist-'));
    const services = newServices();
    services.settings.save({
      recordingDirectory: dir,
      maxConcurrentRecordings: 2,
      quality: 'original',
      checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
      retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
      diskGuard: { minFreeBytes: 0, minFreePercent: 0 },
      mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] },
      dedupeWindowMinutes: 30,
    });
    const { app } = buildApp(services);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'h' });
    const { mkdir, writeFile, access } = await import('node:fs/promises');
    const file1 = path.join(dir, '20260828_100000.mkv');
    const file2 = path.join(dir, '20260828_110000.mkv');
    await mkdir(dir, { recursive: true });
    await writeFile(file1, Buffer.from([1, 2, 3]));
    await writeFile(file2, Buffer.from([4, 5, 6]));
    const rec1 = services.recordings.create({ roomId: room.id, platform: 'bilibili', streamSessionId: 's1', streamTitle: '旧标题', quality: '1080p' });
    services.recordings.update(rec1.id, { state: 'completed', startedAt: '2026-08-28T10:00:00.000Z', endedAt: '2026-08-28T10:10:00.000Z', filePath: file1 });
    const rec2 = services.recordings.create({ roomId: room.id, platform: 'bilibili', streamSessionId: 's2', streamTitle: '第二段', quality: '720p' });
    services.recordings.update(rec2.id, { state: 'completed', startedAt: '2026-08-28T11:00:00.000Z', endedAt: '2026-08-28T11:05:00.000Z', filePath: file2 });

    // quality 输出
    const list = await app.inject({ method: 'GET', url: '/api/v1/recordings', headers: { host: '127.0.0.1:43120' } });
    expect(list.json().items.find((r: { id: string }) => r.id === rec1.id).quality).toBe('1080p');

    // 日期筛选
    const byDate = await app.inject({ method: 'GET', url: '/api/v1/recordings?dateFrom=2026-08-28T10:30:00.000Z', headers: { host: '127.0.0.1:43120' } });
    expect(byDate.json().items.map((r: { id: string }) => r.id)).toEqual([rec2.id]);

    // 重命名同步文件
    const ren = await app.inject({
      method: 'PATCH', url: `/api/v1/recordings/${rec1.id}`, headers: { host: '127.0.0.1:43120' },
      payload: { streamTitle: '新标题' },
    });
    expect(ren.json().recording.streamTitle).toBe('新标题');
    expect(ren.json().recording.filePath).toBe(path.join(dir, '新标题.mkv'));
    await access(path.join(dir, '新标题.mkv'));
    await access(file1).then(() => { throw new Error('old file should be renamed'); }).catch(() => undefined);

    // 删除连带删文件
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/recordings/${rec2.id}`, headers: { host: '127.0.0.1:43120' } });
    expect(del.statusCode).toBe(204);
    await access(file2).then(() => { throw new Error('deleted file should be gone'); }).catch(() => undefined);
    expect(services.recordings.get(rec2.id)).toBeNull();

    // 文件已缺失时删除容错
    const rec3 = services.recordings.create({ roomId: room.id, platform: 'bilibili', streamSessionId: 's3', streamTitle: '缺文件', quality: '720p' });
    services.recordings.update(rec3.id, { state: 'completed', filePath: path.join(dir, 'missing.mkv') });
    const delMissing = await app.inject({ method: 'DELETE', url: `/api/v1/recordings/${rec3.id}`, headers: { host: '127.0.0.1:43120' } });
    expect(delMissing.statusCode).toBe(204);
    expect(services.recordings.get(rec3.id)).toBeNull();

    const badRen = await app.inject({ method: 'PATCH', url: '/api/v1/recordings/rec_none', headers: { host: '127.0.0.1:43120' }, payload: { streamTitle: 'x' } });
    expect(badRen.statusCode).toBe(404);
    await app.close();
  });

  it('alerts carry structured roomId/errorCode for failure retry (#54)', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'r' });
    const err = new AppError('RECORDING_START_FAILED', '启动失败', { roomId: room.id });
    const alert = services.alerts.create({ level: 'error', source: 'recorder', message: `${err.code}: ${err.message}`, occurredAt: services.clock.iso(), roomId: room.id, errorCode: err.code });
    const alerts = await app.inject({ method: 'GET', url: '/api/v1/alerts?unresolvedOnly=1', headers: { host: '127.0.0.1:43120' } });
    const item = alerts.json().alerts.find((a: { id: string }) => a.id === alert.id);
    expect(item.roomId).toBe(room.id);
    expect(item.errorCode).toBe('RECORDING_START_FAILED');
    expect(item.message).toContain('RECORDING_START_FAILED');
    await app.close();
  });

  it('serves recording file for playback (FLV, completed only, #58)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-play-'));
    const services = newServices();
    const { app } = buildApp(services);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'p' });
    const { mkdir, writeFile } = await import('node:fs/promises');
    const file = path.join(dir, 'rec.flv');
    await mkdir(dir, { recursive: true });
    const flvBytes = Buffer.concat([Buffer.from([0x46, 0x4c, 0x56, 0x01]), Buffer.alloc(100)]);
    await writeFile(file, flvBytes);

    const rec = services.recordings.create({ roomId: room.id, platform: 'bilibili', streamSessionId: 's', streamTitle: 'p' });
    services.recordings.update(rec.id, { state: 'completed', filePath: file });

    // completed + 有文件 → 200 + FLV
    const ok = await app.inject({ method: 'GET', url: `/api/v1/recordings/${rec.id}/file`, headers: { host: '127.0.0.1:43120' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('video/x-flv');
    const body = ok.rawPayload;
    expect(body[0]).toBe(0x46);
    expect(body[1]).toBe(0x4c);
    expect(body[2]).toBe(0x56);

    // recording 状态（未完成）→ 404
    const rec2 = services.recordings.create({ roomId: room.id, platform: 'bilibili', streamSessionId: 's2', streamTitle: 'p2' });
    const noFile = await app.inject({ method: 'GET', url: `/api/v1/recordings/${rec2.id}/file`, headers: { host: '127.0.0.1:43120' } });
    expect(noFile.statusCode).toBe(404);

    // 不存在的记录 → 404
    const bad = await app.inject({ method: 'GET', url: '/api/v1/recordings/rec_none/file', headers: { host: '127.0.0.1:43120' } });
    expect(bad.statusCode).toBe(404);
    await app.close();
  });

  it('batch-delete recordings with partial success, CSV export, room stats (#67/#69/#70)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-v4-'));
    const services = newServices();
    const { app } = buildApp(services);
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/1', displayName: 'v4' });
    const f1 = path.join(dir, 'a.flv');
    const f2 = path.join(dir, 'b.flv');
    await writeFile(f1, Buffer.from([1, 2, 3]));
    await writeFile(f2, Buffer.from([4, 5, 6]));
    const r1 = services.recordings.create({ roomId: room.id, platform: 'bilibili', streamSessionId: 's1', streamTitle: 'a', quality: '720p' });
    services.recordings.update(r1.id, { state: 'completed', startedAt: '2026-08-28T10:00:00.000Z', endedAt: '2026-08-28T10:10:00.000Z', filePath: f1, integrity: 'verified' });
    const r2 = services.recordings.create({ roomId: room.id, platform: 'bilibili', streamSessionId: 's2', streamTitle: 'b' });
    services.recordings.update(r2.id, { state: 'completed', startedAt: '2026-08-28T11:00:00.000Z', endedAt: '2026-08-28T11:05:00.000Z', filePath: f2 });

    // #67 batch-delete：删 1 个存在 + 1 个不存在
    const bd = await app.inject({ method: 'POST', url: '/api/v1/recordings/batch-delete', headers: { host: '127.0.0.1:43120' }, payload: { ids: [r1.id, 'rec_none'] } });
    expect(bd.statusCode).toBe(200);
    expect(bd.json().deleted).toEqual([r1.id]);
    expect(bd.json().failed.some((f: { id: string }) => f.id === 'rec_none')).toBe(true);
    expect(services.recordings.get(r1.id)).toBeNull();

    // #69 CSV export
    const csv = await app.inject({ method: 'GET', url: `/api/v1/recordings/export?roomId=${room.id}`, headers: { host: '127.0.0.1:43120' } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const body = csv.body;
    expect(body.startsWith('\uFEFF')).toBe(true); // UTF-8 BOM
    expect(body).toContain('totalRecordings,1');
    expect(body).toContain(r2.id); // 剩 r2

    // #70 room stats
    const stats = await app.inject({ method: 'GET', url: `/api/v1/rooms/${room.id}/stats?days=7`, headers: { host: '127.0.0.1:43120' } });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().roomId).toBe(room.id);
    expect(stats.json().totalRecordings).toBe(1); // r2 剩 1 条
    expect(stats.json().successRate).toBe(100);
    expect(Array.isArray(stats.json().byDay)).toBe(true);
    const badStats = await app.inject({ method: 'GET', url: '/api/v1/rooms/room_none/stats', headers: { host: '127.0.0.1:43120' } });
    expect(badStats.statusCode).toBe(404);
    await app.close();
  });

  it('PATCH /rooms/:id sets/clears autoRecord (room-level override, #75)', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const created = await app.inject({
      method: 'POST', url: '/api/v1/rooms', headers: { host: '127.0.0.1:43120' },
      payload: { platform: 'bilibili', url: 'https://live.bilibili.com/222', displayName: 'ar' },
    });
    const roomId = created.json().room.id;
    expect(created.json().room.autoRecord).toBeNull();

    const set = await app.inject({
      method: 'PATCH', url: `/api/v1/rooms/${roomId}`, headers: { host: '127.0.0.1:43120' },
      payload: { autoRecord: false },
    });
    expect(set.json().room.autoRecord).toBe(false);

    // 恢复继承全局
    const clear = await app.inject({
      method: 'PATCH', url: `/api/v1/rooms/${roomId}`, headers: { host: '127.0.0.1:43120' },
      payload: { autoRecord: null },
    });
    expect(clear.json().room.autoRecord).toBeNull();

    const bad = await app.inject({
      method: 'PATCH', url: `/api/v1/rooms/${roomId}`, headers: { host: '127.0.0.1:43120' },
      payload: { autoRecord: 'yes' },
    });
    expect(bad.statusCode).toBe(422);
    await app.close();
  });

  it('POST /rooms/:id/start-recording forces manual recording when live (#79)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-rec-'));
    const services = newServices();
    services.settings.save({
      recordingDirectory: dir,
      maxConcurrentRecordings: 2,
      quality: 'original',
      recordingFormat: 'source_flv',
      autoRecord: false,
      checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
      retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
      diskGuard: { minFreeBytes: 0, minFreePercent: 0 },
      mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] },
      dedupeWindowMinutes: 30,
    });
    const { app } = buildApp(services);
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/999', displayName: 'rec' });
    (services.adapterFor('bilibili') as FakePlatformAdapter).setScript([{ status: 'live', streamSessionId: 's1' }]);

    // 未开播状态（lastLiveStatus=null）→ 端点实时检测到 live → 强制开录（即使全局 autoRecord=false）
    const ok = await app.inject({ method: 'POST', url: `/api/v1/rooms/${room.id}/start-recording`, headers: { host: '127.0.0.1:43120' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(services.manager.isRoomActive(room.id)).toBe(true);
    expect(services.rooms.get(room.id)!.lastLiveStatus).toBe('live');

    // 已在录制 → 409
    const dup = await app.inject({ method: 'POST', url: `/api/v1/rooms/${room.id}/start-recording`, headers: { host: '127.0.0.1:43120' } });
    expect(dup.statusCode).toBe(409);

    await services.manager.stopRecording(room.id);
    await new Promise((r) => setTimeout(r, 200));

    // 房间不存在 → 404
    const badRoom = await app.inject({ method: 'POST', url: '/api/v1/rooms/room_none/start-recording', headers: { host: '127.0.0.1:43120' } });
    expect(badRoom.statusCode).toBe(404);
    await app.close();
  });
});
