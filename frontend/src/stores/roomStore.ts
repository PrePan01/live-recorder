import { create } from 'zustand';
import * as roomsApi from '../api/rooms';
import type { Room, RoomCreateInput, RoomUpdateInput } from '../types/room';

interface RoomState {
  rooms: Room[];
  loading: boolean;
  fetchRooms: () => Promise<void>;
  addRoom: (input: RoomCreateInput) => Promise<Room>;
  editRoom: (id: string, input: RoomUpdateInput) => Promise<void>;
  removeRoom: (id: string) => Promise<void>;
  toggleRoom: (id: string, enabled: boolean) => Promise<void>;
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
      set({ rooms: await roomsApi.fetchRooms(), loading: false });
    } catch {
      set({ loading: false });
      throw new Error('fetchRooms failed');
    }
  },
  async addRoom(input) {
    const room = await roomsApi.createRoom(input);
    get().upsertRoom(room);
    return room;
  },
  async editRoom(id, input) {
    get().upsertRoom(await roomsApi.updateRoom(id, input));
  },
  async removeRoom(id) {
    await roomsApi.deleteRoom(id);
    set((s) => ({ rooms: s.rooms.filter((r) => r.id !== id) }));
  },
  async toggleRoom(id, enabled) {
    get().upsertRoom(await roomsApi.setRoomEnabled(id, enabled));
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
      const idx = s.rooms.findIndex((r) => r.id === room.id);
      if (idx === -1) return { rooms: [...s.rooms, room] };
      const next = [...s.rooms];
      next[idx] = room;
      return { rooms: next };
    });
  },
}));
