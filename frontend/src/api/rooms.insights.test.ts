import { afterEach, describe, expect, it, vi } from "vitest";
import { http } from "./client";
import { fetchRoomInsights } from "./rooms";

afterEach(() => vi.restoreAllMocks());
describe("room insight batches", () => {
  it("deduplicates and chunks more than 100 rooms without losing metrics", async () => {
    const post = vi
      .spyOn(http, "post")
      .mockImplementation(async (_url, body) => {
        const ids = (body as { roomIds: string[] }).roomIds;
        return {
          data: {
            insights: Object.fromEntries(
              ids.map((id) => [id, { sorting: { totalRecordings: 42 } }]),
            ),
          },
        };
      });
    const ids = Array.from({ length: 205 }, (_, index) => `room-${index}`);
    const result = await fetchRoomInsights([...ids, ids[0]]);
    expect(
      post.mock.calls.map(
        (call) => (call[1] as { roomIds: string[] }).roomIds.length,
      ),
    ).toEqual([100, 100, 5]);
    expect(Object.keys(result)).toHaveLength(205);
    expect(result["room-204"].sorting?.totalRecordings).toBe(42);
  });
  it("skips requests for empty lists", async () => {
    const post = vi.spyOn(http, "post");
    expect(await fetchRoomInsights([])).toEqual({});
    expect(post).not.toHaveBeenCalled();
  });
});
