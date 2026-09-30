import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Recording, RecordingMarker } from '../types/index.js';

export function markerSidecarPath(filePath: string): string {
  return `${filePath}.markers.json`;
}

function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function markerTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h ? `${h}时` : '', m ? `${m}分` : '', s ? `${s}秒` : ''].join('') || '0秒';
}

/** Keep a human-readable sidecar next to the source recording. */
export async function syncMarkerSidecar(recording: Recording, markers: RecordingMarker[]): Promise<void> {
  if (!recording.filePath) return;
  const target = markerSidecarPath(recording.filePath);
  if (markers.length === 0) {
    await rm(target, { force: true }).catch(() => undefined);
    return;
  }
  const body = {
    version: 1,
    recordingStartedAt: localTime(recording.startedAt),
    markers: markers.map((marker) => ({
      time: markerTime(marker.positionSeconds), text: marker.text,
      createdAt: localTime(marker.createdAt), updatedAt: localTime(marker.updatedAt),
    })),
  };
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp`);
  await writeFile(temp, JSON.stringify(body, null, 2), 'utf8');
  await rename(temp, target);
}

export async function moveMarkerSidecar(from: string, to: string): Promise<void> {
  await rename(markerSidecarPath(from), markerSidecarPath(to)).catch(() => undefined);
}

export async function removeMarkerSidecar(filePath: string): Promise<void> {
  await rm(markerSidecarPath(filePath), { force: true }).catch(() => undefined);
}
