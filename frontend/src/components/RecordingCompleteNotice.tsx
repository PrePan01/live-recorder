import { useEffect, useRef, useState } from "react";
import { App } from "antd";
import {
  useRecordingStore,
  type PendingClipExport,
} from "../stores/recordingStore";
import { useRoomStore } from "../stores/roomStore";
import { confirmRecordingKeep, exportRecordingClip } from "../api/recordings";
import { ApiError } from "../types/error";
import { describeError } from "../utils/errorMap";
import { failurePrimaryText } from "../utils/failureReason";
import {
  describeEndReason,
  isInterruptedEnd,
} from "../utils/recordingEndReason";
import RecordingKeepConfirmModal from "./RecordingKeepConfirmModal";
import type { Recording } from "../types/recording";

export default function RecordingCompleteNotice() {
  const { notification } = App.useApp();
  const seenRef = useRef<Set<string>>(new Set());
  const completed = useRecordingStore((s) => s.completionNotice);
  const pendingConfirm = useRecordingStore((s) => s.pendingConfirm);
  const pendingClip = useRecordingStore((s) => s.pendingClipExport);
  const clearPendingClip = useRecordingStore((s) => s.clearPendingClipExport);
  const beginClipExport = useRecordingStore((s) => s.beginClipExport);
  const clipDoneQueue = useRecordingStore((s) => s.clipDoneQueue);
  const clearClipDoneQueue = useRecordingStore((s) => s.clearClipDoneQueue);
  const roomName = useRoomName();

  useEffect(() => {
    if (pendingConfirm)
      notification.destroy(`rec-complete-${pendingConfirm.id}`);
  }, [pendingConfirm, notification]);

  useEffect(() => {
    if (completed?.filePath && !seenRef.current.has(completed.id)) {
      const latest = completed;
      seenRef.current.add(latest.id);
      const name = roomName[latest.roomId] ?? latest.roomId;
      notification.info({
        key: `rec-complete-${latest.id}`,
        message: "录制完成",
        description: `已保存：${name}`,
        duration: 5,
        btn: (
          <span>
            <a
              onClick={() => {
                void useRecordingStore
                  .getState()
                  .openDirectory(latest.id)
                  .catch(() => undefined);
                notification.destroy(`rec-complete-${latest.id}`);
              }}
            >
              打开录像文件
            </a>
          </span>
        ),
      });
    }
  }, [completed, roomName, notification]);

  useEffect(() => {
    if (!clipDoneQueue.length) return;
    for (const rec of clipDoneQueue) {
      if (
        rec.state === "completed" &&
        (rec.pipelineStatus === "failed" || rec.pipelineStatus === "partial")
      ) {
        notification.warning({
          key: `clip-done-${rec.id}`,
          message:
            rec.pipelineStatus === "failed"
              ? "片段后处理失败"
              : "片段后处理部分完成",
          description: `${rec.streamTitle}：请查看后处理详情`,
          duration: 5,
        });
      } else if (rec.state === "completed") {
        notification.success({
          key: `clip-done-${rec.id}`,
          message: "片段已保存",
          description: rec.streamTitle,
          duration: 5,
          btn: (
            <span>
              <a
                onClick={() => {
                  void useRecordingStore
                    .getState()
                    .openDirectory(rec.id)
                    .catch(() => undefined);
                  notification.destroy(`clip-done-${rec.id}`);
                }}
              >
                打开录像文件
              </a>
            </span>
          ),
        });
      } else {
        notification.error({
          key: `clip-done-${rec.id}`,
          message: "片段导出失败",
          description: `${rec.streamTitle}：${failurePrimaryText(rec.failureReason)}`,
          duration: 5,
        });
      }
    }
    clearClipDoneQueue();
  }, [clipDoneQueue, notification, clearClipDoneQueue]);

  // #220/#221：录制完成进入「待确认保留」态 → 弹确认框（保留/不保留）。
  const confirmName = pendingConfirm
    ? (roomName[pendingConfirm.roomId] ?? pendingConfirm.roomId)
    : "";

  return (
    <>
      {pendingConfirm ? (
        <RecordingKeepPrompt key={pendingConfirm.id} recording={pendingConfirm} name={confirmName} />
      ) : null}
      {pendingClip ? (
        <ClipExportConfirmModal
          prompt={pendingClip}
          name={roomName[pendingClip.roomId] ?? pendingClip.roomId}
          onStarted={beginClipExport}
          onFinished={clearPendingClip}
        />
      ) : null}
    </>
  );
}

/** 每份录像独立维护输入和提交状态；响应晚于 SSE 时也只消费自己的队列项。 */
function RecordingKeepPrompt({ recording, name }: { recording: Recording; name: string }) {
  const { message } = App.useApp();
  const [confirming, setConfirming] = useState(false);
  const submitting = useRef(false);
  const [fileName, setFileName] = useState(() =>
    (recording.filePath?.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, ""),
  );
  const doKeep = async (keep: boolean) => {
    if (submitting.current) return;
    submitting.current = true;
    setConfirming(true);
    try {
      await confirmRecordingKeep(recording.id, keep, fileName);
      useRecordingStore.getState().clearPendingConfirm(recording.id);
    } catch {
      message.error("决策提交失败，请重试");
    } finally {
      submitting.current = false;
      setConfirming(false);
    }
  };
  return (
    <RecordingKeepConfirmModal
      open
      name={name}
      endReasonText={describeEndReason(recording.endReason)}
      interruptedEnd={isInterruptedEnd(recording.endReason)}
      fileName={fileName}
      onFileNameChange={setFileName}
      confirming={confirming}
      onKeep={() => void doKeep(true)}
      onDiscard={() => void doKeep(false)}
      onCancel={() => {
        if (!submitting.current) useRecordingStore.getState().clearPendingConfirm(recording.id);
      }}
    />
  );
}

/** 导出选区的「录制完成」确认框：点保留才启动后台导出；关框/不保留=零动作取消。 */
function ClipExportConfirmModal({
  prompt,
  name,
  onStarted,
  onFinished,
}: {
  prompt: PendingClipExport;
  name: string;
  onStarted: (sourceRecordingId: string, clipRecordingId: string) => void;
  onFinished: () => void;
}) {
  const { message } = App.useApp();
  // 弹框按需挂载，文件名随挂载初始化，不会串上一次的输入。
  const [fileName, setFileName] = useState(prompt.defaultName);
  const [confirming, setConfirming] = useState(false);
  const keep = async () => {
    setConfirming(true);
    try {
      const res = await exportRecordingClip(
        prompt.recordingId,
        prompt.startSecond,
        prompt.endSecond,
        fileName.trim() || prompt.defaultName,
      );
      onStarted(prompt.recordingId, res.clip.id);
      onFinished();
    } catch (error) {
      // 命名不合法等可修正错误：留在弹框让用户重输，不吞错。
      message.error(
        error instanceof ApiError
          ? describeError(error.code, error.message)
          : "片段导出失败，请重试",
      );
    } finally {
      setConfirming(false);
    }
  };
  return (
    <RecordingKeepConfirmModal
      open
      name={name}
      endReasonText={describeEndReason("clip_export")}
      interruptedEnd={false}
      fileName={fileName}
      onFileNameChange={setFileName}
      confirming={confirming}
      onKeep={() => void keep()}
      onDiscard={onFinished}
      onCancel={onFinished}
      closable
      autoKeep={false}
    />
  );
}

function useRoomName(): Record<string, string> {
  const rooms = useRoomStore((s) => s.rooms);
  return rooms.reduce<Record<string, string>>((acc, r) => {
    acc[r.id] = r.displayName;
    return acc;
  }, {});
}
