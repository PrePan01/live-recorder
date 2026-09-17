import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Room } from '../types/room';

export const STORAGE_KEY = 'lr-wall-store';

export type WallGrid = '2x2' | '3x3' | '3x1';

export interface WallLayout {
  columns: number;
  rows: number;
  /**
   * 竖屏布局：格子不预设宽高比，由可用高度撑满，画面按真实比例自适应。
   * 主播实际开播比例未知，写死 9:16 会把横向画面裁掉或留出多余黑边。
   */
  fill: boolean;
  /** 是否允许同一个直播间占用多个格子；切到不允许的布局时会去重。 */
  allowDuplicates: boolean;
}

export const WALL_LAYOUTS: Record<WallGrid, WallLayout> = {
  '2x2': { columns: 2, rows: 2, fill: false, allowDuplicates: false },
  '3x3': { columns: 3, rows: 3, fill: false, allowDuplicates: false },
  '3x1': { columns: 3, rows: 1, fill: true, allowDuplicates: true },
};

/** 持久化数据不受类型约束，未知取值退回默认布局而不是崩溃。 */
export function getWallLayout(grid: WallGrid): WallLayout {
  return WALL_LAYOUTS[grid] ?? WALL_LAYOUTS['2x2'];
}

export function getWallCapacity(grid: WallGrid): number {
  const { columns, rows } = getWallLayout(grid);
  return columns * rows;
}

/**
 * 切换布局后的槽位：先按新容量截断，再在目标布局不允许重复时去掉重复项。
 * 去重保留首次出现的位置、把后面的重复项置空——沿用「保留物理槽位」的做法，
 * 这样其它格子上的画面不会被搬到别的位置。
 */
export function applyGridLayout(current: (string | null)[], grid: WallGrid): (string | null)[] {
  const sliced = current.slice(0, getWallCapacity(grid));
  if (getWallLayout(grid).allowDuplicates) return sliced;
  const seen = new Set<string>();
  return sliced.map((id) => {
    if (id === null) return null;
    if (seen.has(id)) return null;
    seen.add(id);
    return id;
  });
}

export interface AddRoomsResult {
  nextIds: (string | null)[];
  /** 本次实际加入墙的路（去重后，且不超过剩余容量） */
  added: string[];
  /** 因已达容量上限未被采纳的房间 id（UI 已用 maxCount 封顶，正常情况下为空） */
  dropped: string[];
}

/**
 * 纯函数：往直播墙追加一批房间，只填剩余空位、最多 max 路，不做替换。
 * UI 层已用 maxCount 把可选数封顶到剩余容量，drop 分支是防御性兜底。
 * allowDuplicates 为 true 时（3x1）同一个直播间可以占多个格子。
 */
export function applyAddRooms(
  current: (string | null)[],
  batch: string[],
  max = getWallCapacity('2x2'),
  allowDuplicates = false,
): AddRoomsResult {
  const nextIds = [...current];
  const added: string[] = [];
  const dropped: string[] = [];
  for (const id of batch) {
    const duplicate = !allowDuplicates && nextIds.includes(id);
    if (duplicate || nextIds.filter(Boolean).length >= max) {
      if (!duplicate) dropped.push(id);
      continue;
    }
    added.push(id);
    const empty = nextIds.indexOf(null);
    if (empty >= 0) nextIds[empty] = id;
    else nextIds.push(id);
  }
  return { nextIds, added, dropped };
}

interface WallState {
  roomIds: (string | null)[];
  grid: WallGrid;
  setGrid: (grid: WallGrid) => void;
  addRooms: (batch: string[]) => AddRoomsResult;
  /** 将尚未加入直播墙的房间直接放入指定空格。 */
  addRoomToSlot: (roomId: string, slot: number) => boolean;
  /**
   * 卡片操作一律按槽位寻址：3x1 下同一个直播间可以占多个格子，
   * 按房间 id 定位会永远命中第一个，导致删一个删掉全部、拖重复格子没反应。
   */
  removeSlot: (slot: number) => void;
  swapSlots: (from: number, to: number) => void;
  /** rooms 数据到达后对账：剔除已不存在或已停用的房间（空列表视为未加载，不清理） */
  reconcile: (rooms: Room[]) => void;
}

export const useWallStore = create<WallState>()(
  persist(
    (set, get) => ({
      roomIds: [],
      grid: '2x2',
      setGrid: (grid) => set((s) => ({
        grid,
        // 缩容不能留下越界的播放器，因此只保留前 capacity 个物理槽位（含刻意的空位）；
        // 目标布局不允许重复时顺带去掉重复项，例如 3x1 -> 2x2。
        roomIds: applyGridLayout(s.roomIds, grid),
      })),
      swapSlots: (from, to) => {
        set((s) => {
          const capacity = Math.max(getWallCapacity(s.grid), s.roomIds.length);
          if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= capacity || to >= capacity || from === to) return s;
          const roomIds = Array.from({ length: capacity }, (_, i) => s.roomIds[i] ?? null);
          [roomIds[from], roomIds[to]] = [roomIds[to]!, roomIds[from]!];
          return { roomIds };
        });
      },
      addRooms: (batch) => {
        const { roomIds, grid } = get();
        const res = applyAddRooms(roomIds, batch, getWallCapacity(grid), getWallLayout(grid).allowDuplicates);
        set({ roomIds: res.nextIds });
        return res;
      },
      addRoomToSlot: (roomId, slot) => {
        const { roomIds, grid } = get();
        const capacity = getWallCapacity(grid);
        if (
          !roomId ||
          !Number.isInteger(slot) ||
          slot < 0 ||
          slot >= capacity ||
          roomIds[slot] != null ||
          (!getWallLayout(grid).allowDuplicates && roomIds.includes(roomId))
        ) {
          return false;
        }
        const nextIds = Array.from(
          { length: capacity },
          (_, index) => roomIds[index] ?? null,
        );
        nextIds[slot] = roomId;
        set({ roomIds: nextIds });
        return true;
      },
      removeSlot: (slot) => {
        set((s) => {
          if (!Number.isInteger(slot) || slot < 0 || slot >= s.roomIds.length || s.roomIds[slot] == null) return s;
          const roomIds = [...s.roomIds];
          roomIds[slot] = null;
          return { roomIds };
        });
      },
      reconcile: (rooms) => {
        if (rooms.length === 0) return;
        set((s) => {
          const valid = new Set(rooms.filter((r) => r.enabled).map((r) => r.id));
          const next = s.roomIds.map((id) => id !== null && valid.has(id) ? id : null);
          if (next.every((id, index) => id === s.roomIds[index])) return s;
          return { roomIds: next };
        });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ roomIds: s.roomIds, grid: s.grid }),
    },
  ),
);
