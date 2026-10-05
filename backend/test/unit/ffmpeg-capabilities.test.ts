import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { videoPassthroughArgs } from '../../src/recorder/ffmpeg-capabilities.js';

describe.skipIf(process.platform === 'win32')('FFmpeg frame synchronization compatibility', () => {
  it('selects modern and legacy options using the actual binary capabilities', async () => {
    const original = process.env.PATH;
    for (const [help, expected] of [
      ['-fps_mode[:stream_specifier] set framerate mode', ['-fps_mode:v', 'passthrough']],
      ['-vsync video sync method', ['-vsync', '0']],
      ['no supported synchronization option', []],
    ] as const) {
      const dir = await mkdtemp(path.join(tmpdir(), 'lr-ffmpeg-capability-'));
      try {
        await writeFile(path.join(dir, 'ffmpeg'), `#!/bin/sh\necho '${help}'\n`);
        await chmod(path.join(dir, 'ffmpeg'), 0o755);
        process.env.PATH = `${dir}${path.delimiter}${original ?? ''}`;
        const first = videoPassthroughArgs();
        expect(videoPassthroughArgs()).toBe(first);
        await expect(first).resolves.toEqual([...expected]);
      } finally {
        process.env.PATH = original;
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
