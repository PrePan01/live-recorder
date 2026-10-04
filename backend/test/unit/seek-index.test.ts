import { appendFile, mkdtemp, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SeekIndexWriter,
  SeekIndexReader,
  beginSeekScan,
  finishSeekScan,
  loadSeekIndex,
  lookupSeekEntry,
  moveSeekIndexSidecar,
  noteSeekCoverage,
  pickFeedSeqHeaders,
  progressSeekScan,
  removeSeekIndexSidecar,
  resetSeekCoverageForTest,
  scanSeekIndex,
  seekIndexOf,
  seekSidecarPath,
  validateSeekEntry,
} from '../../src/storage/seek-index.js';

/** 最小 FLV 构造：与真实流同构（头 + 标签 + PreviousTagSize）。 */
function flvTag(type: number, ts: number, data: Buffer): Buffer {
  const head = Buffer.alloc(11);
  head[0] = type;
  head.writeUIntBE(data.length, 1, 3);
  head.writeUIntBE(ts & 0xffffff, 4, 3);
  head[7] = (ts >>> 24) & 0xff;
  const prev = Buffer.alloc(4);
  prev.writeUInt32BE(11 + data.length, 0);
  return Buffer.concat([head, data, prev]);
}

function videoPayload(keyframe: boolean, seq: boolean): Buffer {
  const flags = (keyframe ? 0x10 : 0x20) | 0x07;
  return Buffer.concat([Buffer.from([flags, seq ? 0 : 1, 0, 0, 0]), Buffer.alloc(64)]);
}

function audioPayload(seq: boolean): Buffer {
  return Buffer.concat([Buffer.from([0xaf, seq ? 0 : 1]), Buffer.alloc(32)]);
}

function flvHeader(): Buffer {
  const head = Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09]);
  return Buffer.concat([head, Buffer.alloc(4)]);
}

/** 造一段 FLV：关键帧在 0/4/8/12 秒，序列头在最前。 */
function buildSampleFlv(): Buffer {
  const tags: Buffer[] = [
    flvTag(9, 0, videoPayload(true, true)),
    flvTag(8, 0, audioPayload(true)),
    flvTag(9, 0, videoPayload(true, false)),
    flvTag(9, 2000, videoPayload(false, false)),
    flvTag(8, 2100, audioPayload(false)),
    flvTag(9, 4000, videoPayload(true, false)),
    flvTag(9, 6000, videoPayload(false, false)),
    flvTag(9, 8000, videoPayload(true, false)),
    flvTag(9, 12000, videoPayload(true, false)),
    flvTag(8, 12100, audioPayload(false)),
  ];
  return Buffer.concat([flvHeader(), ...tags]);
}

async function writeSample(dir: string, name = 'sample.flv'): Promise<string> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, buildSampleFlv());
  return filePath;
}

/** 逐标签扫描得到「标签 → 文件偏移」真值表，供断言对照。 */
function tagLayout(buf: Buffer): Array<{ offset: number; type: number; ts: number; keyframe: boolean; seq: boolean }> {
  const out: Array<{ offset: number; type: number; ts: number; keyframe: boolean; seq: boolean }> = [];
  let off = 13;
  while (off + 11 <= buf.length) {
    const type = buf[off]!;
    const ds = (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!;
    const ts = ((buf[off + 4]! << 16) | (buf[off + 5]! << 8) | buf[off + 6]! | ((buf[off + 7]! & 0xff) << 24)) >>> 0;
    const d0 = buf[off + 11]!;
    const d1 = buf[off + 12]!;
    const seq = (type === 9 && (d0 & 0x0f) === 7 && d1 === 0) || (type === 8 && d0 >> 4 === 10 && d1 === 0);
    const keyframe = type === 9 && d0 >> 4 === 1 && !seq;
    out.push({ offset: off, type, ts, keyframe, seq });
    off += 11 + ds + 4;
  }
  return out;
}

describe('seek-index 索引层', () => {
  it('写入器逐标签落盘：关键帧/序列头条目、偏移与真值表一致、只追加', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'seek-idx-'));
    const filePath = await writeSample(dir);
    const layout = tagLayout(await readFile(filePath));
    const writer = await SeekIndexWriter.open(filePath, 0);
    expect(writer).not.toBeNull();
    for (const tag of layout) {
      if (tag.seq) writer!.note({ t: tag.ts, b: tag.offset, s: 1, k: tag.type === 8 ? 8 : 9 });
      else if (tag.keyframe) writer!.note({ t: tag.ts, b: tag.offset });
    }
    await writer!.close();

    const { entries, seqs } = await loadSeekIndex(filePath);
    expect(entries.map((e) => e.b)).toEqual(layout.filter((t) => t.keyframe).map((t) => t.offset));
    expect(entries.map((e) => e.t)).toEqual(layout.filter((t) => t.keyframe).map((t) => t.ts));
    expect(seqs).toHaveLength(2);
    // 只追加：侧车行数=1 头行+条目数，无整文件重写痕迹（首行恒为版本行）。
    const raw = await readFile(seekSidecarPath(filePath), 'utf8');
    expect(raw.split('\n')[0]).toBe('{"v":1}');
    expect(raw.trim().split('\n')).toHaveLength(1 + entries.length + seqs.length);
  });

  it('崩溃截断尾行被裁掉、重复偏移去重、乱序条目按时间排序', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'seek-idx-'));
    const filePath = await writeSample(dir);
    await mkdir(path.dirname(seekSidecarPath(filePath)), { recursive: true });
    await writeFile(
      seekSidecarPath(filePath),
      '{"v":1}\n{"t":8000,"b":500}\n{"t":4000,"b":300}\n{"t":4000,"b":300}\n{"t":12000,"b":700',
    );
    const { entries } = await loadSeekIndex(filePath);
    expect(entries.map((e) => e.t)).toEqual([4000, 8000]);
    expect(lookupSeekEntry(entries, 12000)?.b).toBe(500);
    expect(lookupSeekEntry(entries, 3999)).toBeNull();
  });

  it('lookup 吸附前一个关键帧、序列头选取起播点前最近的音视频各一', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'seek-idx-'));
    const filePath = await writeSample(dir);
    const layout = tagLayout(await readFile(filePath));
    const writer = await SeekIndexWriter.open(filePath, 0);
    for (const tag of layout) {
      if (tag.seq) writer!.note({ t: tag.ts, b: tag.offset, s: 1, k: tag.type === 8 ? 8 : 9 });
      else if (tag.keyframe) writer!.note({ t: tag.ts, b: tag.offset });
    }
    await writer!.close();
    const { entries, seqs } = await loadSeekIndex(filePath);
    // 请求 5 秒 → 吸附 4 秒关键帧
    expect(lookupSeekEntry(entries, 5000)?.t).toBe(4000);
    // 请求超过尾部 → 夹到最后一帧（绝不抛、绝不硬播到不存在的位置）
    expect(lookupSeekEntry(entries, 999_000)?.t).toBe(12000);
    const target = lookupSeekEntry(entries, 5000)!;
    const chosen = pickFeedSeqHeaders(seqs, target.b);
    expect(chosen).toHaveLength(2);
    expect(chosen.every((s) => s.b < target.b)).toBe(true);
  });

  it('条目校验：对得上过、偏移错/时间戳漂移不过（失效重建绝不硬播）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'seek-idx-'));
    const filePath = await writeSample(dir);
    const layout = tagLayout(await readFile(filePath));
    const key = layout.find((t) => t.keyframe && t.ts === 4000)!;
    expect(await validateSeekEntry(filePath, { t: 4000, b: key.offset })).toBe(true);
    expect(await validateSeekEntry(filePath, { t: 4000, b: key.offset + 3 })).toBe(false);
    expect(await validateSeekEntry(filePath, { t: 60_000, b: key.offset })).toBe(false);
  });

  it('扫描补建与写入器产出等价（同偏移同时间戳），带进度与取消', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'seek-idx-'));
    const filePath = await writeSample(dir);
    const layout = tagLayout(await readFile(filePath));
    const collected: Array<{ t: number; b: number; s?: 1 }> = [];
    let lastProgress = 0;
    await scanSeekIndex(filePath, {
      from: 0,
      to: (await stat(filePath)).size,
      onEntry: (e) => collected.push(e),
      onProgress: (n) => {
        lastProgress = n;
      },
    });
    expect(collected.filter((e) => e.s === undefined)).toEqual(
      layout.filter((t) => t.keyframe).map((t) => ({ t: t.ts, b: t.offset })),
    );
    expect(collected.filter((e) => e.s === 1)).toHaveLength(2);
    expect(lastProgress).toBeGreaterThan(0);
  });

  it('覆盖登记与状态计算：写入自 0=ready；留缺口=building→补扫→ready；无索引=missing', async () => {
    resetSeekCoverageForTest();
    const dir = await mkdtemp(path.join(tmpdir(), 'seek-idx-'));
    const filePath = await writeSample(dir);

    expect(seekIndexOf(filePath, false)).toEqual({ seekIndexState: 'missing' });

    // 续录追加：前缀缺口 → building
    noteSeekCoverage(filePath, 500);
    const building = seekIndexOf(filePath, true);
    expect(building.seekIndexState).toBe('building');

    // 补扫进行中带进度
    beginSeekScan(filePath, 0, 1000);
    progressSeekScan(filePath, 500);
    const mid = seekIndexOf(filePath, true);
    expect(mid.seekIndexState).toBe('building');
    expect(mid.seekIndexProgress).toBeGreaterThan(0);

    finishSeekScan(filePath, true);
    expect(seekIndexOf(filePath, true).seekIndexState).toBe('ready');

    // 全新录制：写入自 0 直接 ready
    resetSeekCoverageForTest();
    noteSeekCoverage(filePath, 0);
    expect(seekIndexOf(filePath, true)).toEqual({ seekIndexState: 'ready' });
  });

  it('侧车随文件改名/删除联动', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'seek-idx-'));
    const filePath = await writeSample(dir);
    const writer = await SeekIndexWriter.open(filePath, 0);
    writer!.note({ t: 0, b: 13 });
    await writer!.close();
    const nextPath = path.join(dir, 'renamed.flv');
    await moveSeekIndexSidecar(filePath, nextPath);
    await expect(stat(seekSidecarPath(nextPath))).resolves.toBeTruthy();
    await removeSeekIndexSidecar(nextPath);
    await expect(stat(seekSidecarPath(nextPath))).rejects.toThrow();
  });
});


describe('增量读取长录制索引', () => {
  it('追加半行不会丢条目，补全后读取，乱序和重复追加保持正确吸附', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'seek-incremental-'));
    const file = await writeSample(dir);
    const sidecar = seekSidecarPath(file);
    await mkdir(path.dirname(sidecar), { recursive: true });
    await writeFile(sidecar, '{"v":1}\n{"t":8000,"b":500}\n{"t":12000,"b":');
    const reader = new SeekIndexReader(file);
    const first = reader.load();
    expect(reader.load()).toBe(first); // 并发共用同次读取
    expect((await first).entries).toEqual([{ t: 8000, b: 500 }]);
    await appendFile(sidecar, '700}\n{"t":4000,"b":300}\n{"t":4000,"b":300}\n');
    const result = await reader.load();
    expect(result.entries.map(e => e.t)).toEqual([4000, 8000, 12000]);
    expect(lookupSeekEntry(result.entries, 10000)).toEqual({ t: 8000, b: 500 });
    expect((await reader.load()).entries).toBe(result.entries);
  });

  it('侧车截短、替换和删除后不沿用旧的索引缓存', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'seek-replace-'));
    const file = await writeSample(dir);
    const sidecar = seekSidecarPath(file);
    await mkdir(path.dirname(sidecar), { recursive: true });
    await writeFile(sidecar, '{"v":1}\n{"t":8000,"b":500}\n{"t":12000,"b":700}\n');
    const reader = new SeekIndexReader(file);
    expect((await reader.load()).entries).toHaveLength(2);
    await writeFile(sidecar, '{"v":1}\n{"t":4000,"b":300}\n');
    expect((await reader.load()).entries).toEqual([{ t: 4000, b: 300 }]);
    await writeFile(sidecar + '.replacement', '{"v":1}\n{"t":6000,"b":400}\n');
    await rename(sidecar + '.replacement', sidecar);
    expect((await reader.load()).entries).toEqual([{ t: 6000, b: 400 }]);
    await removeSeekIndexSidecar(file);
    expect((await reader.load()).entries).toEqual([]);
  });

  it('24 小时索引追加后仍命中新尾部；时间相同的条目保留最后一个', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'seek-long-'));
    const file = await writeSample(dir);
    const sidecar = seekSidecarPath(file);
    await mkdir(path.dirname(sidecar), { recursive: true });
    await writeFile(sidecar, '{"v":1}\n' + Array.from({ length: 43200 }, (_, i) => JSON.stringify({ t: i * 2000, b: i * 1000 + 13 })).join('\n') + '\n');
    const reader = new SeekIndexReader(file);
    const result = await reader.load();
    expect(lookupSeekEntry(result.entries, 86399500)?.t).toBe(86398000);
    await appendFile(sidecar, '{"t":86400000,"b":43200013}\n{"t":86400000,"b":43200113}\n');
    const grown = await reader.load();
    expect(lookupSeekEntry(grown.entries, 86400000)?.b).toBe(43200113);
    expect(grown.entries).toHaveLength(43202);
  });
});
