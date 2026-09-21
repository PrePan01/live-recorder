import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { HIGHLIGHT_EXPORT_IDLE_TIMEOUT_MS, KEEP_CONFIRM_TIMEOUT_MS } from '../../src/core/recorder-manager.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';

function newServices(): Services {
  return buildServices({ dbPath: ':memory:', clock: new FakeClock() });
}

const HOST = { host: '127.0.0.1:43120' };

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('#220 录制完成「询问是否保留」', () => {
  it('settings 默认 confirmAfterComplete=false；PUT 接受布尔、拒绝非布尔', async () => {
    const { app } = buildApp(newServices());
    const before = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: HOST });
    expect(before.json().settings.confirmAfterComplete).toBe(false);

    const dir = await mkdtemp(path.join(tmpdir(), 'lr-keep-'));
    const bad = await app.inject({
      method: 'PUT', url: '/api/v1/settings', headers: HOST,
      payload: { recordingDirectory: dir, confirmAfterComplete: 'yes' },
    });
    expect(bad.statusCode).toBe(422);

    const ok = await app.inject({
      method: 'PUT', url: '/api/v1/settings', headers: HOST,
      payload: { recordingDirectory: dir, confirmAfterComplete: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings.confirmAfterComplete).toBe(true);
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
      payload: { recordingDirectory: dir, confirmAfterComplete: true, retry: { maxAttempts: 0, delaysSeconds: [5, 15, 45] } },
    });
    expect(set.statusCode).toBe(200);

    const created = await app.inject({
      method: 'POST', url: '/api/v1/rooms', headers: HOST,
      payload: { platform: 'bilibili', url: 'https://live.bilibili.com/999', displayName: '保留测试' },
    });
    const room = created.json().room;

    // #222：confirmAfterComplete 开启时不得发出中间 completed 的 recording:updated（避免「已保存+确认框」双弹）。
    const emittedStates: Array<{ id: string; state: string }> = [];
    const unsub = services.events.on((e) => {
      if (e.type === 'recording:updated') emittedStates.push({ id: e.data.id, state: e.data.state });
    });

    await services.manager.maybeStartRecording(services.rooms.get(room.id)!, { streamSessionId: 's99' });
    // 驱动假引擎写满 frames 并 natural end（fake engine：6 帧 × 500ms，逐拍推进以触发各帧定时器）。
    const deadline = Date.now() + 5000;
    while (!services.recordings.list({ pageSize: 100 }).items.some((r) => r.state === 'awaiting_confirmation') && Date.now() < deadline) {
      clock.advance(500);
      await sleep(5);
    }
    const pending = services.recordings.list({ pageSize: 100 }).items;
    expect(pending.some((r) => r.state === 'awaiting_confirmation')).toBe(true);

    const recId = pending.find((r) => r.state === 'awaiting_confirmation')!.id;
    const forThis = emittedStates.filter((e) => e.id === recId);
    expect(forThis.some((e) => e.state === 'completed')).toBe(false);
    expect(forThis.filter((e) => e.state === 'awaiting_confirmation').length).toBeGreaterThan(0);
    unsub();

    // 超时默认保留：推进超过 KEEP_CONFIRM_TIMEOUT_MS。
    clock.advance(KEEP_CONFIRM_TIMEOUT_MS + 1000);
    await sleep(20);
    const rec = services.recordings.get(recId)!;
    expect(rec.state).toBe('completed');
    await app.close();
  });

  it('悬浮按钮来源在确认设置开启时也直接保留并进入完成态', async () => {
    const services = newServices();
    const clock = services.clock as FakeClock;
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-floating-keep-'));
    services.settings.save({ ...DEFAULT_SETTINGS, recordingDirectory: dir, confirmAfterComplete: true });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/998', displayName: '悬浮录制' });
    services.rooms.setLiveStatus(room.id, 'live');

    await services.manager.maybeStartRecording(services.rooms.get(room.id)!, { streamSessionId: 'floating-session' }, { manual: true, origin: 'floating' });
    const deadline = Date.now() + 5_000;
    while (!services.recordings.list({ pageSize: 100 }).items.some((r) => r.state === 'completed') && Date.now() < deadline) {
      clock.advance(500);
      await sleep(5);
    }
    const recording = services.recordings.list({ pageSize: 100 }).items[0]!;
    expect(recording.origin).toBe('floating');
    expect(recording.state).toBe('completed');
  });

  it('统一决策接口 confirm：keep=true 保留、keep=false 删除；keep 非布尔/非待确认态 422', async () => {
    const services = newServices();
    const { app } = buildApp(services);
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-keep-'));
    const file = path.join(dir, 'seg.flv');
    await writeFile(file, 'FLV');
    const rec = services.recordings.create({ roomId: 'room_1', roomName: '保留', platform: 'bilibili', streamSessionId: 's5', streamTitle: 't' });
    services.recordings.update(rec.id, { state: 'awaiting_confirmation', filePath: file, fileSizeBytes: 4 });

    const bad = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec.id}/confirm`, headers: HOST, payload: { keep: 'yes' } });
    expect(bad.statusCode).toBe(422);

    const kept = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec.id}/confirm`, headers: HOST, payload: { keep: true } });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().recording.state).toBe('completed');
    await expect(access(file)).resolves.toBeUndefined();

    const oldName = path.join(dir, 'original-name.flv');
    const newName = path.join(dir, '用户指定名称.flv');
    await writeFile(oldName, 'FLV3');
    const renamed = services.recordings.create({ roomId: 'room_1', roomName: '改名', platform: 'bilibili', streamSessionId: 's7', streamTitle: 't' });
    services.recordings.update(renamed.id, { state: 'awaiting_confirmation', filePath: oldName, fileSizeBytes: 4 });
    const renamedResult = await app.inject({ method: 'POST', url: `/api/v1/recordings/${renamed.id}/confirm`, headers: HOST, payload: { keep: true, fileName: '用户指定名称' } });
    expect(renamedResult.statusCode).toBe(200);
    expect(renamedResult.json().recording.filePath).toBe(newName);
    await expect(access(oldName)).rejects.toBeTruthy();
    await expect(access(newName)).resolves.toBeUndefined();

    const file2 = path.join(dir, 'seg2.flv');
    await writeFile(file2, 'FLV2');
    const rec2 = services.recordings.create({ roomId: 'room_1', roomName: '丢弃', platform: 'bilibili', streamSessionId: 's6', streamTitle: 't' });
    services.recordings.update(rec2.id, { state: 'awaiting_confirmation', filePath: file2, fileSizeBytes: 4 });
    const del = await app.inject({ method: 'POST', url: `/api/v1/recordings/${rec2.id}/confirm`, headers: HOST, payload: { keep: false } });
    expect(del.statusCode).toBe(204);
    expect(services.recordings.get(rec2.id)).toBeNull();
    await sleep(20);
    await expect(access(file2)).rejects.toBeTruthy();
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

  it('精彩时刻导出失败时清理半成品；已选择不保留则删除记录并推送删除事件', async () => {
    const services = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-highlight-failed-'));
    services.settings.save({ recordingDirectory: dir, confirmAfterComplete: true });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/100', displayName: '精彩时刻' });
    services.rooms.setLiveStatus(room.id, 'live');
    let failExport!: (error: Error) => void;
    const buffer = {
      availableSeconds: () => 30,
      exportTo: async () => new Promise<never>((_resolve, reject) => { failExport = reject; }),
    };
    (services.manager as unknown as { highlightBuffers: Map<string, unknown> }).highlightBuffers.set(room.id, buffer);
    const deleted: string[] = [];
    services.events.on((event) => { if (event.type === 'recording:deleted') deleted.push(event.data.id); });

    const { recordingId } = await services.manager.exportHighlight(room.id, 10);
    expect(services.manager.deferHighlightConfirmation(recordingId, false)).toBe(true);
    failExport(new Error('disk failed'));
    await sleep(20);

    expect(services.recordings.get(recordingId)).toBeNull();
    expect(deleted).toContain(recordingId);
  });

  it('精彩时刻导出 watchdog 会中止卡住的复制并收口为失败，不会永久停在待确认', async () => {
    const services = newServices();
    const clock = services.clock as FakeClock;
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-highlight-timeout-'));
    services.settings.save({ recordingDirectory: dir, confirmAfterComplete: true });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/101', displayName: '卡住' });
    services.rooms.setLiveStatus(room.id, 'live');
    const buffer = {
      availableSeconds: () => 30,
      exportTo: async (_output: string, _seconds: number, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })),
    };
    (services.manager as unknown as { highlightBuffers: Map<string, unknown> }).highlightBuffers.set(room.id, buffer);

    const { recordingId } = await services.manager.exportHighlight(room.id, 10);
    expect(services.manager.deferHighlightConfirmation(recordingId, true)).toBe(true);
    clock.advance(HIGHLIGHT_EXPORT_IDLE_TIMEOUT_MS + 1);
    await sleep(20);

    const rec = services.recordings.get(recordingId)!;
    expect(rec.state).toBe('failed');
    expect(rec.highlightExportPending).toBeUndefined();
  });

  it('精彩时刻导出持续报告字节进度时刷新 watchdog，不会因总耗时被误中止', async () => {
    const services = newServices();
    const clock = services.clock as FakeClock;
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-highlight-progress-'));
    services.settings.save({ recordingDirectory: dir, confirmAfterComplete: true });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/102', displayName: '慢盘' });
    services.rooms.setLiveStatus(room.id, 'live');
    let reportProgress!: (bytes: number) => void;
    let failExport!: (error: Error) => void;
    const buffer = {
      availableSeconds: () => 30,
      exportTo: async (_output: string, _seconds: number, _signal?: AbortSignal, onProgress?: (bytes: number) => void) =>
        new Promise<never>((_resolve, reject) => {
          reportProgress = onProgress!;
          failExport = reject;
        }),
    };
    (services.manager as unknown as { highlightBuffers: Map<string, unknown> }).highlightBuffers.set(room.id, buffer);

    const { recordingId } = await services.manager.exportHighlight(room.id, 10);
    clock.advance(HIGHLIGHT_EXPORT_IDLE_TIMEOUT_MS - 1);
    reportProgress(64 * 1024);
    clock.advance(HIGHLIGHT_EXPORT_IDLE_TIMEOUT_MS - 1);
    expect(services.recordings.get(recordingId)!.state).toBe('awaiting_confirmation');

    failExport(new Error('stop test'));
    await sleep(20);
    expect(services.recordings.get(recordingId)!.state).toBe('failed');
  });

  it('导出完成后的落库异常仍走失败收口，不会因已撤掉 watchdog 而永久挂起', async () => {
    const services = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-highlight-post-export-'));
    services.settings.save({ recordingDirectory: dir, confirmAfterComplete: true });
    const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/103', displayName: '落库异常' });
    services.rooms.setLiveStatus(room.id, 'live');
    let completeExport!: () => void;
    const buffer = {
      availableSeconds: () => 30,
      exportTo: async () => new Promise<{ bytes: number; actualSeconds: number }>((resolve) => { completeExport = () => resolve({ bytes: 10, actualSeconds: 10 }); }),
    };
    (services.manager as unknown as { highlightBuffers: Map<string, unknown> }).highlightBuffers.set(room.id, buffer);

    const { recordingId } = await services.manager.exportHighlight(room.id, 10);
    const originalUpdate = services.recordings.update.bind(services.recordings);
    let throwOnce = true;
    (services.recordings as unknown as { update: typeof services.recordings.update }).update = ((id, patch) => {
      if (id === recordingId && throwOnce && patch.fileSizeBytes === 10) {
        throwOnce = false;
        throw new Error('database transient failure');
      }
      return originalUpdate(id, patch);
    }) as typeof services.recordings.update;
    completeExport();
    await sleep(20);

    expect(services.recordings.get(recordingId)!.state).toBe('failed');
  });

  it('重启不会把尚在导出的精彩时刻误标为 completed；已排队的不保留会被兑现', async () => {
    const services = newServices();
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-highlight-recover-'));
    const rec = services.recordings.create({ roomId: 'room_1', roomName: 'x', platform: 'bilibili', streamSessionId: null, streamTitle: '精彩时刻' });
    services.recordings.update(rec.id, {
      state: 'awaiting_confirmation',
      filePath: path.join(dir, 'partial.flv'),
      highlightExportPending: true,
      highlightConfirmationDecision: false,
    });

    services.manager.resumePendingConfirmations();

    expect(services.recordings.get(rec.id)).toBeNull();
  });
});
