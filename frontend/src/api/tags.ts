import { http } from './client';
import type { Tag } from '../types/tag';
import type { Room } from '../types/room';

export async function fetchTags(): Promise<Tag[]> {
  const { data } = await http.get<{ tags: Tag[] }>('/tags');
  return data.tags;
}

export async function createTag(input: { name: string; color?: string }): Promise<Tag> {
  const { data } = await http.post<{ tag: Tag }>('/tags', input);
  return data.tag;
}

export async function updateTag(id: string, input: { name?: string; color?: string }): Promise<Tag> {
  const { data } = await http.patch<{ tag: Tag }>(`/tags/${id}`, input);
  return data.tag;
}

export async function deleteTag(id: string): Promise<void> {
  await http.delete(`/tags/${id}`);
}

export async function setRoomTags(roomId: string, tagIds: string[]): Promise<Room> {
  const { data } = await http.put<{ room: Room }>(`/rooms/${roomId}/tags`, { tagIds });
  return data.room;
}