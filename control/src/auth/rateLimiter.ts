// Token-bucket rate limiter keyed by (actor, remote). Cheap, allocation-light, and evaluated
// BEFORE any deploy work so a flood has no side effects. Over-limit -> the caller returns 429.

import type { Clock } from "../ports.js";

interface Bucket {
  tokens: number;
  updatedMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private clock: Clock, private capacity: number, private refillPerSec: number, private maxKeys = 50_000) {}

  // Returns true if the request is allowed (and consumes a token), false if over the limit.
  allow(key: string): boolean {
    const now = this.clock.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.buckets.clear(); // coarse flood guard
      b = { tokens: this.capacity, updatedMs: now };
      this.buckets.set(key, b);
    } else {
      const elapsedSec = (now - b.updatedMs) / 1000;
      b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
      b.updatedMs = now;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
