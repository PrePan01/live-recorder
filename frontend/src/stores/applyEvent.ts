import type { ServerEvent } from "../types/events";
import { useRoomStore } from "./roomStore";
import { useRecordingStore } from "./recordingStore";
import { useAlertStore } from "./alertStore";
import { useSettingsStore } from "./settingsStore";
import { useServiceStore } from "./serviceStore";
import { useDiagnosticStore } from "./diagnosticStore";
import { useNotificationStore } from "./notificationStore";
import { useUploadStore } from "./uploadStore";
import { usePipelineStore } from "./pipelineStore";
import { useTasksStore } from "./tasksStore";
import { useDanmakuStore } from "./danmakuStore";
import { useStreamHealthStore } from "./streamHealthStore";
import { useClipQueueStore } from "./clipQueueStore";

export function applyServerEvent(e: ServerEvent) {
  switch (e.type) {
    case "desktop:notification":
      // 由 SSE 接收层直接交给原生通知桥接；无需写入应用状态。
      break;
    case "room:updated":
      // DELETE broadcasts the final disabled room after removeRoom has already
      // removed it locally. Do not resurrect that stale event into the list.
      if (
        e.room.monitorState === "disabled" &&
        !useRoomStore.getState().rooms.some((room) => room.id === e.room.id)
      ) {
        break;
      }
      useRoomStore.getState().upsertRoom(e.room);
      break;
    case "recording:updated":
      if (
        ["completed", "failed", "processing", "awaiting_confirmation"].includes(
          e.recording.state,
        )
      )
        useStreamHealthStore.getState().remove(e.recording.id);
      useTasksStore.getState().settleRecording(e.recording);
      useRecordingStore.getState().upsertRecordingFromEvent(e.recording);
      break;
    case "pipeline:updated":
      usePipelineStore.getState().upsert(e.pipeline);
      break;
    case "recording:deleted":
      useStreamHealthStore.getState().remove(e.recordingId);
      useRecordingStore.getState().removeRecordingFromEvent(e.recordingId);
      break;
    case "alert:created":
    case "alert:updated":
      useAlertStore.getState().upsertAlert(e.alert);
      break;
    case "settings:updated":
      useSettingsStore.getState().setSettings(e.settings);
      if (e.settings.notifications)
        useNotificationStore
          .getState()
          .setPreferences(e.settings.notifications);
      break;
    case "service:status":
      useServiceStore.getState().patchStatus(e.serviceStatus);
      break;
    case "disk:space":
      useServiceStore.getState().patchStatus({ disk: e.disk });
      break;
    case "diagnostic:updated":
      useDiagnosticStore.getState().upsert(e.diagnostic);
      break;
    case "upload:updated":
      useUploadStore.getState().upsert(e.upload);
      useRecordingStore.getState().patchRecordingUpload(e.upload.recordingId, {
        status: e.upload.status,
        progress: e.upload.progress,
        remotePath: e.upload.remotePath,
        error: e.upload.error,
        updatedAt: e.upload.updatedAt,
      });
      break;
    case "danmaku:status":
      useDanmakuStore.getState().applyStatus(e.status);
      break;
    case "stream-health":
      useStreamHealthStore.getState().applyHealth(e.health);
      break;
    case "clip-queue:updated":
      useClipQueueStore.getState().touch();
      break;
  }
}
