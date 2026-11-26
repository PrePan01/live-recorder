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
  ["interval-douyu", "斗鱼", 60],
  ["interval-huya", "虎牙", 60],
] as const;

vi.mock("../model/SettingsContext", () => ({
  useSettingsModelContext: () => ({
    loaded: () => true,
    value: (id: string) => columns.find(([key]) => key === id)?.[2],
    states: {},
  }),
}));

it("wraps the existing interval table after five columns and preserves its controls", () => {
  const markup = renderToStaticMarkup(createElement(MonitoringPanel));
  expect(markup).toContain('class="lr-monitoring-table"');
  const groups = markup.match(/<tbody>.*?<\/tbody>/g) ?? [];
  expect(groups.map((group) => group.match(/<td /g)?.length)).toEqual([5, 2]);
  const headings = markup.match(/<th .*?<\/th>/g) ?? [];
  const cells = markup.match(/<td .*?<\/td>/g) ?? [];
  expect(headings).toHaveLength(columns.length);
  expect(cells).toHaveLength(columns.length);
  expect(headings[0]).not.toContain("lr-platform-logo-tag");
  columns.forEach(([id, label, value], index) => {
    const heading = headings[index];
    const cell = cells[index];
    expect(heading).toContain(`for="${id}-control">`);
    expect(heading).toContain(`${label}</label>`);
    if (index > 0) {
      expect(heading).toContain("lr-platform-logo-tag");
      expect(heading).toContain(`alt="${label}图标"`);
    }
    expect(cell).toContain(`id="${id}" headers="${id}-heading"`);
    const input = cell?.match(/<input[^>]*>/)?.[0];
    expect(input).toContain(`id="${id}-control"`);
    expect(input).toContain(`value="${value}"`);
    expect(cell).toContain("<span>秒</span>");
  });
});
