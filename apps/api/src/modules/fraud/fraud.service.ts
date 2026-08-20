import type { PrismaClient } from "@prisma/client";

/** Append-only fraud_events feed → admin anomaly queue (DC-8.5, FR-41b). */
export class FraudService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(
    kind: string,
    opts: { userId?: string; deviceHash?: string; detail: Record<string, unknown> }
  ): Promise<void> {
    await this.prisma.fraudEvent.create({
      data: {
        kind,
        userId: opts.userId ?? null,
        deviceHash: opts.deviceHash ?? null,
        detail: opts.detail as object
      }
    });
  }

  async queue(status: "open" | "cleared" | "actioned" = "open") {
    return this.prisma.fraudEvent.findMany({
      where: { reviewStatus: status },
      orderBy: { createdAt: "desc" },
      take: 100
    });
  }

  async review(id: string, status: "cleared" | "actioned") {
    return this.prisma.fraudEvent.update({ where: { id }, data: { reviewStatus: status } });
  }
}
