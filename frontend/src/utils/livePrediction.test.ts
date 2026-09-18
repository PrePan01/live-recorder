import { describe, expect, it } from "vitest";
import {
  predictionTitle,
  lastOpeningValue,
  predictionAccuracyText,
  predictionCountdownText,
  predictionDisplayLevel,
  predictionOpeningDetail,
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
  it("uses a relative day for the latest opening yesterday", () => {
    expect(
      lastOpeningValue(
        prediction({
          lastRecordedAt: "20:15",
          lastRecordedTimestamp: new Date("2026-09-15T20:15:00").toISOString(),
          lastRecordedQuality: "platform",
        }),
        new Date("2026-09-16T12:00:00"),
      ),
    ).toBe("昨天 20:15");
  });
  it("calls the opening two days ago 前天 instead of a calendar date", () => {
    expect(
      lastOpeningValue(
        prediction({
          lastRecordedAt: "20:15",
          lastRecordedTimestamp: new Date("2026-09-12T20:15:00").toISOString(),
          lastRecordedQuality: "transition",
        }),
        new Date("2026-09-14T12:00:00"),
      ),
    ).toBe("前天 20:15");
  });
  it("does not treat the previous Sunday as part of a Monday's current week", () => {
    expect(
      lastOpeningValue(
        prediction({
          lastRecordedAt: "23:30",
          lastRecordedTimestamp: new Date("2026-09-06T23:30:00").toISOString(),
        }),
        new Date("2026-09-14T12:00:00"),
      ),
    ).toBe("9月6日 23:30");
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
      "常在 19:00–21:00 开播",
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

/** 数字与冒号各占半宽，用来守住卡片宽度。 */
function displayWidth(text: string): number {
  return [...text].reduce(
    (sum, char) => sum + (/[\u2e80-\u9fff\uff00-\uffef]/.test(char) ? 1 : 0.5),
    0,
  );
}

describe("possibility wording follows the backend accuracy", () => {
  const now = new Date("2026-09-14T12:00:00");
  const habit = (basedOnDays: number, overrides: Partial<RoomInsight["prediction"]> = {}) =>
    prediction({
      kind: "typical",
      startAt: "20:00",
      windowStart: "20:00",
      windowEnd: "20:30",
      timeGranularity: "quarter_hour",
      basedOnDays,
      ...overrides,
    });
  it.each([
    [6, "常在 20:00 左右开播"],
    [4, "常在 20:00 左右开播"],
    [3, "一般 20:00 左右开播"],
    [2, "偶尔在 20:00 左右开播"],
  ])("uses the matching lead after %i observed days", (days, expected) => {
    expect(predictionTitle(habit(days), now)).toBe(expected);
  });
  it("takes the lead from the reported accuracy, not from the sample count alone", () => {
    // 见过 20 天但后端判定准确性低（比如事后校准命中率差）：说法要跟着准确性走，
    // 否则同一张卡片上会「措辞笃定 + 详情说准确性低」。
    const withAccuracy = (accuracy: RoomInsight["prediction"]["accuracy"]) =>
      predictionTitle(habit(20, { accuracy }), now);
    expect(withAccuracy("high")).toBe("常在 20:00 左右开播");
    expect(withAccuracy("medium")).toBe("一般 20:00 左右开播");
    expect(withAccuracy("low")).toBe("偶尔在 20:00 左右开播");
  });
  it("softens a dated prediction as the sample shrinks", () => {
    const dated = (basedOnDays: number) =>
      prediction({
        basedOnDays,
        nextDate: "2026-09-16",
        startAt: "20:00",
        windowEnd: "20:30",
        timeGranularity: "exact",
      });
    expect(predictionTitle(dated(6), now)).toBe("预计后天 20:00 开播");
    expect(predictionTitle(dated(3), now)).toBe("大概后天 20:00 开播");
    expect(predictionTitle(dated(2), now)).toBe("可能后天 20:00 开播");
  });
  it("only says 准时 for a tight window with enough samples", () => {
    const tight = (basedOnDays: number, granularity: "exact" | "quarter_hour") =>
      habit(basedOnDays, { windowEnd: "20:20", timeGranularity: granularity });
    expect(predictionTitle(tight(6, "exact"), now)).toBe("准时 20:00 开播");
    expect(predictionTitle(tight(3, "exact"), now)).toBe("一般 20:00 左右开播");
    expect(predictionTitle(tight(6, "quarter_hour"), now)).toBe(
      "常在 20:00 左右开播",
    );
  });
  describe("several periods collapse into the next one", () => {
    const twoPeriods = (slots: RoomInsight["prediction"]["slots"]) =>
      prediction({ kind: "typical", nextDate: null, slots });
    it("predicts the nearest period that has not passed yet", () => {
      expect(
        predictionTitle(
          twoPeriods([
            { startAt: "10:00", endAt: "11:00", likelihood: "medium" },
            { startAt: "20:00", endAt: "21:00", likelihood: "medium" },
          ]),
          new Date("2026-09-14T13:00:00"),
        ),
      ).toBe("预计今天 20:00 左右开播");
    });
    it("keeps a period that already started but has not finished", () => {
      expect(
        predictionTitle(
          twoPeriods([
            { startAt: "12:00", endAt: "14:00", likelihood: "medium" },
            { startAt: "20:00", endAt: "21:00", likelihood: "medium" },
          ]),
          new Date("2026-09-14T13:00:00"),
        ),
      ).toBe("预计今天 12:00–14:00 开播");
    });
    it("rolls to tomorrow only when every period has already passed", () => {
      expect(
        predictionTitle(
          twoPeriods([
            { startAt: "10:00", endAt: "11:00", likelihood: "medium" },
            { startAt: "20:00", endAt: "21:00", likelihood: "medium" },
          ]),
          new Date("2026-09-14T23:00:00"),
        ),
      ).toBe("预计明天 10:00 左右开播");
    });
    it("picks the earliest period of a future dated prediction too", () => {
      expect(
        predictionTitle(
          prediction({
            nextDate: "2026-09-16",
            slots: [
              { startAt: "20:00", endAt: "21:00", likelihood: "medium" },
              { startAt: "15:00", endAt: "16:00", likelihood: "medium" },
            ],
          }),
          now,
        ),
      ).toBe("预计后天 15:00 左右开播");
    });
  });
  it("falls back to a period word instead of a false-precision clock", () => {
    expect(
      predictionTitle(
        habit(6, {
          startAt: "20:00",
          windowStart: "18:30",
          windowEnd: "22:30",
          timeGranularity: "period",
          typicalDayType: "weekend",
        }),
        now,
      ),
    ).toBe("常在周末晚间开播");
  });
  it("keeps every label inside the card width budget", () => {
    const variants: Array<Partial<RoomInsight["prediction"]>> = [
      { nextDate: "2026-09-14", startAt: "20:00", windowEnd: "20:30" },
      {
        nextDate: "2026-09-28",
        startAt: "20:00",
        windowEnd: "20:30",
        timeGranularity: "exact",
      },
      {
        startAt: "23:30",
        windowStart: "23:00",
        windowEnd: "次日 01:00",
        timeGranularity: "approximate",
      },
      {
        nextDate: "2026-09-15",
        nextDateEnd: "2026-09-16",
        startAt: "20:00",
        windowEnd: "20:30",
      },
      {
        kind: "typical",
        startAt: "20:00",
        windowStart: "20:00",
        windowEnd: "20:30",
        timeGranularity: "quarter_hour",
        basedOnDays: 2,
      },
      {
        kind: "typical",
        startAt: "20:00",
        windowStart: "19:00",
        windowEnd: "21:00",
        timeGranularity: "approximate",
      },
      {
        kind: "typical",
        startAt: "20:00",
        timeGranularity: "period",
        typicalDayType: "weekend",
      },
    ];
    for (const variant of variants)
      expect(displayWidth(predictionTitle(prediction(variant), now))).toBeLessThan(20);
  });
});

describe("tag colour shares the accuracy shown in the detail", () => {
  const level = (accuracy: RoomInsight["prediction"]["accuracy"]) =>
    predictionDisplayLevel(prediction({ accuracy }), "low");
  it("collapses the five accuracy levels onto the three tag levels", () => {
    expect(level("high")).toBe("high");
    expect(level("fairly_high")).toBe("high");
    expect(level("medium")).toBe("medium");
    expect(level("fairly_low")).toBe("low");
    expect(level("low")).toBe("low");
  });
  it("agrees with the accuracy text rendered in the popover", () => {
    expect(
      predictionAccuracyText(prediction({ accuracy: "low" }), "high"),
    ).toBe("预测准确性低");
    expect(level("low")).toBe("low");
    expect(
      predictionAccuracyText(prediction({ accuracy: "fairly_high" }), "low"),
    ).toBe("预测准确性较高");
    expect(level("fairly_high")).toBe("high");
  });
  it("keeps the older gated likelihood when accuracy is missing", () => {
    expect(level(null)).toBe("low");
    expect(
      predictionDisplayLevel(
        prediction({ probabilityKnown: true, likelihood: "high" }),
        "high",
      ),
    ).toBe("high");
    expect(
      predictionDisplayLevel(
        prediction({ probabilityKnown: false, likelihood: "high" }),
        "high",
      ),
    ).toBe("low");
  });
});

describe("detail row merges countdown with the clock", () => {
  const today = (overrides: Partial<RoomInsight["prediction"]> = {}) =>
    prediction({
      nextDate: "2026-09-14",
      startAt: "20:00",
      windowStart: "19:00",
      windowEnd: "21:00",
      timeGranularity: "approximate",
      ...overrides,
    });
  it("prepends a coarse countdown for a window that is today and still ahead", () => {
    expect(predictionOpeningDetail(today(), new Date("2026-09-14T18:00:00"))).toBe(
      "大约还要等一小时 · 19:00–21:00",
    );
  });
  it("says 马上开播 without a redundant range when the opening is imminent", () => {
    expect(
      predictionOpeningDetail(
        prediction({
          nextDate: "2026-09-14",
          startAt: "20:00",
          windowStart: "20:00",
          windowEnd: "20:30",
          timeGranularity: "quarter_hour",
        }),
        new Date("2026-09-14T19:45:00"),
      ),
    ).toBe("马上开播 · 20:00");
  });
  it("hedges the countdown when the sample is thin", () => {
    expect(
      predictionOpeningDetail(
        today({ basedOnDays: 2 }),
        new Date("2026-09-14T18:00:00"),
      ),
    ).toBe("可能还要等一小时 · 19:00–21:00");
  });
  it("drops the countdown for a window on another day", () => {
    expect(predictionCountdownText(today(), new Date("2026-09-13T12:00:00"))).toBeNull();
    expect(predictionOpeningDetail(today(), new Date("2026-09-13T12:00:00"))).toBe(
      "明天 19:00–21:00",
    );
  });
  it("returns nothing once the window has passed", () => {
    expect(predictionOpeningDetail(today(), new Date("2026-09-15T12:00:00"))).toBeNull();
  });
});
