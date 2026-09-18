import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runFfmpegTracked } from '../../src/recorder/ffmpeg-run.js';

/** 假 ffmpeg 用 shell 脚本模拟，Windows 无此机制（被测逻辑本身跨平台）。 */
const posixOnly = process.platform !== 'win32';

async function withFakeFfmpeg(script: string, run: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lr-ffmpeg-run-'));
  const bin = path.join(dir, 'ffmpeg');
  await writeFile(bin, script);
  await chmod(bin, 0o755);
  const original = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${original ?? ''}`;
  try {
    await run();
  } finally {
    process.env.PATH = original;
  }
}

describe.skipIf(!posixOnly)('runFfmpegTracked 按进度判定（大文件不因固定超时被打断）', () => {
  it('持续有进度就不打断，即使运行时间远超静默阈值', async () => {
    // 进度间隔 150ms、静默阈值 1200ms、总时长 2.4s：推进中就不该被判卡死。
    await withFakeFfmpeg(`#!/bin/sh
i=0
while [ "$i" -lt 16 ]; do
  echo "out_time_us=$((i * 1000000))"
  echo "progress=continue"
  sleep 0.15
  i=$((i + 1))
done
echo "progress=end"
exit 0
`, async () => {
      const res = await runFfmpegTracked([], { stallMs: 1_200, killGraceMs: 3_000 });
      expect(res.stalled).toBe(false);
      expect(res.ok).toBe(true);
    });
  });

  it('长时间无进度判定为卡死并终止', async () => {
    await withFakeFfmpeg('#!/bin/sh\nexec sleep 30\n', async () => {
      const res = await runFfmpegTracked([], { stallMs: 500, killGraceMs: 3_000 });
      expect(res.stalled).toBe(true);
      expect(res.ok).toBe(false);
    });
  });

  it('正常退出与异常退出分别映射为成功/失败', async () => {
    await withFakeFfmpeg('#!/bin/sh\nexit 0\n', async () => {
      const res = await runFfmpegTracked([], { stallMs: 3_000 });
      expect(res).toMatchObject({ ok: true, stalled: false, code: 0 });
    });
    await withFakeFfmpeg('#!/bin/sh\nexit 1\n', async () => {
      const res = await runFfmpegTracked([], { stallMs: 3_000 });
      expect(res.ok).toBe(false);
      expect(res.stalled).toBe(false);
    });
  });
});
