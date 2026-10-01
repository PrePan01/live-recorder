import { describe, expect, it } from 'vitest';
import { buildServices } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { PipelineManager } from '../../src/core/pipeline-manager.js';

/**
 * 后处理优化三条（task #111）：删除联动取消在途任务、槽位看门狗、[pipeline] 日志。
 */

function setup() {
  const clock = new FakeClock(Date.now());
  const services = buildServices({ dbPath: ':memory:', clock });
  const room = services.rooms.create({
    platform: 'bilibili',
    url: 'https://live.bilibili.com/1',
    displayName: '管线运维',
  });
  const mk = (title: string) =>
    services.recordings.create({
      roomId: room.id,
      roomName: room.displayName,
      platform: 'bilibili',
      streamSessionId: `s_${title}`,
      streamTitle: title,
    });
  return { clock, services, room, mk };
}

describe('删除联动取消在途任务（#111 ①）', () => {
  it('cancel=队列出队标 failed+释放槽位+后续可派发', async () => {
    const { services, mk } = setup();
    const rec = mk('待取消');
    services.pipeline.repo.createRun({ recordingId: rec.id, configSnapshot: {} });
    services.pipeline.cancel(rec.id, '录制已删除');
    const run = services.pipeline.repo.runForRecording(rec.id)!;
    expect(run.status).toBe('failed');
    // 槽位释放：新任务可入队派发（不再被占死）
    const rec2 = mk('后续任务');
    services.pipeline.repo.createRun({ recordingId: rec2.id, configSnapshot: {} });
    services.pipeline.cancel(rec2.id);
    expect(services.pipeline.repo.runForRecording(rec2.id)!.status).toBe('failed');
    expect(services.pipeline.busy).toBe(false);
  });

  it('删除联动：DELETE 录制→其管线 run 标 failed（完整录制=取消后处理）', async () => {
    const { services, mk } = setup();
    const rec = mk('待删录制');
    services.recordings.update(rec.id, { state: 'completed', filePath: '/tmp/x.flv' });
    services.pipeline.repo.createRun({ recordingId: rec.id, configSnapshot: {} });
    // 走 manager 的丢弃链（与 DELETE 同一挂钩）
    services.manager.discardAfterConfirmation(rec.id);
    // 立即真正结束并删除：run 行随录制删除级联清除，不留孤儿。
    expect(services.pipeline.repo.runForRecording(rec.id)).toBeNull();
  });
});

describe('管线槽位看门狗（#111 ②）', () => {
  it('心跳超时强制收割标 failed；心跳鲜活不误杀', async () => {
    const { services, mk } = setup();
    const rec = mk('挂死任务');
    const run = services.pipeline.repo.createRun({ recordingId: rec.id, configSnapshot: {} });
    services.pipeline.repo.setRunStatus(run.id, 'running');
    // 模拟在跑占槽：心跳冻在 11 分钟前
    services.pipeline.repo.setRunProgress(run.id, {
      progressStep: 'compress',
      progressPct: 50,
      heartbeatAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      etaSeconds: null,
    });
    // 伪造占槽（正常派发由 pump 建立，此处直接验看门狗判定逻辑）
    (services.pipeline as unknown as { running: Set<string> }).running.add(rec.id);
    services.pipeline.checkWatchdog();
    expect(services.pipeline.repo.runForRecording(rec.id)!.status).toBe('failed');
    expect((services.pipeline as unknown as { running: Set<string> }).running.has(rec.id)).toBe(false);

    // 心跳鲜活不误杀
    const rec2 = mk('健康任务');
    const run2 = services.pipeline.repo.createRun({ recordingId: rec2.id, configSnapshot: {} });
    services.pipeline.repo.setRunStatus(run2.id, 'running');
    services.pipeline.repo.setRunProgress(run2.id, {
      progressStep: 'compress',
      progressPct: 50,
      heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      etaSeconds: null,
    });
    (services.pipeline as unknown as { running: Set<string> }).running.add(rec2.id);
    services.pipeline.checkWatchdog();
    expect(services.pipeline.repo.runForRecording(rec2.id)!.status).toBe('running');
  });
});

describe('[pipeline] 日志（#111 ③）', () => {
  it('入队/派发/取消时间线留痕（观测面闭合）', async () => {
    const { services, mk } = setup();
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(' '));
    };
    try {
      const rec = mk('日志任务');
      services.pipeline.enqueue(rec.id, 0, true);
      services.pipeline.cancel(rec.id, '录制已删除');
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      console.log = orig;
    }
    const joined = lines.filter((l) => l.startsWith('[pipeline]')).join('\n');
    expect(joined).toContain('cancel');
    expect(joined).toContain('enqueue');
  });
});

describe('看门狗阈值配置化（#111 收口口径 A）', () => {
  it('PIPELINE_HEARTBEAT_TIMEOUT_MS 环境变量覆盖生效；缺省仍 10 分钟', async () => {
    const prev = process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS;
    process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS = '30000';
    try {
      const { services, mk } = await (async () => {
        const clock = new FakeClock(Date.now());
        const s = buildServices({ dbPath: ':memory:', clock });
        const room = s.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/2', displayName: '阈值' });
        const rec = s.recordings.create({ roomId: room.id, roomName: room.displayName, platform: 'bilibili', streamSessionId: 'sx', streamTitle: '阈值任务' });
        return { services: s, mk: () => rec };
      })();
      expect((services.pipeline as unknown as { heartbeatTimeoutMs: number }).heartbeatTimeoutMs).toBe(30_000);
      // 45s 前心跳即被收割（缺省 10min 下不会）
      const run = services.pipeline.repo.createRun({ recordingId: mk().id, configSnapshot: {} });
      services.pipeline.repo.setRunStatus(run.id, 'running');
      services.pipeline.repo.setRunProgress(run.id, { progressStep: 'compress', progressPct: 50, heartbeatAt: new Date(Date.now() - 45_000).toISOString(), etaSeconds: null });
      (services.pipeline as unknown as { running: Set<string> }).running.add(mk().id);
      services.pipeline.checkWatchdog();
      expect(services.pipeline.repo.runForRecording(mk().id)!.status).toBe('failed');
    } finally {
      if (prev === undefined) delete process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS;
      else process.env.PIPELINE_HEARTBEAT_TIMEOUT_MS = prev;
    }
  });
});

describe('#112 删除录制中行：拦截+清理网', () => {
  it('API 拦截：录制中行删除=409 人话（先停止再删除），单删与批量同口径', async () => {
    const { services, mk } = setup();
    const rec = mk('录制中行');
    services.recordings.update(rec.id, { state: 'recording', filePath: '/tmp/live.flv' });
    const { buildApp } = await import('../../src/api/server.js');
    const { app } = buildApp(services);
    const inj = (o: Record<string, unknown>) =>
      app.inject({ ...o, headers: { host: '127.0.0.1:43120' } });
    const single = await inj({ method: 'DELETE', url: `/api/v1/recordings/${rec.id}` });
    expect(single.statusCode).toBe(409);
    expect(single.json().error.message).toContain('先停止录制');
    const batch = await inj({ method: 'POST', url: '/api/v1/recordings/batch-delete', payload: { ids: [rec.id] } });
    expect(batch.statusCode).toBe(409);
    await app.close();
  });

  it('清理网：行删而会话在录=停捕获+清房间态，房间不留残影', async () => {
    const { services, mk } = setup();
    const rec = mk('被删的在录');
    services.recordings.update(rec.id, { state: 'recording', filePath: '/tmp/live2.flv' });
    const room = services.rooms.list()[0]!;
    // 伪造在录会话（房间态被置 recording=残影源）
    services.rooms.setState(room.id, 'recording', { lastCheckedAt: new Date().toISOString(), lastError: null });
    const fakeSession = { recordingId: rec.id, stopRequested: false, requestedEndReason: undefined, size: 0 };
    (services.manager as unknown as { active: Map<string, unknown> }).active.set(room.id, fakeSession);
    await services.manager.stopActiveSessionForDeletion(rec.id);
    expect((services.manager as unknown as { active: Map<string, unknown> }).active.has(room.id)).toBe(false);
    expect(fakeSession.stopRequested).toBe(true);
    expect(services.rooms.get(room.id)!.state).not.toBe('recording');
  });
});
