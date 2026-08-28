import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StreamRecordingEngine } from '../../src/recorder/stream-recorder.js';

function chunksBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function endlessBody(): ReadableStream<Uint8Array> {
  let count = 0;
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array([count++ % 256]));
      if (count > 100_000) controller.close();
    },
  });
}

function mockFetch(status: number, body: () => ReadableStream<Uint8Array>): typeof fetch {
  return async () => new Response(body(), { status }) as unknown as Response;
}

describe('StreamRecordingEngine (HTTP)', () => {
  it('writes the stream to disk and yields data/completed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-engine-'));
    const out = path.join(dir, 'a.flv');
    const chunks = [Buffer.from('FLVheader123'), Buffer.from('000000000000'), Buffer.from('morebytes')];
    const engine = new StreamRecordingEngine(mockFetch(200, () => chunksBody(chunks)));
    const events: string[] = [];
    let bytes = 0;
    let fileSize = 0;
    for await (const ev of engine.start({ url: 'https://x.com/live.flv', format: 'flv', headers: { Referer: 'https://x.com' } }, out)) {
      events.push(ev.type);
      if (ev.type === 'data') bytes += ev.chunk.length;
      if (ev.type === 'completed') fileSize = ev.fileSize;
    }
    expect(events).toEqual(['file_created', 'data', 'data', 'data', 'completed']);
    expect(bytes).toBe(Buffer.concat(chunks).length);
    expect(fileSize).toBe(bytes);
    const onDisk = await readFile(out);
    expect(onDisk.subarray(0, 12).toString()).toBe('FLVheader123');
    expect(onDisk.length).toBe(bytes);
  });

  it('yields NETWORK_UNAVAILABLE for a failed fetch', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-engine-'));
    const out = path.join(dir, 'b.flv');
    const engine = new StreamRecordingEngine(mockFetch(404, () => new ReadableStream()));
    const events: string[] = [];
    for await (const ev of engine.start({ url: 'https://x.com/404.flv', format: 'flv' }, out)) {
      events.push(ev.type);
      if (ev.type === 'error') expect(ev.error.code).toBe('NETWORK_UNAVAILABLE');
    }
    expect(events).toEqual(['error']);
  });

  it('honors stop() mid-stream and keeps the file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-engine-'));
    const out = path.join(dir, 'c.flv');
    const engine = new StreamRecordingEngine(mockFetch(200, endlessBody));
    let received = 0;
    const run = async () => {
      for await (const ev of engine.start({ url: 'https://x.com/live.flv', format: 'flv' }, out)) {
        if (ev.type === 'data') received += 1;
        if (received === 2) await engine.stop();
      }
    };
    await Promise.race([run(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
    const info = await stat(out);
    expect(info.size).toBeGreaterThan(0);
  });

  it('passes request headers through', async () => {
    let seenHeaders: Record<string, string> | undefined;
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-engine-'));
    const out = path.join(dir, 'd.flv');
    const stub: typeof fetch = async (input, init) => {
      seenHeaders = init?.headers as Record<string, string>;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 }) as unknown as Response;
    };
    const engine = new StreamRecordingEngine(stub);
    for await (const ev of engine.start({ url: 'https://x.com/live.flv', format: 'flv', headers: { Cookie: 'a=b', 'User-Agent': 'ua' } }, out)) {
      void ev;
    }
    expect(seenHeaders).toEqual({ Cookie: 'a=b', 'User-Agent': 'ua' });
  });
});

describe('StreamRecordingEngine (HLS)', () => {
  it('downloads playlist segments and concatenates them', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-hls-'));
    const out = path.join(dir, 'e.ts');
    const segs: Record<string, Uint8Array> = {
      'https://x.com/seg0.ts': new Uint8Array([0x47, 0x01, 0x02]),
      'https://x.com/seg1.ts': new Uint8Array([0x47, 0x03, 0x04]),
    };
    const stub: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('playlist')) {
        return new Response('#EXTM3U\n#EXT-X-ENDLIST\n#EXTINF:4,\nhttps://x.com/seg0.ts\n#EXTINF:4,\nhttps://x.com/seg1.ts\n', { status: 200 }) as unknown as Response;
      }
      return new Response(segs[url]!, { status: 200 }) as unknown as Response;
    };
    const engine = new StreamRecordingEngine(stub);
    let bytes = 0;
    for await (const ev of engine.start({ url: 'https://x.com/playlist.m3u8', format: 'hls' }, out)) {
      if (ev.type === 'data') bytes += ev.chunk.length;
    }
    expect(bytes).toBe(6);
    const onDisk = await readFile(out);
    expect(onDisk.length).toBe(6);
    expect(onDisk.subarray(0, 1)[0]).toBe(0x47);
  });
});