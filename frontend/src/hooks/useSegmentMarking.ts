import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "antd";
import { createRecordingMarker } from "../api/recordings";
import type { RecordingMarker } from "../types/recording";
import { useSegmentDraftStore } from "../stores/segmentDraftStore";
import { ApiError } from "../types/error";
import { describeError } from "../utils/error/errorMap";

export function useSegmentMarking(
  recordingId: string | undefined,
  markers: RecordingMarker[],
  getPosition: () => Promise<number>,
  onSaved: (marker: RecordingMarker) => void,
  disabled = false,
) {
  const { message } = App.useApp();
  const start = useSegmentDraftStore((s) =>
    s.recordingId === recordingId ? s.start : null,
  );
  const end = useSegmentDraftStore((s) =>
    s.recordingId === recordingId ? s.end : null,
  );
  const text = useSegmentDraftStore((s) =>
    s.recordingId === recordingId ? s.text : "",
  );
  const [saving, setSaving] = useState(false);
  const lock = useRef(false);
  const identity = useRef(recordingId);
  useEffect(() => {
    identity.current = recordingId;
    return () => {
      identity.current = undefined;
    };
  }, [recordingId]);
  useEffect(() => {
    if (recordingId) useSegmentDraftStore.getState().activate(recordingId);
  }, [recordingId]);
  const mark = useCallback(async () => {
    if (!recordingId || disabled || lock.current) return;
    lock.current = true;
    setSaving(true);
    const id = recordingId;
    try {
      const draft = useSegmentDraftStore.getState();
      const position =
        draft.recordingId === id && draft.end != null
          ? draft.end
          : await getPosition();
      if (identity.current !== id || !Number.isFinite(position)) return;
      const store = useSegmentDraftStore.getState();
      if (store.recordingId !== id) return;
      if (store.start == null) {
        const index =
          markers.reduce(
            (max, m) =>
              Math.max(max, Number(/^片段 (\d+)$/.exec(m.text)?.[1] ?? 0)),
            markers.filter((m) => m.endPositionSeconds != null).length,
          ) + 1;
        store.setStart(id, position, `片段 ${index}`);
        return;
      }
      const from = Math.min(store.start, position);
      const to = Math.max(store.start, position);
      if (to - from < 1) {
        message.warning("片段至少需要 1 秒");
        return;
      }
      store.setEnd(id, position);
      const marker = await createRecordingMarker(id, store.text, from, to);
      if (
        identity.current === id &&
        useSegmentDraftStore.getState().recordingId === id
      ) {
        useSegmentDraftStore.getState().setStart(id, null);
        onSaved(marker);
        message.success("已标记片段");
      }
    } catch (error) {
      message.error(
        error instanceof ApiError
          ? describeError(error.code, error.message)
          : "片段保存失败，请重试",
      );
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }, [recordingId, disabled, getPosition, markers, onSaved, message]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        !e.altKey ||
        e.ctrlKey ||
        e.metaKey ||
        e.repeat ||
        e.code !== "KeyP" ||
        (e.target as HTMLElement | null)?.closest(
          "input,textarea,select,[contenteditable=true]",
        )
      )
        return;
      e.preventDefault();
      void mark();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [mark]);
  return {
    start,
    end,
    text,
    rename: (value: string) => {
      const trimmed = value.trim();
      if (recordingId && !lock.current && trimmed && trimmed.length <= 200)
        useSegmentDraftStore.getState().setText(recordingId, trimmed);
    },
    saving,
    mark,
    cancel: () => {
      if (recordingId && !lock.current)
        useSegmentDraftStore.getState().setStart(recordingId, null);
    },
  };
}
