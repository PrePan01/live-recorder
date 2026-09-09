import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HighlightBuffer } from '../../src/recorder/highlight-buffer.js';

function flvHeader(): Buffer { return Buffer.from([0x46, 0x4c, 0x56, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]); }
function keyframe(): Buffer { return Buffer.from([9, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0x17, 1, 0, 0, 0, 13]); }
function mediaTag(size: number): Buffer {
  const tag = Buffer.alloc(11 + size + 4);
  tag[0] = 9;
  tag.writeUIntBE(size, 1, 3);
  tag[11] = 0x17;
  tag[12] = 1;
  return tag;
}

describe('highlight buffer export', () => {
  it('exports a keyframe-aligned cache without loading complete segments into memory', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'lr-highlight-'));
    const buffer = new HighlightBuffer(path.join(base, 'cache'), 300);
    await buffer.start();
    const at = Date.now();
    buffer.append(flvHeader(), at);
    buffer.append(keyframe(), at + 10);
    buffer.append(keyframe(), at + 5_100);
    const output = path.join(base, 'out.flv');
    const result = await buffer.exportTo(output, 30);
    const bytes = await readFile(output);
    expect(bytes.subarray(0, 3).toString()).toBe('FLV');
    expect(result.bytes).toBe(bytes.length);
    expect(bytes.length).toBeGreaterThan(flvHeader().length);
  });

  it('stops only this cache when the pending disk-write queue exceeds 8 MiB', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'lr-highlight-slow-'));
    const buffer = new HighlightBuffer(path.join(base, 'cache'), 300);
    await buffer.start();
    buffer.append(flvHeader());
    buffer.append(mediaTag(8 * 1024 * 1024 + 1));
    expect(buffer.isAccepting).toBe(false);
    expect(buffer.backpressureReason).toBe('slow_disk');
  });
});
