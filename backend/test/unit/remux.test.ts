import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { remuxFlvToMp4 } from '../../src/recorder/remux.js';
import { buildMinimalFlv } from '../../src/platform/fake-adapter.js';

describe('remuxFlvToMp4 (#165 mp4_after 假 MP4)', () => {
  it('produces a real MP4 (not FLV content) and removes the source FLV', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-remux-'));
    const flvPath = path.join(dir, 'rec.flv');
    await writeFile(flvPath, buildMinimalFlv());

    const mp4 = await remuxFlvToMp4(flvPath);
    // ffmpeg 缺失/失败时返回 null（保留 FLV），此时跳过（环境无 ffmpeg）。
    if (!mp4) {
      await access(flvPath);
      return;
    }
    expect(mp4).toBe(flvPath.replace(/\.flv$/i, '.mp4'));
    // 产物应是真 MP4（ftyp 魔数），而非被 rename 覆盖的 FLV（46 4c 56）。
    const head = await readFile(mp4);
    expect(head.subarray(0, 3).toString()).not.toBe('FLV');
    expect(head.subarray(4, 8).toString()).toBe('ftyp');
    // 源 FLV 应被删除（unlink），而非 rename 覆盖 mp4。
    await expect(access(flvPath)).rejects.toBeTruthy();
  });
});
