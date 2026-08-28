import { useEffect, useRef } from 'react';
import { App } from 'antd';
import { useRecordingStore } from '../stores/recordingStore';
import { useRoomStore } from '../stores/roomStore';

export default function RecordingCompleteNotice() {
  const { notification } = App.useApp();
  const seenRef = useRef<Set<string>>(new Set());
  const ids = useRecordingStore((s) => s.items.map((r) => r.id).join(','));
  const roomName = useRoomName();

  useEffect(() => {
    const items = useRecordingStore.getState().items;
    const completed = items.filter((r) => r.state === 'completed' && r.filePath && !seenRef.current.has(r.id));
    completed.forEach((r) => seenRef.current.add(r.id));
    if (completed.length > 0) {
      const latest = completed[completed.length - 1]!;
      const name = roomName[latest.roomId] ?? latest.roomId;
      notification.info({
        key: `rec-complete-${latest.id}`,
        message: '录制完成',
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
  }, [ids, roomName, notification]);

  return null;
}

function useRoomName(): Record<string, string> {
  const rooms = useRoomStore((s) => s.rooms);
  return rooms.reduce<Record<string, string>>((acc, r) => {
    acc[r.id] = r.displayName;
    return acc;
  }, {});
}