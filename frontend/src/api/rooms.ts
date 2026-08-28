import { http } from './client';
import type { Room, RoomCreateInput, RoomUpdateInput } from '../types/room';

export async function fetchRooms(): Promise<Room[]> {
  const { data } = await http.get<{ rooms: Room[] }>('/rooms');
  return data.rooms;
}

export async function createRoom(input: RoomCreateInput): Promise<Room> {
  const { data } = await http.post<{ room: Room }>('/rooms', input);
  return data.room;
}

export interface BatchRoomResult {
  succeeded: Room[];
  failed: Array<{ url: string; reason: string }>;
}

export async function batchCreateRooms(urls: string[]): Promise<BatchRoomResult> {
  const { data } = await http.post<BatchRoomResult>('/rooms/batch', { urls });
  return data;
}

export async function updateRoom(id: string, input: RoomUpdateInput): Promise<Room> {
  const { data } = await http.patch<{ room: Room }>(`/rooms/${id}`, input);
  return data.room;
}

export async function deleteRoom(id: string): Promise<void> {
  await http.delete(`/rooms/${id}`);
}

export async function setRoomEnabled(id: string, enabled: boolean): Promise<Room> {
  const { data } = await http.patch<{ room: Room }>(`/rooms/${id}/enable`, { enabled });
  return data.room;
}

export async function setRoomFavorite(id: string, favorited: boolean): Promise<Room> {
  const { data } = await http.patch<{ room: Room }>(`/rooms/${id}/favorite`, { favorited });
  return data.room;
}

export async function checkRoomNow(id: string): Promise<void> {
  await http.post(`/rooms/${id}/check`);
}

export async function stopRecording(id: string): Promise<void> {
  await http.post(`/rooms/${id}/stop-recording`);
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

export async function fetchRoomStats(id: string): Promise<RoomStats> {
  const { data } = await http.get<RoomStats>(`/rooms/${id}/stats`);
  return data;
}
