import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SystemClock } from '../../src/core/clock.js';
import { FakeClock } from '../../src/core/clock.js';
import { FakePlatformAdapter, buildMinimalFlv } from '../../src/platform/fake-adapter.js';
import { FakeRecordingEngine } from '../../src/recorder/fake-engine.js';
import { FakeDiskGuard } from '../../src/storage/disk-guard.js';
import { FakeMailer } from '../../src/mail/mailer.js';
import { MemorySecretStore } from '../../src/security/memory-store.js';

describe('FakeClock', () => {
  it('fires timers only when advanced', () => {
    const clock = new FakeClock();
    let fired = 0;
    clock.setTimeout(() => (fired += 1), 5000);
    clock.advance(4999);
    expect(fired).toBe(0);
    clock.advance(2);
    expect(fired).toBe(1);
    expect(clock.pendingTimers()).toBe(0);
  });

  it('supports cancellation', () => {
    const clock = new FakeClock();
    let fired = false;
    const h = clock.setTimeout(() => (fired = true), 1000);
    clock.clearTimeout(h);
    clock.advance(2000);
    expect(fired).toBe(false);
  });
});

describe('FakePlatformAdapter', () => {
  it('walks the scripted sequence then falls back to live', async () => {
    const a = new FakePlatformAdapter();
    a.setScript([{ status: 'offline' }, { status: 'restricted' }]);
    expect((await a.checkLiveStatus('u')).status).toBe('offline');
    expect((await a.checkLiveStatus('u')).status).toBe('restricted');
    const third = await a.checkLiveStatus('u');
    expect(third.status).toBe('live');
    expect(third.streamSessionId).toBe('sess_2');
  });

  it('validates and normalizes platform urls', () => {
    const a = new FakePlatformAdapter();
    expect(a.validateUrl('https://live.bilibili.com/123')).toBe(true);
    expect(a.validateUrl('https://example.com/123')).toBe(false);
    expect(a.normalizeUrl('https://live.douyin.com/9/?x=1#t')).toBe('https://live.douyin.com/9');
  });
});

describe('minimal FLV', () => {
  it('starts with FLV header and video+audio flags', () => {
    const flv = buildMinimalFlv();
    expect(flv.subarray(0, 3).toString('latin1')).toBe('FLV');
    expect(flv[3]).toBe(1);
    expect(flv[4]! & 0x05).toBe(0x05);
    expect(flv.readUInt32BE(5)).toBe(9);
  });
});

describe('FakeRecordingEngine', () => {
  it('streams frames to disk and completes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fake-rec-'));
    const file = path.join(dir, 'test.mkv');
    const engine = new FakeRecordingEngine(new SystemClock(), { frames: 3, intervalMs: 1 });
    let dataEvents = 0;
    let completed = 0;
    for await (const ev of engine.start({ url: 'fake://x', format: 'flv' }, file)) {
      if (ev.type === 'data') dataEvents += 1;
      if (ev.type === 'completed') completed = ev.fileSize;
    }
    expect(dataEvents).toBe(3);
    expect(completed).toBeGreaterThan(13);
    const onDisk = await readFile(file);
    expect(onDisk.subarray(0, 3).toString('latin1')).toBe('FLV');
    await engine.stop();
  });

  it('emits scripted error', async () => {
    const engine = new FakeRecordingEngine(new SystemClock(), {
      frames: 10,
      intervalMs: 1,
      failAfterMs: 1,
      failError: { code: 'RECORDING_START_FAILED', message: 'boom', roomId: null, recordingId: null, occurredAt: 'x', retryable: true },
    });
    const events: string[] = [];
    for await (const ev of engine.start({ url: 'fake://x', format: 'flv' }, path.join(await mkdtemp(path.join(tmpdir(), 'fr-')), 'a.mkv'))) {
      events.push(ev.type);
    }
    expect(events.at(-1)).toBe('error');
  });
});

describe('other fakes', () => {
  it('disk guard returns injected space, mailer records sends, secret store works', async () => {
    const disk = new FakeDiskGuard({ freeBytes: 1, totalBytes: 10 });
    expect((await disk.inspect('/tmp')).freeBytes).toBe(1);

    const mailer = new FakeMailer();
    mailer.failNext = true;
    await expect(mailer.send({ enabled: true, host: 'h', port: 1, secure: true, username: 'u', from: 'f', recipients: ['a'] }, { to: ['a'], subject: 's', text: 't' })).rejects.toThrow();
    await mailer.send({ enabled: true, host: 'h', port: 1, secure: true, username: 'u', from: 'f', recipients: ['a'] }, { to: ['a'], subject: 's', text: 't' });
    expect(mailer.sent).toHaveLength(1);

    const store = new MemorySecretStore();
    await store.set('mail.password', 'p');
    expect(await store.get('mail.password')).toBe('p');
    expect(await store.has('mail.password')).toBe(true);
    await store.delete('mail.password');
    expect(await store.has('mail.password')).toBe(false);
  });
});
