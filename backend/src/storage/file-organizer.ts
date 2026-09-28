import path from 'node:path';
import type { Platform, RecordingFormat } from '../types/index.js';

/** 按 UTF-8 字节截断（不切断多字节字符）：文件名单段上限 255B，扣除模板后缀余量后取 160B。 */
function truncateBytes(input: string, maxBytes: number): string {
  const buf = Buffer.from(input, 'utf8');
  if (buf.length <= maxBytes) return input;
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

function sanitize(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '');
  if (!cleaned) return 'unknown';
  // 超长房间名不再原样入路径：截到 160 字节（255B 段上限内的安全余量），防建文件时 ENAMETOOLONG 被误报成「保存目录无效」。
  return truncateBytes(cleaned, 160).replace(/_+$/g, '') || 'unknown';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO（UTC）→ 本地时间各部分。文件名日期应反映用户本地日期（PrePan：9月3日凌晨录制不应命名为9月2日）。 */
function localParts(iso: string): { date: string; time: string; slug: string } {
  const d = new Date(iso);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}_${pad2(d.getMinutes())}_${pad2(d.getSeconds())}`;
  const slug = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return { date, time, slug };
}

export function timestampSlug(iso: string): string {
  return localParts(iso).slug;
}

/** 录制文件路径：source_flv 直写用 .flv；mp4_after 录制阶段仍落 .flv，完成后转 MP4。template 为 V5 命名规则（#115，null 时用时间戳）。 */
export function recordingFilePath(recordingDirectory: string, platform: Platform, displayName: string, startedAtIso: string, format?: RecordingFormat, template?: string | null, quality?: string, roomId?: string): string {
  const ext = format === 'mp4_after' ? '.flv' : '.flv';
  const base = resolveBaseName(displayName, startedAtIso, platform, quality, roomId, template);
  return path.join(recordingDirectory, platform, sanitize(displayName), `${base}${ext}`);
}

/** 解析文件基名：template 为空用时间戳；否则按变量替换+过滤。 */
export function resolveBaseName(displayName: string, startedAtIso: string, platform: Platform, quality?: string, roomId?: string, template?: string | null): string {
  if (!template) return timestampSlug(startedAtIso);
  const { date, time, slug } = localParts(startedAtIso);
  let name = template
    .replaceAll('{room}', sanitize(displayName) || 'unknown')
    .replaceAll('{platform}', platform)
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
    .replaceAll('{quality}', quality ?? '')
    .replaceAll('{roomId}', roomId ?? '');
  name = sanitize(name);
  return name || slug;
}
