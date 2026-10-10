import { App } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createRecordingMarker,
  fetchRecordingMarkers,
} from "../../api/recordings";
import { ApiError } from "../../types/error";
import type { RecordingMarker } from "../../types/recording";
import type { Room } from "../../types/room";
import { describeError } from "../../utils/errorMap";

import type { RefObject } from "react";

export function usePreviewMarkers(
  _room: Room,
  _live: Room,
  activeRecordingId: string | undefined,
  activeRecordingRef: RefObject<string | undefined>,
  displayPreview: {
    mode: "live" | "history";
    second?: number;
    loading?: boolean;
  },
  trackClosing: boolean,
  trackElapsedSeconds: number,
  getPosition?: () => Promise<number>,
) {
  const { message } = App.useApp();
  const [markers, setMarkers] = useState<RecordingMarker[]>([]);
  const addingMarkerRef = useRef(false);
  const [addingMarker, setAddingMarker] = useState(false);
  useEffect(() => {
    setMarkers([]);
    if (!activeRecordingId) return;
    let cancelled = false;
    void fetchRecordingMarkers(activeRecordingId)
      .then((items) => {
        if (!cancelled) setMarkers(items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeRecordingId]);

  const updateMarkers = async (
    action: () => Promise<RecordingMarker | void>,
  ) => {
    const id = activeRecordingId;
    try {
      await action();
      if (id) {
        const items = await fetchRecordingMarkers(id);
        if (activeRecordingRef.current === id) setMarkers(items);
      }
    } catch (error) {
      message.error(
        error instanceof ApiError
          ? describeError(error.code, error.message)
          : "标记保存失败",
      );
      throw error;
    }
  };

  const quickAddMarker = useCallback(() => {
    if (
      !activeRecordingId ||
      addingMarkerRef.current ||
      displayPreview.loading ||
      trackClosing
    )
      return;
    addingMarkerRef.current = true;
    setAddingMarker(true);
    const index =
      markers.reduce(
        (max, m) =>
          Math.max(max, Number(/^标记 (\d+)$/.exec(m.text)?.[1] ?? 0)),
        markers.length,
      ) + 1;
    const position =
      displayPreview.mode === "history"
        ? Math.floor(displayPreview.second ?? 0)
        : trackElapsedSeconds;
    const create = (at: number) =>
      createRecordingMarker(activeRecordingId, `标记 ${index}`, at);
    const pending = getPosition ? getPosition().then(create) : create(position);
    void pending
      .then((marker) => {
        if (activeRecordingRef.current !== activeRecordingId) return;
        setMarkers((items) => [...items, marker]);
      })
      .catch((error) =>
        message.error(
          error instanceof ApiError
            ? describeError(error.code, error.message)
            : "打点失败",
        ),
      )
      .finally(() => {
        addingMarkerRef.current = false;
        setAddingMarker(false);
      });
  }, [
    activeRecordingId,
    activeRecordingRef,
    displayPreview.loading,
    displayPreview.mode,
    displayPreview.second,
    markers,
    message,
    trackClosing,
    trackElapsedSeconds,
    getPosition,
  ]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        !event.altKey ||
        event.code !== "KeyM" ||
        target?.closest("input, textarea, select, [contenteditable=true]")
      )
        return;
      event.preventDefault();
      quickAddMarker();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [quickAddMarker]);

  return {
    markers,
    addingMarker,
    updateMarkers,
    quickAddMarker,
  };
}
