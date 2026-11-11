import { http } from "./client";
import { ApiError } from "../types/error";

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

const path = (roomId: string) => `/rooms/${roomId}/keyword-plans`;

function explainMissingRoute(error: unknown): never {
  // Older sidecars return an unstructured 404. Missing rooms and plans use RESOURCE_NOT_FOUND.
  if (
    error instanceof ApiError &&
    error.status === 404 &&
    error.code === "SERVICE_UNAVAILABLE"
  ) {
    error.message = "当前连接的后端不支持关键词计划，请更新应用或连接新版后端";
  }
  throw error;
}

export async function fetchKeywordPlans(
  roomId: string,
): Promise<KeywordPlan[]> {
  const { data } = await http
    .get<{ plans: KeywordPlan[] }>(path(roomId))
    .catch(explainMissingRoute);
  return data.plans;
}

export function createKeywordPlan(roomId: string, input: KeywordPlanInput) {
  return http.post(path(roomId), input).catch(explainMissingRoute);
}

export function updateKeywordPlan(
  roomId: string,
  planId: string,
  input: Partial<KeywordPlanInput>,
) {
  return http
    .patch(`${path(roomId)}/${planId}`, input)
    .catch(explainMissingRoute);
}

export function deleteKeywordPlan(roomId: string, planId: string) {
  return http.delete(`${path(roomId)}/${planId}`).catch(explainMissingRoute);
}
