import { http } from "./client";
import type { Room, RoomCreateInput, RoomUpdateInput } from "../types/room";

export async function fetchRooms(): Promise<Room[]> {
  const { data } = await http.get<{ rooms: Room[] }>("/rooms");
  return data.rooms;
}

export async function reorderRooms(roomIds: string[]): Promise<Room[]> {
  const { data } = await http.put<{ rooms: Room[] }>("/rooms/order", {
    roomIds,
  });
  return data.rooms;
}

export async function createRoom(input: RoomCreateInput): Promise<Room> {
  const { data } = await http.post<{ room: Room }>("/rooms", input);
  return data.room;
}

export interface BatchRoomResult {
  succeeded: Room[];
  failed: Array<{ url: string; reason: string }>;
}

export async function batchCreateRooms(
  urls: string[],
): Promise<BatchRoomResult> {
  const { data } = await http.post<BatchRoomResult>("/rooms/batch", { urls });
  return data;
}

export async function updateRoom(
  id: string,
  input: RoomUpdateInput,
): Promise<Room> {
  const { data } = await http.patch<{ room: Room }>(`/rooms/${id}`, input);
  return data.room;
}

export async function deleteRoom(id: string): Promise<void> {
  await http.delete(`/rooms/${id}`);
}

export async function setRoomEnabled(
  id: string,
  enabled: boolean,
): Promise<Room> {
  const { data } = await http.patch<{ room: Room }>(`/rooms/${id}/enable`, {
    enabled,
  });
  return data.room;
}

export async function setRoomFavorite(
  id: string,
  favorited: boolean,
): Promise<Room> {
  const { data } = await http.patch<{ room: Room }>(`/rooms/${id}/favorite`, {
    favorited,
  });
  return data.room;
}

export async function checkRoomNow(id: string): Promise<void> {
  await http.post(`/rooms/${id}/check`);
}

/** 对全部启用直播间执行一次即时开播检测。 */
export async function checkEnabledRooms(): Promise<void> {
  await http.post("/rooms/check-enabled");
}

export async function startRoomRecording(id: string, origin?: "floating"): Promise<void> {
  await http.post(`/rooms/${id}/start-recording`, origin ? { origin } : undefined);
}

export async function stopRecording(id: string): Promise<void> {
  await http.post(`/rooms/${id}/stop-recording`);
}

export interface HighlightBufferStatus {
  enabled: boolean;
  availableSeconds: number;
  maxSeconds: number;
  accepting: boolean;
  disabledReason?: "slow_disk" | "write_error";
}

export async function enableHighlightBuffer(
  id: string,
): Promise<HighlightBufferStatus> {
  const { data } = await http.post<{ highlight: HighlightBufferStatus }>(
    `/rooms/${id}/highlight-buffer`,
  );
  return data.highlight;
}

export async function disableHighlightBuffer(id: string): Promise<void> {
  await http.delete(`/rooms/${id}/highlight-buffer`);
}

export async function clearHighlightBuffer(id: string): Promise<void> {
  await http.post(`/rooms/${id}/highlight-buffer/clear`);
}

export async function fetchHighlightBufferStatus(
  id: string,
): Promise<HighlightBufferStatus> {
  const { data } = await http.get<{ highlight: HighlightBufferStatus }>(
    `/rooms/${id}/highlight-buffer`,
  );
  return data.highlight;
}

export async function exportHighlight(
  id: string,
  lookbackSeconds: number,
): Promise<{ recordingId: string; availableSeconds: number }> {
  const { data } = await http.post<{
    highlight: { recordingId: string; availableSeconds: number };
  }>(`/rooms/${id}/highlights`, { lookbackSeconds });
  return data.highlight;
}

export interface RoomStats {
  roomId: string;
  days: number;
  totalRecordings: number;
  totalBytes: number;
  successRate: number;
  completed: number;
  failed: number;
  lastCheckedAt: string | null;
  lastError: Record<string, unknown> | null;
  byDay: Array<{ date: string; count: number; bytes: number }>;
}

export interface RoomInsight {
  totalRecordings: number;
  totalBytes: number;
  successRate: number;
  completed: number;
  failed: number;
  prediction: {
    kind: "unavailable" | "observation" | "typical" | "next";
    basis: "daily" | "weekday" | "day_type" | "interval" | "all" | null;
    intervalDays?: number | null;
    intervalDaysMax?: number | null;
    nextDate: string | null;
    startTimestamp?: string | null;
    windowStartTimestamp?: string | null;
    windowEndTimestamp?: string | null;
    rawLikelihood?: "high" | "medium" | "low" | null;
    probabilityKnown?: boolean;
    accuracy?: "high" | "fairly_high" | "medium" | "fairly_low" | "low" | null;
    coverageDays?: number;
    timeSource?: "platform" | "detected" | "recording" | "mixed" | null;
    sampleCount: number;
    timeGranularity: "exact" | "quarter_hour" | "approximate" | "period" | null;
    windowStart: string | null;
    windowEnd: string | null;
    slots: Array<{
      startAt: string;
      endAt: string;
      likelihood: "high" | "medium" | "low";
      probabilityKnown?: boolean;
    }>;
    todayProbability: "high" | "medium" | "low" | null;
    likelihood: "high" | "medium" | "low" | null;
    lastRecordedAt: string | null;
    lastRecordedTimestamp?: string | null;
    lastRecordedQuality?: "platform" | "transition" | "initial_live" | "legacy";
    nextDateEnd?: string | null;
    typicalDayType?: string | null;
    recentObservations: Array<{
      time: string;
      quality: "platform" | "transition" | "initial_live" | "legacy";
    }>;
    startAt: string | null;
    endAt: string | null;
    confidence: "high" | "medium" | "low" | null;
    basedOnDays: number;
    notice: string | null;
  };
}

export async function fetchRoomInsights(
  roomIds: string[],
): Promise<Record<string, RoomInsight>> {
  const { data } = await http.post<{ insights: Record<string, RoomInsight> }>(
    "/rooms/insights/batch",
    { roomIds },
  );
  return data.insights;
}

export async function fetchRoomStats(id: string): Promise<RoomStats> {
  const { data } = await http.get<RoomStats>(`/rooms/${id}/stats`);
  return data;
}
