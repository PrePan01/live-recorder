import { describe, expect, it } from "vitest";
import {
  predictionTitle,
  lastOpeningValue,
  predictionAccuracyText,
  timelineBands,
  timelineShowsNow,
} from "./livePrediction";
import type { RoomInsight } from "../api/rooms";
function prediction(
  overrides: Partial<RoomInsight["prediction"]> = {},
): RoomInsight["prediction"] {
  return {
    kind: "next",
    basis: "weekday",
    nextDate: "2026-09-14",
    sampleCount: 4,
    timeGranularity: "quarter_hour",
    windowStart: "23:50",
    windowEnd: "次日 00:20",
    expectedEndAt: null,
    slots: [],
    todayProbability: null,
    likelihood: "low",
    lastRecordedAt: null,
    recentObservations: [],
    startAt: "次日 00:10",
    endAt: null,
    confidence: "medium",
    basedOnDays: 4,
    notice: null,
    probabilityKnown: false,
    ...overrides,
  };
}
describe("live prediction display", () => {
  it("uses a weekday for the latest opening in the current week", () => {
    expect(
      lastOpeningValue(
        prediction({
          lastRecordedAt: "20:15",
          lastRecordedTimestamp: new Date("2026-09-15T20:15:00").toISOString(),
          lastRecordedQuality: "platform",
        }),
        new Date("2026-09-16T12:00:00"),
      ),
    ).toBe("周二 20:15");
  });
  it("uses a calendar date for the latest opening before the current week", () => {
    expect(
      lastOpeningValue(
        prediction({
          lastRecordedAt: "20:15",
          lastRecordedTimestamp: new Date("2026-09-12T20:15:00").toISOString(),
          lastRecordedQuality: "transition",
        }),
        new Date("2026-09-14T12:00:00"),
      ),
    ).toBe("9月12日 20:15");
  });
  it("does not treat the previous Sunday as part of a Monday's current week", () => {
    expect(
      lastOpeningValue(
        prediction({
          lastRecordedAt: "23:30",
          lastRecordedTimestamp: new Date("2026-09-13T23:30:00").toISOString(),
        }),
        new Date("2026-09-14T12:00:00"),
      ),
    ).toBe("9月13日 23:30");
  });
  it("recognizes an imminent opening before the predicted window begins", () => {
    expect(
      predictionTitle(
        prediction({
          startAt: "20:00",
          likelihood: "high",
          probabilityKnown: true,
          windowStart: "20:00",
          windowEnd: "20:30",
        }),
        new Date("2026-09-14T19:50:00"),
      ),
    ).toBe("预计即将开播");
  });
  it("shows the current-time pointer on the early side of an overnight window", () => {
    expect(
      timelineShowsNow(prediction(), new Date("2026-09-15T00:05:00")),
    ).toBe(true);
    expect(
      timelineShowsNow(prediction(), new Date("2026-09-16T00:05:00")),
    ).toBe(false);
  });
  it("uses the actual next-day date instead of calling an overnight opening today", () => {
    expect(predictionTitle(prediction(), new Date("2026-09-14T12:00:00"))).toBe(
      "预计明天凌晨 00:15 左右开播",
    );
  });
  it("recognizes an active previous-day midnight window", () => {
    expect(predictionTitle(prediction(), new Date("2026-09-15T00:05:00"))).toBe(
      "预计今天凌晨 00:15 左右开播",
    );
  });
  it("rounds 23:58 to next-day 00:00 without losing the date", () => {
    expect(
      predictionTitle(
        prediction({ startAt: "23:58" }),
        new Date("2026-09-14T12:00:00"),
      ),
    ).toBe("预计明天凌晨 00:00 左右开播");
  });
  it("does not describe an already finished window as upcoming", () => {
    expect(predictionTitle(prediction(), new Date("2026-09-15T12:00:00"))).toBe(
      "暂无预测",
    );
  });
  it("uses explicit dates instead of calling next weekend this weekend", () => {
    expect(
      predictionTitle(
        prediction({
          nextDate: "2026-09-19",
          startAt: "20:00",
          windowStart: "19:50",
          windowEnd: "20:30",
          timeGranularity: "approximate",
          basis: "day_type",
        }),
        new Date("2026-09-13T12:00:00"),
      ),
    ).toBe("预计下周六 19:50–20:30 开播");
  });
  it("uses five-level accuracy labels and maps older responses", () => {
    expect(predictionAccuracyText(prediction(), "low")).toBe("预测准确性低");
    expect(predictionAccuracyText(prediction(), "high")).toBe("预测准确性低");
    expect(
      predictionAccuracyText(prediction({ probabilityKnown: true }), "low"),
    ).toBe("预测准确性低");
    expect(
      predictionAccuracyText(prediction({ probabilityKnown: true }), "high"),
    ).toBe("预测准确性高");
    expect(
      predictionAccuracyText(prediction({ accuracy: "fairly_high" }), "low"),
    ).toBe("预测准确性较高");
    expect(
      predictionAccuracyText(prediction({ accuracy: "fairly_low" }), "high"),
    ).toBe("预测准确性较低");
  });
  it("splits the timeline on both sides of midnight without dropping the early band", () => {
    expect(
      timelineBands({
        startAt: "23:50",
        endAt: "次日 00:20",
        likelihood: "low",
      }).map((b) => [b.start, b.end]),
    ).toEqual([
      [1430, 1440],
      [0, 20],
    ]);
    expect(
      timelineBands({
        startAt: "次日 00:10",
        endAt: "次日 00:40",
        likelihood: "low",
      }).map((b) => [b.start, b.end]),
    ).toEqual([[10, 40]]);
  });
});

describe("natural prediction wording", () => {
  const now = new Date("2026-09-14T12:00:00");
  it.each([
    [
      {
        nextDate: "2026-09-16",
        startAt: "20:00",
        windowEnd: "20:30",
        timeGranularity: "exact",
      },
      "预计后天 20:00 开播",
    ],
    [
      {
        nextDate: "2026-09-18",
        startAt: "20:00",
        windowEnd: "20:30",
        timeGranularity: "exact",
      },
      "预计周五 20:00 开播",
    ],
    [
      {
        nextDate: "2026-09-28",
        startAt: "20:00",
        windowEnd: "20:30",
        timeGranularity: "exact",
      },
      "预计9月28日 20:00 开播",
    ],
    [
      {
        startAt: "20:00",
        windowStart: "19:00",
        windowEnd: "21:00",
        timeGranularity: "approximate",
      },
      "预计今天 19:00–21:00 开播",
    ],
    [
      {
        startAt: "20:00",
        windowStart: "18:30",
        windowEnd: "22:30",
        timeGranularity: "period",
      },
      "预计今晚开播",
    ],
    [
      {
        nextDate: "2026-09-15",
        nextDateEnd: "2026-09-16",
        startAt: "20:00",
        windowEnd: "20:30",
      },
      "预计明天或后天晚间开播",
    ],
    [
      {
        kind: "typical",
        startAt: "20:00",
        windowStart: "19:00",
        windowEnd: "21:00",
        timeGranularity: "approximate",
      },
      "常在19:00–21:00 开播",
    ],
    [
      {
        kind: "typical",
        startAt: "20:00",
        timeGranularity: "period",
        typicalDayType: "weekend",
      },
      "常在周末晚间开播",
    ],
  ] as Array<[Partial<RoomInsight["prediction"]>, string]>)(
    "formats %j",
    (overrides, expected) => {
      expect(predictionTitle(prediction(overrides), now)).toBe(expected);
    },
  );
  it("keeps a specific time when possibility is low near an opening", () => {
    expect(
      predictionTitle(
        prediction({ startAt: "20:00", windowEnd: "20:30" }),
        new Date("2026-09-14T19:50:00"),
      ),
    ).toBe("预计今天 20:00 左右开播");
  });
  it("does not call a past representative time imminent even at high possibility", () => {
    expect(
      predictionTitle(
        prediction({
          startAt: "20:00",
          windowEnd: "20:30",
          likelihood: "high",
          probabilityKnown: true,
        }),
        new Date("2026-09-14T20:10:00"),
      ),
    ).toBe("预计今天 20:00 左右开播");
  });
});

it("shows today's pointer on the remaining day of a two-day prediction", () => {
  expect(
    timelineShowsNow(
      prediction({
        nextDate: "2026-09-14",
        nextDateEnd: "2026-09-15",
        startAt: "20:00",
        windowStart: "19:00",
        windowEnd: "21:00",
      }),
      new Date("2026-09-15T12:00:00"),
    ),
  ).toBe(true);
});

it("uses tonight for a range crossing midnight while retaining next-day clocks", () => {
  expect(
    predictionTitle(
      prediction({
        startAt: "23:30",
        windowStart: "23:00",
        windowEnd: "次日 01:00",
        timeGranularity: "approximate",
      }),
      new Date("2026-09-14T12:00:00"),
    ),
  ).toBe("预计今晚 23:00–次日 01:00 开播");
});

describe("early-morning window dates", () => {
  const early = prediction({
    nextDate: "2026-09-14",
    startAt: "次日 00:30",
    windowStart: "次日 00:00",
    windowEnd: "次日 01:00",
    timeGranularity: "approximate",
  });
  it("does not repeat next-day wording after converting the range date to today", () => {
    expect(predictionTitle(early, new Date("2026-09-15T00:05:00"))).toBe(
      "预计今天 00:00–01:00 开播",
    );
  });
  it("shows tomorrow's early range without advancing its clocks again", () => {
    expect(predictionTitle(early, new Date("2026-09-14T12:00:00"))).toBe(
      "预计明天 00:00–01:00 开播",
    );
  });
  it("formats precise window timestamps rather than conflicting legacy clock labels", () => {
    expect(
      predictionTitle(
        {
          ...early,
          startTimestamp: new Date("2026-09-15T00:30:00").toISOString(),
          windowStartTimestamp: new Date("2026-09-15T00:00:00").toISOString(),
          windowEndTimestamp: new Date("2026-09-15T01:00:00").toISOString(),
        },
        new Date("2026-09-15T00:05:00"),
      ),
    ).toBe("预计今天 00:00–01:00 开播");
  });
  it("keeps genuine overnight ranges explicit on the early side of midnight", () => {
    expect(
      predictionTitle(
        prediction({
          nextDate: "2026-09-14",
          startAt: "次日 00:30",
          windowStart: "23:00",
          windowEnd: "次日 01:00",
          timeGranularity: "approximate",
        }),
        new Date("2026-09-15T00:05:00"),
      ),
    ).toBe("预计周一晚间 23:00–次日 01:00 开播");
  });
});
