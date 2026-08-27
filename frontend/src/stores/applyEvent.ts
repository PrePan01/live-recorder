import type { ServerEvent } from '../types/events';
import { useRoomStore } from './roomStore';
import { useRecordingStore } from './recordingStore';
import { useAlertStore } from './alertStore';
import { useSettingsStore } from './settingsStore';
import { useServiceStore } from './serviceStore';

export function applyServerEvent(e: ServerEvent) {
  switch (e.type) {
    case 'room:updated':
      useRoomStore.getState().upsertRoom(e.room);
      break;
    case 'recording:updated':
      useRecordingStore.getState().upsertRecording(e.recording);
      break;
    case 'alert:created':
    case 'alert:updated':
      useAlertStore.getState().upsertAlert(e.alert);
      break;
    case 'settings:updated':
      useSettingsStore.getState().setSettings(e.settings);
      break;
    case 'service:status':
      useServiceStore.getState().patchStatus(e.serviceStatus);
      break;
    case 'disk:space':
      useServiceStore.getState().patchStatus({ diskSpace: e.diskSpace });
      break;
  }
}
