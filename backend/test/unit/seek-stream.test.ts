import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildServices, type Services } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildApp } from '../../src/api/server.js';
import {
  SeekService,
  MAX_SEEK_SESSIONS,
  defaultSeekStreamFactory,
  type SeekFeedPlan,
  type SeekProcFactory,
} from '../../src/core/seek-service.js';
import {
  SeekIndexWriter,
  noteSeekCoverage,
  resetSeekCoverageForTest,
  seekSidecarPath,
} from '../../src/storage/seek-index.js';
import { FlvTimestampNormalizer, type FlvTagInfo } from '../../src/recorder/stream-recorder.js';

/* ---------- FLV 构造（与真实流同构） ---------- */

function flvTag(type: number, ts: number, data: Buffer): Buffer {
  const head = Buffer.alloc(11);
  head[0] = type;
  head.writeUIntBE(data.length, 1, 3);
  head.writeUIntBE(ts & 0xffffff, 4, 3);
  head[7] = (ts >>> 24) & 0xff;
  const prev = Buffer.alloc(4);
  prev.writeUInt32BE(11 + data.length, 0);
  return Buffer.concat([head, data, prev]);
}

function videoPayload(keyframe: boolean, seq: boolean): Buffer {
  const flags = (keyframe ? 0x10 : 0x20) | 0x07;
  return Buffer.concat([Buffer.from([flags, seq ? 0 : 1, 0, 0, 0]), Buffer.alloc(64)]);
}

function audioPayload(seq: boolean): Buffer {
  return Buffer.concat([Buffer.from([0xaf, seq ? 0 : 1]), Buffer.alloc(32)]);
}

const TAG_SPECS = [
  { type: 9, ts: 0, seq: true, key: true },
  { type: 8, ts: 0, seq: true, key: false },
  { type: 9, ts: 0, seq: false, key: true },
  { type: 9, ts: 2000, seq: false, key: false },
  { type: 9, ts: 4000, seq: false, key: true },
  { type: 9, ts: 8000, seq: false, key: true },
  { type: 9, ts: 12000, seq: false, key: true },
  { type: 8, ts: 12100, seq: false, key: false },
] as const;

function buildSampleFlv(): Buffer {
  const head = Buffer.concat([
    Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09]),
    Buffer.alloc(4),
  ]);
  return Buffer.concat([
    head,
    ...TAG_SPECS.map((s) => flvTag(s.type, s.ts, s.type === 9 ? videoPayload(s.key, s.seq) : audioPayload(s.seq))),
  ]);
}

/** 标签 → 文件偏移真值表（含未记索引的标签）。 */
function tagLayout(buf: Buffer): Array<{ offset: number; type: number; ts: number; seq: boolean; key: boolean }> {
  const out: Array<{ offset: number; type: number; ts: number; seq: boolean; key: boolean }> = [];
  let off = 13;
  let i = 0;
  while (off + 11 <= buf.length) {
    const ds = (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!;
    const spec = TAG_SPECS[i]!;
    out.push({ offset: off, type: spec.type, ts: spec.ts, seq: spec.seq, key: spec.key });
    off += 11 + ds + 4;
    i += 1;
  }
  return out;
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** 确定性等待：轮询到条件成立（不靠固定时序赌快慢，CI 负载下稳健）。 */
async function waitUntil(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('waitUntil timeout');
    await tick(10);
  }
}

/** 假起流进程：不碰 ffmpeg（CI 不假设本机工具），记录计划/kill，可灌字节、可收尾。 */
function fakeProcs() {
  const calls: Array<{ plan: SeekFeedPlan; killed: boolean; stdout: PassThrough }> = [];
  const factory: SeekProcFactory = (plan) => {
    const stdout = new PassThrough();
    const record = { plan, killed: false, stdout };
    calls.push(record);
    const done = new Promise<void>((resolve) => stdout.on('end', () => resolve()));
    return {
      stdout,
      kill: () => {
        record.killed = true;
        stdout.end();
      },
      done,
    };
  };
  return { factory, calls };
}

async function setup() {
  resetSeekCoverageForTest();
  const dir = await mkdtemp(path.join(tmpdir(), 'seek-svc-'));
  const filePath = path.join(dir, 'rec.flv');
  await writeFile(filePath, buildSampleFlv());
  const flv = buildSampleFlv();
  // 索引由写入器落盘（关键帧 0/4/8/12 秒 + 序列头）
  const writer = await SeekIndexWriter.open(filePath, 0);
  for (const tag of tagLayout(flv)) {
    if (tag.seq) writer!.note({ t: tag.ts, b: tag.offset, s: 1, k: tag.type === 8 ? 8 : 9 });
    else if (tag.key) writer!.note({ t: tag.ts, b: tag.offset });
  }
  await writer!.close();

  const services: Services = buildServices({ dbPath: ':memory:', clock: new FakeClock() });
  const room = services.rooms.create({
    platform: 'bilibili',
    url: 'https://live.bilibili.com/1',
    displayName: '跳播测试',
  });
  const rec = services.recordings.create({
    roomId: room.id,
    roomName: room.displayName,
    platform: 'bilibili',
    streamSessionId: 's1',
    streamTitle: 't',
  });
  services.recordings.update(rec.id, { filePath, state: 'recording' });
  const { factory, calls } = fakeProcs();
  services.seek = new SeekService(services, factory);
  const { app } = buildApp(services);
  return { services, app, filePath, rec, factory, calls, flv };
}

function host(app: { inject: (o: Record<string, unknown>) => Promise<{ statusCode: number; json: () => any; body: string; headers: Record<string, string> }> }) {
  return (o: Record<string, unknown>) => app.inject({ ...o, headers: { host: '127.0.0.1:43120', ...(o.headers ?? {}) } });
}

describe('跳播 seek-stream / seek-prewarm', () => {
  it('起流 200：关键帧吸附 + X-Seek-Start-Second 真值 + 计划=FLV头/字节区间到已写尾', async () => {
    const { app, calls, flv, rec } = await setup();
    const inj = host(app);
    const pending = inj({ method: 'GET', url: `/api/v1/recordings/${rec.id}/seek-stream?second=5` });
    await waitUntil(() => calls.length >= 1);
    expect(calls).toHaveLength(1);
    const plan = calls[0]!.plan;
    expect(plan.prefix.subarray(0, 3).toString('ascii')).toBe('FLV');
    // 4 秒关键帧的偏移：=头 13 + 前四个标签长
    const layout = tagLayout(flv);
    expect(plan.from).toBe(layout[4]!.offset);
    expect(plan.to).toBe(flv.length);
    calls[0]!.stdout.end(Buffer.from('MP4DATA'));
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-seek-start-second']).toBe('4');
    expect(res.headers['content-type']).toContain('video/x-flv');
    expect(res.body).toBe('MP4DATA');
    await app.close();
  });

  it('每次请求=新代际：同秒也杀旧起新（恒 1 路在途）、换秒同语义', async () => {
    const { services, calls, rec } = await setup();
    const fresh = services.recordings.get(rec.id)!;
    await services.seek.openStream(fresh, 5);
    expect(calls).toHaveLength(1);
    // 同秒再开：新代际杀旧起新（重放/挂靠路已随瞬灌根因一并拆除，恒 1 路在途）
    await services.seek.openStream(fresh, 5);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.killed).toBe(true);
    // 换秒：同语义杀旧起新
    await services.seek.openStream(fresh, 9);
    expect(calls).toHaveLength(3);
    expect(calls[1]!.killed).toBe(true);
    expect(calls[2]!.killed).toBe(false);
    calls[2]!.stdout.end();
  });

  it('消费端断开即销流：弃流不再全速灌（瞬灌/overflow 根源拆除）', async () => {
    const { services, calls, rec } = await setup();
    const fresh = services.recordings.get(rec.id)!;
    const { stream } = await services.seek.openStream(fresh, 5);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.killed).toBe(false);
    // 消费端（HTTP 响应/播放器）断开 → 会话立即销毁，不再把剩余窗口灌向虚空
    stream.destroy();
    await waitUntil(() => calls[0]!.killed);
  });

  it('并发上限独立小上限：只拒新不杀在途（409 人话）', async () => {
    const { app, services, calls, filePath, rec } = await setup();
    const inj = host(app);
    const room = services.rooms.list()[0]!;
    const recs = [services.recordings.get(rec.id)!];
    for (let i = 1; i < MAX_SEEK_SESSIONS + 1; i += 1) {
      const r = services.recordings.create({
        roomId: room.id,
        roomName: room.displayName,
        platform: 'bilibili',
        streamSessionId: `x${i}`,
        streamTitle: 't',
      });
      services.recordings.update(r.id, { filePath, state: 'recording' });
      recs.push(services.recordings.get(r.id)!);
    }
    const pending: Array<Promise<unknown>> = [];
    for (const r of recs.slice(0, MAX_SEEK_SESSIONS)) {
      await services.seek.openStream(r, 5);
    }
    expect(calls).toHaveLength(MAX_SEEK_SESSIONS);
    const overflow = await inj({ method: 'GET', url: `/api/v1/recordings/${recs[MAX_SEEK_SESSIONS]!.id}/seek-stream?second=5` });
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json().error.code).toBe('CONCURRENT_LIMIT_REACHED');
    // 只拒新：在途会话未被杀
    expect(calls.filter((c) => !c.killed)).toHaveLength(MAX_SEEK_SESSIONS);
    for (const c of calls) c.stdout.end();
    await app.close();
  });

  it('预热 202 幂等零进程；响应体带起播真值 startSecond；参数非法 422', async () => {
    const { app, calls, rec } = await setup();
    const inj = host(app);
    const ok = await inj({ method: 'POST', url: `/api/v1/recordings/${rec.id}/seek-prewarm`, payload: { second: 5 } });
    expect(ok.statusCode).toBe(202);
    // 吸附后的真值（4 秒关键帧）：起流同秒同吸附点，前端用它+currentTime 精确映射源时间轴
    expect(ok.json().startSecond).toBe(4);
    const again = await inj({ method: 'POST', url: `/api/v1/recordings/${rec.id}/seek-prewarm`, payload: { second: 5 } });
    expect(again.statusCode).toBe(202);
    expect(again.json().startSecond).toBe(4);
    expect(calls).toHaveLength(0); // 零进程
    const bad = await inj({ method: 'POST', url: `/api/v1/recordings/${rec.id}/seek-prewarm`, payload: { second: -1 } });
    expect(bad.statusCode).toBe(422);
    const badGet = await inj({ method: 'GET', url: `/api/v1/recordings/${rec.id}/seek-stream?second=abc` });
    expect(badGet.statusCode).toBe(422);
    await app.close();
  });

  it('作用范围=仅录制中：停录后拒绝且在途会话被收掉；历史行不带索引字段', async () => {
    const { app, services, calls, rec } = await setup();
    const inj = host(app);
    await services.seek.openStream(services.recordings.get(rec.id)!, 5);
    expect(calls).toHaveLength(1);
    services.recordings.update(rec.id, { state: 'completed' });
    services.events.emit({ type: 'recording:updated', data: services.recordings.get(rec.id)! });
    expect(calls[0]!.killed).toBe(true);
    const rejected = await inj({ method: 'GET', url: `/api/v1/recordings/${rec.id}/seek-stream?second=5` });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.message).toContain('仅录制中的录像支持跳播');
    const list = await inj({ method: 'GET', url: '/api/v1/recordings' });
    expect(list.json().items[0].seekIndexState).toBeUndefined();
    await app.close();
  });

  it('索引建立中显式拒绝（人话），补扫建好自动恢复', async () => {
    const { app, services, rec, filePath, calls } = await setup();
    const inj = host(app);
    // 模拟「重启前写入的前缀缺口」→ building（清掉 setup 里写入器登记的全覆盖）
    resetSeekCoverageForTest();
    noteSeekCoverage(filePath, 5000);
    const list1 = await inj({ method: 'GET', url: '/api/v1/recordings' });
    expect(list1.json().items[0].seekIndexState).toBe('building');
    const blocked = await inj({ method: 'GET', url: `/api/v1/recordings/${rec.id}/seek-stream?second=5` });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.message).toContain('正在建立定位索引');
    // 补扫完成后自动恢复
    await services.seek.startScan(filePath, rec.id);
    const list2 = await inj({ method: 'GET', url: '/api/v1/recordings' });
    expect(list2.json().items[0].seekIndexState).toBe('ready');
    await services.seek.openStream(services.recordings.get(rec.id)!, 5);
    expect(calls).toHaveLength(1);
    calls[0]!.stdout.end();
    await app.close();
  });

  it('默认起流=FLV 直通字节流（零进程）：头+序列头+从关键帧偏移起的字节到已写尾', async () => {
    const { services, filePath, rec, flv } = await setup();
    const real = new SeekService(services); // 默认工厂（直通，不注入假进程）
    const { stream, startSecond } = await real.openStream(services.recordings.get(rec.id)!, 5);
    expect(startSecond).toBe(4);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    expect(body.subarray(0, 3).toString('ascii')).toBe('FLV');
    // 尾部字节=源文件尾（从关键帧偏移起到请求时刻已写尾部）
    expect(body.subarray(body.length - 16)).toEqual(flv.subarray(flv.length - 16));
    const from = tagLayout(flv)[4]!.offset;
    expect(body.length).toBeGreaterThan(flv.length - from);
    // 索引仍在、文件未被写坏（只读直通）
    expect(filePath).toBeTruthy();
  });

  it('不同目标秒返回不同吸附秒：索引增长后缓存必须刷新（真值不错位）', async () => {
    const { services, rec } = await setup();
    const fresh = services.recordings.get(rec.id)!;
    // 自建样本：关键帧 0/4/8/12/20/40 秒，只先落前半段索引（模拟录制还年轻）
    const dir = await mkdtemp(path.join(tmpdir(), 'seek-grow-'));
    const filePath = path.join(dir, 'grow.flv');
    const head = Buffer.concat([Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09]), Buffer.alloc(4)]);
    const specs = [
      { ts: 0, key: true }, { ts: 4000, key: true }, { ts: 8000, key: true },
      { ts: 12000, key: true }, { ts: 20000, key: true }, { ts: 40000, key: true },
    ];
    const tags = specs.map((s) => flvTag(9, s.ts, videoPayload(s.key, false)));
    await writeFile(filePath, Buffer.concat([head, ...tags]));
    let off = 13;
    const offsets = tags.map((t) => {
      const at = off;
      off += t.length;
      return at;
    });
    services.recordings.update(rec.id, { filePath });
    const target = services.recordings.get(rec.id)!;

    const early = await SeekIndexWriter.open(filePath, 0);
    for (let i = 0; i < 4; i += 1) early!.note({ t: specs[i]!.ts, b: offsets[i]! });
    await early!.close();
    expect((await services.seek.prewarm(target, 5)).startSecond).toBe(4);

    // 录制继续增长：新关键帧条目追加落盘
    const grown = await SeekIndexWriter.open(filePath, 9999);
    grown!.note({ t: 20000, b: offsets[4]! });
    grown!.note({ t: 40000, b: offsets[5]! });
    await grown!.close();

    // 修复前：缓存不过期 → 两次都吸到旧末条 12 秒；修复后各自命中自己的关键帧
    const b = await services.seek.prewarm(target, 20);
    const c = await services.seek.prewarm(target, 40);
    expect(b.startSecond).toBe(20);
    expect(c.startSecond).toBe(40);
  });

  it('索引与文件对不上=失效重建绝不硬播', async () => {
    const { app, rec, filePath } = await setup();
    const inj = host(app);
    // 外部改动：条目偏移全部失效（模拟文件被换过）
    await import('node:fs/promises').then((m) => m.mkdir(path.dirname(seekSidecarPath(filePath)), { recursive: true }));
    await writeFile(seekSidecarPath(filePath), '{"v":1}\n{"t":4000,"b":999999}\n');
    const res = await inj({ method: 'GET', url: `/api/v1/recordings/${rec.id}/seek-stream?second=5` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/重建|建立定位索引/);
    await app.close();
  });
});

describe('写盘链索引钩子（归一化器 onTag）', () => {
  it('关键帧/序列头回调带正确落盘偏移（含续录基准、跨块标签）', () => {
    const flv = buildSampleFlv();
    const layout = tagLayout(flv);
    const infos: FlvTagInfo[] = [];
    const norm = new FlvTimestampNormalizer({
      appendBaseBytes: 100,
      onTag: (i) => infos.push(i),
    });
    // 分块喂，覆盖跨块标签
    norm.push(flv.subarray(0, 40));
    norm.push(flv.subarray(40));
    norm.remaining();

    // 只记关键帧+序列头：4 关键帧 + 2 序列头
    expect(infos.filter((i) => i.seqHeader)).toHaveLength(2);
    expect(infos.filter((i) => i.keyframe)).toHaveLength(4);
    // 偏移对照真值表：基准 100 + 标签在文件里的偏移（13 字节头之后）
    const expected = layout.filter((t) => t.seq || t.key);
    infos.forEach((info, i) => {
      expect(info.fileOffset).toBe(100 + expected[i]!.offset);
    });
    // 写入时间戳为归一化后的相对值
    expect(infos.every((i) => i.ts < 60_000)).toBe(true);
  });
});

describe('起流供给限速（P0 字节不同步根因面·二轮）', () => {
  it('消费端断开即销流后，旧会话不再瞬灌（架构性拆除弃流路径）', async () => {
    const { services, calls, rec } = await setup();
    const fresh = services.recordings.get(rec.id)!;
    const { stream } = await services.seek.openStream(fresh, 5);
    stream.destroy();
    await waitUntil(() => calls[0]!.killed);
    expect(calls[0]!.killed).toBe(true);
  });

  it('默认工厂 burst 后按码率限速供给（不再整窗瞬灌）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'seek-pace-'));
    const big = path.join(dir, 'big.bin');
    await writeFile(big, Buffer.alloc(10 * 1024 * 1024));
    const proc = defaultSeekStreamFactory({
      filePath: big,
      prefix: Buffer.alloc(13),
      from: 0,
      to: 10 * 1024 * 1024,
      paceBytesPerMs: 2_000, // 2MB/s
    });
    let received = 0;
    proc.stdout.on('data', (c: Buffer) => {
      received += c.length;
    });
    await tick(300);
    // burst 4MB + 300ms×2MB/s≈0.6MB + 调度松量：远小于整窗 10MB（修复前 300ms 内灌完）
    expect(received).toBeLessThan(6 * 1024 * 1024);
    proc.kill();
  });
});

describe('索引冻结自愈（#94 四轮根因面）', () => {
  it('目标超出索引覆盖=显式「建立中」+补扫补条目后各归各位（不再恒吸旧条目）', async () => {
    const { services, calls, rec } = await setup();
    // 自建样本：关键帧 0/4/8/12/30 秒，但索引只落前段——模拟写入器中途死亡、索引冻结在 12s
    const dir = await mkdtemp(path.join(tmpdir(), 'seek-frozen-'));
    const filePath = path.join(dir, 'frozen.flv');
    const head = Buffer.concat([Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09]), Buffer.alloc(4)]);
    const specs = [
      { ts: 0 }, { ts: 4000 }, { ts: 8000 }, { ts: 12000 }, { ts: 30000 },
    ];
    const tags = specs.map((s) => flvTag(9, s.ts, videoPayload(true, false)));
    await writeFile(filePath, Buffer.concat([head, ...tags]));
    let off = 13;
    const offsets = tags.map((t) => {
      const at = off;
      off += t.length;
      return at;
    });
    services.recordings.update(rec.id, { filePath });
    const target = services.recordings.get(rec.id)!;
    const frozen = await SeekIndexWriter.open(filePath, 0);
    for (let i = 0; i < 4; i += 1) frozen!.note({ t: specs[i]!.ts, b: offsets[i]! });
    await frozen!.close();

    // 修复前：请求 30s 会硬吸 12s 条目（拖哪都跳同一位置）；修复后=显式「建立中」
    await expect(
      services.seek.openStream(target, 30),
    ).rejects.toMatchObject({ code: 'RECORDING_START_FAILED' });

    // 补扫读真文件补条目（自愈）→ 再请求各归各位
    await services.seek.startScan(filePath, target.id);
    const { startSecond, stream } = await services.seek.openStream(target, 30);
    expect(startSecond).toBe(30);
    stream.resume();
    await waitUntil(() => calls.some((c) => !c.killed));
    for (const c of calls) c.stdout.end();
  });
});
