import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';
import { validateSettings } from '../../src/config/schema.js';
import { settingsView } from '../../src/api/routes/settings-view.js';

const headers = { host: '127.0.0.1:43120' };
function setup() {
  const clock = new FakeClock();
  const services = buildServices({ dbPath: ':memory:', clock });
  services.settings.save({ ...structuredClone(DEFAULT_SETTINGS), recordingDirectory: '/tmp/recordings' });
  const room = services.rooms.create({ platform: 'bilibili', url: 'https://live.bilibili.com/123', displayName: 'Power' });
  const rec = services.recordings.create({ roomId: room.id, roomName: room.displayName, platform: room.platform, streamSessionId: null, streamTitle: 'Power' });
  services.recordings.update(rec.id, { startedAt: clock.iso() });
  const { app } = buildApp(services);
  return { clock, services, app, rec, room };
}

describe('recording power policy and sleep evidence', () => {
  it('defaults on for new and legacy settings, and validates the switch', async () => {
    const { services, app } = setup();
    expect(DEFAULT_SETTINGS.preventSleepWhileRecording).toBe(true);
    const old = services.settings.load()!;
    delete old.preventSleepWhileRecording;
    services.settings.save(old);
    expect((await settingsView(services)).preventSleepWhileRecording).toBe(true);
    expect(() => validateSettings({ ...old, preventSleepWhileRecording: 'true' })).toThrow();
    const saved = await app.inject({ method: 'PUT', url: '/api/v1/settings', headers, payload: { preventSleepWhileRecording: false } });
    expect(saved.statusCode).toBe(200);
    expect((await settingsView(services)).preventSleepWhileRecording).toBe(false);
    await app.close();
  });

  it('does not prevent sleep without active recordings, including pending confirmation', async () => {
    const { services, app, rec } = setup();
    services.recordings.update(rec.id, { state: 'awaiting_confirmation' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/service/power', headers });
    expect(res.json()).toEqual({ preventSleep: false });
    await app.close();
  });

  it('keeps protection across multiple active sessions and reconnects, and respects disabling', async () => {
    const { services, app } = setup();
    const active = (services.manager as unknown as { active: Map<string, unknown> }).active;
    active.set('room-1', {}); active.set('room-2', {});
    const power = async () => (await app.inject({ method: 'GET', url: '/api/v1/service/power', headers })).json().preventSleep;
    expect(await power()).toBe(true);
    active.delete('room-1');
    expect(await power()).toBe(true);
    services.settings.save({ ...services.settings.load()!, preventSleepWhileRecording: false });
    expect(await power()).toBe(false);
    services.settings.save({ ...services.settings.load()!, preventSleepWhileRecording: true });
    expect(await power()).toBe(true);
    active.clear();
    expect(await power()).toBe(false);
    const starting = (services.manager as unknown as { starting: Set<string> }).starting;
    starting.add('pending');
    expect(await power()).toBe(true);
    starting.clear();
    await services.manager.shutdown();
    expect(await power()).toBe(false);
    await app.close();
  });

  it('marks overlapping gaps on late native wake notification, without changing totals', async () => {
    const { services, app, clock, rec } = setup();
    const startedAt = clock.now(); clock.advance(60_000);
    services.recordings.insertGap({ recordingId: rec.id, startedAt: new Date(startedAt).toISOString(), endedAt: clock.iso(), missingMs: 60_000, kind: 'stream_disconnect' });
    services.recordings.update(rec.id, { state: 'completed', missingMs: 60_000 });
    const sleep = { startedAt: startedAt + 1000, endedAt: clock.now() - 1000 };
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/v1/service/system-sleep', headers, payload: sleep });
      expect(res.statusCode).toBe(200);
    }
    expect(services.recordings.listGaps(rec.id)).toHaveLength(1);
    expect(services.recordings.listGaps(rec.id)[0]!.kind).toBe('system_sleep');
    expect(services.recordings.get(rec.id)!.missingMs).toBe(60_000);
    expect(services.recordings.get(rec.id)!.systemSleepInterrupted).toBe(true);
    expect(services.recordings.list().items[0]!.systemSleepInterrupted).toBe(true);
    await app.close();
  });

  it('does not mislabel a long network gap outside the observed sleep interval', async () => {
    const { services, app, clock, rec } = setup();
    const startedAt = clock.now(); clock.advance(20 * 60_000);
    services.recordings.insertGap({ recordingId: rec.id, startedAt: new Date(startedAt).toISOString(), endedAt: clock.iso(), missingMs: 20 * 60_000, kind: 'stream_disconnect' });
    services.manager.recordSystemSleep(startedAt - 10_000, startedAt - 1000);
    expect(services.recordings.listGaps(rec.id)[0]!.kind).toBe('stream_disconnect');
    expect(services.recordings.get(rec.id)!.systemSleepInterrupted).toBeUndefined();
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/service/system-sleep', headers, payload: { startedAt, endedAt: startedAt - 1 } });
    expect(invalid.statusCode).toBe(422);
    await app.close();
  });
});
