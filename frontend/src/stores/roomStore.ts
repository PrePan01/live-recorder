import { create } from 'zustand';
import * as roomsApi from '../api/rooms';
import type { Room, RoomCreateInput, RoomUpdateInput } from '../types/room';

function normalizeRoom(room: Room): Room {
  return {
    ...room,
    favorited: room.favorited ?? false,
    activeRecording: room.activeRecording ?? null,
  };
}

interface RoomState {
  rooms: Room[];
  loading: boolean;
  fetchRooms: () => Promise<void>;
  addRoom: (input: RoomCreateInput) => Promise<Room>;
  editRoom: (id: string, input: RoomUpdateInput) => Promise<void>;
  removeRoom: (id: string) => Promise<void>;
  toggleRoom: (id: string, enabled: boolean) => Promise<void>;
  favoriteRoom: (id: string, favorited: boolean) => Promise<void>;
  checkRoomNow: (id: string) => Promise<void>;
  stopRoomRecording: (id: string) => Promise<void>;
  upsertRoom: (room: Room) => void;
}

export const useRoomStore = create<RoomState>((set, get) => ({
  rooms: [],
  loading: false,
  async fetchRooms() {
    set({ loading: true });
    try {
      set({ rooms: (await roomsApi.fetchRooms()).map(normalizeRoom), loading: false });
    } catch {
      set({ loading: false });
      throw new Error('fetchRooms failed');
    }
  },
  async addRoom(input) {
    const room = normalizeRoom(await roomsApi.createRoom(input));
    get().upsertRoom(room);
    return room;
  },
  async editRoom(id, input) {
    get().upsertRoom(normalizeRoom(await roomsApi.updateRoom(id, input)));
  },
  async removeRoom(id) {
    await roomsApi.deleteRoom(id);
    set((s) => ({ rooms: s.rooms.filter((r) => r.id !== id) }));
  },
  async toggleRoom(id, enabled) {
    get().upsertRoom(normalizeRoom(await roomsApi.setRoomEnabled(id, enabled)));
  },
  async favoriteRoom(id, favorited) {
    get().upsertRoom(normalizeRoom(await roomsApi.setRoomFavorite(id, favorited)));
  },
  async checkRoomNow(id) {
    const room = get().rooms.find((r) => r.id === id);
    if (room) {
      get().upsertRoom({ ...room, monitorState: 'checking', lastCheckedAt: new Date().toISOString() });
    }
    await roomsApi.checkRoomNow(id);
  },
  async stopRoomRecording(id) {
    await roomsApi.stopRecording(id);
  },
  upsertRoom(room) {
    set((s) => {
      const norm = normalizeRoom(room);
      const idx = s.rooms.findIndex((r) => r.id === norm.id);
      if (idx === -1) return { rooms: [...s.rooms, norm] };
      const next = [...s.rooms];
      next[idx] = norm;
      return { rooms: next };
    });
  },
}));
