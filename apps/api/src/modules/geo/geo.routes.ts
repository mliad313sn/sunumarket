import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../../deps.js";
import { requireRoles } from "../auth/rbac.js";

const createPointBody = z.object({
  pin: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    landmark: z.string().min(3).max(200)
  }),
  label: z.string().max(60).optional(),
  consent: z.literal(true)
});

const quoteBody = z.object({
  shop_id: z.string().uuid(),
  pin: z.object({ lat: z.number(), lng: z.number() })
});

export function registerGeoRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { geo } = deps;

  app.post("/delivery-points", { preHandler: requireRoles() }, async (req, reply) => {
    const body = createPointBody.parse(req.body);
    const { id } = await geo.createDeliveryPoint(req.user.sub, {
      pin: body.pin,
      ...(body.label !== undefined ? { label: body.label } : {})
    });
    return reply.code(201).send({ id });
  });

  app.get("/delivery-points", { preHandler: requireRoles() }, async (req) => {
    return geo.listSavedPoints(req.user.sub);
  });

  app.post("/fees/quote", async (req, reply) => {
    const body = quoteBody.parse(req.body);
    const r = await geo.quoteFee(body.shop_id, body.pin);
    return reply.send({
      fee: r.fee ? { amount_minor: r.fee.amountMinor.toString(), currency: r.fee.currency } : null,
      zone_name: r.zone,
      resolution: r.resolution,
      deliverable: r.deliverable
    });
  });

  app.get("/nav-links", async (req) => {
    const q = z.object({ lat: z.coerce.number(), lng: z.coerce.number() }).parse(req.query);
    return deps.geo.navLinks({ lat: q.lat, lng: q.lng });
  });
}
