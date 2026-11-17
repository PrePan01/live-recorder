import type { Room } from "../../types/room";

export function roomSavesDanmaku(
  room: Pick<Room, "danmakuEnabled" | "effective"> | undefined,
  globalEnabled: boolean,
): boolean {
  return room
    ? room.danmakuEnabled ?? room.effective?.danmakuEnabled?.value ?? globalEnabled
    : false;
}
