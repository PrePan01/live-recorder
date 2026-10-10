import type { Alert, Diagnostic, ExportJob, PipelineArtifact, PipelineRun, Recording, RecordingSchedule, Room, SettingsView, UploadJob } from '../types/index.js';
import type { DanmakuStatus } from '../danmaku/types.js';

export type AppEvent =
  | { type: 'room:updated'; data: Room }
  | { type: 'desktop:notification'; data: { title: string; body: string } }
  | { type: 'recording:updated'; data: Recording }
  | { type: 'pipeline:updated'; data: { run: PipelineRun; artifacts: PipelineArtifact[] } }
  | { type: 'recording:deleted'; data: { id: string } }
  | { type: 'alert:created'; data: Alert }
  | { type: 'alert:updated'; data: Alert }
  | { type: 'settings:updated'; data: SettingsView }
  | { type: 'service:status'; data: ServiceStatusPayload }
  | { type: 'disk:space'; data: DiskSpacePayload }
  | { type: 'diagnostic:updated'; data: Diagnostic }
  | { type: 'upload:updated'; data: UploadJob }
  | { type: 'schedule:updated'; data: RecordingSchedule }
  | { type: 'export:updated'; data: ExportJob }
  | { type: 'danmaku:status'; data: DanmakuStatus }
  | { type: 'stream-health'; data: import('./quality-health.js').StreamHealth }
  | { type: 'clip-queue:updated'; data: { recordingId: string } };

export interface ServiceStatusPayload {
  state: 'running' | 'starting' | 'offline' | 'restarting';
  activeRecordings: number;
  setupCompleted: boolean;
}

export interface DiskSpacePayload {
  directory: string;
  freeBytes: number;
  totalBytes: number;
  low: boolean;
}

export type EventListener = (event: AppEvent) => void;

export class AppEventBus {
  private listeners = new Set<EventListener>();

  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AppEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者失败不影响其他订阅者
      }
    }
  }
}
