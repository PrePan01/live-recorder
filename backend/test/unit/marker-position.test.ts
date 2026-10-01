import { describe, expect, it } from 'vitest';
import { buildServices } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { buildApp } from '../../src/api/server.js';

/**
 * 标记时间点（task #95 BE 协助面）：POST 接受 positionSeconds=当前预览播放头秒
 * （与 PATCH 同款校验），不带则回退「当前已录尾」——直播落尾部语义不变。
 */

function host(app: { inject: (o: Record<string, unknown>) => Promise<{ statusCode: number; json: () => any }> }) {
  return (o: Record<string, unknown>) => app.inject({ ...o, headers: { host: '127.0.0.1:43120' } });
}

async function setup() {
  const clock = new FakeClock(Date.now());
  const services = buildServices({ dbPath: ':memory:', clock });
  const room = services.rooms.create({
    platform: 'bilibili',
    url: 'https://live.bilibili.com/1',
    displayName: '标记时间',
  });
  const rec = services.recordings.create({
    roomId: room.id,
    roomName: room.displayName,
    platform: 'bilibili',
    streamSessionId: 's1',
    streamTitle: 't',
  });
  services.recordings.update(rec.id, { state: 'recording', filePath: '/tmp/marker-pos.flv' });
  // startedAt 钉到时钟基准（create 用真实时间会与 FakeClock 有亚秒漂移）。
  services.db
    .prepare('UPDATE recordings SET started_at = ? WHERE id = ?')
    .run(new Date(clock.now()).toISOString(), rec.id);
  clock.advance(60_000); // 已录制 60 秒
  const { app } = buildApp(services);
  return { services, app, rec };
}

describe('标记时间点=预览播放头秒（#95 BE 协助面）', () => {
  it('带 positionSeconds=落指定秒（不再恒落最右）；不带=回退当前已录尾（直播语义不变）', async () => {
    const { app, rec } = await setup();
    const inj = host(app);
    const at30 = await inj({
      method: 'POST',
      url: `/api/v1/recordings/${rec.id}/markers`,
      payload: { text: '播放头标记', positionSeconds: 30 },
    });
    expect(at30.statusCode).toBe(201);
    expect(at30.json().marker.positionSeconds).toBe(30);
    const fallback = await inj({
      method: 'POST',
      url: `/api/v1/recordings/${rec.id}/markers`,
      payload: { text: '尾部标记' },
    });
    expect(fallback.statusCode).toBe(201);
    expect(fallback.json().marker.positionSeconds).toBe(60);
    await app.close();
  });

  it('越界/非法 positionSeconds=422（沿 PATCH 同款校验：0≤整数≤已录时长）', async () => {
    const { app, rec } = await setup();
    const inj = host(app);
    for (const bad of [61, -1, 3.5, '30']) {
      const res = await inj({
        method: 'POST',
        url: `/api/v1/recordings/${rec.id}/markers`,
        payload: { text: '非法', positionSeconds: bad },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('CONFIG_INVALID');
    }
    await app.close();
  });
});
