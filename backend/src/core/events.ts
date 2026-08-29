import type { Alert, Diagnostic, Recording, Room, SettingsView } from '../types/index.js';

export type AppEvent =
  | { type: 'room:updated'; data: Room }
  | { type: 'recording:updated'; data: Recording }
  | { type: 'alert:created'; data: Alert }
  | { type: 'alert:updated'; data: Alert }
  | { type: 'settings:updated'; data: SettingsView }
  | { type: 'service:status'; data: ServiceStatusPayload }
  | { type: 'disk:space'; data: DiskSpacePayload }
  | { type: 'diagnostic:updated'; data: Diagnostic };

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
