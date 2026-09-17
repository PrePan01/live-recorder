/**
 * Keep React children in a stable DOM order; CSS grid controls their visual positions.
 *
 * 3x1 允许同一个直播间占多个格子，此时 `room-<id>` 会重复——重复的 key 会让 React
 * 复用错节点（画面串格、拖拽拖动错卡片）。因此按出现次序给第 2 个及以后的同 id 加后缀：
 * 出现次序按槽位顺序编号，交换两个不同房间时编号不变，DOM 顺序与动画仍保持稳定。
 */
export function stableSlotEntries<T extends { id: string }>(slots: (T | undefined)[]) {
  const occurrences = new Map<string, number>();
  return slots
    .map((room, index) => {
      if (!room) return { room, index, key: `empty-${index}` };
      const occurrence = occurrences.get(room.id) ?? 0;
      occurrences.set(room.id, occurrence + 1);
      return {
        room,
        index,
        key: occurrence === 0 ? `room-${room.id}` : `room-${room.id}#${occurrence}`,
      };
    })
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
