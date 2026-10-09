import { playbackClock } from "../../utils/playbackClock";
import {
  createRecordingMarker,
  deleteRecordingMarker,
  updateRecordingMarker,
} from "../../api/recordings";
import { MarkerNavPanel } from "../MarkerNavPanel";
import { QualityLight } from "../QualityLight";
import RecordingTrack from "../RecordingTrack";

import { usePreviewDanmaku } from "./usePreviewDanmaku.ts";
import { usePreviewLayout } from "./usePreviewLayout.ts";
import { usePreviewMarkers } from "./usePreviewMarkers.ts";
import { usePreviewRecording } from "./usePreviewRecording.ts";
import { usePreviewSeek } from "./usePreviewSeek.ts";
type Props = Pick<
  ReturnType<typeof usePreviewRecording>,
  "displayedTrack" | "trackClosing" | "trackElapsedSeconds" | "recording"
> &
  Pick<
    ReturnType<typeof usePreviewLayout>,
    "trackRevealRef" | "trackWidth" | "setTrackCollapsed"
  > &
  Pick<ReturnType<typeof usePreviewDanmaku>, "trackGaps" | "streamHealth"> &
  Pick<
    ReturnType<typeof usePreviewMarkers>,
    | "markers"
    | "quickAddMarker"
    | "addingMarker"
    | "updateMarkers"
    | "handleClipExport"
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
    markerNavigationContainer: HTMLSpanElement | null;
    setMarkerNavigationContainer: (element: HTMLSpanElement | null) => void;
  };
export function PreviewRecordingTrack({
  displayedTrack,
  trackClosing,
  trackRevealRef,
  trackWidth,
  trackGaps,
  trackElapsedSeconds,
  markers,
  quickAddMarker,
  setMarkerNavigationContainer,
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
  handleClipExport,
  setTrackCollapsed,
  markerNavigationContainer,
}: Props) {
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
              gaps={trackGaps}
              elapsedSeconds={trackElapsedSeconds}
              markers={markers}
              editable
              onQuickAdd={quickAddMarker}
              markerNavigationRef={setMarkerNavigationContainer}
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
              previewSecond={displayPreview.second}
              previewLoading={displayPreview.loading}
              seekHint={
                seekIndexState === "building"
                  ? "正在加载…"
                  : seekActualStart != null
                    ? `从 ${playbackClock(seekActualStart.second, false)} 起播`
                    : undefined
              }
              onAdd={(text) =>
                updateMarkers(() =>
                  createRecordingMarker(
                    displayedTrack.id,
                    text,
                    displayPreview.mode === "history" &&
                      displayPreview.second != null
                      ? Math.floor(displayPreview.second)
                      : undefined,
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
              onExport={handleClipExport}
              onCollapsedChange={setTrackCollapsed}
            >
              <MarkerNavPanel
                navigationContainer={markerNavigationContainer}
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
                onReturnToLive={() => handleSeekCommit("live")}
                onEdit={(marker, text) =>
                  updateMarkers(() =>
                    updateRecordingMarker(displayedTrack.id, marker.id, {
                      text,
                    }),
                  )
                }
                onExport={handleClipExport}
              />
            </RecordingTrack>
          </div>
        </div>
      ) : null}
    </>
  );
}
