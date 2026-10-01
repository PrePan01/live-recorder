import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SeekIndexWriter,
  loadSeekIndex,
  removeSeekIndexSidecar,
  seekSidecarPath,
} from '../../src/storage/seek-index.js';
import {
  keptMarkerSidecarPath,
  liveMarkerSidecarPath,
  moveMarkerSidecar,
  promoteMarkerSidecar,
  removeMarkerSidecar,
  resolveMarkerSidecarPath,
  syncMarkerSidecar,
} from '../../src/storage/recording-markers.js';
import type { Recording, RecordingMarker } from '../../src/types/index.js';

/**
 * sidecar 归位（task #96）：seekindex→房间 .cache/；markers 录制中→.cache/、
 * 保留时搬 标签/（沿用原名）；两阶段改名/删除同层跟随；中文房名回归。
 */

function rec(filePath: string): Recording {
  return {
    id: 'rec_x',
    roomId: 'room_x',
    roomName: '渡一',
    platform: 'douyin',
    streamSessionId: 's1',
    streamTitle: 't',
    state: 'recording',
    startedAt: '2026-10-01T00:00:00.000Z',
    endedAt: null,
    filePath,
    fileSizeBytes: 0,
    failureReason: null,
    retryCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    origin: 'manual',
  };
}

function marker(t: number, text: string): RecordingMarker {
  return {
    id: `m_${t}`,
    recordingId: 'rec_x',
    positionSeconds: t,
    text,
    createdAt: '2026-10-01T00:00:01.000Z',
    updatedAt: '2026-10-01T00:00:01.000Z',
  };
}

async function roomDir(dir: string, name: string): Promise<string> {
  const room = path.join(dir, 'douyin', name);
  await mkdir(room, { recursive: true });
  return room;
}

describe('sidecar 归位（#96）', () => {
  it('seekindex 进 .cache/（幂等创建、不与视频混放）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sidecar-'));
    const room = await roomDir(dir, '渡一');
    const filePath = path.join(room, '渡一_2026-10-01.flv');
    await writeFile(filePath, 'v');
    const writer = await SeekIndexWriter.open(filePath, 0);
    expect(writer).not.toBeNull();
    writer!.note({ t: 0, b: 13 });
    await writer!.close();
    const target = seekSidecarPath(filePath);
    expect(target).toBe(path.join(room, '.cache', '渡一_2026-10-01.flv.seekindex.jsonl'));
    expect((await stat(target)).size).toBeGreaterThan(0);
    // 不与视频混放：旧位置不存在
    await expect(stat(`${filePath}.seekindex.jsonl`)).rejects.toThrow();
    // 读取往返
    expect((await loadSeekIndex(filePath)).entries).toHaveLength(1);
  });

  it('markers 录制中进 .cache/，保留时搬 标签/（沿用原名）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sidecar-'));
    const room = await roomDir(dir, '渡一');
    const filePath = path.join(room, '渡一_2026-10-01.flv');
    await writeFile(filePath, 'v');
    await syncMarkerSidecar(rec(filePath), [marker(3, '开场')]);
    const live = liveMarkerSidecarPath(filePath);
    expect(live).toBe(path.join(room, '.cache', '渡一_2026-10-01.flv.markers.json'));
    expect((await stat(live)).size).toBeGreaterThan(0);

    await promoteMarkerSidecar(filePath);
    const kept = keptMarkerSidecarPath(filePath);
    expect(kept).toBe(path.join(room, '标签', '渡一_2026-10-01.flv.markers.json'));
    expect((await stat(kept)).size).toBeGreaterThan(0);
    await expect(stat(live)).rejects.toThrow(); // 搬走不残留
    // 沿用原名：内容原样
    expect((await readFile(kept, 'utf8')).includes('开场')).toBe(true);
    // 读取解析=优先保留位
    expect(await resolveMarkerSidecarPath(filePath)).toBe(kept);
  });

  it('改名两阶段同层跟随、删除两阶段同清（不孤儿）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sidecar-'));
    const room = await roomDir(dir, '渡一');
    const from = path.join(room, '旧名.flv');
    const to = path.join(room, '新名.flv');
    await writeFile(from, 'v');
    await syncMarkerSidecar(rec(from), [marker(1, 'a')]);
    await moveMarkerSidecar(from, to);
    expect(await resolveMarkerSidecarPath(to)).toBe(liveMarkerSidecarPath(to));
    await expect(stat(liveMarkerSidecarPath(from))).rejects.toThrow();

    await promoteMarkerSidecar(to);
    const renamed = path.join(room, '再改名.flv');
    await moveMarkerSidecar(to, renamed);
    expect(await resolveMarkerSidecarPath(renamed)).toBe(keptMarkerSidecarPath(renamed));

    await removeMarkerSidecar(renamed);
    expect(await resolveMarkerSidecarPath(renamed)).toBeNull();

    // seek 侧同清
    const writer = await SeekIndexWriter.open(renamed, 0);
    writer!.note({ t: 0, b: 13 });
    await writer!.close();
    await removeSeekIndexSidecar(renamed);
    await expect(stat(seekSidecarPath(renamed))).rejects.toThrow();
  });

  it('中文房间目录全程正确（渡一/SL.二十二 风格）', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sidecar-'));
    for (const name of ['渡一', 'SL.二十二']) {
      const room = await roomDir(dir, name);
      const filePath = path.join(room, `${name}_2026-10-01.flv`);
      await writeFile(filePath, 'v');
      const writer = await SeekIndexWriter.open(filePath, 0);
      writer!.note({ t: 0, b: 13 });
      await writer!.close();
      await syncMarkerSidecar(rec(filePath), [marker(2, name)]);
      expect((await loadSeekIndex(filePath)).entries).toHaveLength(1);
      await promoteMarkerSidecar(filePath);
      const kept = await resolveMarkerSidecarPath(filePath);
      expect(kept).toContain(path.join(name, '标签'));
    }
  });
});
