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
    // 合法 FLV：头 + onMetaData + 一个视频 tag（#181：截断/非法尾部不再写入）。
    const header = Buffer.concat([Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09]), Buffer.alloc(4)]);
    const makeTag = (type: number, ts: number, data: Buffer): Buffer => {
      const head = Buffer.alloc(11);
      head[0] = type;
      head.writeUIntBE(data.length, 1, 3);
      head[4] = (ts >> 16) & 0xff;
      head[5] = (ts >> 8) & 0xff;
      head[6] = ts & 0xff;
      head[7] = (ts >> 24) & 0xff;
      return Buffer.concat([head, data]);
    };
    const prevSize = (t: Buffer): Buffer => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(t.length);
      return b;
    };
    const meta = makeTag(0x12, 0, Buffer.from([0x02, 0x00, 0x0a, ...Buffer.from('onMetaData')]));
    const v1 = makeTag(0x09, 40, Buffer.from([0x17, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    const full = Buffer.concat([header, meta, prevSize(meta), v1, prevSize(v1)]);
    // 拆块喂入，模拟网络分片。
    const chunks: Buffer[] = [];
    for (let i = 0; i < full.length; i += 5) chunks.push(full.subarray(i, i + 5));
    const engine = new StreamRecordingEngine(mockFetch(200, () => chunksBody(chunks)));
    const events: string[] = [];
    let bytes = 0;
    let fileSize = 0;
    for await (const ev of engine.start({ url: 'https://x.com/live.flv', format: 'flv', headers: { Referer: 'https://x.com' } }, out)) {
      events.push(ev.type);
      if (ev.type === 'data') bytes += ev.chunk.length;
      if (ev.type === 'completed') fileSize = ev.fileSize;
    }
    // 归一化按完整标签分批输出；完整 FLV 全部落盘。
    expect(events[0]).toBe('file_created');
    expect(events[events.length - 1]).toBe('completed');
    expect(events.filter((e) => e === 'data').length).toBeGreaterThan(0);
    expect(bytes).toBe(full.length);
    expect(fileSize).toBe(bytes);
    const onDisk = await readFile(out);
    expect(onDisk.subarray(0, 3).toString()).toBe('FLV');
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

  it('rewrites absolute PTS to relative so duration is correct (抖音录几分钟显示 1 小时+ 根因)', async () => {
    // 构造合法 FLV：头部 + onMetaData + 音频(3602000) + 两个视频(3609000/3609500)，绝对 PTS，大端编码。
    const header = Buffer.concat([Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09]), Buffer.alloc(4)]);
    const makeTag = (type: number, ts: number, data: Buffer): Buffer => {
      const head = Buffer.alloc(11);
      head[0] = type;
      head.writeUIntBE(data.length, 1, 3);
      head[4] = (ts >> 16) & 0xff;
      head[5] = (ts >> 8) & 0xff;
      head[6] = ts & 0xff;
      head[7] = (ts >> 24) & 0xff;
      return Buffer.concat([head, data]);
    };
    const prevSize = (t: Buffer): Buffer => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(t.length);
      return b;
    };
    const meta = makeTag(0x12, 0, Buffer.from([0x02, 0x00, 0x0a, ...Buffer.from('onMetaData')]));
    const a1 = makeTag(0x08, 3_602_000, Buffer.from([0xaf, 0x00, 0x01]));
    const v1 = makeTag(0x09, 3_609_000, Buffer.from([0x17, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    const v2 = makeTag(0x09, 3_609_500, Buffer.from([0x17, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    const stream = Buffer.concat([header, meta, prevSize(meta), a1, prevSize(a1), v1, prevSize(v1), v2, prevSize(v2)]);

    const dir = await mkdtemp(path.join(tmpdir(), 'lr-engine-'));
    const out = path.join(dir, 'norm.flv');
    // 逐 3 字节喂入，强制标签跨 chunk 边界，验证流式归一化稳健。
    const tiny: Uint8Array[] = [];
    for (let i = 0; i < stream.length; i += 3) tiny.push(stream.subarray(i, i + 3));
    const engine = new StreamRecordingEngine(mockFetch(200, () => chunksBody(tiny)));
    for await (const ev of engine.start({ url: 'https://x.com/live.flv', format: 'flv' }, out)) {
      void ev;
    }
    const outBuf = await readFile(out);
    expect(outBuf.length).toBe(stream.length);

    // 解析输出文件：音频按音频 base（→0），视频按视频 base（→0/500），各自独立归零。
    const tsByType: Record<string, number[]> = { '8': [], '9': [] };
    let off = 13;
    while (off + 11 <= outBuf.length) {
      const type = outBuf[off]!;
      const ds = outBuf.readUIntBE(off + 1, 3);
      const len = 11 + ds + 4;
      if (off + len > outBuf.length) break;
      if (type === 8 || type === 9) {
        tsByType[String(type)]!.push((outBuf[off + 4]! << 16) | (outBuf[off + 5]! << 8) | outBuf[off + 6]! | ((outBuf[off + 7]! & 0xff) << 24));
      }
      off += len;
    }
    expect(tsByType['8']).toEqual([0]);
    expect(tsByType['9']).toEqual([0, 500]);
  });

  it('keeps normal (near-zero) FLV timestamps untouched (bilibili 首帧≈0 透传)', async () => {
    const header = Buffer.concat([Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09]), Buffer.alloc(4)]);
    const makeTag = (type: number, ts: number, data: Buffer): Buffer => {
      const head = Buffer.alloc(11);
      head[0] = type;
      head.writeUIntBE(data.length, 1, 3);
      head[4] = (ts >> 16) & 0xff;
      head[5] = (ts >> 8) & 0xff;
      head[6] = ts & 0xff;
      head[7] = (ts >> 24) & 0xff;
      return Buffer.concat([head, data]);
    };
    const prevSize = (t: Buffer): Buffer => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(t.length);
      return b;
    };
    const meta = makeTag(0x12, 0, Buffer.from([0x02, 0x00, 0x0a, ...Buffer.from('onMetaData')]));
    const v1 = makeTag(0x09, 40, Buffer.from([0x17, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    const v2 = makeTag(0x09, 80, Buffer.from([0x17, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    const stream = Buffer.concat([header, meta, prevSize(meta), v1, prevSize(v1), v2, prevSize(v2)]);

    const dir = await mkdtemp(path.join(tmpdir(), 'lr-engine-'));
    const out = path.join(dir, 'keep.flv');
    const tiny: Uint8Array[] = [];
    for (let i = 0; i < stream.length; i += 3) tiny.push(stream.subarray(i, i + 3));
    const engine = new StreamRecordingEngine(mockFetch(200, () => chunksBody(tiny)));
    for await (const ev of engine.start({ url: 'https://x.com/live.flv', format: 'flv' }, out)) {
      void ev;
    }
    const outBuf = await readFile(out);
    const vts: number[] = [];
    let off = 13;
    while (off + 11 <= outBuf.length) {
      const type = outBuf[off]!;
      const ds = outBuf.readUIntBE(off + 1, 3);
      const len = 11 + ds + 4;
      if (off + len > outBuf.length) break;
      if (type === 9) vts.push((outBuf[off + 4]! << 16) | (outBuf[off + 5]! << 8) | outBuf[off + 6]! | ((outBuf[off + 7]! & 0xff) << 24));
      off += len;
    }
    // 首媒体时间戳 40ms ≤ 60s：不扣减，原样保留。
    expect(vts).toEqual([40, 80]);
  });

  it('drops the truncated tail tag so the file ends cleanly (偶现损坏 #181 根因)', async () => {
    // 构造合法 FLV + 一个完整视频 tag + 一个被截断的尾部视频 tag（录制中途停止的典型形态）。
    const header = Buffer.concat([Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09]), Buffer.alloc(4)]);
    const makeTag = (type: number, ts: number, data: Buffer): Buffer => {
      const head = Buffer.alloc(11);
      head[0] = type;
      head.writeUIntBE(data.length, 1, 3);
      head[4] = (ts >> 16) & 0xff;
      head[5] = (ts >> 8) & 0xff;
      head[6] = ts & 0xff;
      head[7] = (ts >> 24) & 0xff;
      return Buffer.concat([head, data]);
    };
    const prevSize = (t: Buffer): Buffer => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(t.length);
      return b;
    };
    const meta = makeTag(0x12, 0, Buffer.from([0x02, 0x00, 0x0a, ...Buffer.from('onMetaData')]));
    const v1 = makeTag(0x09, 40, Buffer.from([0x17, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
    // 截断尾部：声明 size=100 但只给 30 字节 body（不完整）。
    const v2Head = Buffer.alloc(11);
    v2Head[0] = 0x09;
    v2Head.writeUIntBE(100, 1, 3);
    v2Head[4] = (80 >> 16) & 0xff;
    v2Head[5] = (80 >> 8) & 0xff;
    v2Head[6] = 80 & 0xff;
    const v2Partial = Buffer.concat([v2Head, Buffer.alloc(30)]);
    const stream = Buffer.concat([header, meta, prevSize(meta), v1, prevSize(v1), v2Partial]);

    const dir = await mkdtemp(path.join(tmpdir(), 'lr-engine-'));
    const out = path.join(dir, 'tail.flv');
    // 一次性喂入（不拆小块，让引擎在收尾时才遇到截断尾）。
    const engine = new StreamRecordingEngine(mockFetch(200, () => chunksBody([stream])));
    for await (const ev of engine.start({ url: 'https://x.com/live.flv', format: 'flv' }, out)) {
      void ev;
    }
    const outBuf = await readFile(out);
    // 输出文件应只含完整标签：完整 video tag 结束即止，不包含截断尾。
    let off = 13;
    let tags = 0;
    while (off + 11 <= outBuf.length) {
      const ds = outBuf.readUIntBE(off + 1, 3);
      const len = 11 + ds + 4;
      if (off + len > outBuf.length) break;
      tags += 1;
      off += len;
    }
    expect(tags).toBe(2); // meta + v1（截断的 v2 被丢弃）
    expect(off).toBe(outBuf.length); // 文件在完整标签边界结束，无残余
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