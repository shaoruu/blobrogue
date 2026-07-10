// Named PRNG streams + THE ROLL-ORDER CONTRACT — the deterministic randomness backbone the
// floor-mutators, elite-affixes and boss-affixes hang off (docs/blobrogue_WAVE1_FOUNDATIONS.md,
// Gate 3). Every floor-level roll draws from a stream keyed by (worldSeed, floorIndex,
// rollStreamId, ordinal): distinct systems never share a stream, so appending a new system can
// never perturb an existing one's sequence, and the same key on any client reproduces the same
// draw. Integer/fixed-point mixing only — NO floats, NO wall-clock, NO player-count branching
// inside a draw (the player count enters CAPS/veto, outside the stream key; see floorRolls.ts).

import { Rng } from "./rng.js";

// ---- THE ROLL-ORDER CONTRACT (authoritative — mirror in docs/blobrogue_WAVE1_FOUNDATIONS.md) ----
// Floor rolls resolve in EXACTLY this order. New systems APPEND to the end (higher ids), never
// insert mid-list, so existing seeds stay stable. The order is enforced by a golden-master test
// (test/determinism.test.ts): any reorder or mid-list insert changes the frozen bytes and fails.
//   1) FLOOR_MUTATORS
//   2) ENCOUNTER_DECK   (the Gate 1 per-region roster/deck draw)
//   3) ELITE_AFFIXES    (by ASCENDING spawn ordinal — the ordinal sub-keys the stream)
//   4) BOSS_AFFIX
// The numeric ids are the STABLE stream salts; do not renumber (a renumber is a reseed of every
// affected stream and would invalidate every stored seed).
export const RollStream = {
  FLOOR_MUTATORS: 0,
  ENCOUNTER_DECK: 1,
  ELITE_AFFIXES: 2,
  BOSS_AFFIX: 3,
} as const;

export type RollStreamId = (typeof RollStream)[keyof typeof RollStream];

// The contract as data (the resolver walks this, and the golden test locks it): the ordered
// list every floor resolves. Appending here is how a new system joins the contract.
export const ROLL_ORDER: readonly RollStreamId[] = [
  RollStream.FLOOR_MUTATORS,
  RollStream.ENCOUNTER_DECK,
  RollStream.ELITE_AFFIXES,
  RollStream.BOSS_AFFIX,
];

// Per-stream salts: fixed odd constants that separate the streams in the mix. Keyed BY the
// RollStreamId so a stream's identity (not its position) picks its salt — reordering ROLL_ORDER
// never changes a stream's sequence, only appending a NEW id does. Chosen distinct from the
// legacy per-system XOR constants already in the sim (dungeon/hazards/props/deck/boss) so the
// backbone never collides with a pre-existing stream.
const STREAM_SALT: Readonly<Record<RollStreamId, number>> = {
  [RollStream.FLOOR_MUTATORS]: 0x4d757400, // "Mut"
  [RollStream.ENCOUNTER_DECK]: 0x4465636b, // "Deck"
  [RollStream.ELITE_AFFIXES]: 0x456c6974, // "Elit"
  [RollStream.BOSS_AFFIX]: 0x426f7373, // "Boss"
};

// A finalized 32-bit mix of (worldSeed, floorIndex, streamId salt, ordinal). All ops are
// integer (imul / xor / shift), so the result is bit-identical across every JS engine — the
// determinism contract holds on the server and every client.
function mix32(worldSeed: number, floorIndex: number, salt: number, ordinal: number): number {
  let h = worldSeed | 0;
  h = Math.imul(h ^ 0x9e3779b9, 0x85ebca6b) | 0;
  h = Math.imul(h ^ (floorIndex | 0), 0xc2b2ae35) | 0;
  h = Math.imul(h ^ (salt | 0), 0x27d4eb2f) | 0;
  h = Math.imul(h ^ (ordinal | 0), 0x165667b1) | 0;
  h ^= h >>> 15;
  return h | 0;
}

// The one entry point: a fresh Rng for a named floor-roll stream. `ordinal` sub-keys a stream
// that rolls many times in a defined sequence (elite affixes by ascending spawn ordinal); it
// defaults to 0 for the single-shot streams. The returned Rng is independent of every other
// stream — draining it never touches another system's sequence.
export function rollStream(worldSeed: number, floorIndex: number, id: RollStreamId, ordinal = 0): Rng {
  return new Rng(mix32(worldSeed, floorIndex, STREAM_SALT[id], ordinal));
}
