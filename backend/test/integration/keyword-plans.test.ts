import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { DEFAULT_SETTINGS } from "../../src/config/defaults.js";
import { FakeClock } from "../../src/core/clock.js";
import { buildServices } from "../../src/core/services.js";
import { KeywordPlanRepository } from "../../src/db/repositories/keyword-plan.repo.js";
import { ScheduleRepository } from "../../src/db/repositories/schedule.repo.js";
import type { LiveStatusResult } from "../../src/platform/adapter.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "lr-keyword-plan-"));
});

const closeApps: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closeApps.splice(0).reverse()) await close();
  await rm(directory, { recursive: true, force: true });
});

function setup() {
  const clock = new FakeClock(Date.now());
  const services = buildServices({ dbPath: ":memory:", clock });
  const { app } = buildApp(services);
  closeApps.push(() => app.close());
  services.settings.save({
    ...structuredClone(DEFAULT_SETTINGS),
    recordingDirectory: directory,
    autoRecord: false,
  });
  const createRoom = (platformId: number) =>
    services.rooms.create({
      platform: "bilibili",
      url: `https://live.bilibili.com/${platformId}`,
      displayName: "主播",
    });
  const room = createRoom(123);
  const endpoint = `/api/v1/rooms/${room.id}/keyword-plans`;
  return {
    app,
    clock,
    services,
    room,
    endpoint,
    createRoom,
    headers: { host: "127.0.0.1:43120" },
  };
}

it("validates, scopes and persists CRUD while updating the enabled index", async () => {
  const { app, services, room, endpoint, createRoom, headers } = setup();
  for (const payload of [
    {},
    { includeKeywords: [" "] },
    { excludeKeywords: [1] },
    { includeKeywords: ["a"], enabled: "yes" },
    { includeKeywords: null },
  ]) {
    expect(
      (await app.inject({ method: "POST", url: endpoint, headers, payload }))
        .statusCode,
    ).toBe(422);
  }
  const created = await app.inject({
    method: "POST",
    url: endpoint,
    headers,
    payload: {
      includeKeywords: ["  GAME ", "game", "赛事", "  "],
      excludeKeywords: [" Replay "],
    },
  });
  expect(created.statusCode).toBe(201);
  const { plan } = created.json();
  expect(plan).toMatchObject({
    roomId: room.id,
    enabled: true,
    includeKeywords: ["GAME", "赛事"],
    excludeKeywords: ["Replay"],
  });
  expect((await app.inject({ url: endpoint, headers })).json()).toEqual({
    plans: [plan],
  });
  const otherRoom = createRoom(456);
  const otherEndpoint = `/api/v1/rooms/${otherRoom.id}/keyword-plans/${plan.id}`;
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: otherEndpoint,
        headers,
        payload: { enabled: false },
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (await app.inject({ method: "DELETE", url: otherEndpoint, headers }))
      .statusCode,
  ).toBe(404);

  const index = services.keywordPlans;
  expect(index.matches(room.id, "game 决赛")).toBe(true);
  expect(index.matches(room.id, "赛事")).toBe(true);
  expect(index.matches(room.id, "GAME replay")).toBe(false);
  expect(index.matches(room.id, "直播")).toBe(false);
  const planEndpoint = `${endpoint}/${plan.id}`;
  const edit = (payload: object) =>
    app.inject({ method: "PATCH", url: planEndpoint, headers, payload });
  expect((await edit({ enabled: false })).statusCode).toBe(200);
  expect(index.matches(room.id, "game")).toBe(false);
  expect(new KeywordPlanRepository(services.db).matches(room.id, "game")).toBe(
    false,
  );
  expect((await edit({ enabled: true, includeKeywords: [] })).statusCode).toBe(
    200,
  );
  expect(index.matches(room.id, "闲聊")).toBe(true);
  expect(index.matches(room.id, undefined)).toBe(false);
  expect(index.matches(room.id, " ")).toBe(false);
  expect(new KeywordPlanRepository(services.db).matches(room.id, "闲聊")).toBe(
    true,
  );
  expect(
    (await app.inject({ method: "DELETE", url: planEndpoint, headers }))
      .statusCode,
  ).toBe(204);
  expect(index.matches(room.id, "闲聊")).toBe(false);
  expect(index.listForRoom(room.id)).toEqual([]);

  index.create(room.id, {
    enabled: true,
    includeKeywords: ["a"],
    excludeKeywords: [],
  });
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: `/api/v1/rooms/${room.id}`,
        headers,
      })
    ).statusCode,
  ).toBe(204);
  expect(index.listForRoom(room.id)).toEqual([]);
  expect(index.matches(room.id, "a")).toBe(false);
});

it("includes enabled plans in the room list and publishes changes to monitor subscribers", async () => {
  const { app, services, room, endpoint, headers } = setup();
  const schedules = `/api/v1/rooms/${room.id}/schedules`;
  const updates: unknown[] = [];
  const unsubscribe = services.events.on((event) => {
    if (event.type === "room:updated" && event.data.id === room.id) {
      updates.push(event.data.enabledPlans);
    }
  });
  try {
    const addSchedule = async (enabled: boolean) => {
      const response = await app.inject({
        method: "POST",
        url: schedules,
        headers,
        payload: { daysOfWeek: [1], startTime: "08:00", enabled },
      });
      expect(response.statusCode).toBe(201);
      return response.json().schedule.id as string;
    };
    const disabled = await addSchedule(false);
    expect(updates.at(-1)).toEqual({ schedule: false, keyword: false });
    const first = await addSchedule(true);
    const second = await addSchedule(true);
    expect(updates.at(-1)).toEqual({ schedule: true, keyword: false });
    expect(new ScheduleRepository(services.db).hasEnabledForRoom(room.id)).toBe(
      true,
    );

    const created = await app.inject({
      method: "POST",
      url: endpoint,
      headers,
      payload: { includeKeywords: ["赛事"] },
    });
    expect(created.statusCode).toBe(201);
    expect(updates.at(-1)).toEqual({ schedule: true, keyword: true });
    const list = await app.inject({ url: "/api/v1/rooms", headers });
    expect(list.json().rooms[0].enabledPlans).toEqual({
      schedule: true,
      keyword: true,
    });

    const remove = (url: string) =>
      app.inject({ method: "DELETE", url, headers });
    expect((await remove(`${schedules}/${first}`)).statusCode).toBe(204);
    expect(updates.at(-1)).toEqual({ schedule: true, keyword: true });
    const setScheduleEnabled = (id: string, enabled: boolean) =>
      app.inject({
        method: "PATCH",
        url: `${schedules}/${id}`,
        headers,
        payload: { enabled },
      });
    expect((await setScheduleEnabled(second, false)).statusCode).toBe(200);
    expect(updates.at(-1)).toEqual({ schedule: false, keyword: true });
    expect((await setScheduleEnabled(disabled, true)).statusCode).toBe(200);
    expect(updates.at(-1)).toEqual({ schedule: true, keyword: true });
    expect(
      (await remove(`${endpoint}/${created.json().plan.id}`)).statusCode,
    ).toBe(204);
    expect(updates.at(-1)).toEqual({ schedule: true, keyword: false });
  } finally {
    unsubscribe();
  }
});

it("starts on a mid-stream title change and respects a manual stop until the next broadcast", async () => {
  const { services, room, clock } = setup();
  const { keywordPlans, scheduler, manager, recordings } = services;
  keywordPlans.create(room.id, {
    enabled: true,
    includeKeywords: ["GAME"],
    excludeKeywords: ["重播"],
  });
  keywordPlans.create(room.id, {
    enabled: true,
    includeKeywords: ["决赛"],
    excludeKeywords: [],
  });
  const platform = vi.spyOn(services.adapterFor("bilibili"), "checkLiveStatus");
  const start = vi.spyOn(manager, "maybeStartRecording");
  const check = async (status: LiveStatusResult) => {
    platform.mockResolvedValue(status);
    await scheduler.triggerImmediateCheck(room.id);
  };
  await check({
    status: "live",
    streamTitle: "GAME 重播",
    streamSessionId: "first",
  });
  expect(start).not.toHaveBeenCalled();
  await check({
    status: "live",
    streamTitle: "Game 决赛",
    streamSessionId: "first",
  });
  expect(start).toHaveBeenCalledTimes(1);
  expect(manager.isRoomActive(room.id)).toBe(true);
  expect(recordings.list({ roomId: room.id }).items[0]?.origin).toBe(
    "automatic",
  );
  await check({
    status: "live",
    streamTitle: "闲聊",
    streamSessionId: "first",
  });
  expect(manager.isRoomActive(room.id)).toBe(true);
  await manager.stopRecording(room.id);
  await check({
    status: "live",
    streamTitle: "Game 决赛",
    streamSessionId: "first-reconnected",
  });
  expect(start).toHaveBeenCalledTimes(1);
  clock.advance(5_000);
  await check({ status: "offline" });
  await check({
    status: "live",
    streamTitle: "Game 决赛",
    streamSessionId: "second",
  });
  expect(start).toHaveBeenCalledTimes(2);
  expect(manager.isRoomActive(room.id)).toBe(true);
  expect(platform).toHaveBeenCalledTimes(6);
});

it("skips placeholder titles, disabled rooms and name-only checks", async () => {
  const { services, room } = setup();
  services.keywordPlans.create(room.id, {
    enabled: true,
    includeKeywords: [],
    excludeKeywords: ["重播"],
  });
  const start = vi
    .spyOn(services.manager, "maybeStartRecording")
    .mockResolvedValue(true);
  const platform = vi.spyOn(services.adapterFor("bilibili"), "checkLiveStatus");
  platform.mockResolvedValue({ status: "live" });
  await services.scheduler.triggerImmediateCheck(room.id);
  platform.mockResolvedValue({
    status: "live",
    streamTitle: "占位",
    streamTitleIsPlaceholder: true,
  });
  await services.scheduler.triggerImmediateCheck(room.id);
  platform.mockResolvedValue({ status: "live", streamTitle: "正常标题" });
  await services.scheduler.triggerImmediateCheck(room.id, { nameOnly: true });
  services.rooms.update(room.id, { enabled: false });
  await services.scheduler.triggerImmediateCheck(room.id);
  expect(start).not.toHaveBeenCalled();
  services.rooms.update(room.id, { enabled: true, autoRecord: true });
  const match = vi.spyOn(services.keywordPlans, "matches");
  await services.scheduler.triggerImmediateCheck(room.id);
  expect(match).not.toHaveBeenCalled();
  expect(start).toHaveBeenCalledTimes(1);
});
