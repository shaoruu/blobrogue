import type { Logger } from "./logger.js";
import { mintRunCompletionReceipt } from "./runReceipt.js";
import type { RunCompletionPayload } from "../../src/net/runReceipt.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Fetcher = typeof fetch;

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

interface OutboxEntry {
  receipt: string;
  payload: RunCompletionPayload;
  failedAt?: number;
}

const DEAD_LETTER_RETENTION_MS = 30 * 24 * 60 * 60_000;

export class RunReceiptDispatcher {
  private pending = new Set<Promise<void>>();
  private pendingJtis = new Set<string>();
  private outbox = new Map<string, OutboxEntry>();

  constructor(
    private endpoint: string | null,
    private secret: string | null,
    private log: Logger,
    private fetcher: Fetcher = fetch,
    private outboxPath: string | null = null,
  ) {
    this.loadOutbox();
    if (this.endpoint) {
      for (const entry of this.outbox.values()) {
        if (entry.failedAt === undefined && entry.payload.expiresAt > Date.now()) {
          this.startDelivery(entry);
        }
      }
    }
  }

  submit(payload: RunCompletionPayload): void {
    if (!this.endpoint || !this.secret) {
      this.log.warn("run receipt not dispatched: endpoint or secret unavailable", {
        worldId: payload.worldId,
        generation: payload.generation,
      });
      return;
    }
    const receipt = mintRunCompletionReceipt(this.secret, payload);
    const entry = { receipt, payload };
    this.outbox.set(payload.jti, entry);
    this.persistOutbox();
    this.startDelivery(entry);
  }

  hasDeliverableWorld(worldId: string, nowMs = Date.now()): boolean {
    return [...this.outbox.values()].some((entry) => (
      entry.payload.worldId === worldId
      && entry.failedAt === undefined
      && entry.payload.expiresAt > nowMs
    ));
  }

  private startDelivery(entry: OutboxEntry): void {
    if (this.pendingJtis.has(entry.payload.jti)) return;
    const task = this.deliver(entry);
    this.pendingJtis.add(entry.payload.jti);
    this.pending.add(task);
    void task.finally(() => {
      this.pending.delete(task);
      this.pendingJtis.delete(entry.payload.jti);
    });
  }

  private async deliver(entry: OutboxEntry): Promise<void> {
    const { receipt, payload } = entry;
    let attempt = 0;
    while (Date.now() < payload.expiresAt) {
      const delayMs = attempt === 0 ? 0 : Math.min(30_000, 250 * (2 ** Math.min(attempt - 1, 8)));
      await wait(delayMs);
      attempt++;
      if (Date.now() >= payload.expiresAt) break;
      try {
        const response = await this.fetcher(this.endpoint!, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ receipt }),
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok || response.status === 409) {
          this.outbox.delete(payload.jti);
          this.persistOutbox();
          this.log.info("run receipt delivered", {
            worldId: payload.worldId,
            generation: payload.generation,
            status: payload.status,
          });
          return;
        }
        if (response.status === 400 || response.status === 401) {
          this.fail(entry);
          return;
        }
      } catch {
      }
    }
    this.fail(entry);
  }

  private fail(entry: OutboxEntry): void {
    entry.failedAt = Date.now();
    this.outbox.set(entry.payload.jti, entry);
    this.persistOutbox();
    this.log.error("run receipt delivery exhausted", {
      worldId: entry.payload.worldId,
      generation: entry.payload.generation,
      status: entry.payload.status,
    });
  }

  async flush(timeoutMs = 3000): Promise<void> {
    if (this.pending.size === 0) return;
    await Promise.race([
      Promise.all([...this.pending]).then(() => undefined),
      wait(timeoutMs),
    ]);
  }

  private loadOutbox(): void {
    if (!this.outboxPath) return;
    try {
      const entries = JSON.parse(readFileSync(this.outboxPath, "utf8")) as OutboxEntry[];
      const now = Date.now();
      for (const entry of entries) {
        if (entry.failedAt !== undefined && entry.failedAt + DEAD_LETTER_RETENTION_MS <= now) continue;
        if (entry.failedAt === undefined && entry.payload.expiresAt <= now) entry.failedAt = now;
        this.outbox.set(entry.payload.jti, entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("run receipt outbox is malformed");
      }
    }
  }

  private persistOutbox(): void {
    if (!this.outboxPath) return;
    const now = Date.now();
    for (const [jti, entry] of this.outbox) {
      if (entry.failedAt !== undefined && entry.failedAt + DEAD_LETTER_RETENTION_MS <= now) {
        this.outbox.delete(jti);
      }
    }
    mkdirSync(dirname(this.outboxPath), { recursive: true });
    const temporary = `${this.outboxPath}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.outbox.values()]), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, this.outboxPath);
  }
}
