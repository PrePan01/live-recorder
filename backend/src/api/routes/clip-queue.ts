import type { FastifyInstance } from "fastify";
import type { Services } from "../../core/services.js";
import { AppError } from "../../types/error.js";

export function registerClipQueueRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  app.get("/api/v1/clip-queue", async (req, reply) => {
    const { recordingId, page: rawPage } = req.query as {
      recordingId?: string;
      page?: string;
    };
    const page = Number(rawPage ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > 100000)
      throw new AppError("CONFIG_INVALID", "页码非法", {});
    return reply.send(services.clipQueue.page(recordingId, page));
  });
  app.post("/api/v1/clip-queue/export-all", async (req, reply) => {
    const body = req.body as {
      recordingId?: unknown;
      markerIds?: unknown;
      requestId?: unknown;
    } | null;
    if (
      !body ||
      typeof body.recordingId !== "string" ||
      !body.recordingId ||
      typeof body.requestId !== "string" ||
      !body.requestId ||
      body.requestId.length > 128 ||
      !Array.isArray(body.markerIds) ||
      body.markerIds.length === 0 ||
      body.markerIds.length > 500 ||
      !body.markerIds.every((id) => typeof id === "string") ||
      new Set(body.markerIds).size !== body.markerIds.length
    )
      throw new AppError("CONFIG_INVALID", "请选择当前录像的片段并提交", {});
    const batchId = await services.clipQueueManager.submit(
      body.recordingId,
      body.markerIds as string[],
      body.requestId,
    );
    return reply
      .status(201)
      .send({
        batchId,
        items: services.clipQueue.list(body.recordingId, batchId),
      });
  });
  app.post("/api/v1/clip-queue/export-range", async (req, reply) => {
    const body = req.body as { recordingId?: unknown; startSecond?: unknown; endSecond?: unknown; name?: unknown; requestId?: unknown } | null;
    if (!body || typeof body.recordingId !== "string" || !body.recordingId ||
      typeof body.requestId !== "string" || !body.requestId || body.requestId.length > 128 ||
      typeof body.startSecond !== "number" || typeof body.endSecond !== "number" || typeof body.name !== "string")
      throw new AppError("CONFIG_INVALID", "请选择有效选区并命名", {});
    const batchId = await services.clipQueueManager.submitRange(
      body.recordingId, body.startSecond, body.endSecond, body.name, body.requestId,
    );
    return reply.status(201).send({ batchId, items: services.clipQueue.list(body.recordingId, batchId) });
  });
  for (const action of ["cancel", "retry"] as const)
    app.post(`/api/v1/clip-queue/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!services.clipQueue.get(id))
        throw new AppError("RESOURCE_NOT_FOUND", "导出任务不存在", {});
      services.clipQueueManager[action](id);
      return reply.send({ item: services.clipQueue.get(id) });
    });
  app.post("/api/v1/clip-queue/cancel-pending", async (req, reply) => {
    const body = req.body as { batchId?: unknown } | null;
    if (!body || typeof body.batchId !== "string" || !body.batchId)
      throw new AppError("CONFIG_INVALID", "请选择要取消的批次", {});
    services.clipQueueManager.cancelPending(body.batchId);
    return reply.status(204).send();
  });
}
