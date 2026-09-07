/** Keep React children in a stable DOM order; CSS grid controls their visual positions. */
export function stableSlotEntries<T extends { id: string }>(slots: (T | undefined)[]) {
  return slots
    .map((room, index) => ({ room, index, key: room ? `room-${room.id}` : `empty-${index}` }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
