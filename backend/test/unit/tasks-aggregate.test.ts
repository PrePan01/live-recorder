import { describe, expect, it } from 'vitest';
import { buildServices } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildApp } from '../../src/api/server.js';

/**
 * 任务进度聚合端点（task #102）：四类在途任务统一 DTO、完成即离在途扫描、
 * 失败人话契约随行（error 字段）。
 */

function host(app: { inject: (o: Record<string, unknown>) => Promise<{ statusCode: number; json: () => any }> }) {
  return (o: Record<string, unknown>) => app.inject({ ...o, headers: { host: '127.0.0.1:43120' } });
}

async function seed() {
  const clock = new FakeClock(Date.now());
  const services = buildServices({ dbPath: ':memory:', clock });
  const room = services.rooms.create({
    platform: 'bilibili',
    url: 'https://live.bilibili.com/1',
    displayName: '任务聚合',
  });
  const mk = (title: string, extra: Record<string, unknown> = {}) =>
    services.recordings.create({
      roomId: room.id,
      roomName: room.displayName,
      platform: 'bilibili',
      streamSessionId: `s_${title}`,
      streamTitle: title,
      ...extra,
    });
  return { clock, services, room, mk };
}

describe('GET /api/v1/tasks（四类在途聚合）', () => {
  it('四类在途各出一条统一 DTO；终态即离在途扫描', async () => {
    const { clock, services, mk } = await seed();
    // ① 片段导出在途
    const clip = mk('片段甲', { origin: 'clip' });
    services.recordings.update(clip.id, { state: 'processing' });
    // ② 管线在途（含进度四列）
    const pRec = mk('管线乙');
    const run = services.pipeline.repo.createRun({ recordingId: pRec.id, configSnapshot: {} });
    services.pipeline.repo.setRunProgress(run.id, {
      progressStep: 'convert',
      progressPct: 42,
      heartbeatAt: new Date(clock.now()).toISOString(),
      etaSeconds: 30,
    });
    // ③ 上传在途
    const uRec = mk('上传丙');
    const job = services.uploader.uploadRepo.create({ recordingId: uRec.id, idempotencyKey: 'k1' });
    services.uploader.uploadRepo.update(job!.id, { status: 'running', progress: 60 });
    // ④ 诊断/导出在途
    const eRec = mk('导出丁');
    const exportJob = services.exporter.exportRepo.create({ recordingIds: [eRec.id] });

    const { app } = buildApp(services);
    const inj = host(app);
    const res = await inj({ method: 'GET', url: '/api/v1/tasks' });
    expect(res.statusCode).toBe(200);
    const byKind = new Map(res.json().tasks.map((t: { kind: string }) => [t.kind, t]));
    expect(byKind.size).toBe(4);
    const clipTask = byKind.get('clip');
    expect(clipTask.title).toBe('片段甲');
    expect(clipTask.state).toBe('exporting');
    const pipelineTask = byKind.get('pipeline');
    expect(pipelineTask.title).toBe('管线乙');
    expect(pipelineTask.progressPercent).toBe(42);
    expect(pipelineTask.step).toBe('convert');
    expect(pipelineTask.etaSeconds).toBe(30);
    const uploadTask = byKind.get('upload');
    expect(uploadTask.title).toBe('上传丙');
    expect(uploadTask.progressPercent).toBe(60);
    const exportTask = byKind.get('export');
    expect(exportTask.title).toBe('导出丁');
    expect(exportTask.state).toBe('queued');

    // 终态即离在途扫描（宽限=前端层，后端不存已读）
    services.pipeline.repo.setRunStatus(run.id, 'ok');
    services.uploader.uploadRepo.update(job!.id, { status: 'ok' });
    services.exporter.exportRepo.update(exportJob.id, { status: 'ok' });
    services.recordings.update(clip.id, { state: 'completed' });
    const after = await inj({ method: 'GET', url: '/api/v1/tasks' });
    expect(after.json().tasks).toHaveLength(0);
    // 携带已观察 id 时返回真实终态，让前端展示完成，而不是冻结最后一次进度。
    const settled = await inj({ method: 'GET', url: `/api/v1/tasks?ids=${[clip.id, run.id, job!.id, exportJob.id].join(',')}` });
    expect(settled.json().tasks).toHaveLength(4);
    for (const task of settled.json().tasks) {
      expect(task.state).toBe('completed');
      expect(task.progressPercent).toBe(100);
      expect(task.etaSeconds).toBeNull();
      expect(task.step).toBeNull();
    }
    await app.close();
  });

  it('失败人话契约随行：error 字段携带既有失败文案；失败终态即离扫描', async () => {
    const { services, mk } = await seed();
    const uRec = mk('上传重试件');
    const job = services.uploader.uploadRepo.create({ recordingId: uRec.id, idempotencyKey: 'k2' });
    // 重试中携带上轮人话文案（error 位随行）
    services.uploader.uploadRepo.update(job!.id, { status: 'running', progress: 10, error: '网络中断，请检查网络后重试' });
    const { app } = buildApp(services);
    const inj = host(app);
    const res = await inj({ method: 'GET', url: '/api/v1/tasks' });
    const tasks = res.json().tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].error).toBe('网络中断，请检查网络后重试');
    // 失败终态=不在在途扫描（展示宽限由前端做）
    services.uploader.uploadRepo.update(job!.id, { status: 'failed' });
    const after = await inj({ method: 'GET', url: '/api/v1/tasks' });
    expect(after.json().tasks).toHaveLength(0);
    const failed = await inj({ method: 'GET', url: `/api/v1/tasks?ids=${job!.id}` });
    expect(failed.json().tasks[0]).toMatchObject({ state: 'failed', progressPercent: 10, error: '网络中断，请检查网络后重试' });
    await app.close();
  });

  it('后处理排队交接不报完成，部分完成及删除不伪报成功', async () => {
    const { services, mk } = await seed();
    const clip = mk('待后处理', { origin: 'clip' });
    services.recordings.update(clip.id, { state: 'completed', pipelineStatus: 'queued' });
    const rec = mk('部分成功');
    const run = services.pipeline.repo.createRun({ recordingId: rec.id, configSnapshot: {} });
    services.pipeline.repo.setRunStatus(run.id, 'partial');
    const { app } = buildApp(services);
    const inj = host(app);
    const response = await inj({ method: 'GET', url: `/api/v1/tasks?ids=${clip.id},${run.id},rec_missing` });
    expect(response.json().tasks).toHaveLength(1);
    expect(response.json().tasks[0]).toMatchObject({ id: run.id, state: 'partial' });
    expect(response.json().tasks[0].progressPercent).not.toBe(100);
    await app.close();
  });
});

describe('导出创建校验（不再延迟失败）', () => {
  it('不存在的录制=4xx 人话；空清单=4xx', async () => {
    const { services } = await seed();
    await expect(
      services.exporter.create(['rec_missing'], '/tmp'),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(services.exporter.create([], '/tmp')).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });
});

describe('clip 与其后处理管线合并单卡（#106）', () => {
  it('clip 管线相位并入同一条卡（不双计）；普通录制管线照旧单独出', async () => {
    const { services, mk } = await seed();
    // clip 行被管线置回 processing（双相位语义），其 run 在途
    const clip = mk('合并片段', { origin: 'clip' });
    services.recordings.update(clip.id, { state: 'processing' });
    const clipRun = services.pipeline.repo.createRun({ recordingId: clip.id, configSnapshot: {} });
    services.pipeline.repo.setRunProgress(clipRun.id, {
      progressStep: 'compress',
      progressPct: 70,
      heartbeatAt: new Date(Date.now()).toISOString(),
      etaSeconds: 15,
    });
    // 普通录制的管线照旧单独出
    const normal = mk('普通管线');
    services.pipeline.repo.createRun({ recordingId: normal.id, configSnapshot: {} });

    const { app } = buildApp(services);
    const inj = host(app);
    const res = await inj({ method: 'GET', url: '/api/v1/tasks' });
    const tasks = res.json().tasks as Array<{ id: string; kind: string; state: string; progressPercent?: number; step?: string | null }>;
    // clip 只有一张卡（其 run 不再单独出条）、角标不双计
    expect(tasks.filter((t) => t.id === clip.id || t.id === clipRun.id)).toHaveLength(1);
    const merged = tasks.find((t) => t.kind === 'clip')!;
    expect(merged.state).toBe('post_processing'); // 相位切换：导出中→后处理中
    // 动态 ETA 合成（#110）：两相位 0-100 连续值（精确数学在 task-progress 纯函数用例钉）
    expect(merged.progressPercent).toBeGreaterThanOrEqual(0);
    expect(merged.progressPercent).toBeLessThanOrEqual(100);
    expect(merged.step).toBe('compress');
    // 普通录制管线不受影响
    const pipelineTask = tasks.find((t) => t.kind === 'pipeline')!;
    expect(pipelineTask.title).toBe('普通管线');
    await app.close();
  });
});
