import type { ErrorObject } from '../types/index.js';

export interface StreamInput {
  url: string;
  format: 'flv' | 'hls';
  headers?: Record<string, string>;
}

/**
 * 续录选项：中断恢复后接着写同一个文件，而不是另开一个文件。
 * 同一场直播的多次中断恢复因此在磁盘上只留一个文件、历史里只留一条记录。
 */
export interface RecordingResumeOptions {
  /** 追加到已存在的文件（保留已录内容），而不是截断重建。 */
  append: boolean;
  /** 本段媒体时间戳统一加上的偏移（上一段结尾时间戳），保证拼接处播放连续。 */
  timestampOffsetMs: number;
}

export type RecordingEvent =
  | { type: 'file_created'; filePath: string }
  | { type: 'data'; chunk: Buffer }
  | { type: 'completed'; fileSize: number; endTimestampMs?: number }
  | { type: 'error'; error: ErrorObject; endTimestampMs?: number }
  | { type: 'stream_format_changed' };

export interface RecordingEngine {
  /** outputPath 传 null 时为纯预览模式：拉流只产出 data 事件（预览转发），不写文件、不发 file_created。 */
  start(input: StreamInput, outputPath?: string | null, resume?: RecordingResumeOptions): AsyncIterable<RecordingEvent>;
  stop(): Promise<void>;
}
