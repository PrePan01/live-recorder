import { afterEach, describe, expect, it, vi } from "vitest";
import type { Room } from "../types/room";
vi.mock("../api/rooms", () => ({ updateRoom: vi.fn() }));
import { updateRoom } from "../api/rooms";
import { useRoomStore } from "./roomStore";
const room = (id: string, extra: Partial<Room> = {}) =>
  ({ id, tags: [], sortOrder: 0, ...extra }) as Room;

afterEach(() => {
  useRoomStore.setState({ rooms: [] });
  vi.resetAllMocks();
});
describe("room policy writes", () => {
  it("serializes same-room edits from different controls and continues after a failed request", async () => {
    let release!: (room: Room) => void;
    vi.mocked(updateRoom)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(room("a", { quality: "720p", autoRecord: true }));
    useRoomStore.getState().upsertRoom(room("a"));
    const first = useRoomStore.getState().editRoom("a", { quality: "720p" });
    const second = useRoomStore.getState().setAutoRecord("a", false);
    const failed = expect(second).rejects.toThrow("offline");
    const third = useRoomStore.getState().setAutoRecord("a", true);
    await vi.waitFor(() => expect(updateRoom).toHaveBeenCalledTimes(1));
    release(room("a", { quality: "720p" }));
    await first;
    await failed;
    await third;
    expect(vi.mocked(updateRoom).mock.calls).toEqual([
      ["a", { quality: "720p" }],
      ["a", { autoRecord: false }],
      ["a", { autoRecord: true }],
    ]);
    expect(useRoomStore.getState().rooms[0]).toMatchObject({
      quality: "720p",
      autoRecord: true,
    });
  });
  it("preserves the other 999 references when one SSE update arrives", () => {
    const rooms = Array.from({ length: 1000 }, (_, i) =>
      room(String(i), { sortOrder: i }),
    );
    useRoomStore.setState({ rooms });
    useRoomStore.getState().upsertRoom({ ...rooms[17], quality: "720p" });
    const updated = useRoomStore.getState().rooms;
    expect(updated.filter((room, i) => room !== rooms[i])).toHaveLength(1);
    expect(updated[17].quality).toBe("720p");
  });
});
