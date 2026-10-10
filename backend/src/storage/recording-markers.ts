import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Recording, RecordingMarker } from "../types/index.js";

/** 录制中/待确认期间的临时居所：房间目录 .cache/（不与视频混放）。 */
export function liveMarkerSidecarPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    ".cache",
    `${path.basename(filePath)}.markers.json`,
  );
}

/** 保留后的最终居所：房间目录 标签/（沿用原名、只搬家不改名）。 */
export function keptMarkerSidecarPath(filePath: string): string {
  return path.join(
    path.dirname(filePath),
    "标签",
    `${path.basename(filePath)}.markers.json`,
  );
}

/** 最终居所路径（历史调用点兼容名；读取请用 resolveMarkerSidecarPath）。 */
export function markerSidecarPath(filePath: string): string {
  return keptMarkerSidecarPath(filePath);
}

/** 读取解析：优先保留位，回退临时位（导出诊断包等只读面）。 */
export async function resolveMarkerSidecarPath(
  filePath: string,
): Promise<string | null> {
  for (const candidate of [
    keptMarkerSidecarPath(filePath),
    liveMarkerSidecarPath(filePath),
  ]) {
    if (
      await stat(candidate)
        .then(() => true)
        .catch(() => false)
    )
      return candidate;
  }
  return null;
}

function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function markerTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return (
    [h ? `${h}时` : "", m ? `${m}分` : "", s ? `${s}秒` : ""].join("") || "0秒"
  );
}

/** Keep a human-readable sidecar next to the source recording. 录制中/待确认写 .cache/（临时居所）。 */
const sidecarWrites = new Map<string, Promise<void>>();

export async function syncMarkerSidecar(
  recording: Recording,
  markers: RecordingMarker[],
): Promise<void> {
  if (!recording.filePath) return;
  const key = recording.filePath;
  const previous = sidecarWrites.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => writeMarkerSidecar(recording, markers));
  sidecarWrites.set(key, current);
  try {
    await current;
  } finally {
    if (sidecarWrites.get(key) === current) sidecarWrites.delete(key);
  }
}

async function writeMarkerSidecar(
  recording: Recording,
  markers: RecordingMarker[],
): Promise<void> {
  if (!recording.filePath) return;
  const target =
    recording.state === "completed"
      ? keptMarkerSidecarPath(recording.filePath)
      : liveMarkerSidecarPath(recording.filePath);
  if (markers.length === 0) {
    await rm(target, { force: true }).catch(() => undefined);
    await rm(keptMarkerSidecarPath(recording.filePath), { force: true }).catch(
      () => undefined,
    );
    return;
  }
  const body = {
    version: 1,
    recordingStartedAt: localTime(recording.startedAt),
    markers: markers.map((marker) => ({
      time: markerTime(marker.positionSeconds),
      text: marker.text,
      ...(marker.endPositionSeconds != null
        ? {
            endTime: markerTime(marker.endPositionSeconds),
            startSecond: marker.positionSeconds,
            endSecond: marker.endPositionSeconds,
          }
        : {}),
      createdAt: localTime(marker.createdAt),
      updatedAt: localTime(marker.updatedAt),
    })),
  };
  await mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp`);
  await writeFile(temp, JSON.stringify(body, null, 2), "utf8");
  await rename(temp, target);
}

/** 保留确认时的归位：标签数据从 .cache/ 搬到 标签/（沿用原名；同卷 rename 优先、回退 copy+unlink）。 */
export async function promoteMarkerSidecar(filePath: string): Promise<void> {
  const from = liveMarkerSidecarPath(filePath);
  const to = keptMarkerSidecarPath(filePath);
  if (
    !(await stat(from)
      .then(() => true)
      .catch(() => false))
  )
    return;
  await mkdir(path.dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch {
    try {
      await copyFile(from, to);
      await rm(from, { force: true });
    } catch {
      // 搬迁失败不阻断保留主流程（标签文件留在原位，导出面有回退读）。
    }
  }
}

/** 改名联动：两阶段同层跟随（临时位→临时位、保留位→保留位），不丢不串。 */
export async function moveMarkerSidecar(
  from: string,
  to: string,
): Promise<void> {
  const pairs: Array<[string, string]> = [
    [liveMarkerSidecarPath(from), liveMarkerSidecarPath(to)],
    [keptMarkerSidecarPath(from), keptMarkerSidecarPath(to)],
  ];
  for (const [fromPath, toPath] of pairs) {
    if (
      !(await stat(fromPath)
        .then(() => true)
        .catch(() => false))
    )
      continue;
    await mkdir(path.dirname(toPath), { recursive: true });
    await rename(fromPath, toPath).catch(() => undefined);
  }
}

/** 删除联动：两阶段同清（不保留/删除不孤儿）。 */
export async function removeMarkerSidecar(filePath: string): Promise<void> {
  await rm(liveMarkerSidecarPath(filePath), { force: true }).catch(
    () => undefined,
  );
  await rm(keptMarkerSidecarPath(filePath), { force: true }).catch(
    () => undefined,
  );
}
