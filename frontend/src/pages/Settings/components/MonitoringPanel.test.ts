import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { MonitoringPanel } from "./SettingsPanels";

const columns = [
  ["interval-default", "全局", 45],
  ["interval-bilibili", "B站", 75],
  ["interval-douyin", "抖音", 105],
  ["interval-xiaohongshu", "小红书", 120],
  ["interval-youtube", "YouTube", 150],
] as const;

vi.mock("../model/SettingsContext", () => ({
  useSettingsModelContext: () => ({
    loaded: () => true,
    value: (id: string) => columns.find(([key]) => key === id)?.[2],
    states: {},
  }),
}));

it("renders a labeled interval in seconds for every monitoring column", () => {
  const markup = renderToStaticMarkup(createElement(MonitoringPanel));
  const headers = markup.match(/<th scope="col">.*?<\/th>/g) ?? [];
  const cells = markup.match(/<td id="interval-[^"]+">.*?<\/td>/g) ?? [];
  expect(headers).toHaveLength(columns.length);
  expect(cells).toHaveLength(columns.length);
  expect(headers[0]).not.toContain("lr-platform-logo-tag");
  columns.forEach(([id, label, value], index) => {
    const header = headers[index];
    expect(header).toContain(`for="${id}-control">`);
    expect(header).toContain(`${label}</label>`);
    if (index > 0) {
      expect(header).toContain("lr-platform-logo-tag");
      expect(header).toContain(`alt="${label}图标"`);
    }
    const input = cells[index]?.match(/<input[^>]*>/)?.[0];
    expect(input).toContain(`id="${id}-control"`);
    expect(input).toContain(`value="${value}"`);
    expect(cells[index]).toContain("<span>秒</span>");
  });
});
