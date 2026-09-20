import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mp4PathFor, remuxFlvToMp4, remuxStallMsForSize } from '../../src/recorder/remux.js';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { timeout: 20_000 }).status === 0;

/** 生成一个能被 ffmpeg 真正转封装的最小 FLV（假 FLV 字节流 ffmpeg 会直接拒绝）。 */
function generateFlv(file: string): boolean {
  const res = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ], { timeout: 60_000 });
  return res.status === 0;
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

describe.skipIf(!HAS_FFMPEG)('remuxFlvToMp4 (#165 mp4_after 假 MP4 / 大文件半成品)', () => {
  it('按源文件大小动态放宽无进度阈值，并限制最大等待时间', () => {
    expect(remuxStallMsForSize(0)).toBe(2 * 60_000);
    expect(remuxStallMsForSize(1)).toBe(3 * 60_000);
    expect(remuxStallMsForSize(5.3 * 1024 ** 3)).toBe(8 * 60_000);
    expect(remuxStallMsForSize(100 * 1024 ** 3)).toBe(10 * 60_000);
  });

  it('成功：产物是真 MP4、源 FLV 删除、不留临时文件', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-remux-'));
    const flvPath = path.join(dir, 'rec.flv');
    expect(generateFlv(flvPath)).toBe(true);

    const mp4 = await remuxFlvToMp4(flvPath);
    expect(mp4).toBe(mp4PathFor(flvPath));
    expect(mp4).toBe(flvPath.replace(/\.flv$/i, '.mp4'));

    // 产物应是真 MP4（ftyp 魔数），而非被 rename 覆盖的 FLV（46 4c 56）。
    const head = await readFile(mp4!);
    expect(head.subarray(0, 3).toString()).not.toBe('FLV');
    expect(head.subarray(4, 8).toString()).toBe('ftyp');

    // 源 FLV 应被删除，且不残留未落地的临时产物。
    expect(await exists(flvPath)).toBe(false);
    expect(await exists(`${mp4}.part`)).toBe(false);
  });

  it('失败：保留源 FLV，并删掉半成品与转换坏掉的 MP4', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-remux-fail-'));
    const flvPath = path.join(dir, 'rec.flv');
    const mp4Path = flvPath.replace(/\.flv$/i, '.mp4');
    await writeFile(flvPath, 'not a media file');
    // 上一次失败留在目标路径上的坏 MP4 + 本次会写出的半成品。
    await writeFile(mp4Path, 'broken mp4 from a previous run');
    await writeFile(`${mp4Path}.part`, 'partial output');

    expect(await remuxFlvToMp4(flvPath)).toBeNull();

    // 无论如何不丢源文件。
    expect(await exists(flvPath)).toBe(true);
    // 转换坏掉的文件必须清掉，否则用户会以为转换成功。
    expect(await exists(mp4Path)).toBe(false);
    expect(await exists(`${mp4Path}.part`)).toBe(false);
  });

  it('非 flv 输入不推导 MP4 目标', () => {
    expect(mp4PathFor('/tmp/a.mp4')).toBeNull();
    expect(mp4PathFor('/tmp/a.flv')).toBe('/tmp/a.mp4');
  });
});
