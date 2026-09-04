import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Room } from '../types/room';

export const MAX_WALL = 4;
export const STORAGE_KEY = 'lr-wall-store';

export type WallGrid = '2x2' | '3x3';

export interface AddRoomsResult {
  nextIds: string[];
  /** 本次实际加入墙的路（去重后，且不超过剩余容量） */
  added: string[];
  /** 因已达 MAX_WALL 未被采纳的房间 id（UI 已用 maxCount 封顶，正常情况下为空） */
  dropped: string[];
}

/**
 * 纯函数：往直播墙追加一批房间，只填剩余空位、最多 MAX_WALL，不做替换。
 * UI 层已用 maxCount 把可选数封顶到剩余容量，drop 分支是防御性兜底。
 */
export function applyAddRooms(current: string[], batch: string[], max = MAX_WALL): AddRoomsResult {
  const added: string[] = [];
  const dropped: string[] = [];
  for (const id of batch) {
    const duplicate = current.includes(id) || added.includes(id);
    if (duplicate || added.length + current.length >= max) {
      if (!duplicate) dropped.push(id);
      continue;
    }
    added.push(id);
  }
  return { nextIds: [...current, ...added], added, dropped };
}

interface WallState {
  roomIds: string[];
  grid: WallGrid;
  setGrid: (grid: WallGrid) => void;
  addRooms: (batch: string[]) => AddRoomsResult;
  removeRoom: (roomId: string) => void;
  /** rooms 数据到达后对账：剔除已不存在或已停用的房间（空列表视为未加载，不清理） */
  reconcile: (rooms: Room[]) => void;
}

export const useWallStore = create<WallState>()(
  persist(
    (set, get) => ({
      roomIds: [],
      grid: '2x2',
      setGrid: (grid) => set({ grid }),
      addRooms: (batch) => {
        const res = applyAddRooms(get().roomIds, batch);
        set({ roomIds: res.nextIds });
        return res;
      },
      removeRoom: (roomId) => {
        set((s) => ({ roomIds: s.roomIds.filter((id) => id !== roomId) }));
      },
      reconcile: (rooms) => {
        if (rooms.length === 0) return;
        set((s) => {
          const valid = new Set(rooms.filter((r) => r.enabled).map((r) => r.id));
          const next = s.roomIds.filter((id) => valid.has(id));
          if (next.length === s.roomIds.length) return s;
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
