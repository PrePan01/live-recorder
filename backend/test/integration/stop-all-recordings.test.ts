import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices } from '../../src/core/services.js';
import { FakeClock } from '../../src/core/clock.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';
import { FakeRecordingEngine } from '../../src/recorder/fake-engine.js';

const request = { method: 'POST' as const, url: '/api/v1/rooms/stop-recording-all', headers: { host: '127.0.0.1:43120' } };

async function setup() {
  const clock = new FakeClock();
  const services = buildServices({ dbPath: ':memory:', clock });
  const directory = await mkdtemp(path.join(tmpdir(), 'lr-stop-all-'));
  services.settings.save({ ...structuredClone(DEFAULT_SETTINGS), recordingDirectory: directory });
  services.engineFor = () => new FakeRecordingEngine(clock, { frames: 1000 });
  const rooms = [1, 2, 3].map(id => services.rooms.create({
    platform: 'bilibili', url: `https://live.bilibili.com/${id}`, displayName: `Room ${id}`,
  }));
  const { app } = buildApp(services);
  return { services, rooms, app };
}

it.each([false, true])('stops all current recordings and preserves a preview-only stream (confirmAfterComplete=%s)', async confirmAfterComplete => {
  const { services, rooms, app } = await setup();
  try {
    services.settings.save({ ...services.settings.load()!, confirmAfterComplete });
    const awaiting: string[] = [];
    services.events.on(event => {
      if (event.type === 'recording:updated' && event.data.state === 'awaiting_confirmation') awaiting.push(event.data.roomId);
    });
    services.rooms.setLiveStatus(rooms[2]!.id, 'live');
    await services.manager.ensurePreviewStream(rooms[2]!.id);
    for (const room of rooms.slice(0, 2)) await services.manager.maybeStartRecording(room, {}, { manual: true });
    expect(services.manager.activeRoomIds()).toHaveLength(2);
    // 开录返回后文件写入异步进行；等真实首帧落盘再验证正常停止后的记录。
    for (const room of rooms.slice(0, 2)) {
      const deadline = Date.now() + 2000;
      while (true) {
        const recording = services.recordings.list({ roomId: room.id }).items[0]!;
        if (recording.filePath && (await stat(recording.filePath)).size > 13) break;
        if (Date.now() > deadline) throw new Error('recording did not receive its first frame');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    const response = await app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ stopped: rooms.slice(0, 2).map(room => room.id), failed: [] });
    expect(services.manager.activeRoomIds()).toEqual([]);
    expect(services.manager.isPreviewStreaming(rooms[2]!.id)).toBe(true);
    for (const room of rooms.slice(0, 2)) {
      const recording = services.recordings.list({ roomId: room.id }).items[0]!;
      expect(recording.state).toBe(confirmAfterComplete ? 'awaiting_confirmation' : 'completed');
      expect(recording.endReason).toBe('stopped');
      const stopped = services.db.prepare('SELECT auto_record_stopped_session AS session FROM rooms WHERE id = ?').get(room.id) as { session: string | null };
      expect(stopped.session).toBeTruthy();
    }
    expect(awaiting.sort()).toEqual(confirmAfterComplete ? rooms.slice(0, 2).map(room => room.id).sort() : []);
  } finally {
    await services.manager.shutdown();
    await app.close();
  }
});

it('is a no-op when there are no active recordings', async () => {
  const { services, app } = await setup();
  try {
    const stop = vi.spyOn(services.manager, 'stopRecording');
    const response = await app.inject(request);
    expect(response.json()).toEqual({ stopped: [], failed: [] });
    expect(stop).not.toHaveBeenCalled();
  } finally {
    await services.manager.shutdown();
    await app.close();
  }
});

it('attempts every recording even if one stop fails', async () => {
  const { services, rooms, app } = await setup();
  try {
    const activeIds = vi.spyOn(services.manager, 'activeRoomIds').mockReturnValue(rooms.slice(0, 2).map(room => room.id));
    const stop = vi.spyOn(services.manager, 'stopRecording').mockImplementation(async id => {
      if (id === rooms[0]!.id) throw new Error('stop failed');
    });
    const response = await app.inject(request);
    expect(response.json()).toEqual({ stopped: [rooms[1]!.id], failed: [rooms[0]!.id] });
    expect(stop).toHaveBeenCalledTimes(2);
    stop.mockRestore();
    activeIds.mockRestore();
  } finally {
    await services.manager.shutdown();
    await app.close();
  }
});
