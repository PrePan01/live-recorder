import { promptRangeExport } from "../../utils/promptRangeExport";
import { playbackClock } from "../../utils/playbackClock";
import {
  createRecordingMarker,
  deleteRecordingMarker,
  updateRecordingMarker,
} from "../../api/recordings";
import { MarkerNavPanel } from "../MarkerNavPanel";
import { QualityLight } from "../QualityLight";

import RecordingTrack from "../RecordingTrack";
import { useCallback, useEffect, useState } from "react";
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
type Props = Pick<
  ReturnType<typeof usePreviewRecording>,
  "displayedTrack" | "trackClosing" | "recording"
> &
  Pick<
    ReturnType<typeof usePreviewLayout>,
    "trackRevealRef" | "trackWidth" | "setTrackCollapsed"
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
  };
export function PreviewRecordingTrack({
  roomId,
  displayedTrack,
  trackClosing,
  trackRevealRef,
  trackWidth,
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
  const marking = useSegmentMarking(
    id,
    markers,
    media.getPosition,
    saved,
    trackClosing ||
      displayPreview.loading ||
      !media.duration ||
      editingRange != null || selectingRange,
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
            width: trackWidth,
            margin: "0 auto",
            flexShrink: 0,
            minHeight: 0,
            maxWidth: "100%",
          }}
        >
          <div>
            <RecordingTrack
              key={id}
              onExport={(start, end) => promptRangeExport(displayedTrack.id, roomId, start, end)}
              selectionDisabled={trackClosing || marking.saving || marking.start != null}
              onSelectionChange={setSelectingRange}
              segmentActions={
                <SegmentMarkActions
                  marking={marking}
                  current={media.current}
                  disabled={
                    trackClosing ||
                    displayPreview.loading ||
                    !media.duration ||
                    editingRange != null || selectingRange
                  }
                >
                  <SegmentExportActions
                    exports={exports}
                    disabled={trackClosing || editingRange != null}
                  />
                </SegmentMarkActions>
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
              addingMarker={addingMarker}
              quickAddDisabled={displayPreview.loading || trackClosing}
              toolbar={
                recording && !trackClosing ? (
                  <QualityLight health={streamHealth} />
                ) : undefined
              }
              onSeekIntent={handleSeekIntent}
              onSeekCommit={handleSeekCommit}
              onReturnToLive={
                seekPlayback ? () => handleSeekCommit("live") : undefined
              }
              previewMode={displayPreview.mode}
              previewSecond={media.current ?? displayPreview.second}
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
              onMove={(markerId, positionSeconds) =>
                updateMarkers(() =>
                  updateRecordingMarker(displayedTrack.id, markerId, {
                    positionSeconds,
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
                onAdjustRange={marking.start != null || marking.saving ? undefined : (marker) =>
                  setEditingRange({
                    marker,
                    range: [marker.positionSeconds, marker.endPositionSeconds!],
                  })
                }
                onPreview={onPreviewSegment}
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
