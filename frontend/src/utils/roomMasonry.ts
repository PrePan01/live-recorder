export function layoutRoomMasonry(
  heights: number[],
  columns: number,
  width: number,
  gap: number,
  rowGap = gap,
  assignedColumns: readonly number[] = [],
) {
  const bottoms = Array<number>(Math.max(1, columns)).fill(0);
  const columnAssignments: number[] = [];
  const positions = heights.map((height, index) => {
    const assigned = assignedColumns[index];
    const column =
      assigned !== undefined && assigned >= 0 && assigned < bottoms.length
        ? assigned
        : bottoms.indexOf(Math.min(...bottoms));
    columnAssignments.push(column);
    const top = bottoms[column];
    bottoms[column] = top + height + rowGap;
    return { left: column * (width + gap), top };
  });
  return {
    positions,
    columnAssignments,
    height: heights.length ? Math.max(...bottoms) - rowGap : 0,
  };
}
