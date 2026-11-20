import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { StreamRecordingEngine } from '../../src/recorder/stream-recorder.js';
import { PreviewManager } from '../../src/api/websocket.js';
import { resolveBin } from '../../src/utils/ffmpeg.js';
import { BilibiliAdapter } from '../../src/platform/bilibili/adapter.js';
import { trackedFfmpegCount } from '../../src/recorder/ffmpeg-registry.js';
import type { Services } from '../../src/core/services.js';

it('decodes a real fragmented AVC/AAC stream after recording and late preview bootstrap', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lr-live-parser-'));
  try {
    const source = path.join(directory, 'source.flv');
    const recording = path.join(directory, 'recording.flv');
    const late = path.join(directory, 'late.flv');
    execFileSync(resolveBin('ffmpeg'), [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=20',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
      '-g', '20', '-bf', '0', '-c:a', 'aac', '-f', 'flv', source,
    ], { timeout: 10_000 });
    const bytes = await readFile(source);
    const preview = new PreviewManager({} as Services);
    const fetcher = (async () => new Response(new ReadableStream({
      start(controller) {
        // Deliberately split headers, audio packets and video keyframes.
        for (let offset = 0; offset < bytes.length; offset += 137)
          controller.enqueue(bytes.subarray(offset, offset + 137));
        controller.close();
      },
    }))) as typeof fetch;
    const engine = new StreamRecordingEngine(fetcher);
    let completed = false;
    for await (const event of engine.start({ url: 'https://example.test/live.flv', format: 'flv' }, recording)) {
      if (event.type === 'preview_data') preview.broadcastFrame('r', event.chunk);
      if (event.type === 'error') throw new Error(event.error.message);
      if (event.type === 'completed') completed = true;
    }
    expect(completed).toBe(true);
    const sent: Buffer[] = [];
    const client = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN, bufferedAmount: 0,
      send(chunk: Buffer) { sent.push(Buffer.from(chunk)); },
    });
    preview.addClient('r', client as unknown as WebSocket);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    await writeFile(late, Buffer.concat(sent));
    const delayedAudio = path.join(directory, 'delayed-audio.flv');
    const rearranged = new PreviewManager({} as Services);
    const delayed: Buffer[] = [];
    const waiting = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN, bufferedAmount: 0,
      send(chunk: Buffer) { delayed.push(chunk); },
      close(code: number) { throw new Error(`Unexpected preview close: ${code}`); },
    });
    rearranged.addClient('r', waiting as unknown as WebSocket);
    rearranged.broadcastFrame('r', bytes.subarray(0, 13));
    let audioConfig: Buffer | undefined;
    for (let offset = 13; offset < bytes.length;) {
      const tag = bytes.subarray(offset, offset + bytes.readUIntBE(offset + 1, 3) + 15);
      offset += tag.length;
      if (tag[0] === 8 && tag[12] === 0 && !audioConfig) {
        audioConfig = tag;
        continue;
      }
      rearranged.broadcastFrame('r', tag);
      if (audioConfig && tag[0] === 9 && tag[11] === 0x17 && tag[12] === 1) {
        expect(delayed).toHaveLength(0);
        rearranged.broadcastFrame('r', audioConfig);
        expect(delayed).toHaveLength(2);
        // Input only contains one AAC sequence header. Release it once.
        audioConfig = undefined;
      }
    }
    await writeFile(delayedAudio, Buffer.concat(delayed));
    for (const [file, expectedFrames] of [[recording, 40], [late, 20], [delayedAudio, 40]] as const) {
      // Decode the packets, not only container metadata, to catch missing SPS,
      // lost fragment bytes and undecodable GOP starts.
      execFileSync(resolveBin('ffmpeg'), ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { timeout: 10_000 });
      const info = JSON.parse(execFileSync(resolveBin('ffprobe'), [
        '-v', 'error', '-count_frames', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,nb_read_frames', '-of', 'json', file,
      ], { encoding: 'utf8', timeout: 10_000 }));
      expect(info.streams[0].codec_name).toBe('h264');
      const frames = Number(info.streams[0].nb_read_frames);
      expect(frames).toBe(expectedFrames);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('remuxes a Bilibili fMP4 HLS playlist into decodable preview and recording FLV', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lr-hls-fmp4-'));
  const requested = new Set<string>();
  const referers = new Set<string | undefined>();
  const server = createServer((request, response) => {
    const name = request.url?.split('?')[0]?.slice(1) ?? '';
    if (!/^(live\.m3u8|init\.mp4|live\d+\.m4s)$/.test(name)) {
      response.writeHead(404).end();
      return;
    }
    requested.add(name);
    referers.add(request.headers.referer);
    void readFile(path.join(directory, name)).then(
      bytes => response.end(bytes), () => response.writeHead(404).end(),
    );
  });
  const initialProcessCount = trackedFfmpegCount();
  try {
    execFileSync(resolveBin('ffmpeg'), [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=20',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
      '-g', '20', '-bf', '0', '-c:a', 'aac',
      '-f', 'hls', '-hls_time', '1', '-hls_segment_type', 'fmp4', path.join(directory, 'live.m3u8'),
    ], { timeout: 10_000 });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const adapter = new BilibiliAdapter(async () => Response.json({
      code: 0, data: { live_status: 1, playurl_info: { playurl: { stream: [{
        protocol_name: 'http_hls', format: [{ format_name: 'fmp4', codec: [{
          codec_name: 'avc', current_qn: 250, base_url: '/live.m3u8', url_info: [{ host }],
        }] }],
      }] } } },
    }));
    const source = await adapter.getStreamUrl('https://live.bilibili.com/26924998', 'original');
    expect(source.format).toBe('hls-fmp4');
    const engine = new StreamRecordingEngine();
    const recording = path.join(directory, 'recording.flv');
    const preview = new PreviewManager({} as Services);
    const sent: Buffer[] = [];
    const client = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN, bufferedAmount: 0,
      send(chunk: Buffer) { sent.push(Buffer.from(chunk)); },
    });
    preview.addClient('r', client as unknown as WebSocket);
    let completed = false;
    for await (const event of engine.start(source, recording)) {
      if (event.type === 'preview_data') preview.broadcastFrame('r', event.chunk);
      if (event.type === 'error') throw new Error(event.error.message);
      if (event.type === 'completed') completed = true;
    }
    expect(completed).toBe(true);
    expect(trackedFfmpegCount()).toBe(initialProcessCount);
    expect(requested).toEqual(new Set(['live.m3u8', 'init.mp4', 'live0.m4s', 'live1.m4s']));
    expect(referers).toEqual(new Set(['https://live.bilibili.com/26924998']));
    expect(sent[0]?.subarray(0, 3).toString()).toBe('FLV');
    const previewPath = path.join(directory, 'preview.flv');
    await writeFile(previewPath, Buffer.concat(sent));
    for (const file of [recording, previewPath]) {
      execFileSync(resolveBin('ffmpeg'), ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { timeout: 10_000 });
      const info = JSON.parse(execFileSync(resolveBin('ffprobe'), [
        '-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', file,
      ], { encoding: 'utf8', timeout: 10_000 }));
      expect(info.streams.map((stream: { codec_name: string }) => stream.codec_name).sort()).toEqual(['aac', 'h264']);
    }

    const outcomes = [];
    for await (const event of engine.start({ ...source, url: `${host}/missing.m3u8` }))
      outcomes.push(event);
    expect(outcomes).toMatchObject([{ type: 'error', error: { code: 'NETWORK_UNAVAILABLE', retryable: true } }]);
    expect(trackedFfmpegCount()).toBe(initialProcessCount);
  } finally {
    if (server.listening) await new Promise<void>(resolve => { server.close(() => resolve()); });
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
