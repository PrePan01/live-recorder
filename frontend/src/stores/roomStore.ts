import { create } from 'zustand';
import * as roomsApi from '../api/rooms';
import { setRoomTags } from '../api/tags';
import type { Room, RoomCreateInput, RoomUpdateInput } from '../types/room';

let roomsRequest: Promise<Room[]> | null = null;
let roomsEpoch = 0;
let roomsFetchedAt = 0;
const ROOMS_CACHE_MS = 30_000;

function invalidateRoomsRequest(): void {
  roomsEpoch += 1;
}

function normalizeRoom(room: Room): Room {
  return {
    ...room,
    favorited: room.favorited ?? false,
    autoRecord: room.autoRecord ?? null,
    lastLiveStatus: room.lastLiveStatus ?? null,
    activeRecording: room.activeRecording ?? null,
    tags: room.tags ?? [],
    uploadEnabled: room.uploadEnabled ?? null,
    titleSource: room.titleSource ?? null,
    titleUpdatedAt: room.titleUpdatedAt ?? null,
    titleFallbackUsed: room.titleFallbackUsed ?? false,
  };
}

/** Preserve unchanged records so a room-level SSE update does not re-render every card. */
function mergeRooms(current: Room[], incoming: Room[]): Room[] {
  const previous = new Map(current.map((room) => [room.id, room]));
  return incoming.map((room) => {
    const normalized = normalizeRoom(room);
    const old = previous.get(normalized.id);
    return old && JSON.stringify(old) === JSON.stringify(normalized) ? old : normalized;
  });
}

interface RoomState {
  rooms: Room[];
  loading: boolean;
  /** 房间级操作 loading（check/record/stop），键为 roomId */
  actingRoomId: string | null;
  actingAction: 'check' | 'record' | 'stop' | null;
  fetchRooms: (force?: boolean) => Promise<void>;
  addRoom: (input: RoomCreateInput) => Promise<Room>;
  batchAddRooms: (urls: string[]) => Promise<roomsApi.BatchRoomResult>;
  editRoom: (id: string, input: RoomUpdateInput) => Promise<void>;
  removeRoom: (id: string) => Promise<void>;
  toggleRoom: (id: string, enabled: boolean) => Promise<void>;
  favoriteRoom: (id: string, favorited: boolean) => Promise<void>;
  setAutoRecord: (id: string, value: boolean | null) => Promise<void>;
  checkRoomNow: (id: string) => Promise<void>;
  startRoomRecording: (id: string) => Promise<void>;
  stopRoomRecording: (id: string) => Promise<void>;
  updateRoomTags: (id: string, tagIds: string[]) => Promise<void>;
  upsertRoom: (room: Room) => void;
}

export const useRoomStore = create<RoomState>((set, get) => ({
  rooms: [],
  loading: false,
  actingRoomId: null,
  actingAction: null,
  async fetchRooms(force = false) {
    if (!force && get().rooms.length > 0 && Date.now() - roomsFetchedAt < ROOMS_CACHE_MS) return;
    set({ loading: true });
    const epoch = roomsEpoch;
    try {
      if (!roomsRequest) {
        const request = roomsApi.fetchRooms();
        const wrapped = request.finally(() => {
          if (roomsRequest === wrapped) roomsRequest = null;
        });
        roomsRequest = wrapped;
      }
      const rooms = await roomsRequest;
      // A mutation made while this response was in flight already updated the
      // precise room locally. Never overwrite it with an older list response.
      if (epoch === roomsEpoch) {
        roomsFetchedAt = Date.now();
        set((state) => ({ rooms: mergeRooms(state.rooms, rooms), loading: false }));
      }
      else set({ loading: false });
    } catch {
      set({ loading: false });
      throw new Error('fetchRooms failed');
    }
  },
  async addRoom(input) {
    const room = normalizeRoom(await roomsApi.createRoom(input));
    invalidateRoomsRequest();
    get().upsertRoom(room);
    return room;
  },
  async batchAddRooms(urls) {
    const res = await roomsApi.batchCreateRooms(urls);
    if (res.succeeded.length > 0) invalidateRoomsRequest();
    res.succeeded.forEach((room) => get().upsertRoom(normalizeRoom(room)));
    return res;
  },
  async editRoom(id, input) {
    invalidateRoomsRequest();
    get().upsertRoom(normalizeRoom(await roomsApi.updateRoom(id, input)));
  },
  async removeRoom(id) {
    await roomsApi.deleteRoom(id);
    invalidateRoomsRequest();
    set((s) => ({ rooms: s.rooms.filter((r) => r.id !== id) }));
  },
  async toggleRoom(id, enabled) {
    invalidateRoomsRequest();
    get().upsertRoom(normalizeRoom(await roomsApi.setRoomEnabled(id, enabled)));
  },
  async favoriteRoom(id, favorited) {
    invalidateRoomsRequest();
    get().upsertRoom(normalizeRoom(await roomsApi.setRoomFavorite(id, favorited)));
  },
  async setAutoRecord(id, value) {
    invalidateRoomsRequest();
    get().upsertRoom(normalizeRoom(await roomsApi.updateRoom(id, { autoRecord: value })));
  },
  async checkRoomNow(id) {
    invalidateRoomsRequest();
    set({ actingRoomId: id, actingAction: 'check' });
    try {
      const room = get().rooms.find((r) => r.id === id);
      if (room) {
        get().upsertRoom({ ...room, monitorState: 'checking', lastCheckedAt: new Date().toISOString() });
      }
      await roomsApi.checkRoomNow(id);
    } finally {
      set({ actingRoomId: null, actingAction: null });
    }
  },
  async startRoomRecording(id) {
    invalidateRoomsRequest();
    set({ actingRoomId: id, actingAction: 'record' });
    try {
      await roomsApi.startRoomRecording(id);
      // 乐观更新：成功后先本地标记录制中，等待 SSE room:updated 校正。
      const room = get().rooms.find((r) => r.id === id);
      if (room) {
        get().upsertRoom({
          ...room,
          monitorState: 'recording',
          activeRecording: room.activeRecording ?? { recordingId: '', startedAt: new Date().toISOString() },
        });
      }
    } finally {
      set({ actingRoomId: null, actingAction: null });
    }
  },
  async stopRoomRecording(id) {
    invalidateRoomsRequest();
    set({ actingRoomId: id, actingAction: 'stop' });
    try {
      await roomsApi.stopRecording(id);
    } finally {
      set({ actingRoomId: null, actingAction: null });
    }
  },
  async updateRoomTags(id, tagIds) {
    invalidateRoomsRequest();
    get().upsertRoom(normalizeRoom(await setRoomTags(id, tagIds)));
  },
  upsertRoom(room) {
    set((s) => {
      const norm = normalizeRoom(room);
      const idx = s.rooms.findIndex((r) => r.id === norm.id);
      if (idx === -1) return { rooms: [...s.rooms, norm] };
      if (JSON.stringify(s.rooms[idx]) === JSON.stringify(norm)) return s;
      const next = [...s.rooms];
      next[idx] = norm;
      return { rooms: next };
    });
  },
}));
