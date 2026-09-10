import { afterEach, describe, expect, it, vi } from "vitest";
import type { Room } from "../types/room";

vi.mock("../api/rooms", () => ({
  reorderRooms: vi.fn(),
  fetchRooms: vi.fn(),
}));

import * as roomsApi from "../api/rooms";
import { useRoomStore } from "./roomStore";

const room = (id: string, sortOrder: number): Room =>
  ({ id, sortOrder, tags: [] }) as unknown as Room;

describe("roomStore ordering", () => {
  afterEach(() => {
    useRoomStore.setState({ rooms: [], reorderBusy: false });
    vi.resetAllMocks();
  });

  it("updates optimistically and adopts the authoritative response", async () => {
    const initial = [room("a", 0), room("b", 1), room("c", 2)];
    const authoritative = [room("c", 0), room("a", 1), room("b", 2)];
    vi.mocked(roomsApi.reorderRooms).mockResolvedValue(authoritative);
    useRoomStore.setState({ rooms: initial });

    const pending = useRoomStore.getState().reorderRooms(["c", "a", "b"]);
    expect(useRoomStore.getState().rooms.map((item) => item.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(useRoomStore.getState().reorderBusy).toBe(true);
    await pending;
    expect(useRoomStore.getState().rooms.map((item) => item.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(useRoomStore.getState().reorderBusy).toBe(false);
  });

  it("reloads the server order after a save failure", async () => {
    const initial = [room("a", 0), room("b", 1), room("c", 2)];
    vi.mocked(roomsApi.reorderRooms).mockRejectedValue(new Error("offline"));
    vi.mocked(roomsApi.fetchRooms).mockResolvedValue(initial);
    useRoomStore.setState({ rooms: initial });

    await expect(
      useRoomStore.getState().reorderRooms(["c", "a", "b"]),
    ).rejects.toThrow("offline");
    expect(useRoomStore.getState().rooms.map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps order when a room update arrives", () => {
    useRoomStore.setState({ rooms: [room("b", 0), room("a", 1)] });
    useRoomStore
      .getState()
      .upsertRoom({ ...room("a", 99), displayName: "updated" });
    expect(useRoomStore.getState().rooms.map((item) => item.id)).toEqual([
      "b",
      "a",
    ]);
    expect(useRoomStore.getState().rooms[1]!.sortOrder).toBe(1);
  });
});
