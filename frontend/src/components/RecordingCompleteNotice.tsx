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

export default function RecordingCompleteNotice() {
  const { notification, message } = App.useApp();
  const seenRef = useRef<Set<string>>(new Set());
  const completed = useRecordingStore((s) => s.completionNotice);
  const pendingConfirm = useRecordingStore((s) => s.pendingConfirm);
  const clearPendingConfirm = useRecordingStore((s) => s.clearPendingConfirm);
  const pendingClip = useRecordingStore((s) => s.pendingClipExport);
  const clearPendingClip = useRecordingStore((s) => s.clearPendingClipExport);
  const beginClipExport = useRecordingStore((s) => s.beginClipExport);
  const clipDoneQueue = useRecordingStore((s) => s.clipDoneQueue);
  const clearClipDoneQueue = useRecordingStore((s) => s.clearClipDoneQueue);
  const roomName = useRoomName();
  const [confirming, setConfirming] = useState(false);
  const [fileName, setFileName] = useState("");

  useEffect(() => {
    const current = pendingConfirm?.filePath?.split(/[\\/]/).pop() ?? "";
    setFileName(current.replace(/\.[^.]+$/, ""));
  }, [pendingConfirm]);

  // 确认框弹出即撤掉同录制的「录制完成」通知，两条提示不同时占屏。
  useEffect(() => {
    if (pendingConfirm)
      notification.destroy(`rec-complete-${pendingConfirm.id}`);
  }, [pendingConfirm, notification]);

  // 录制完成（非待确认保留）→ 通知「已保存 + 打开录像文件」。
  useEffect(() => {
    if (completed?.filePath && !seenRef.current.has(completed.id)) {
      const latest = completed;
      seenRef.current.add(latest.id);
      const name = roomName[latest.roomId] ?? latest.roomId;
      notification.info({
        key: `rec-complete-${latest.id}`,
        message: "录制完成",
        description: `已保存：${name}`,
        duration: 0,
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
      if (rec.state === "completed") {
        notification.success({
          key: `clip-done-${rec.id}`,
          message: "片段已保存",
          description: rec.streamTitle,
          duration: 0,
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
          duration: 0,
        });
      }
    }
    clearClipDoneQueue();
  }, [clipDoneQueue, notification, clearClipDoneQueue]);

  // #220/#221：录制完成进入「待确认保留」态 → 弹确认框（保留/不保留）。
  const confirmName = pendingConfirm
    ? (roomName[pendingConfirm.roomId] ?? pendingConfirm.roomId)
    : "";
  const endReasonText = describeEndReason(pendingConfirm?.endReason);
  const interruptedEnd = isInterruptedEnd(pendingConfirm?.endReason);
  const doKeep = async (keep: boolean) => {
    if (!pendingConfirm) return;
    setConfirming(true);
    try {
      await confirmRecordingKeep(pendingConfirm.id, keep, fileName);
    } catch {
      message.error("决策提交失败，请重试");
    } finally {
      setConfirming(false);
      clearPendingConfirm();
    }
  };

  return (
    <>
      <RecordingKeepConfirmModal
        open={!!pendingConfirm}
        name={confirmName}
        endReasonText={endReasonText}
        interruptedEnd={interruptedEnd}
        fileName={fileName}
        onFileNameChange={setFileName}
        confirming={confirming}
        onKeep={() => void doKeep(true)}
        onDiscard={() => void doKeep(false)}
        onCancel={() => clearPendingConfirm()}
      />
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
