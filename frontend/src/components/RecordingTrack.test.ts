import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RecordingGap, RecordingMarker } from "../types/recording";
import RecordingTrack from "./RecordingTrack";
import type { RecordingTrackProps } from "./recording-track/types";

const marker: RecordingMarker = {
  id: "marker-1",
  recordingId: "recording-1",
  positionSeconds: 3661,
  text: "精彩时刻",
  createdAt: "2026-10-09T00:00:00Z",
  updatedAt: "2026-10-09T00:00:00Z",
};
const gap: RecordingGap = {
  id: "gap-1",
  startedAt: "2026-10-09T00:00:00Z",
  endedAt: "2026-10-09T00:00:03Z",
  missingMs: 3000,
  kind: "stream_break",
  evidence: null,
  positionMs: 60000,
};
function render(props: Partial<RecordingTrackProps> = {}) {
  return renderToStaticMarkup(
    createElement(RecordingTrack, {
      elapsedSeconds: 4000,
      markers: [marker],
      ...props,
    }),
  );
}

describe("recording and file playback track", () => {
  it("keeps the editable selection, marker labels, export action and toolbar", () => {
    const html = render({
      editable: true,
      toolbar: createElement("span", null, "录制健康"),
    });
    expect(html).toContain('aria-label="选区起始手柄"');
    expect(html).toContain('aria-label="选区结束手柄"');
    expect(html).toContain('aria-label="01:01:01 · 精彩时刻"');
    expect(html).toContain("导出选区");
    expect(html).toContain("录制健康");
  });
  it("file playback hides the selection and disables seeking when unavailable", () => {
    const html = render({
      mode: "playback",
      previewMode: "history",
      previewSecond: 3661,
      seekDisabled: true,
    });
    expect(html).not.toContain('aria-label="选区起始手柄"');
    expect(html).not.toContain('aria-label="选区结束手柄"');
    expect(html).toContain('aria-label="回看位置 01:01:01"');
    expect(html).toContain('tabindex="-1" aria-disabled="true"');
  });
  it("only paints gaps with real media positions", () => {
    const html = render({
      gaps: [gap, { ...gap, id: "unknown", positionMs: undefined }],
    });
    expect(html.match(/class="lr-recording-track__gap"/g)).toHaveLength(1);
  });
});
