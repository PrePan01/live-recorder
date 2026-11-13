import type { FastifyInstance } from "fastify";
import { validateKeywordPlan } from "../../core/keyword-plan.js";
import type { Services } from "../../core/services.js";
import { AppError } from "../../types/index.js";

export function registerKeywordPlanRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  const { rooms, keywordPlans } = services;
  const path = "/api/v1/rooms/:id/keyword-plans";
  const requireRoom = (id: string) => {
    if (!rooms.get(id)) {
      throw new AppError("RESOURCE_NOT_FOUND", "房间不存在", {
        roomId: id,
        details: { resource: "room" },
      });
    }
  };
  const missingPlan = () =>
    new AppError("RESOURCE_NOT_FOUND", "计划不存在", {
      details: { resource: "keywordPlan" },
    });

  app.get<{ Params: { id: string } }>(path, (req) => {
    requireRoom(req.params.id);
    return { plans: keywordPlans.listForRoom(req.params.id) };
  });

  app.post<{ Params: { id: string } }>(path, (req, reply) => {
    requireRoom(req.params.id);
    const plan = keywordPlans.create(
      req.params.id,
      validateKeywordPlan(req.body),
    );
    services.manager.emitRoomUpdate(req.params.id);
    return reply.code(201).send({ plan });
  });

  app.patch<{ Params: { id: string; planId: string } }>(
    `${path}/:planId`,
    (req) => {
      const { id, planId } = req.params;
      requireRoom(id);
      const existing = keywordPlans.get(id, planId);
      if (!existing) throw missingPlan();
      const plan = keywordPlans.update(existing, validateKeywordPlan(req.body, existing));
      services.manager.emitRoomUpdate(id);
      return { plan };
    },
  );

  app.delete<{ Params: { id: string; planId: string } }>(
    `${path}/:planId`,
    (req, reply) => {
      const { id, planId } = req.params;
      requireRoom(id);
      if (!keywordPlans.remove(id, planId)) throw missingPlan();
      services.manager.emitRoomUpdate(id);
      return reply.code(204).send();
    },
  );
}
