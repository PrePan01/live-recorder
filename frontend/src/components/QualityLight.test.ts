import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QualityLight, RoomQualityLight } from "./QualityLight";
import type { StreamHealth } from "../types/streamHealth";

const state = vi.hoisted(() => ({ connected: true, now: 100000 }));
vi.mock("../hooks/useDisplayClock", () => ({
  useDisplayClock: () => state.now,
}));
vi.mock("../hooks/useStreamHealth", () => ({ useStreamHealth: () => null }));
vi.mock("../stores/serviceStore", () => ({
  useServiceStore: () => state.connected,
}));
const health = (patch: Partial<StreamHealth> = {}): StreamHealth => ({
  recordingId: "r1",
  state: "good",
  active: true,
  sampledAt: state.now,
  ...patch,
});
beforeEach(() => {
  state.connected = true;
});

describe("状态灯展示条件", () => {
  it("未录制或没有健康快照时不占位", () => {
    expect(renderToStaticMarkup(createElement(RoomQualityLight))).toBe("");
    expect(
      renderToStaticMarkup(createElement(QualityLight, { health: null })),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(QualityLight, { health: health({ active: false }) }),
      ),
    ).toBe("");
  });
  it("未知状态和未知状态的清晰度回退均隐藏", () => {
    expect(
      renderToStaticMarkup(
        createElement(QualityLight, { health: health({ state: "unknown" }) }),
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(QualityLight, {
          health: health({
            state: "unknown",
            qualityFallback: true,
            recovering: true,
          }),
        }),
      ),
    ).toBe("");
  });
  it("连接失效或快照过期时隐藏旧灯", () => {
    state.connected = false;
    expect(
      renderToStaticMarkup(createElement(QualityLight, { health: health() })),
    ).toBe("");
    state.connected = true;
    expect(
      renderToStaticMarkup(
        createElement(QualityLight, {
          health: health({ sampledAt: state.now - 46000 }),
        }),
      ),
    ).toBe("");
  });
  it("健康状态和异常状态仍可打开详情", () => {
    expect(
      renderToStaticMarkup(createElement(QualityLight, { health: health() })),
    ).toContain('aria-label="录制健康：录制正常"');
    expect(
      renderToStaticMarkup(
        createElement(QualityLight, {
          health: health({ state: "degraded", recovering: true }),
        }),
      ),
    ).toContain('aria-label="录制健康：正在恢复录制"');
  });
});
