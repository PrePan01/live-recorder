import { afterEach, expect, it, vi } from "vitest";
import { http } from "./client";
import { fetchKeywordPlans, updateKeywordPlan } from "./keywordPlan";
import { ApiError } from "../types/error";

afterEach(() => vi.restoreAllMocks());

it("explains that an older backend is missing the keyword plan route", async () => {
  vi.spyOn(http, "get").mockRejectedValue(
    new ApiError(
      {
        code: "SERVICE_UNAVAILABLE",
        message: "服务返回 404",
        occurredAt: "2026-11-11T00:00:00.000Z",
        retryable: false,
      },
      404,
    ),
  );
  await expect(fetchKeywordPlans("room")).rejects.toThrow(
    "当前连接的后端不支持关键词计划",
  );
});

it("preserves the reason when a supported backend cannot find a plan", async () => {
  const error = new ApiError(
    {
      code: "RESOURCE_NOT_FOUND",
      message: "计划不存在",
      occurredAt: "2026-11-11T00:00:00.000Z",
      retryable: false,
    },
    404,
  );
  vi.spyOn(http, "patch").mockRejectedValue(error);
  await expect(
    updateKeywordPlan("room", "plan", { enabled: false }),
  ).rejects.toBe(error);
});
