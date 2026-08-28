import path from 'node:path';
import type { Platform } from '../types/index.js';

function sanitize(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

export function timestampSlug(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '_');
}

export function recordingFilePath(recordingDirectory: string, platform: Platform, displayName: string, startedAtIso: string): string {
  return path.join(recordingDirectory, platform, sanitize(displayName), `${timestampSlug(startedAtIso)}.mkv`);
}
