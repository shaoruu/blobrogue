// Small deterministic PRNG. Same seed -> same sequence, which is what lets every
// player in a co-op room generate an identical dungeon and enemy layout.

export class Rng {
  private state: number;

  constructor(seed: number) {
    // Keep the seed in a stable 32-bit range so it round-trips through Convex.
    this.state = seed | 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}

export function randomSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) | 0);
}
