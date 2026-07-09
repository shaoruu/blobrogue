// Spectate target selection for a downed player: pure functions over the remote roster so
// the camera hand-off, cycling order, and revive transition are headless-testable. The Game
// holds only the current target id and calls these each tick / on a cycle input; any input
// source (keyboard Q/E, arrows, a future controller's bumpers) drives the same cycle call.

export interface SpectateCandidate {
  playerId: string;
  isDown: boolean;
}

// The living teammates, in a stable deterministic order (by id) so every client — and every
// cycle press — walks the same ring regardless of snapshot array order.
export function livingTeammates<T extends SpectateCandidate>(remotes: readonly T[]): T[] {
  return remotes.filter((r) => !r.isDown).sort((a, b) => (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0));
}

// The target to follow this tick: keep the current one while it still lives, otherwise the
// first living teammate, otherwise null (nobody left to watch — the run is ending).
export function resolveSpectateTarget(currentId: string | null, remotes: readonly SpectateCandidate[]): string | null {
  const living = livingTeammates(remotes);
  if (living.length === 0) return null;
  if (currentId !== null && living.some((r) => r.playerId === currentId)) return currentId;
  return living[0].playerId;
}

// Step the target through the living ring by dir (+1 next / -1 previous), wrapping. A stale
// or absent current target resolves to the ring's first entry before stepping is meaningful.
export function cycleSpectateTarget(currentId: string | null, remotes: readonly SpectateCandidate[], dir: 1 | -1): string | null {
  const living = livingTeammates(remotes);
  if (living.length === 0) return null;
  const at = currentId !== null ? living.findIndex((r) => r.playerId === currentId) : -1;
  if (at < 0) return living[0].playerId;
  return living[(at + dir + living.length) % living.length].playerId;
}
