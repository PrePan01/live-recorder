import { expect, it } from "vitest";
import { formatTime } from "./format";

it("displays the schedule ISO timestamp in local time, including today at 17:00", () => {
  const nextRunAt = new Date(2026, 9, 3, 17, 0).toISOString();
  expect(formatTime(nextRunAt)).toBe("2026-10-03 17:00:00");
  expect(formatTime(null)).toBe("-");
});
