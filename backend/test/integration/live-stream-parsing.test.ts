import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { StreamRecordingEngine } from '../../src/recorder/stream-recorder.js';
import { PreviewManager } from '../../src/api/websocket.js';
import { resolveBin } from '../../src/utils/ffmpeg.js';
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
    for (const file of [recording, late]) {
      // Decode the packets, not only container metadata, to catch missing SPS,
      // lost fragment bytes and undecodable GOP starts.
      execFileSync(resolveBin('ffmpeg'), ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { timeout: 10_000 });
      const info = JSON.parse(execFileSync(resolveBin('ffprobe'), [
        '-v', 'error', '-count_frames', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,nb_read_frames', '-of', 'json', file,
      ], { encoding: 'utf8', timeout: 10_000 }));
      expect(info.streams[0].codec_name).toBe('h264');
      const frames = Number(info.streams[0].nb_read_frames);
      expect(frames).toBe(file === recording ? 40 : 20);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
