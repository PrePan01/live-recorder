import { AppError } from "../types/index.js";

export interface KeywordPlanInput {
  includeKeywords: string[];
  excludeKeywords: string[];
  enabled: boolean;
}

export interface KeywordPlan extends KeywordPlanInput {
  id: string;
  roomId: string;
  createdAt: string;
  updatedAt: string;
}

export function foldKeywordCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((word) => typeof word !== "string")) {
    throw new AppError("CONFIG_INVALID", "关键词需为字符串数组");
  }
  const seen = new Set<string>();
  return (value as string[])
    .map((word) => word.trim())
    .filter((word) => {
      const key = foldKeywordCase(word);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function validateKeywordPlan(
  body: unknown,
  existing?: KeywordPlanInput,
): KeywordPlanInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("CONFIG_INVALID", "关键词计划需为对象");
  }
  const input = {
    includeKeywords: [],
    excludeKeywords: [],
    enabled: true,
    ...existing,
    ...body,
  };
  const includeKeywords = normalizeKeywords(input.includeKeywords);
  const excludeKeywords = normalizeKeywords(input.excludeKeywords);
  if (!includeKeywords.length && !excludeKeywords.length) {
    throw new AppError("CONFIG_INVALID", "请至少填写一个包含或不包含的关键词");
  }
  if (typeof input.enabled !== "boolean") {
    throw new AppError("CONFIG_INVALID", "enabled 需为布尔值");
  }
  return { includeKeywords, excludeKeywords, enabled: input.enabled };
}
