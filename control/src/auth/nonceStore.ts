// Replay prevention: a token's jti may be presented at most once. Seen jtis are remembered until
// their token would have expired, then evicted (bounded memory). `seen(jti, expSec)` returns
// true if this jti was already used — the auth layer rejects on true.

import type { Clock } from "../ports.js";

export class NonceStore {
  private seenUntil = new Map<string, number>(); // jti -> unix seconds when it can be forgotten

  constructor(private clock: Clock, private maxEntries = 100_000) {}

  // Records the jti and returns whether it was ALREADY present (i.e. a replay).
  checkAndRecord(jti: string, expSec: number): boolean {
    this.evict();
    if (this.seenUntil.has(jti)) return true;
    if (this.seenUntil.size >= this.maxEntries) return true; // fail closed if flooded
    this.seenUntil.set(jti, expSec);
    return false;
  }

  private evict(): void {
    const nowSec = Math.floor(this.clock.now() / 1000);
    for (const [jti, until] of this.seenUntil) {
      if (until <= nowSec) this.seenUntil.delete(jti);
    }
  }

  get size(): number {
    return this.seenUntil.size;
  }
}
