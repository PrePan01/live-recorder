// 将选中的录像时间范围交给片段导出确认流程，并生成默认名称。
import { useRecordingStore } from "../../stores/recordingStore";
import { playbackClock } from "../player/playbackClock";

/** Freeze the selection before the naming dialog; never create a marker. */
export function promptRangeExport(recordingId: string, roomId: string, startSecond: number, endSecond: number) {
  useRecordingStore.getState().setPendingClipExport({
    recordingId, roomId, startSecond, endSecond,
    defaultName: `选区 ${playbackClock(startSecond).replace(/:/g, "-")}-${playbackClock(endSecond).replace(/:/g, "-")}`,
    queueRequestId: crypto.randomUUID(),
  });
}
