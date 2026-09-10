import type { Room } from "../types/room";

export type InsertEdge = "before" | "after";

/**
 * Reorder only the visible projection, then put it back into the same global
 * slots. Hidden/filtered rooms therefore retain their relative order.
 */
export function reorderVisibleRooms(
  allRooms: Room[],
  visibleIds: string[],
  sourceId: string,
  targetId: string,
  edge: InsertEdge,
): Room[] {
  if (sourceId === targetId) return allRooms;
  const allIds = new Set(allRooms.map((room) => room.id));
  const visibleSet = new Set(visibleIds);
  if (
    visibleSet.size !== visibleIds.length ||
    !visibleSet.has(sourceId) ||
    !visibleSet.has(targetId) ||
    visibleIds.some((id) => !allIds.has(id))
  ) {
    return allRooms;
  }

  const reorderedVisible = visibleIds.filter((id) => id !== sourceId);
  const targetIndex = reorderedVisible.indexOf(targetId);
  reorderedVisible.splice(
    targetIndex + (edge === "after" ? 1 : 0),
    0,
    sourceId,
  );
  if (reorderedVisible.every((id, index) => id === visibleIds[index]))
    return allRooms;

  const roomById = new Map(allRooms.map((room) => [room.id, room]));
  let visibleIndex = 0;
  return allRooms.map((room) =>
    visibleSet.has(room.id)
      ? roomById.get(reorderedVisible[visibleIndex++]!)!
      : room,
  );
}
