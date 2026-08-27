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
  start(input: StreamInput, outputPath: string): AsyncIterable<RecordingEvent>;
  stop(): Promise<void>;
}
