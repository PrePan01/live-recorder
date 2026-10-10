import { useMemo, useRef, useState } from "react";
import type { RecordingMarker } from "../types/recording";
import { App } from "antd";
import { exportClipSegments } from "../api/clipQueue";
import { ApiError } from "../types/error";
import { describeError } from "../utils/errorMap";

export function useSegmentExport(
  recordingId: string | undefined,
  markers: RecordingMarker[],
) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<{
    recordingId: string | undefined;
    enabled: boolean;
    ids: string[];
  }>({ recordingId, enabled: false, ids: [] });
  if (selection.recordingId !== recordingId)
    setSelection({ recordingId, enabled: false, ids: [] });
  const segmentIds = useMemo(
    () => markers.filter((m) => m.endPositionSeconds != null).map((m) => m.id),
    [markers],
  );
  const selectedIds = useMemo(() => {
    const available = new Set(segmentIds);
    return selection.recordingId === recordingId
      ? selection.ids.filter((id) => available.has(id))
      : [];
  }, [segmentIds, selection, recordingId]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selecting = selection.recordingId === recordingId && selection.enabled;
  const select = (id: string, checked: boolean) => {
    if (busy || !selecting || !segmentIds.includes(id)) return;
    setSelection((s) => ({
      ...s,
      ids: checked
        ? [...new Set([...s.ids, id])]
        : s.ids.filter((value) => value !== id),
    }));
  };
  const lock = useRef(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const submit = async (ids: string[]) => {
    if (!recordingId || !ids.length || lock.current) return;
    lock.current = true;
    setBusy(true);
    const key = `${recordingId}:${ids.join(",")}`;
    if (request.current?.key !== key)
      request.current = { key, id: crypto.randomUUID() };
    try {
      await exportClipSegments(recordingId, ids, request.current.id);
      request.current = null;
      message.success(`已提交 ${ids.length} 个片段`);
    } catch (error) {
      message.error(
        error instanceof ApiError
          ? describeError(error.code, error.message)
          : "提交失败，请重试",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const selectOrSubmit = () => {
    if (busy) return;
    if (!selecting) setSelection({ recordingId, enabled: true, ids: [] });
    else if (!selectedIds.length)
      setSelection({ recordingId, enabled: false, ids: [] });
    else void submit(selectedIds);
  };
  return {
    busy,
    submit,
    segmentIds,
    selecting,
    selectedIds,
    selectedSet,
    select,
    selectOrSubmit,
  };
}
