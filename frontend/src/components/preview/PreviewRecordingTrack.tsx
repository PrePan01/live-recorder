import { promptRangeExport } from "../../utils/timeline/promptRangeExport";
import { playbackClock } from "../../utils/player/playbackClock";
import {
  createRecordingMarker,
  deleteRecordingMarker,
  updateRecordingMarker,
} from "../../api/recordings";
import { MarkerNavPanel } from "../MarkerNavPanel";
import { QualityLight } from "../QualityLight";

import RecordingTrack from "../RecordingTrack";
import { useCallback, useEffect, useImperativeHandle, useMemo, useState, type Ref } from "react";
import type { RecordingMarker } from "../../types/recording";
import { useSegmentMarking } from "../../hooks/useSegmentMarking";
import { useSegmentExport } from "../../hooks/useSegmentExport";
import type { useRecordingMediaPosition } from "../../hooks/useRecordingMediaPosition";
import { SegmentExportActions } from "../SegmentExportActions";
import { SegmentMarkActions } from "../SegmentMarkActions";

import { usePreviewDanmaku } from "./usePreviewDanmaku.ts";
import { usePreviewLayout } from "./usePreviewLayout.ts";
import { usePreviewMarkers } from "./usePreviewMarkers.ts";
import { usePreviewRecording } from "./usePreviewRecording.ts";
import { usePreviewSeek } from "./usePreviewSeek.ts";
import { playheadStepTarget, previewPosition } from "../../utils/timeline/recordingTimeline";
import { formatShortcut, shortcutTitle } from "../../utils/keyboardShortcuts";
import { previewBinding, type ShortcutOverrides } from "../../utils/previewShortcuts";

const seekSteps = { seekBack: -1, seekForward: 1, seekBackFive: -5, seekForwardFive: 5 } as const;
type SeekAction = keyof typeof seekSteps;
type TrackAction = SeekAction | "mark" | "markSegment" | "returnToLive";

export type PreviewTrackControls = {
  selectionActive: boolean;
  run: (action: TrackAction) => boolean;
};

type Props = Pick<
  ReturnType<typeof usePreviewRecording>,
  "displayedTrack" | "trackClosing" | "recording"
> &
  Pick<
    ReturnType<typeof usePreviewLayout>,
    "trackRevealRef" | "setTrackCollapsed"
  > &
  Pick<ReturnType<typeof usePreviewDanmaku>, "trackGaps" | "streamHealth"> &
  Pick<
    ReturnType<typeof usePreviewMarkers>,
    "markers" | "quickAddMarker" | "addingMarker" | "updateMarkers"
  > &
  Pick<
    ReturnType<typeof usePreviewSeek>,
    | "displayPreview"
    | "handleSeekIntent"
    | "handleSeekCommit"
    | "seekPlayback"
    | "seekIndexState"
    | "seekActualStart"
  > & {
    roomId: string;
    media: ReturnType<typeof useRecordingMediaPosition>;
    trackElapsedSeconds: number;
    onPreviewSegment: (marker: RecordingMarker) => void;
    ref: Ref<PreviewTrackControls>;
    shortcutOverrides: ShortcutOverrides;
  };
export function PreviewRecordingTrack({
  roomId,
  displayedTrack,
  trackClosing,
  trackRevealRef,
  trackGaps,
  trackElapsedSeconds,
  markers,
  quickAddMarker,
  addingMarker,
  displayPreview,
  recording,
  streamHealth,
  handleSeekIntent,
  handleSeekCommit,
  seekPlayback,
  seekIndexState,
  seekActualStart,
  updateMarkers,
  media,
  onPreviewSegment,
  setTrackCollapsed,
  ref,
  shortcutOverrides,
}: Props) {
  const id = displayedTrack?.id;
  const [editingRange, setEditingRange] = useState<{
    marker: RecordingMarker;
    range: [number, number];
  } | null>(null);
  const [selectingRange, setSelectingRange] = useState(false);
  const [rangeSaving, setRangeSaving] = useState(false);
  useEffect(() => {
    setEditingRange(null);
    setSelectingRange(false);
  }, [id]);
  const saved = useCallback(() => {
    void updateMarkers(async () => {}).catch(() => undefined);
  }, [updateMarkers]);
  const selectionActive = editingRange != null || selectingRange;
  const markDisabled = !id || trackClosing || !!displayPreview.loading;
  const segmentDisabled = markDisabled || !media.duration || selectionActive;
  const marking = useSegmentMarking(
    id,
    markers,
    media.getPosition,
    saved,
    segmentDisabled,
  );
  const returnToLive = seekPlayback ? () => handleSeekCommit("live") : undefined;
  const previewSecond = media.current ?? displayPreview.second;
  useImperativeHandle(ref, () => ({
    selectionActive,
    run(action) {
      if (action === "returnToLive") {
        if (!returnToLive) return false;
        returnToLive();
      } else if (action === "mark") {
        if (markDisabled || addingMarker) return false;
        quickAddMarker();
      } else if (action === "markSegment") {
        if (segmentDisabled || marking.saving) return false;
        void marking.mark();
      } else {
        if (!recording || !id || trackClosing || displayPreview.loading) return false;
        const position = previewPosition(displayPreview.mode, trackElapsedSeconds, previewSecond);
        if (position === undefined) return false;
        const target = playheadStepTarget(
          "recording", position, seekSteps[action], trackElapsedSeconds,
        );
        if (target === undefined || target === position || (target === "live" && !seekPlayback)) return false;
        // Commit prepares the target immediately. Pointer movement still prewarms before release.
        handleSeekCommit(target);
      }
      return true;
    },
  }));
  const playheadTitle = useMemo(
    () => (Object.keys(seekSteps) as SeekAction[]).flatMap((action) => {
      const binding = previewBinding(shortcutOverrides, action);
      const step = seekSteps[action];
      return binding ? [`${step < 0 ? "后退" : "前进"} ${Math.abs(step)} 秒（${formatShortcut(binding)}）`] : [];
    }).join("，"),
    [shortcutOverrides],
  );
  const exports = useSegmentExport(id, markers);
  const changeRange = async (
    marker: RecordingMarker,
    start: number,
    end: number,
  ) => {
    if (!id) return;
    await updateMarkers(() =>
      updateRecordingMarker(id, marker.id, {
        positionSeconds: start,
        endPositionSeconds: end,
      }),
    );
  };
  const removeMarker = async (marker: RecordingMarker) => {
    if (!id) return;
    await updateMarkers(() => deleteRecordingMarker(id, marker.id));
    if (editingRange?.marker.id === marker.id) setEditingRange(null);
  };
  return (
    <>
      {displayedTrack ? (
        <div
          ref={trackRevealRef}
          className={`lr-recording-track-reveal${trackClosing ? " lr-recording-track-reveal--closing" : ""}`}
          style={{
            flexShrink: 0,
            minHeight: 0,
          }}
        >
          <div>
            <RecordingTrack
              key={id}
              onExport={
                marking.start != null || editingRange != null
                  ? undefined
                  : (start, end) =>
                      promptRangeExport(displayedTrack.id, roomId, start, end)
              }
              selectionDisabled={
                trackClosing || marking.saving || marking.start != null
              }
              onSelectionChange={setSelectingRange}
              segmentActions={
                editingRange == null ? (
                  <SegmentMarkActions
                    marking={marking}
                    current={media.current}
                    disabled={segmentDisabled}
                    shortcut={previewBinding(shortcutOverrides, "markSegment")}
                  >
                    <SegmentExportActions
                      exports={exports}
                      disabled={trackClosing || editingRange != null}
                    />
                  </SegmentMarkActions>
                ) : null
              }
              temporarySegment={
                marking.start != null
                  ? [
                      marking.start,
                      marking.end ?? media.current ?? marking.start,
                    ]
                  : null
              }
              rangeSelection={
                editingRange && editingRange.marker.recordingId === id
                  ? editingRange.range
                  : null
              }
              busy={rangeSaving}
              showRangeNudge
              onSaveRange={async (start, end) => {
                if (!editingRange || rangeSaving) return;
                setRangeSaving(true);
                try {
                  await changeRange(editingRange.marker, start, end);
                  setEditingRange(null);
                } catch {
                  /* updateMarkers presents the error and preserves the range. */
                } finally {
                  setRangeSaving(false);
                }
              }}
              onCancelRange={() => setEditingRange(null)}
              gaps={trackGaps}
              elapsedSeconds={trackElapsedSeconds}
              markers={markers}
              editable
              onQuickAdd={quickAddMarker}
              quickAddTitle={shortcutTitle("标记当前位置", previewBinding(shortcutOverrides, "mark"))}
              addingMarker={addingMarker}
              quickAddDisabled={markDisabled}
              toolbar={
                recording && !trackClosing ? (
                  <QualityLight health={streamHealth} />
                ) : undefined
              }
              onSeekIntent={handleSeekIntent}
              onSeekCommit={handleSeekCommit}
              onReturnToLive={returnToLive}
              returnToLiveTitle={shortcutTitle("返回直播", previewBinding(shortcutOverrides, "returnToLive"))}
              externalPlayheadKeyboard
              previewPlayheadTitle={playheadTitle}
              previewMode={displayPreview.mode}
              previewSecond={previewSecond}
              markerPositionSecond={media.current}
              getMarkerPosition={media.getPosition}
              previewLoading={displayPreview.loading}
              seekHint={
                seekIndexState === "building"
                  ? "正在加载…"
                  : seekActualStart != null
                    ? `从 ${playbackClock(seekActualStart.second, false)} 起播`
                    : undefined
              }
              onAdd={(text, positionSeconds) =>
                updateMarkers(() =>
                  createRecordingMarker(
                    displayedTrack.id,
                    text,
                    positionSeconds,
                  ),
                )
              }
              onEdit={(markerId, text) =>
                updateMarkers(() =>
                  updateRecordingMarker(displayedTrack.id, markerId, {
                    text,
                  }),
                )
              }
              onMove={(markerId, positionSeconds, endPositionSeconds) =>
                updateMarkers(() =>
                  updateRecordingMarker(displayedTrack.id, markerId, {
                    positionSeconds,
                    ...(endPositionSeconds !== undefined
                      ? { endPositionSeconds }
                      : {}),
                  }),
                )
              }
              onDelete={(markerId) =>
                updateMarkers(() =>
                  deleteRecordingMarker(displayedTrack.id, markerId),
                )
              }
              onCollapsedChange={setTrackCollapsed}
            >
              <MarkerNavPanel
                key={displayedTrack.id}
                markers={markers}
                pendingSegment={marking.start != null ? {
                  start: marking.start,
                  text: marking.text,
                  saving: marking.saving,
                  onEdit: marking.rename,
                  onDelete: marking.cancel,
                } : undefined}
                gaps={trackGaps}
                duration={trackElapsedSeconds}
                currentSecond={
                  displayPreview.mode === "history"
                    ? displayPreview.second
                    : undefined
                }
                liveMode={displayPreview.mode === "live"}
                loading={displayPreview.loading}
                blockedReason={
                  trackClosing
                    ? "录制已结束"
                    : seekIndexState === "building"
                      ? "索引加载中，暂不可定位"
                      : undefined
                }
                onSeek={(second) => handleSeekCommit(second)}
                onDelete={removeMarker}
                onRangeEdit={changeRange}
                onAdjustRange={
                  marking.start != null || marking.saving
                    ? undefined
                    : (marker) =>
                        setEditingRange({
                          marker,
                          range: [
                            marker.positionSeconds,
                            marker.endPositionSeconds!,
                          ],
                        })
                }
                onPreview={onPreviewSegment}
                onExport={(marker) => exports.submit([marker.id])}
                selectingSegments={exports.selecting}
                selectedSegmentIds={exports.selectedSet}
                onSelectSegment={exports.select}
                exportBusy={exports.busy}
                onEdit={(marker, text) =>
                  updateMarkers(() =>
                    updateRecordingMarker(displayedTrack.id, marker.id, {
                      text,
                    }),
                  )
                }
              />
            </RecordingTrack>
          </div>
        </div>
      ) : null}
    </>
  );
}
