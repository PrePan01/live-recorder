import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DanmakuStore } from '../../src/danmaku/store.js';
import { exportDanmakuFiles, renderDanmakuSubtitles } from '../../src/danmaku/export.js';

const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'lr-subtitles-'));
  dirs.push(dir);
  const rec = path.join(dir, '录像.mp4'), directory = path.join(dir, 'exports');
  await mkdir(directory);
  return { rec, directory };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const options = { durationMs: 12000, width: 1920, height: 1080, opacity: 0.9, density: 40 };
const msg = (id: string, tMs: number | null, text: string) => ({ id, tMs, text, wallMs: 1 });

it('writes sorted millisecond SRT cues, groups simultaneous text and clips the last cue to the video end', () => {
  const result = renderDanmakuSubtitles([msg('c', 11000, '尾部'), msg('a', 1000, '第一条'), msg('b', 1000, '第二条'), msg('d', 2500, '第三条')], [], options);
  expect(result.srt).toBe('1\n00:00:01,000 --> 00:00:02,500\n第一条\n第二条\n\n2\n00:00:02,500 --> 00:00:05,500\n第三条\n\n3\n00:00:11,000 --> 00:00:12,000\n尾部\n');
  expect(result.count).toBe(4);
});

it('generates complete ASS headers, rolling movement, chosen resolution and alpha without executable input tags', () => {
  const result = renderDanmakuSubtitles([msg('a', 1234, '你好{\\move(0,0,1,1)}\n世界')], [], options);
  expect(result.ass).toContain('PlayResX: 1920\nPlayResY: 1080');
  expect(result.ass).toContain('Style: Danmaku,sans-serif,36,&H19FFFFFF');
  expect(result.ass).toMatch(/Dialogue: 0,0:00:01\.23,.*\{\\move\(1920,0,-\d+,0,0,\d+\)\}/);
  expect(result.ass).toContain('你好｛＼move(0,0,1,1)｝ 世界');
  expect(result.assCount).toBe(1);
});

it('excludes missing, unmappable, invalid and outside-video timestamps from both formats', () => {
  const messages = [msg('null', null, '未定位'), { ...msg('unmapped', 100, '未定位'), unmappable: true }, msg('negative', -1, '无效'), msg('nan', NaN, '无效'), msg('gap', 1000, '缺失'), msg('end', 12000, '片尾'), msg('empty', 100, '  '), msg('valid', 2000, '有效')];
  const result = renderDanmakuSubtitles(messages, [{ fromMs: 500, toMs: 1500, reason: 'disconnect' }], options);
  expect(result.count).toBe(1);
  expect(result.srt).toContain('有效');
  expect(result.assCount).toBe(1);
});

it('handles hour timecodes without truncation', () => {
  const result = renderDanmakuSubtitles([msg('a', 3661123, '小时')], [], { ...options, durationMs: 3700000 });
  expect(result.srt).toContain('01:01:01,123');
  expect(result.ass).toContain('1:01:01.12');
});

it('applies density to ASS while retaining all text in SRT', () => {
  const messages = Array.from({ length: 50 }, (_, i) => msg(String(i), 1000, `文字${i}`));
  const result = renderDanmakuSubtitles(messages, [], { ...options, width: 1920, height: 1080, density: 20 });
  expect(result.count).toBe(50);
  expect(result.assCount).toBeLessThanOrEqual(20);
  expect(result.srt).toContain('文字49');
});

it('exports both UTF-8 files and uses a common numbered name without overwriting either existing file', async () => {
  const { rec, directory } = await fixture(), store = await DanmakuStore.open(rec);
  store.append(msg('a', 1000, '中文弹幕')); await store.close();
  await writeFile(path.join(directory, '录像.srt'), 'existing');
  const first = await exportDanmakuFiles(rec, { ...options, directory });
  expect(path.basename(first.assPath)).toBe('录像 (1).ass');
  expect(path.basename(first.srtPath)).toBe('录像 (1).srt');
  expect(await readFile(path.join(directory, '录像.srt'), 'utf8')).toBe('existing');
  expect(await readFile(first.srtPath, 'utf8')).toContain('中文弹幕');
  const second = await exportDanmakuFiles(rec, { ...options, directory });
  expect(path.basename(second.assPath)).toBe('录像 (2).ass');
  expect(await readdir(directory)).not.toContain('录像.ass');
});

it('rejects invalid directories and recordings without timed text without creating files', async () => {
  const { rec, directory } = await fixture();
  await expect(exportDanmakuFiles(rec, { ...options, directory: 'relative' })).rejects.toMatchObject({ code: 'RECORDING_DIRECTORY_INVALID' });
  await expect(exportDanmakuFiles(rec, { ...options, directory })).rejects.toMatchObject({ code: 'RECORDING_EMPTY' });
  const store = await DanmakuStore.open(rec);
  store.append({ ...msg('a', null, '未定位'), unmappable: true }); await store.close();
  await expect(exportDanmakuFiles(rec, { ...options, directory })).rejects.toMatchObject({ code: 'RECORDING_EMPTY' });
  expect(await readdir(directory)).toEqual([]);
});

it('reads all offset pages instead of stopping at the first 20000 messages', async () => {
  const { rec, directory } = await fixture(), store = await DanmakuStore.open(rec);
  for (let i = 0; i < 20001; i++) store.append(msg(String(i), 1000, `弹幕${i}`));
  await store.close();
  const result = await exportDanmakuFiles(rec, { ...options, directory });
  expect(result.count).toBe(20001);
  expect(await readFile(result.srtPath, 'utf8')).toContain('弹幕20000');
});

it('streamed worker matches the shared renderer across out-of-order, fractional and simultaneous timestamps and gaps', async () => {
  const { rec, directory } = await fixture();
  await mkdir(path.dirname(DanmakuStore.sidecarPathFor(rec)), { recursive: true });
  const messages = Array.from({ length: 5001 }, (_, i) => msg(String(i), (i * 37 % 11000) + (i % 3) / 10, `行${i}{\\test}\n下一行`));
  messages.push(msg('gap', 1000, '不应显示'), msg('null', null, '未定位'), msg('same-a', 100.1, '小数'), msg('same-b', 100.9, '同毫秒'));
  const gaps = [{ fromMs: 900, toMs: 1100, reason: 'disconnect' as const }];
  const file = DanmakuStore.sidecarPathFor(rec);
  await writeFile(file, messages.map(m => JSON.stringify(m)).join('\n') + '\n');
  await writeFile(file + '.gaps.json', JSON.stringify(gaps));
  const expected = renderDanmakuSubtitles(messages, gaps, options);
  const result = await exportDanmakuFiles(rec, { ...options, directory });
  expect(await readFile(result.assPath, 'utf8')).toBe(expected.ass);
  expect(await readFile(result.srtPath, 'utf8')).toBe(expected.srt);
  expect(result.count).toBe(expected.count);
  expect(result.assCount).toBe(expected.assCount);
});

it('bounds queued exports, preserves failure codes and continues after a failed worker', async () => {
  const { rec, directory } = await fixture(), store = await DanmakuStore.open(rec);
  store.append(msg('a', 1000, '队列')); await store.close();
  const results = await Promise.allSettled([
    exportDanmakuFiles(rec, { ...options, directory: 'relative' }),
    exportDanmakuFiles(rec, { ...options, directory }),
    exportDanmakuFiles(rec, { ...options, directory }),
    exportDanmakuFiles(rec, { ...options, directory }),
  ]);
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'RECORDING_DIRECTORY_INVALID' } });
  expect(results[1]).toMatchObject({ status: 'fulfilled', value: { count: 1 } });
  expect(results[2]).toMatchObject({ status: 'fulfilled', value: { count: 1 } });
  expect(results[3]).toMatchObject({ status: 'rejected', reason: { code: 'SERVICE_UNAVAILABLE' } });
});
