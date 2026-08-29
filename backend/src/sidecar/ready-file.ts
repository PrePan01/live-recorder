import { mkdir, writeFile, rename, unlink, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AppInstance } from './types.js';

/**
 * 受控 ready 文件：以临时文件 + 原子 rename 写入 AppInstance。
 * 由 Tauri 壳读取以获知运行时 base URL（不写死 43120/5173）。
 */
export async function writeReadyFile(file: string, instance: AppInstance): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(instance), 'utf8');
  await rename(tmp, file);
}

export async function readReadyFile(file: string): Promise<AppInstance | null> {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as AppInstance;
  } catch {
    return null;
  }
}

export async function removeReadyFile(file: string): Promise<void> {
  await unlink(file).catch(() => undefined);
}