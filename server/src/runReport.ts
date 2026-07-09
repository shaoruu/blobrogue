// Authoritative run-result reporting: when a player's run ends on THIS server (death or
// disconnect), the server — never the client — builds the result from its own simulation
// state and POSTs it to the Convex inbox (convex/http.ts /gs/run-result), signed with
// HMAC-SHA256 over the exact body bytes using the SAME GS_AUTH_SECRET that already backs
// join tickets. Convex re-validates and clamps every field (convex/statsCore.ts), so this
// payload asserts, Convex decides. Fire-and-forget with bounded retries: stats must never
// stall the tick loop, and a duplicate retry is settled idempotently by submissionId.

import { randomUUID } from "node:crypto";
import { signRunBody } from "../../convex/gsSignCore.js";
import type { WorldState, PlayerSim } from "../../src/sim/world.js";
import type { Logger } from "./logger.js";

export type RunReportResult = "death" | "victory" | "abandon";

// Mirrors the ServerSubmission envelope statsCore parses (v1). Field order is irrelevant —
// the signature covers whatever bytes we send.
export interface RunReportPayload {
  v: 1;
  submissionId: string;
  playerId: string;
  worldId: string;
  sentAt: number;
  mode: "online";
  difficulty: "casual" | "standard" | "brutal";
  result: RunReportResult;
  floor: number;
  startFloor: number;
  kills: number;
  coins: number;
  coinsEarned: number;
  coinsSpent: number;
  durationMs: number;
  damageDealt: number;
  damageTaken: number;
  bestCombo: number;
  bossKills: number;
  bossKillFloors: number[];
  firstBossKillMs: number | null;
  killsByWeapon: Record<string, number>;
  weapons: string[];
  blessings: string[];
  deathCause: string | null;
}

// Build the payload from the server's own sim state. `authPlayerId` is the VERIFIED ticket
// identity (a Convex players-row id, or "guest:<clientId>") — the world-scoped "p<connId>"
// never leaves the server. Difficulty is the standard default until the authoritative
// difficulty feature lands on WorldState; then it threads through here.
export function buildRunReport(
  world: WorldState,
  p: PlayerSim,
  authPlayerId: string,
  worldId: string,
  result: RunReportResult,
  nowMs: number,
): RunReportPayload {
  const rs = p.runStats;
  return {
    v: 1,
    submissionId: randomUUID(),
    playerId: authPlayerId,
    worldId,
    sentAt: nowMs,
    mode: "online",
    difficulty: "standard",
    result,
    floor: world.floor,
    startFloor: rs.startFloor,
    kills: p.kills,
    coins: p.coins,
    coinsEarned: rs.coinsEarned,
    coinsSpent: rs.coinsSpent,
    durationMs: Math.round(rs.timeAliveSecs * 1000),
    damageDealt: Math.round(rs.damageDealt),
    damageTaken: Math.round(rs.damageTaken),
    bestCombo: rs.bestCombo,
    bossKills: rs.bossKills,
    bossKillFloors: rs.bossKillFloors.slice(),
    firstBossKillMs: rs.firstBossKillSecs >= 0 ? Math.round(rs.firstBossKillSecs * 1000) : null,
    killsByWeapon: Object.fromEntries(Object.entries(rs.killsByWeapon).map(([k, n]) => [k, n ?? 0])),
    weapons: p.ownedWeapons.slice(),
    blessings: p.ownedItemIds.slice(),
    deathCause: rs.deathCause,
  };
}

// A connection blip seconds after joining is noise, not a run: skip abandons with nothing
// to their name. Deaths always report.
export function isReportWorthy(payload: RunReportPayload): boolean {
  if (payload.result !== "abandon") return true;
  return payload.durationMs >= 15000 || payload.kills > 0 || payload.floor > payload.startFloor;
}

export interface RunReporterOpts {
  url: string | null;    // GS_RUN_RESULTS_URL; null disables reporting entirely
  secret: string | null; // GS_AUTH_SECRET (shared with the ticket mint)
  log: Logger;
  fetchFn?: typeof fetch;
  maxAttempts?: number;
  backoffMs?: number;    // base backoff, doubled per retry
  onSettled?: (isOk: boolean) => void; // metrics hook
}

export class RunReporter {
  private url: string | null;
  private secret: string | null;
  private log: Logger;
  private fetchFn: typeof fetch;
  private maxAttempts: number;
  private backoffMs: number;
  private onSettled: (isOk: boolean) => void;
  // In-flight tracking so tests (and a graceful shutdown) can await the queue draining.
  private inflight = new Set<Promise<boolean>>();

  constructor(opts: RunReporterOpts) {
    this.url = opts.url;
    this.secret = opts.secret;
    this.log = opts.log;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.backoffMs = opts.backoffMs ?? 1000;
    this.onSettled = opts.onSettled ?? (() => {});
    if (this.url !== null && this.secret === null) {
      this.log.warn("run reporting configured without GS_AUTH_SECRET — disabled");
    }
  }

  get isEnabled(): boolean {
    return this.url !== null && this.secret !== null;
  }

  // Fire-and-forget: never throws, never blocks the caller. Retries transient failures
  // (network / 5xx) with exponential backoff; 4xx responses are terminal (a rejected
  // payload will never become acceptable by resending the same bytes).
  submit(payload: RunReportPayload): void {
    if (!this.isEnabled) return;
    const task = this.deliver(payload)
      .catch((err) => {
        this.log.error("run report crashed", { err: String(err) });
        return false;
      })
      .then((isOk) => {
        this.onSettled(isOk);
        this.inflight.delete(task);
        return isOk;
      });
    this.inflight.add(task);
  }

  async drain(): Promise<void> {
    await Promise.all([...this.inflight]);
  }

  private async deliver(payload: RunReportPayload): Promise<boolean> {
    const body = JSON.stringify(payload);
    const signature = await signRunBody(this.secret!, body);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await this.fetchFn(this.url!, {
          method: "POST",
          headers: { "content-type": "application/json", "x-gs-signature": signature },
          body,
        });
        if (res.ok) {
          this.log.info("run reported", { playerId: payload.playerId, result: payload.result, floor: payload.floor });
          return true;
        }
        const text = await res.text().catch(() => "");
        if (res.status >= 400 && res.status < 500) {
          this.log.warn("run report rejected", { status: res.status, response: text.slice(0, 200) });
          return false;
        }
        this.log.warn("run report failed", { status: res.status, attempt });
      } catch (err) {
        this.log.warn("run report network error", { err: String(err), attempt });
      }
      if (attempt < this.maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, this.backoffMs * 2 ** (attempt - 1)));
      }
    }
    return false;
  }
}
