import type { ErrorObject } from '../types/index.js';

export interface StreamInput {
  url: string;
  format: 'flv' | 'hls';
  headers?: Record<string, string>;
}

export type RecordingEvent =
  | { type: 'file_created'; filePath: string }
  | { type: 'data'; chunk: Buffer }
  | { type: 'completed'; fileSize: number }
  | { type: 'error'; error: ErrorObject }
  | { type: 'stream_format_changed' };

export interface RecordingEngine {
  /** outputPath 传 null 时为纯预览模式：拉流只产出 data 事件（预览转发），不写文件、不发 file_created。 */
  start(input: StreamInput, outputPath?: string | null): AsyncIterable<RecordingEvent>;
  stop(): Promise<void>;
}
