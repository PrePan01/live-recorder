import { afterEach, describe, expect, it, vi } from "vitest";
import { http } from "./client";
import { EndpointResolver } from "./endpoint";
import { liveCoverSrc, saveLiveCover } from "./rooms";
import type { Room } from "../types/room";

const room = { id: "room 1", displayName: "主播" } as Room;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  EndpointResolver.reset();
});

describe("live cover saving", () => {
  it("uses the current endpoint and separates cover URL versions", () => {
    EndpointResolver.set({
      baseUrl: "http://127.0.0.1:43199",
      apiVersion: "v1",
      instanceId: "test",
    } as never);
    expect(liveCoverSrc(room.id, "https://cdn/cover?token=a")).toBe(
      "http://127.0.0.1:43199/api/v1/rooms/room%201/cover?v=https%3A%2F%2Fcdn%2Fcover%3Ftoken%3Da",
    );
  });
  it.each([
    [true, null, "saved"],
    [false, "cancelled", "cancelled"],
  ] as const)(
    "returns the save result without downloading (%s)",
    async (saved, reason, expected) => {
      const post = vi
        .spyOn(http, "post")
        .mockResolvedValue({ data: { saved, reason } });
      const get = vi.spyOn(http, "get");
      expect(await saveLiveCover(room)).toBe(expected);
      expect(post).toHaveBeenCalledWith(
        "/rooms/room%201/cover/save",
        undefined,
        { timeout: 0 },
      );
      expect(get).not.toHaveBeenCalled();
    },
  );
  it("downloads the original image when no native dialog is available", async () => {
    vi.spyOn(http, "post").mockResolvedValue({
      data: { saved: false, reason: "no-dialog" },
    });
    vi.spyOn(http, "get").mockResolvedValue({
      data: new Blob(["image"]),
      headers: {
        "content-disposition":
          `attachment; filename="live-cover.png"; filename*=UTF-8''${encodeURIComponent("主播-直播封面-20261007T123456Z.png")}`,
      },
    });
    const anchor = { click: vi.fn(), href: "", download: "" };
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor) });
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => callback(),
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cover");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    expect(await saveLiveCover(room)).toBe("downloaded");
    expect(anchor.download).toBe("主播-直播封面-20261007T123456Z.png");
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:cover");
  });
  it("propagates save failures for the card error message", async () => {
    vi.spyOn(http, "post").mockRejectedValue(new Error("无法保存"));
    await expect(saveLiveCover(room)).rejects.toThrow("无法保存");
  });
});
