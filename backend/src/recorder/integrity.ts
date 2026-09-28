import { spawn } from 'node:child_process';
import { resolveBin } from '../utils/ffmpeg.js';
import type { RecordingIntegrity } from '../types/index.js';

const FFPROBE_TIMEOUT_MS = 15_000;

/**
 * 用 ffprobe 校验录制文件可播（时长 > 0 且可解封装）。
 * ffprobe 缺失或校验超时返回 'pending'（不阻塞列表，提示用户手动确认）。
 */
/** 校验结论的细分：ok=可播、failed=文件损坏（终态）、unverifiable=环境问题（ffprobe 缺失/超时，可重试）。 */
export interface IntegrityCheckDetail {
  outcome: 'ok' | 'failed' | 'unverifiable';
  detail: string;
}

export async function checkFileIntegrityDetailed(filePath: string, timeoutMs = FFPROBE_TIMEOUT_MS): Promise<IntegrityCheckDetail> {
  return new Promise((resolve) => {
    const child = spawn(resolveBin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath], { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ outcome: 'unverifiable', detail: '校验超时' });
    }, timeoutMs);
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', () => undefined);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ outcome: 'unverifiable', detail: 'ffprobe 不可用' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ outcome: 'failed', detail: '文件损坏或截断' });
        return;
      }
      try {
        const parsed = JSON.parse(out) as { format?: { duration?: string } };
        const duration = Number(parsed.format?.duration ?? 0);
        resolve(duration > 0 ? { outcome: 'ok', detail: '' } : { outcome: 'failed', detail: '时长为 0' });
      } catch {
        resolve({ outcome: 'failed', detail: '无法解析媒体信息' });
      }
    });
  });
}

export function checkFileIntegrity(filePath: string, timeoutMs = FFPROBE_TIMEOUT_MS): Promise<RecordingIntegrity> {
  return new Promise((resolve) => {
    const child = spawn(resolveBin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath], { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('pending');
    }, timeoutMs);
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => {
      // ffprobe 不存在（ENOENT）→ pending 降级。
      clearTimeout(timer);
      resolve('pending');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve('failed');
        return;
      }
      try {
        const parsed = JSON.parse(out) as { format?: { duration?: string } };
        const duration = Number(parsed.format?.duration ?? 0);
        resolve(duration > 0 ? 'verified' : 'failed');
      } catch {
        resolve('failed');
      }
    });
  });
}