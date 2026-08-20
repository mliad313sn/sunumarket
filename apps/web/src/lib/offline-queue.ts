/**
 * Offline queue (FR-45 / DC-15): order+pin captures made offline are stored
 * locally and flushed idempotently when connectivity returns. Server-side
 * idempotency keys make replays safe (ADR-0012).
 */
export interface QueuedRequest {
  id: string;
  url: string;
  method: "POST";
  body: unknown;
  queued_at: string;
}

type Store = Pick<Storage, "getItem" | "setItem">;

const KEY = "sunu_offline_queue";

export class OfflineQueue {
  constructor(
    private readonly store: Store,
    private readonly send: (req: QueuedRequest) => Promise<boolean>
  ) {}

  private read(): QueuedRequest[] {
    try {
      return JSON.parse(this.store.getItem(KEY) ?? "[]") as QueuedRequest[];
    } catch {
      return [];
    }
  }

  private write(items: QueuedRequest[]): void {
    this.store.setItem(KEY, JSON.stringify(items));
  }

  enqueue(url: string, body: unknown): QueuedRequest {
    const req: QueuedRequest = {
      id: crypto.randomUUID(),
      url,
      method: "POST",
      body,
      queued_at: new Date().toISOString()
    };
    this.write([...this.read(), req]);
    return req;
  }

  size(): number {
    return this.read().length;
  }

  /**
   * Flush in order; stop at the first still-failing request (retry later).
   * Successful sends are removed exactly once — flushing twice cannot resend
   * (queue is drained per item on success).
   */
  async flush(): Promise<{ sent: number; remaining: number }> {
    let sent = 0;
    let items = this.read();
    while (items.length > 0) {
      const head = items[0]!;
      const ok = await this.send(head).catch(() => false);
      if (!ok) break;
      items = items.slice(1);
      this.write(items);
      sent++;
    }
    return { sent, remaining: items.length };
  }
}
