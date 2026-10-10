import { App } from "antd";
import { useEffect, useRef, useState } from "react";
import { useRoomStore } from "../../stores/roomStore";
import { ApiError } from "../../types/error";
import type { Room } from "../../types/room";
import { describeError } from "../../utils/errorMap";

export function usePreviewRecording(room: Room) {
  const { message } = App.useApp();
  const live = useRoomStore(
    (s) => s.rooms.find((r) => r.id === room.id) ?? room,
  );
  const actingRoomId = useRoomStore((s) => s.actingRoomId);
  const actingAction = useRoomStore((s) => s.actingAction);
  const startRoomRecording = useRoomStore((s) => s.startRoomRecording);
  const stopRoomRecording = useRoomStore((s) => s.stopRoomRecording);
  const [recentStop, setRecentStop] = useState(false);
  const [displayedTrack, setDisplayedTrack] = useState<{
    id: string;
    startedAt: string;
  } | null>(null);
  const recording =
    live.monitorState === "recording" || live.monitorState === "reconnecting";
  const onAir = live.lastLiveStatus === "live";
  const busy = actingRoomId === room.id;
  const activeRecordingId = live.activeRecording?.recordingId;
  const activeRecordingRef = useRef(activeRecordingId);
  activeRecordingRef.current = activeRecordingId;
  // 停止后保留最后一帧到退场动画结束，避免条件渲染直接卸载而闪退。
  useEffect(() => {
    if (recording && activeRecordingId && live.activeRecording?.startedAt) {
      const next = {
        id: activeRecordingId,
        startedAt: live.activeRecording.startedAt,
      };
      setDisplayedTrack((current) =>
        current?.id === next.id && current.startedAt === next.startedAt
          ? current
          : next,
      );
      return;
    }
    if (!displayedTrack) return;
    const timer = window.setTimeout(() => setDisplayedTrack(null), 1000);
    return () => window.clearTimeout(timer);
  }, [
    recording,
    activeRecordingId,
    live.activeRecording?.startedAt,
    displayedTrack,
  ]);
  const trackClosing = Boolean(displayedTrack) && !recording;

  useEffect(() => {
    if (!recentStop) return;
    const t = setTimeout(() => setRecentStop(false), 1200);
    return () => clearTimeout(t);
  }, [recentStop]);

  const handleStart = () => {
    void startRoomRecording(room.id).catch((e) =>
      message.error(
        e instanceof ApiError
          ? describeError(e.code, e.message)
          : "录制请求失败",
      ),
    );
  };

  const handleStop = () => {
    setRecentStop(true);
    void stopRoomRecording(room.id).catch(() => message.error("停止请求失败"));
  };

  return {
    live,
    recording,
    onAir,
    busy,
    actingAction,
    activeRecordingId,
    activeRecordingRef,
    displayedTrack,
    trackClosing,
    recentStop,
    handleStart,
    handleStop,
  };
}
