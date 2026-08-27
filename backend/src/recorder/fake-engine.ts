import { appendFile, writeFile } from 'node:fs/promises';
import type { ErrorObject } from '../types/index.js';
import { buildMinimalFlv } from '../platform/fake-adapter.js';
import type { Clock } from '../core/clock.js';
import type { RecordingEngine, RecordingEvent, StreamInput } from './engine.js';

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

  constructor(private clock: Clock, private script: FakeEngineScript = {}) {}

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }

  async *start(input: StreamInput, outputPath: string): AsyncIterable<RecordingEvent> {
    const frames = this.script.frames ?? 6;
    const interval = this.script.intervalMs ?? 500;
    this.stopped = false;
    const flv = buildMinimalFlv();
    await writeFile(outputPath, flv.subarray(0, 13)); // FLV header 先落盘
    yield { type: 'file_created', filePath: outputPath };
    let written = 13;
    for (let i = 0; i < frames; i += 1) {
      if (this.stopped) break;
      if (this.script.formatChangeAfterMs !== undefined && written >= this.script.formatChangeAfterMs) {
        yield { type: 'stream_format_changed' };
        written += 1;
      }
      const chunk = i === 0 ? flv : flv.subarray(9);
      yield { type: 'data', chunk };
      await appendFile(outputPath, chunk);
      written += chunk.length;
      if (this.script.failAfterMs !== undefined && written >= this.script.failAfterMs && this.script.failError) {
        yield { type: 'error', error: this.script.failError };
        return;
      }
      await new Promise<void>((resolve) => {
        this.clock.setTimeout(() => resolve(), interval);
      });
    }
    if (!this.stopped) yield { type: 'completed', fileSize: written };
  }
}
