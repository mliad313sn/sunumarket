import type { FastifyReply, FastifyRequest } from "fastify";
import type { AccessPayload } from "./auth.service.js";

export type Role = "buyer" | "seller" | "rider" | "partner" | "admin";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AccessPayload;
    user: AccessPayload;
  }
}

/**
 * RBAC guard — 5 roles (FR-1..3). Admin passes every check; everyone else needs
 * one of the listed roles. Rider/partner data isolation is enforced in queries
 * (ownership filters), this guard covers route access.
 */
export function requireRoles(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ code: "unauthorized", message: "connexion requise" });
    }
    if (roles.length === 0) return;
    const have = req.user.roles;
    if (have.includes("admin")) return;
    if (!roles.some((r) => have.includes(r))) {
      return reply.code(403).send({ code: "forbidden", message: "accès refusé" });
    }
  };
}
