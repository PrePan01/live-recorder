import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ settings: undefined as unknown }));
vi.mock("../stores/settingsStore", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: state.settings }),
}));

import DetectionLoadHint, { detectionLoadText } from "./DetectionLoadHint";

function render() {
  return renderToStaticMarkup(createElement(DetectionLoadHint));
}

beforeEach(() => {
  state.settings = undefined;
});

describe("detection load hint", () => {
  it("renders nothing until the backend supplies the load block", () => {
    expect(render()).toBe("");
  });
  it("shows configured frequency and explains the active frequency guard", () => {
    state.settings = {
      detectionLoad: { perMinute: 42, limitPerMinute: 60, staggered: true, queued: 3 },
    };
    const staggered = render();
    expect(staggered).toContain("当前配置合计检测频率约 42 次/分");
    expect(staggered).toContain("已自动降低检测频率（上限 60 次/分）");
    state.settings = {
      detectionLoad: { perMinute: 8, limitPerMinute: 60, staggered: false, queued: 0 },
    };
    const normal = render();
    expect(normal).toContain("当前配置合计检测频率约 8 次/分");
    expect(normal).not.toContain("已自动降低检测频率");
  });
  it("keeps the wording pinned to the scheduler values without extra math", () => {
    expect(
      detectionLoadText({ perMinute: 7, limitPerMinute: 60, staggered: false, queued: 0 }),
    ).toBe("当前配置合计检测频率约 7 次/分");
  });
});
