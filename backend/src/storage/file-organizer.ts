import path from 'node:path';
import type { Platform, RecordingFormat } from '../types/index.js';

function sanitize(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

export function timestampSlug(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '_');
}

/** 录制文件路径：source_flv 直写用 .flv；mp4_after 录制阶段仍落 .flv，完成后转 MP4。 */
export function recordingFilePath(recordingDirectory: string, platform: Platform, displayName: string, startedAtIso: string, format?: RecordingFormat): string {
  const ext = format === 'mp4_after' ? '.flv' : '.flv';
  return path.join(recordingDirectory, platform, sanitize(displayName), `${timestampSlug(startedAtIso)}${ext}`);
}
