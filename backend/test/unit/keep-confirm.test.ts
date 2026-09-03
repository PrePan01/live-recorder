import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { KEEP_CONFIRM_TIMEOUT_MS } from '../../src/core/recorder-manager.js';

function newServices(): Services {
  return buildServices({ dbPath: ':memory:', clock: new FakeClock() });
}

const HOST = { host: '127.0.0.1:43120' };

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('#220 录制完成「询问是否保留」', () => {
  it('settings 默认 confirmKeepAfterComplete=false；PUT 接受布尔、拒绝非布尔', async () => {
    const { app } = buildApp(newServices());
    const before = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: HOST });
    expect(before.json().settings.confirmKeepAfterComplete).toBe(false);

    const dir = await mkdtemp(path.join(tmpdir(), 'lr-keep-'));
    const bad = await app.inject({
      method: 'PUT', url: '/api/v1/settings', headers: HOST,
      payload: { recordingDirectory: dir, confirmKeepAfterComplete: 'yes' },
    });
    expect(bad.statusCode).toBe(422);

    const ok = await app.inject({
      method: 'PUT', url: '/api/v1/settings', headers: HOST,
      payload: { recordingDirectory: dir, confirmKeepAfterComplete: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings.confirmKeepAfterComplete).toBe(true);
    await app.close();
  });

  it('keep：待确认 → completed，文件保留；discard：删除文件 + 删除记录', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-keep-'));
    const file = path.join(dir, 'seg.flv');
    await writeFile(file, 'FLV');
    const rec = services.recordings.create({ roomId: 'room_1', roomName: '保留', platform: 'bilibili', streamSessionId: 's1', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'awaiting_confirmation', filePath: file, fileSizeBytes: 4 });

    const kept = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec.id}/keep`, headers: HOST });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().recording.state).toBe('completed');
    await expect(access(file)).resolves.toBeUndefined();

    const file2 = path.join(dir, 'seg2.flv');
    await writeFile(file2, 'FLV2');
    const rec2 = services.recordings.create({ roomId: 'room_1', roomName: '丢弃', platform: 'bilibili', streamSessionId: 's2', streamTitle: 't' });
    services.recordings.update(rec2.id, { state: 'awaiting_confirmation', filePath: file2, fileSizeBytes: 4 });
    const del = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec2.id}/discard`, headers: HOST });
    expect(del.statusCode).toBe(204);
    expect(services.recordings.get(rec2.id)).toBeNull();
    await sleep(20);
    await expect(access(file2)).rejects.toBeTruthy();
    await app.close();
  });

  it('keep/discard 仅允许待确认状态，其余状态 422', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const rec = services.recordings.create({ roomId: 'room_1', roomName: 'x', platform: 'bilibili', streamSessionId: 's3', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'completed' });
    const k = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec.id}/keep`, headers: HOST });
    expect(k.statusCode).toBe(422);
    const d = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec.id}/discard`, headers: HOST });
    expect(d.statusCode).toBe(422);
    await app.close();
  });

  it('开启后录制完成进入待确认态并挂起管线；超时自动保留为 completed', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const clock = services.clock as FakeClock;
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-keep-flow-'));

    const set = await app.inject({
      method: 'PUT', url: '/api/v1/settings', headers: HOST,
      payload: { recordingDirectory: dir, confirmKeepAfterComplete: true, retry: { maxAttempts: 0, delaysSeconds: [5, 15, 45] } },
    });
    expect(set.statusCode).toBe(200);

    const created = await app.inject({
      method: 'POST', url: '/api/v1/rooms', headers: HOST,
      payload: { platform: 'bilibili', url: 'https://live.bilibili.com/999', displayName: '保留测试' },
    });
    const room = created.json().room;

    await services.manager.maybeStartRecording(services.rooms.get(room.id)!, { streamSessionId: 's99' });
    // 驱动假引擎写满 frames 并 natural end（fake engine：6 帧 × 500ms，逐拍推进以触发各帧定时器）。
    for (let i = 0; i < 10; i += 1) {
      clock.advance(500);
      await sleep(5);
    }
    const pending = services.recordings.list({ pageSize: 100 }).items;
    expect(pending.some((r) => r.state === 'awaiting_confirmation')).toBe(true);

    // 超时默认保留：推进超过 KEEP_CONFIRM_TIMEOUT_MS。
    clock.advance(KEEP_CONFIRM_TIMEOUT_MS + 1000);
    await sleep(20);
    const rec = services.recordings.get(pending[0].id)!;
    expect(rec.state).toBe('completed');
    await app.close();
  });

  it('重启恢复：resumePendingConfirmations 对待确认录制按默认保留恢复', async () => {
    const services = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-keep-resume-'));
    const file = path.join(dir, 'a.flv');
    await writeFile(file, 'FLV');
    const rec = services.recordings.create({ roomId: 'room_1', roomName: 'x', platform: 'bilibili', streamSessionId: 's4', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'awaiting_confirmation', filePath: file, fileSizeBytes: 4 });

    services.manager.resumePendingConfirmations();
    const after = services.recordings.get(rec.id)!;
    expect(after.state).toBe('completed');
    expect(after.pipelineStatus).toBe('not_required');
  });
});