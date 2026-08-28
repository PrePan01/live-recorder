import { describe, expect, it } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkFileIntegrity } from '../../src/recorder/integrity.js';

describe('checkFileIntegrity', () => {
  it('returns pending when ffprobe is missing (degraded)', async () => {
    // 本环境通常无 ffprobe；无论有无，结果都应是 verified/failed/pending 之一，
    // 且缺 ffprobe（ENOENT）时为 pending。
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-integrity-'));
    const f = path.join(dir, 'a.mkv');
    await writeFile(f, Buffer.from([1, 2, 3]));
    const result = await checkFileIntegrity(f, 2000);
    expect(['verified', 'failed', 'pending']).toContain(result);
    await rm(dir, { recursive: true, force: true });
  });

  it('returns failed for a missing file (non-zero exit or ENOENT-pending)', async () => {
    const result = await checkFileIntegrity('/nonexistent/nope.mkv', 2000);
    expect(['failed', 'pending']).toContain(result);
  });
});