import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Room } from '../types/room';

export const MAX_WALL = 9;
export const STORAGE_KEY = 'lr-wall-store';

export type WallGrid = '2x2' | '3x3';

export function getWallCapacity(grid: WallGrid): number {
  return grid === '3x3' ? MAX_WALL : 4;
}

export interface AddRoomsResult {
  nextIds: (string | null)[];
  /** 本次实际加入墙的路（去重后，且不超过剩余容量） */
  added: string[];
  /** 因已达 MAX_WALL 未被采纳的房间 id（UI 已用 maxCount 封顶，正常情况下为空） */
  dropped: string[];
}

/**
 * 纯函数：往直播墙追加一批房间，只填剩余空位、最多 MAX_WALL，不做替换。
 * UI 层已用 maxCount 把可选数封顶到剩余容量，drop 分支是防御性兜底。
 */
export function applyAddRooms(current: (string | null)[], batch: string[], max = getWallCapacity('2x2')): AddRoomsResult {
  const nextIds = [...current];
  const added: string[] = [];
  const dropped: string[] = [];
  for (const id of batch) {
    const duplicate = nextIds.includes(id);
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
  removeRoom: (roomId: string) => void;
  swapRooms: (sourceId: string, targetId: string) => void;
  moveRoomToSlot: (sourceId: string, target: number) => void;
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
        // A smaller grid must not leave off-grid players mounted.  Keep the
        // first physical slots (including intentional empty slots) so the
        // layout remains stable and 3x3 -> 2x2 retains only slots 1-4.
        roomIds: s.roomIds.slice(0, getWallCapacity(grid)),
      })),
      moveRoomToSlot: (sourceId, target) => {
        set((s) => {
          const source = s.roomIds.indexOf(sourceId);
          const capacity = Math.max(getWallCapacity(s.grid), s.roomIds.length);
          if (source < 0 || !Number.isInteger(target) || target < 0 || target >= capacity || source === target) return s;
          const roomIds = Array.from({ length: capacity }, (_, i) => s.roomIds[i] ?? null);
          [roomIds[source], roomIds[target]] = [roomIds[target]!, roomIds[source]!];
          return { roomIds };
        });
      },
      swapRooms: (sourceId, targetId) => {
        set((s) => {
          const source = s.roomIds.indexOf(sourceId);
          const target = s.roomIds.indexOf(targetId);
          if (source < 0 || target < 0 || source === target) return s;
          const roomIds = [...s.roomIds];
          [roomIds[source], roomIds[target]] = [roomIds[target]!, roomIds[source]!];
          return { roomIds };
        });
      },
      addRooms: (batch) => {
        const { roomIds, grid } = get();
        const res = applyAddRooms(roomIds, batch, getWallCapacity(grid));
        set({ roomIds: res.nextIds });
        return res;
      },
      removeRoom: (roomId) => {
        set((s) => ({ roomIds: s.roomIds.map((id) => id === roomId ? null : id) }));
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
