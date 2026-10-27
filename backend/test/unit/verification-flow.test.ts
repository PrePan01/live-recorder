import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServices, type Services } from "../../src/core/services.js";
import { DEFAULT_SETTINGS } from "../../src/config/defaults.js";
import type { IntegrityCheckDetail } from "../../src/recorder/integrity.js";

const check = vi.hoisted(() => vi.fn());
vi.mock("../../src/recorder/integrity.js", async (original) => ({
  ...(await original<typeof import("../../src/recorder/integrity.js")>()),
  checkFileIntegrityDetailed: check,
}));

let services: Services;
let root: string;
beforeEach(async () => {
  check.mockReset();
  root = await mkdtemp(path.join(tmpdir(), "lr-verify-flow-"));
  services = buildServices({ dbPath: path.join(root, "fixture.db") });
  const settings =
    services.settings.load() ?? structuredClone(DEFAULT_SETTINGS);
  services.settings.save({
    ...settings,
    pipeline: {
      ...services.pipeline.pipelineConfig(),
      enabled: true,
      verify: true,
      exportCover: false,
    },
  });
  vi.spyOn(services.uploader, "enqueue").mockResolvedValue(null);
});
afterEach(async () => {
  await vi.waitFor(() => expect(services.pipeline.busy).toBe(false), {
    timeout: 5000,
  });
  services.db.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function fixture(name = "video") {
  const room = services.rooms.create({
    platform: "bilibili",
    url: `https://live.bilibili.com/${name}`,
    displayName: name,
  });
  const rec = services.recordings.create({
    roomId: room.id,
    roomName: name,
    platform: "bilibili",
    streamSessionId: null,
    streamTitle: name,
  });
  const file = path.join(root, `${name}.flv`);
  await writeFile(file, "dummy");
  return services.recordings.update(rec.id, {
    state: "completed",
    filePath: file,
  });
}
function deferred() {
  let resolve!: (result: IntegrityCheckDetail) => void;
  const promise = new Promise<IntegrityCheckDetail>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function finished(id: string) {
  await vi.waitFor(
    () =>
      expect(["ok", "partial", "failed"]).toContain(
        services.pipeline.repo.runForRecording(id)?.status,
      ),
    { timeout: 5000 },
  );
}

describe("shared recording verification", () => {
  it("completion and pipeline share one probe, synchronize legacy and detailed results", async () => {
    const rec = await fixture();
    services.recordings.update(rec.id, {
      integrity: "failed",
      integrityState: "failed",
      integrityError: "old error",
    });
    const pending = deferred();
    check.mockReturnValue(pending.promise);
    expect(services.verificationQueue.enqueue(rec)).toBe(true);
    services.pipeline.enqueue(rec.id, 0, true);
    expect(check).toHaveBeenCalledTimes(1);
    pending.resolve({ outcome: "ok", detail: "" });
    await finished(rec.id);
    expect(check).toHaveBeenCalledTimes(1);
    expect(services.recordings.get(rec.id)).toMatchObject({
      integrity: "verified",
      integrityState: "ok",
    });
    expect(services.recordings.get(rec.id)?.integrityError).toBeUndefined();
  });

  it("unavailable checks continue processing as partial and are rechecked on resume", async () => {
    const rec = await fixture();
    check.mockResolvedValueOnce({
      outcome: "unverifiable",
      detail: "校验超时",
    });
    services.pipeline.enqueue(rec.id, 0, true);
    await finished(rec.id);
    const run = services.pipeline.repo.runForRecording(rec.id)!;
    expect(run.status).toBe("partial");
    expect(run.artifacts.find((art) => art.step === "verify")).toMatchObject({
      status: "failed",
      error: "校验超时",
    });
    expect(services.recordings.get(rec.id)).toMatchObject({
      integrity: "pending",
      integrityState: "unverifiable",
    });
    check.mockResolvedValueOnce({ outcome: "ok", detail: "" });
    expect(await services.pipeline.resumeRunById(run.id)).toBe(true);
    await finished(rec.id);
    expect(check).toHaveBeenCalledTimes(2);
    expect(
      services.pipeline.repo
        .getRun(run.id)
        ?.artifacts.find((art) => art.step === "verify")?.status,
    ).toBe("ok");
    expect(services.recordings.get(rec.id)).toMatchObject({
      integrity: "verified",
      integrityState: "ok",
    });
  });

  it("corruption stops the pipeline and writes both failure fields", async () => {
    const rec = await fixture();
    check.mockResolvedValue({ outcome: "failed", detail: "文件损坏或截断" });
    services.pipeline.enqueue(rec.id, 0, true);
    await finished(rec.id);
    expect(services.pipeline.repo.runForRecording(rec.id)?.status).toBe(
      "failed",
    );
    expect(services.recordings.get(rec.id)).toMatchObject({
      integrity: "failed",
      integrityState: "failed",
      integrityError: "文件损坏或截断",
    });
  });

  it("never lets a delayed source result overwrite a replacement file result", async () => {
    const rec = await fixture();
    const pending = deferred();
    check.mockReturnValue(pending.promise);
    const result = services.verificationQueue.verify(rec);
    const replacement = path.join(root, "replacement.mp4");
    await writeFile(replacement, "replacement");
    services.recordings.update(rec.id, {
      filePath: replacement,
      integrity: "verified",
      integrityState: "ok",
    });
    pending.resolve({ outcome: "failed", detail: "old file failed" });
    expect(await result).toMatchObject({ outcome: "unverifiable" });
    expect(services.recordings.get(rec.id)).toMatchObject({
      filePath: replacement,
      integrity: "verified",
      integrityState: "ok",
    });
  });

  it("limits probes to two and deduplicates pipeline waits without preventing manual rechecks", async () => {
    const recs = await Promise.all(["one", "two", "three"].map(fixture));
    const pending = recs.map(() => deferred());
    let index = 0;
    check.mockImplementation(() => pending[index++]!.promise);
    const jobs = recs.map((rec) => services.verificationQueue.verify(rec));
    const duplicate = services.verificationQueue.verify(recs[0]!);
    expect(check).toHaveBeenCalledTimes(2);
    pending[0]!.resolve({ outcome: "ok", detail: "" });
    await jobs[0];
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(3));
    pending[1]!.resolve({ outcome: "ok", detail: "" });
    pending[2]!.resolve({ outcome: "ok", detail: "" });
    await Promise.all([...jobs, duplicate]);
    await services.verificationQueue.verify(recs[0]!);
    expect(check).toHaveBeenCalledTimes(3);
    check.mockResolvedValue({ outcome: "ok", detail: "" });
    expect(services.verificationQueue.enqueue(recs[0]!)).toBe(true);
    await services.verificationQueue.verify(recs[0]!);
    expect(check).toHaveBeenCalledTimes(4);
  });

  it("invalidates a result if the same file changes during its check", async () => {
    const rec = await fixture();
    const pending = deferred();
    check.mockReturnValue(pending.promise);
    const result = services.verificationQueue.verify(rec);
    await writeFile(rec.filePath!, "different bytes");
    pending.resolve({ outcome: "ok", detail: "" });
    expect(await result).toMatchObject({ outcome: "unverifiable" });
    expect(services.recordings.get(rec.id)).toMatchObject({
      integrity: "pending",
      integrityState: "unverifiable",
    });
  });
});
