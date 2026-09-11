import { useEffect, useRef, useState } from "react";
import { App, Button, Input, Modal, Space } from "antd";
import { useRecordingStore } from "../stores/recordingStore";
import { useRoomStore } from "../stores/roomStore";
import { confirmRecordingKeep } from "../api/recordings";

export default function RecordingCompleteNotice() {
  const { notification, message } = App.useApp();
  const seenRef = useRef<Set<string>>(new Set());
  const completed = useRecordingStore((s) => s.completionNotice);
  const pendingConfirm = useRecordingStore((s) => s.pendingConfirm);
  const clearPendingConfirm = useRecordingStore((s) => s.clearPendingConfirm);
  const roomName = useRoomName();
  const [confirming, setConfirming] = useState(false);
  const [fileName, setFileName] = useState("");

  useEffect(() => {
    const current = pendingConfirm?.filePath?.split(/[\\/]/).pop() ?? "";
    setFileName(current.replace(/\.[^.]+$/, ""));
  }, [pendingConfirm]);

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
                void useRecordingStore.getState().openDirectory(latest.id);
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

  // #220/#221：录制完成进入「待确认保留」态 → 弹确认框（保留/不保留）。
  const confirmName = pendingConfirm
    ? (roomName[pendingConfirm.roomId] ?? pendingConfirm.roomId)
    : "";
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
    <Modal
      centered
      open={!!pendingConfirm}
      title="录制完成"
      closable={false}
      maskClosable={false}
      zIndex={1200}
      footer={null}
      onCancel={() => clearPendingConfirm()}
    >
      <p>
        录制已完成，是否保留此片段？
        <br />
        <span style={{ fontWeight: 600 }}>{confirmName}</span>
      </p>
      <Input
        size="small"
        value={fileName}
        onChange={(event) => setFileName(event.target.value)}
        placeholder="录像文件名（不含扩展名）"
        addonBefore="文件名"
        disabled={confirming}
        maxLength={120}
      />
      <Space
        style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}
      >
        <Button danger loading={confirming} onClick={() => void doKeep(false)}>
          不保留（删除）
        </Button>
        <Button
          type="primary"
          loading={confirming}
          onClick={() => void doKeep(true)}
        >
          保留
        </Button>
      </Space>
    </Modal>
  );
}

function useRoomName(): Record<string, string> {
  const rooms = useRoomStore((s) => s.rooms);
  return rooms.reduce<Record<string, string>>((acc, r) => {
    acc[r.id] = r.displayName;
    return acc;
  }, {});
}
