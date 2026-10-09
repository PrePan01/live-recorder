import { App } from "antd";
import { useEffect, useRef, useState } from "react";
import {
  clearHighlightBuffer,
  disableHighlightBuffer,
  enableHighlightBuffer,
  exportHighlight,
  fetchHighlightBufferStatus,
  type HighlightBufferStatus,
} from "../../api/rooms";
import { useSettingsStore } from "../../stores/settingsStore";
import { ApiError } from "../../types/error";
import type { Room } from "../../types/room";
import { describeError } from "../../utils/errorMap";

export function usePreviewHighlights(
  room: Room,
  recording: boolean,
  onAir: boolean,
  enableHighlights: boolean,
) {
  const { message } = App.useApp();
  const highlightEnabled = useSettingsStore(
    (s) => s.settings?.highlightEnabled ?? true,
  );
  const [highlightSeconds, setHighlightSeconds] = useState(30);
  const [highlightMaxSeconds, setHighlightMaxSeconds] = useState(300);
  const [highlightAvailableSeconds, setHighlightAvailableSeconds] = useState(0);
  const [highlightDisabledReason, setHighlightDisabledReason] = useState<
    string | null
  >(null);
  const [exporting, setExporting] = useState(false);
  const highlightGenRef = useRef(new Map<string, number>());
  const bumpHighlightGen = (id: string) => {
    const next = (highlightGenRef.current.get(id) ?? 0) + 1;
    highlightGenRef.current.set(id, next);
    return next;
  };

  // 此组件只用于监控页/全屏普通观看；直播墙直接使用 VideoPlayer，因此不会触发缓存。
  useEffect(() => {
    if (!enableHighlights || !highlightEnabled || recording || !onAir) {
      setHighlightAvailableSeconds(0);
      setHighlightDisabledReason(null);
      return;
    }
    let alive = true;
    bumpHighlightGen(room.id);
    const applyStatus = (status: HighlightBufferStatus) => {
      if (!alive) return;
      setHighlightMaxSeconds(status.maxSeconds);
      setHighlightAvailableSeconds(status.availableSeconds);
      setHighlightDisabledReason(
        status.accepting ? null : (status.disabledReason ?? null),
      );
    };
    const refresh = () =>
      void fetchHighlightBufferStatus(room.id)
        .then((status) => {
          if (!alive) return;
          applyStatus(status);
          if (!status.enabled) {
            bumpHighlightGen(room.id);
            void enableHighlightBuffer(room.id)
              .then(applyStatus)
              .catch(() => undefined);
          }
        })
        .catch(() => alive && setHighlightAvailableSeconds(0));
    void enableHighlightBuffer(room.id)
      .then(applyStatus)
      .catch(() => alive && setHighlightAvailableSeconds(0));
    let timer: number | null = null;
    const startTick = () => {
      if (timer === null) timer = window.setInterval(refresh, 1_000);
    };
    const stopTick = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    // 后台暂停预览轮询，回前台立即刷一次再恢复（预览画面/时长显示不滞后）。
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refresh();
        startTick();
      } else stopTick();
    };
    if (document.visibilityState === "visible") startTick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      stopTick();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [room.id, recording, onAir, enableHighlights, highlightEnabled]);

  const saveHighlight = (seconds: number) => {
    seconds = Math.max(1, Math.min(Math.floor(seconds), highlightMaxSeconds));
    setExporting(true);
    void exportHighlight(room.id, seconds)
      .then(() =>
        message.success(`${formatSeconds(seconds)}精彩时刻录制完成`, 5),
      )
      .catch((e) =>
        message.error(
          e instanceof ApiError
            ? describeError(e.code, e.message)
            : "精彩时刻录制失败",
        ),
      )
      .finally(() => setExporting(false));
  };

  const clearHighlight = () => {
    void clearHighlightBuffer(room.id)
      .then(() => {
        setHighlightAvailableSeconds(0);
        setHighlightDisabledReason(null);
      })
      .catch(() => message.error("清空精彩时刻缓存失败"));
  };

  const formatSeconds = (seconds: number) =>
    seconds >= 60
      ? `${Math.floor(seconds / 60)} 分 ${seconds % 60 ? `${seconds % 60} 秒` : ""}`
      : `${seconds} 秒`;
  const quickSeconds = [30, 60, 120, 300].map((seconds) =>
    Math.min(seconds, highlightMaxSeconds),
  );

  useEffect(() => {
    const roomId = room.id;
    const generations = highlightGenRef.current;
    return () => {
      if (!enableHighlights) return;
      const gen = generations.get(roomId) ?? 0;
      window.setTimeout(() => {
        if ((generations.get(roomId) ?? 0) !== gen) return;
        void disableHighlightBuffer(roomId).catch(() => undefined);
      }, 150);
    };
  }, [enableHighlights, room.id]);

  return {
    highlightEnabled,
    highlightSeconds,
    setHighlightSeconds,
    highlightMaxSeconds,
    highlightAvailableSeconds,
    highlightDisabledReason,
    exporting,
    saveHighlight,
    clearHighlight,
    formatSeconds,
    quickSeconds,
  };
}
