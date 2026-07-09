// Spectate target selection for a downed player: pure functions over the remote roster so
// the camera hand-off, cycling order, and revive transition are headless-testable. The Game
// holds only the current target id and calls these each tick / on a cycle input; any input
// source (keyboard Q/E, arrows, a future controller's bumpers) drives the same cycle call.
//
// Reconnect awareness CONSUMES the Sev-0 coherence system's roster status (PR #39:
// `RemotePlayer.isAbsent` — a body reserved for the reconnect grace). The field is optional
// here so this module reads it the moment it exists on the wire without owning any reconnect
// implementation; until then every teammate reads as present. A reconnecting teammate is
// neither dead nor departed: they stay watchable as a last resort (their frozen body is
// still the run), but the camera prefers someone actually playing.

export interface SpectateCandidate {
  playerId: string;
  isDown: boolean;
  // Reserved mid-outage body (the reconnect grace) — see PR #39. Absent field = present.
  isAbsent?: boolean;
}

export function isReconnectingTeammate(r: SpectateCandidate): boolean {
  return r.isAbsent === true;
}

function byId<T extends SpectateCandidate>(a: T, b: T): number {
  return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
}

// The living, PRESENT teammates in a stable deterministic order (by id) so every client —
// and every cycle press — walks the same ring regardless of snapshot array order.
export function livingTeammates<T extends SpectateCandidate>(remotes: readonly T[]): T[] {
  return remotes.filter((r) => !r.isDown && !isReconnectingTeammate(r)).sort(byId);
}

// The ring the spectator camera walks: living present teammates first; when EVERY living
// teammate is mid-reconnect (their bodies reserved, the run merely idling), fall back to
// watching the ghosts rather than nothing — no wipe can fire during the grace, so there is
// always something true to show.
function spectateRing<T extends SpectateCandidate>(remotes: readonly T[]): T[] {
  const present = livingTeammates(remotes);
  if (present.length > 0) return present;
  return remotes.filter((r) => !r.isDown && isReconnectingTeammate(r)).sort(byId);
}

// The target to follow this tick: keep the current one while it is still in the ring,
// otherwise the ring's first (this is also what hands the camera off a teammate who went
// down or dropped into the reconnect grace while being watched), otherwise null.
export function resolveSpectateTarget(currentId: string | null, remotes: readonly SpectateCandidate[]): string | null {
  const ring = spectateRing(remotes);
  if (ring.length === 0) return null;
  if (currentId !== null && ring.some((r) => r.playerId === currentId)) return currentId;
  return ring[0].playerId;
}

// Step the target through the ring by dir (+1 next / -1 previous), wrapping. A stale or
// absent current target resolves to the ring's first entry before stepping is meaningful.
export function cycleSpectateTarget(currentId: string | null, remotes: readonly SpectateCandidate[], dir: 1 | -1): string | null {
  const ring = spectateRing(remotes);
  if (ring.length === 0) return null;
  const at = currentId !== null ? ring.findIndex((r) => r.playerId === currentId) : -1;
  if (at < 0) return ring[0].playerId;
  return ring[(at + dir + ring.length) % ring.length].playerId;
}
