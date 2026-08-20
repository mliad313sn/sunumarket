import type { PrismaClient } from "@prisma/client";

/**
 * MessagingProvider — mock-first (Playbook 0.5). Real SMS gateways are
 * config-selected adapters; DC-15 SMS notification fallback rides on this too.
 */
export interface SmsMessage {
  phone: string;
  body: string;
  senderId: string;
}

export interface MessagingProvider {
  sendSms(msg: SmsMessage): Promise<void>;
}

export class MockMessagingProvider implements MessagingProvider {
  readonly sent: SmsMessage[] = [];

  async sendSms(msg: SmsMessage): Promise<void> {
    this.sent.push(msg);
  }

  lastTo(phone: string): SmsMessage | undefined {
    return [...this.sent].reverse().find((m) => m.phone === phone);
  }
}

/**
 * DC-15 / committee finding B: every notification SMS is persisted to the
 * sms_outbox table (auditable, retry-able by the worker) before delegating to
 * the actual gateway (mock or real). Delivery failures leave the row `queued`
 * for the worker's retry sweep instead of losing the notification.
 */
export class OutboxMessagingProvider implements MessagingProvider {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly inner: MessagingProvider
  ) {}

  async sendSms(msg: SmsMessage): Promise<void> {
    const row = await this.prisma.smsOutbox.create({
      data: { phone: msg.phone, body: msg.body, senderId: msg.senderId, status: "queued" }
    });
    try {
      await this.inner.sendSms(msg);
      await this.prisma.smsOutbox.update({
        where: { id: row.id },
        data: { status: "sent", sentAt: new Date() }
      });
    } catch {
      // stays queued — the worker retry sweep picks it up
    }
  }

  /** Worker sweep: retry queued rows through the gateway. */
  async flushQueued(limit = 100): Promise<number> {
    const queued = await this.prisma.smsOutbox.findMany({
      where: { status: "queued" },
      orderBy: { createdAt: "asc" },
      take: limit
    });
    let sent = 0;
    for (const row of queued) {
      try {
        await this.inner.sendSms({ phone: row.phone, body: row.body, senderId: row.senderId });
        await this.prisma.smsOutbox.update({
          where: { id: row.id },
          data: { status: "sent", sentAt: new Date() }
        });
        sent++;
      } catch {
        break; // gateway still down — retry next sweep
      }
    }
    return sent;
  }
}
