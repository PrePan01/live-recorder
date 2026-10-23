import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import PlatformAuthorizationList, { type PlatformAuthorizationConfig } from "./PlatformAuthorizationList";

vi.mock("../stores/bootStore", () => ({ bridge: { isDesktop: true } }));

describe("platform authorization methods", () => {
  it("offers one-click authorization for all platforms and manual entry only for the other three", () => {
    const supplement = vi.fn((config: PlatformAuthorizationConfig) => createElement("span", null, `manual-${config.platform}`));
    const html = renderToStaticMarkup(createElement(PlatformAuthorizationList, {
      settings: null,
      onAuthorized: async () => {},
      renderSupplement: supplement,
    }));
    expect(supplement.mock.calls.map(([config]) => config.platform)).toEqual([
      "douyin", "bilibili", "xiaohongshu",
    ]);
    expect(html).not.toContain("manual-youtube");
    expect(html).toContain('id="youtube-cookie"');
    expect(html.match(/登录并授权/g)).toHaveLength(4);
  });
});
