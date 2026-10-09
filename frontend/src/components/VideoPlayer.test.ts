import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import VideoPlayer, { type VideoPlayerProps } from "./VideoPlayer";

vi.mock("mpegts.js", () => ({
  default: { Events: { ERROR: "error", LOADING_COMPLETE: "loading_complete" } },
}));

function render(props: Partial<VideoPlayerProps> = {}) {
  return renderToStaticMarkup(
    createElement(VideoPlayer, { roomId: "room-1", ...props }),
  );
}

describe("preview video presentation", () => {
  it("normal live preview keeps controls, autoplay and the initial loading indicator", () => {
    const html = render();
    expect(html).toContain("连接预览流");
    expect(html).toContain('controls=""');
    expect(html).toContain('autoPlay=""');
    expect(html).toContain("aspect-ratio:16 / 9");
  });
  it("hover thumbnails hide controls and the loading overlay", () => {
    const html = render({ thumbnail: true });
    expect(html).not.toContain('controls=""');
    expect(html).not.toContain("连接预览流");
    expect(html).toContain('muted=""');
  });
  it("seek playback waits for positioning and preserves the transition canvas", () => {
    const html = render({
      fill: true,
      preserveFrameOnSwitch: true,
      seek: { url: "/seek", generation: 1, second: 120, startSecond: 118 },
    });
    expect(html).not.toContain('autoPlay=""');
    expect(html).toContain('controls=""');
    expect(html).toContain("object-fit:contain");
    expect(html).toContain('<canvas aria-hidden="true"');
  });
});
