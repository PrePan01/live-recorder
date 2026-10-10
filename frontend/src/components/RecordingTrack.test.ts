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
  it("keeps temporary export handles separate from saved segment adjustment", () => {
    const onExport = () => {};
    const normal = render({ onExport });
    expect(normal).toContain('aria-label="选区起始手柄"');
    expect(normal).toContain('aria-label="选区结束手柄"');
    expect(normal).toContain("导出选区");
    expect(normal).not.toContain("取消选区");
    expect(normal).not.toContain("保存范围");
    const marking = render({ onExport, selectionDisabled: true, temporarySegment: [3, 8] });
    expect(marking).not.toContain('aria-label="选区起始手柄"');
    expect(marking).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?导出选区/);
    expect(marking).toContain("lr-recording-track__temporary-segment");
    const adjusting = render({ onExport, rangeSelection: [3, 8] });
    expect(adjusting).toContain("保存范围");
    expect(adjusting).toContain("导出选区");
  });
  it("keeps range editing, point marker labels and the toolbar", () => {
    const html = render({
      editable: true,
      toolbar: createElement("span", null, "录制健康"),
      rangeSelection: [0, 10],
    });
    expect(html).toContain('aria-label="选区起始手柄"');
    expect(html).toContain('aria-label="选区结束手柄"');
    expect(html).toContain('aria-label="01:01:01 · 精彩时刻"');
    expect(html).toContain("保存范围");
    expect(html).not.toContain("导出选区");
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
  it("renders persistent segments as stretched yellow markers without hiding point markers", () => {
    const html = render({
      mode: "playback",
      elapsedSeconds: 100,
      markers: [
        marker,
        {
          ...marker,
          id: "segment",
          positionSeconds: 10,
          endPositionSeconds: 20,
          text: "片段 1",
        },
      ],
    });
    expect(html).toContain("lr-recording-track__marker--segment");
    expect(html).toContain("width:10%");
    expect(html).toContain('aria-label="01:01:01 · 精彩时刻"');
  });
  it("only paints gaps with real media positions", () => {
    const html = render({
      gaps: [gap, { ...gap, id: "unknown", positionMs: undefined }],
    });
    expect(html.match(/class="lr-recording-track__gap"/g)).toHaveLength(1);
  });
});
