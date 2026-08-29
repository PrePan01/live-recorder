import type { ServerEvent } from '../types/events';
import { useRoomStore } from './roomStore';
import { useRecordingStore } from './recordingStore';
import { useAlertStore } from './alertStore';
import { useSettingsStore } from './settingsStore';
import { useServiceStore } from './serviceStore';
import { useDiagnosticStore } from './diagnosticStore';
import { useNotificationStore } from './notificationStore';
import { useUploadStore } from './uploadStore';

export function applyServerEvent(e: ServerEvent) {
  switch (e.type) {
    case 'room:updated':
      // DELETE broadcasts the final disabled room after removeRoom has already
      // removed it locally. Do not resurrect that stale event into the list.
      if (
        e.room.monitorState === 'disabled' &&
        !useRoomStore.getState().rooms.some((room) => room.id === e.room.id)
      ) {
        break;
      }
      useRoomStore.getState().upsertRoom(e.room);
      break;
    case 'recording:updated':
      useRecordingStore.getState().upsertRecordingFromEvent(e.recording);
      break;
    case 'alert:created':
    case 'alert:updated':
      useAlertStore.getState().upsertAlert(e.alert);
      break;
    case 'settings:updated':
      useSettingsStore.getState().setSettings(e.settings);
      if (e.settings.notifications) useNotificationStore.getState().setPreferences(e.settings.notifications);
      break;
    case 'service:status':
      useServiceStore.getState().patchStatus(e.serviceStatus);
      break;
    case 'disk:space':
      useServiceStore.getState().patchStatus({ disk: e.disk });
      break;
    case 'diagnostic:updated':
      useDiagnosticStore.getState().upsert(e.diagnostic);
      break;
    case 'upload:updated':
      useUploadStore.getState().upsert(e.upload);
      break;
  }
}
