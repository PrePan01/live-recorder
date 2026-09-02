import path from 'node:path';
import type { Platform, RecordingFormat } from '../types/index.js';

function sanitize(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
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
