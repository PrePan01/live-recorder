import { appendFile, stat, writeFile } from 'node:fs/promises';
import type { ErrorObject } from '../types/index.js';
import { buildMinimalFlv } from '../platform/fake-adapter.js';
import type { Clock } from '../core/clock.js';
import type { RecordingEngine, RecordingEvent, RecordingResumeOptions, StreamInput } from './engine.js';

export interface FakeEngineScript {
  frames?: number;
  intervalMs?: number;
  failAfterMs?: number;
  failError?: ErrorObject;
  formatChangeAfterMs?: number;
}

/**
 * 假录制引擎：把最小 FLV 帧周期性写入文件并产出 data 事件（预览转发源）。
 * 支持断流/错误/格式变化脚本，全部走注入 Clock，不真实等待。
 */
export class FakeRecordingEngine implements RecordingEngine {
  private stopped = false;
  private stopWaiters = new Set<() => void>();

  constructor(private clock: Clock, private script: FakeEngineScript = {}) {}

  stop(): Promise<void> {
    this.stopped = true;
    for (const wake of [...this.stopWaiters]) wake();
    return Promise.resolve();
  }

  async *start(input: StreamInput, outputPath?: string | null, resume?: RecordingResumeOptions): AsyncIterable<RecordingEvent> {
    const frames = this.script.frames ?? 6;
    const interval = this.script.intervalMs ?? 500;
    this.stopped = false;
    const flv = buildMinimalFlv();
    // 续录：文件里已有内容时不再重复写 FLV 头（首段 0 字节时需要补头）。
    const existing = resume?.append && outputPath ? await stat(outputPath).catch(() => null) : null;
    let written = existing?.size ?? 0;
    const hadContent = written > 0;
    if (outputPath) {
      if (!hadContent) {
        await writeFile(outputPath, flv.subarray(0, 13)); // FLV header 先落盘
        written = 13;
      }
      yield { type: 'file_created', filePath: outputPath };
    }
    const segmentStart = written;
    let mediaMs = resume?.timestampOffsetMs ?? 0;
    for (let i = 0; i < frames; i += 1) {
      if (this.stopped) break;
      if (this.script.formatChangeAfterMs !== undefined && written - segmentStart >= this.script.formatChangeAfterMs) {
        yield { type: 'stream_format_changed' };
        written += 1;
      }
      // 写文件时文件头已在上面单独落盘（续录时由上一段写过），首帧只追加标签、不重复写头，与真实引擎一致；
      // 纯预览（无 outputPath）没有单独的落盘动作，文件头必须随首帧发出，否则预览无法初始化。
      const chunk = i === 0 ? (outputPath ? flv.subarray(13) : flv) : flv.subarray(9);
      yield { type: 'data', chunk };
      if (outputPath) await appendFile(outputPath, chunk);
      written += chunk.length;
      mediaMs += interval;
      if (this.script.failAfterMs !== undefined && written - segmentStart >= this.script.failAfterMs && this.script.failError) {
        yield { type: 'error', error: this.script.failError, endTimestampMs: mediaMs };
        return;
      }
      // stop() 可能恰好发生在 data yield 暂停期间；恢复后先检查，不能再登记一个无人唤醒的定时器。
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        let settled = false;
        let stop!: () => void;
        const finish = () => {
          if (settled) return;
          settled = true;
          this.stopWaiters.delete(stop);
          resolve();
        };
        const handle = this.clock.setTimeout(finish, interval);
        stop = () => {
          this.clock.clearTimeout(handle);
          finish();
        };
        this.stopWaiters.add(stop);
      });
    }
    if (!this.stopped) yield { type: 'completed', fileSize: written, endTimestampMs: mediaMs };
  }
}
