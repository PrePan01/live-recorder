import path from 'node:path';
import type { Platform, RecordingFormat } from '../types/index.js';

function sanitize(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

export function timestampSlug(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '_');
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
  const date = startedAtIso.slice(0, 10);
  const time = startedAtIso.slice(11, 19).replace(/:/g, '_');
  let name = template
    .replaceAll('{room}', sanitize(displayName) || 'unknown')
    .replaceAll('{platform}', platform)
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
    .replaceAll('{quality}', quality ?? '')
    .replaceAll('{roomId}', roomId ?? '');
  name = sanitize(name);
  return name || timestampSlug(startedAtIso);
}
