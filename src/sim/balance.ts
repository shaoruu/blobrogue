// The versioned BalanceDef — every gameplay-balance number from
// docs/specs/blobrogue_BALANCE_FINAL_impl.md, reconciled against the studio-wide
// docs/specs/blobrogue_STUDIO_BALANCE_GATE.md (Standard baseline), lives HERE, in one
// deterministic module the pure sim consumes (LocalTransport solo and the authoritative
// server run the same data).
// Design rule (spec §0): difficulty comes from techniques, telegraphed commitments, room
// composition, movement and scarcity — HP is a calibration output, never the difficulty lever.
//
// Engine-mechanical constants that are not balance (pathfinding cadence, knockback physics,
// status-system plumbing) stay in constants.ts.

import type { EnemyKind, WeaponId } from "./types.js";

export const BALANCE_VERSION = 2;

// ---- §1 player constants ----

export const PLAYER = {
  baseMaxHp: 6,
  moveSpeed: 200,
  postHitInvuln: 0.80,
  dashCooldown: 0.70,
  dashActive: 0.16,
  dashSpeed: 620,
  // Non-refreshing, non-overlapping dash iframe — a SEPARATE protection from the post-hit
  // invuln (0.80s), which must never extend it. At Second Wind Lv3 (CD 0.35s) the
  // theoretical uptime is 0.18/0.35 = 51.4%: excellent mobility, not immunity.
  dashIframe: 0.18,
} as const;

// ---- §2 sustain / heart economy (ambient healing roughly halved) ----

export const SUSTAIN = {
  enemyHeartDrop: 0.06,   // was 0.12
  crateHeartDrop: 0.06,   // was 0.15
  woodChestHeart: 0.15,   // was 0.20
  woodChestWeapon: 0.07,
  descentHeal: 0,         // was +2 — the descent is pacing, not a free mistake reset
  fullHpHeartCoins: 2,    // a loose heart at full HP is consumed and converts to coins
  // Recovery pity: after this many consecutive non-boss floors that generated zero hearts
  // while the party entered below 50% HP, force one heart into the next wood chest.
  pityFloors: 2,
  pityLowHpFrac: 0.5,
} as const;

// Dealer: a purchasable heart on every third floor (3/6/9, …). +1 HP, never a full heal.
// Co-op stocks P hearts (§8). Studio gate §4: the Dealer also stocks max(2, P) DISTINCT
// weapons at the fixed 12/18/24 price ladder — purchases are personal and never deplete a
// teammate's stock (an owned weapon is simply walked past).
export const DEALER = {
  floorInterval: 3,
  price: 6,
  heal: 1,
  weaponPrices: [12, 18, 24, 24] as readonly number[], // by stock slot; 4th holds at 24
} as const;

export function dealerWeaponStock(players: number): number {
  return Math.max(2, clampPlayers(players));
}

// Studio gate §4 weapon-opportunity rules: party size buys OPTIONS, never rarity/power.
// Normal floor pedestal rolls (weapons stocked into the floor's chests): P1–2 roll 1,
// P3–4 roll 2, distinct IDs when the pool permits.
export function pedestalWeaponRolls(players: number): number {
  return Math.max(1, Math.ceil(clampPlayers(players) / 2));
}

// Boss weapon reward: P+1 distinct personal CHOICES (capped 5). Each player claims one;
// a claim never removes a teammate's options.
export function bossWeaponChoices(players: number): number {
  return Math.min(5, clampPlayers(players) + 1);
}

export const REVIVE = {
  radius: 46,
  channel: 1.5,     // was 1.1 — any damage to the reviver cancels the channel
  hp: 2,
  invuln: 1.0,
  fireLockout: 0.35, // a revived player cannot attack for this long
} as const;

// Vampire Fang: shared proc cooldown; boss-spawned/summoned adds are excluded from both
// Fang procs and natural heart drops (no farmable trivial sustain).
export const FANG_PROC_COOLDOWN = 1.25;

// ---- §3 regular enemy scaling (exact per-floor multiplier tables) ----

// Index 0 = floor 1; floors beyond 10 clamp to the last entry (the F1–10 envelope).
export const FLOOR_HP_MULT = [1.00, 1.25, 1.50, 1.72, 1.94, 2.12, 2.30, 2.47, 2.60, 2.71] as const;
export const FLOOR_SPEED_MULT = [1.00, 1.02, 1.04, 1.06, 1.07, 1.09, 1.11, 1.13, 1.14, 1.16] as const;

// Spec rounding: round-half-to-even reproduces every value in the §3 tables
// (bat F2 2.5→2, slime F3 4.5→4, skeleton F2 7.5→8).
export function roundHalfToEven(v: number): number {
  const floor = Math.floor(v);
  const frac = v - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function floorIndex(floor: number): number {
  const f = Math.max(1, Math.floor(floor));
  return Math.min(f, FLOOR_HP_MULT.length) - 1;
}

export function floorHpMult(floor: number): number {
  return FLOOR_HP_MULT[floorIndex(floor)];
}

export function floorSpeedMult(floor: number): number {
  return FLOOR_SPEED_MULT[floorIndex(floor)];
}

// ---- §4 threat budget, density and variety tiers (difficulty ≠ HP) ----

export function floorThreat(floor: number): number {
  return Math.min(30, 6 + 2 * (Math.max(1, floor) - 1));
}

export function activeThreatCap(floor: number): number {
  return Math.min(16, 8 + Math.max(1, floor));
}

export type EnemyTier = "swarm" | "standard" | "brute" | "elite";

export interface TierDef {
  hpMult: number;
  speedMult: number;
  radiusMult: number;
  drawMult: number;
  threatCost: number;
  minFloor: number;
  attackCdMult: number; // elite: one affix + 20% shorter commit cooldowns
}

export const TIERS: Record<EnemyTier, TierDef> = {
  swarm: { hpMult: 0.55, speedMult: 1.15, radiusMult: 0.78, drawMult: 0.78, threatCost: 0.55, minFloor: 1, attackCdMult: 1 },
  standard: { hpMult: 1.00, speedMult: 1.00, radiusMult: 1.00, drawMult: 1.00, threatCost: 1.0, minFloor: 1, attackCdMult: 1 },
  brute: { hpMult: 2.40, speedMult: 0.82, radiusMult: 1.30, drawMult: 1.35, threatCost: 2.2, minFloor: 4, attackCdMult: 1 },
  elite: { hpMult: 1.70, speedMult: 1.12, radiusMult: 1.08, drawMult: 1.12, threatCost: 2.8, minFloor: 6, attackCdMult: 0.8 },
};

// Brute damage rule: only its authored, clearly telegraphed commitment (the skeleton lunge)
// deals 2 — ordinary contact stays 1. No tier ever blanket-multiplies damage.
export const BRUTE_HEAVY_DAMAGE = 2;

// Room-composition guards (§4): readable pressure, never soup.
export const MAX_COMPLEX_PER_ROOM = 2;
export const BRUTE_ELITE_COMBO_FLOOR = 8; // no brute+elite in one room before this floor
export const ELITE_SPLIT_COUNT = 2;       // the shipped elite affix: splits into swarm units

// Studio gate §1 (Standard): never more than 2 complex MOVERS live simultaneously — the
// charge/burrow verbs that deny standard answers. Enforced at the spawn split and again
// at every reinforcement release.
export const MAX_COMPLEX_MOVERS_ACTIVE = 2;
// Studio gate §2: max one burrower per room, and no flock pack may consume more than 35%
// of the room's threat spend.
export const MAX_BURROWERS_PER_ROOM = 1;
export const FLOCK_THREAT_SHARE_MAX = 0.35;

// Reinforcement release pacing: pending threat trickles in as waves whenever the living
// active threat drops below the cap, spaced by this stagger so waves read as waves.
export const REINFORCE_STAGGER = 0.9;

// Biome pressure (§4): bodies/hazard modifiers, never HP. Indexed by biomeIndexForFloor.
export interface BiomePressure {
  budgetMult: number;      // threat-budget multiplier
  packBias: number;        // extra swarm-pack likelihood (Amberwild +15% pack units)
  complexShare: number;    // ranged/kiter weight multiplier (Sunless 1.10×)
  hazardMult: number;      // explosive-prop bias (Deep 1.15×)
  reinforceRate: number;   // reinforcement release-rate multiplier (Emberreach 1.15×)
}

// Six entries matching the curriculum's six regions (biomeIndexForFloor keys them).
export const BIOME_PRESSURE: readonly BiomePressure[] = [
  { budgetMult: 1.00, packBias: 1.15, complexShare: 1.00, hazardMult: 1.00, reinforceRate: 1.00 }, // Amberwild
  { budgetMult: 1.00, packBias: 1.20, complexShare: 1.00, hazardMult: 1.00, reinforceRate: 1.05 }, // Rootbound Warrens (formation density)
  { budgetMult: 0.95, packBias: 1.00, complexShare: 1.10, hazardMult: 1.00, reinforceRate: 1.00 }, // Sunless Caves
  { budgetMult: 0.90, packBias: 1.00, complexShare: 1.00, hazardMult: 1.15, reinforceRate: 1.00 }, // The Deep
  { budgetMult: 0.95, packBias: 1.00, complexShare: 1.05, hazardMult: 1.00, reinforceRate: 1.00 }, // Gilded Archive (order/claimed space)
  { budgetMult: 1.05, packBias: 1.00, complexShare: 1.00, hazardMult: 1.00, reinforceRate: 1.15 }, // Emberreach
];

// ---- §5 Slime King (studio gate §3: F5, 900 HP, median 35–50s, high-roll 20–25s) ----

export const BOSS = {
  // HP = max(round10(targetMedianBurn × medianPracticalDPS),
  //          ceil10((minLegalTTK − forcedTransitionTime) × P95LegalDPS))   [gate §3]
  // The gate's initial Standard-solo calibration is 900, but its own rule recalibrates HP
  // from telemetry whenever the legal arsenal changes (this wave added Thumper/Sunlance):
  // at 900 the fastest legal build (point-blank sawnoff + Deadeye Lv3 + Glass Cannon)
  // measures 19.0s — under the 20s high-roll floor. The anti-burst term lands 950:
  // median 48.2s ∈ 35–50, fastest legal high-roll 22.8s ∈ 20–25 (see balance tests).
  baseHp: 950,
  baseHpFloor: 5,             // the floor the 950 calibration belongs to
  contactDamage: 2,           // was 3 — collision hurts, but can't delete half a base bar
  entranceGrace: 1.2,
  attackCd: [0, 3.2, 2.7, 2.25] as readonly number[], // indexed by phase 1..3
  hopWindup: 0.65,
  hopLock: 0.32,
  hopAir: 0.45,
  hopRecover: 0.65,
  slamRadius: 90,
  slamInnerRadius: 55,
  slamCenterDamage: 2,
  slamOuterDamage: 1,
  globDamage: 1,
  radialWindup: 0.75,
  radialRecover: 0.60,
  radialCount: 10,            // 36° gaps
  packSurgeEvery: 2,          // every 2nd radial orders existing slimes into a delayed surge
  packSurgeDelay: 0.6,
  packSurgeDuration: 1.2,
  packSurgeSpeedMult: 1.6,
  // Phase thresholds, evaluated immediately after EVERY authoritative damage event.
  phaseAt: [0.70, 0.35] as readonly number[],
  phaseFloor: [0.62, 0.27] as readonly number[],
  roarDuration: 1.2,          // no invuln/reduction beat exceeds 1.2s; total forced 2.4s
  roarDamageReduction: 0.35,  // reduction, not immunity
  roarBulletClearRadius: 70,
  transitionAddCount: 2,      // two slimes at opposite marked edges
  addFirstAt: 4.5,
  addInterval: [0, 6.5, 6.5, 7.0] as readonly number[], // per phase 1..3
  addBatch: [0, 1, 1, 2] as readonly number[],
  addCap: [0, 5, 5, 7] as readonly number[],
  p3ChaseMult: 1.12,          // was 1.2
  squeezeEvery: 3,            // every 3rd P3 attack is the arena squeeze
  squeezeTelegraph: 1.0,
  squeezeDuration: 3.0,
  squeezeStartRadius: 340,    // safe radius shrinks toward the boss…
  squeezeEndRadius: 150,      // …forcing movement into the fight
  squeezeDamage: 1,
} as const;

// Should the King reappear past the authored ladder (seeded deep rotation, F30+), it
// scales off the same §3 HP curve, anchored at the F5 calibration; the curve clamps at
// F10 (≈1.40×), respecting the gate's ≤1.5× later-boss effective-health ceiling.
export function bossHpForFloor(floor: number): number {
  const scaled = BOSS.baseHp * (floorHpMult(floor) / floorHpMult(BOSS.baseHpFloor));
  return Math.round(scaled / 10) * 10;
}

// ---- §5b MARROW (curriculum F15 milestone; gate §3 initial 1,260, median 38–52s, high-roll 22–28s) ----
// A LINE fight, not an area fight: sidestep the charge lanes, weave the volleys/spiral,
// and punish the wall crash. Its transition beat is a bone SHIELD instead of a roar:
// identical anti-burst plumbing (damage reduction + hard HP floor + queued overflow), but
// INTERACTIVE — killing both summoned husks drops the shield early. The gate's forced
// transition time (0.9s each) is the beat's unbreakable minimum.

export const MARROW = {
  // Gate §3 initial Standard-solo calibration, verified by Stage-C telemetry against the
  // depth's median build (Hair Trigger Lv3 + Glass Cannon Lv2 pistol) — see balance
  // tests. The curriculum slots Marrow at F15; the §3 HP curve clamps at F10, so the
  // calibrated value holds unchanged at the deeper floor.
  baseHp: 1260,
  baseHpFloor: 15,
  contactDamage: 2,
  entranceGrace: 1.2,
  attackCd: [0, 3.0, 2.6, 2.2] as readonly number[], // indexed by phase 1..3
  // Line charge per the gate's pressure contract: windup .70, lock .40, active .60 @ 520,
  // wall recover 1.0. From P2 charges come in PAIRS (a crash cancels the pair — the stun
  // is the punish); P3 charges run 20% hotter and pave rubble lanes down the furrow.
  chargeWindup: 0.70,
  chargeLock: 0.40,
  chargeSpeed: 520,
  chargeDur: 0.60,
  chargeRecover: 0.7,
  crashStun: 1.0,
  chargePairPhase: 2,   // charges chain into pairs from this phase
  p3ChargeSpeedMult: 1.2,
  crashShards: [0, 0, 6, 8] as readonly number[],    // ring size on a wall crash, per phase
  // P3 rubble lanes: slow-zone debris paved along the charge furrow. Max 2 live lanes —
  // planting a third expires the oldest (gate §3: "max 2 rubble lanes, each 4s").
  rubbleRadius: 34,
  rubbleSpacing: 72,    // px between rubble pads along the lane
  rubbleLife: 4,
  rubbleMaxLanes: 2,
  rubbleSlow: 0.65,     // player move-speed multiplier on rubble (enemies unaffected)
  // Bone-shard volley: an aimed fan that widens with the phase.
  volleyWindup: 0.7,
  volleyLock: 0.4,
  volleyRecover: 0.6,
  volleyShards: [0, 3, 5, 7] as readonly number[],   // fan size per phase 1..3
  volleySpread: 0.22,                                // radians between fan shards
  shardSpeed: 300,
  shardRadius: 7,
  shardDamage: 1,
  shardLife: 2.4,
  // P3 spiral barrage: every 3rd attack, a stationary rotating pair-emitter you weave through.
  spinEvery: 3,
  spinWindup: 0.8,
  spinDuration: 2.2,
  spinInterval: 0.22,   // seconds between shard pairs
  spinStep: 0.55,       // radians the spiral advances per pair
  spinRecover: 0.8,
  // Gate §3 phase thresholds (66%/33%), floors 8pp under; evaluated after EVERY
  // authoritative damage event (like §5).
  phaseAt: [0.66, 0.33] as readonly number[],
  phaseFloor: [0.58, 0.25] as readonly number[],
  shieldDuration: 2.6,        // max beat length when the husks are ignored (attackable at 65%)
  shieldMinDuration: 0.9,     // the gate's forced transition time — the unbreakable minimum
  shieldDamageReduction: 0.35, // reduction, not immunity — same principle as the roar
  shieldBulletClearRadius: 70,
  shieldHusks: 2,             // summoned at opposite marked edges; killing both breaks early
  addFirstAt: 5,
  addInterval: [0, 7, 7, 7] as readonly number[],
  addBatch: [0, 1, 1, 2] as readonly number[],
  addCap: [0, 4, 4, 6] as readonly number[],
  p3ChaseMult: 1.10,
} as const;

// Deep bosses ride the same clamped §3 curve off their own calibration anchor (beyond F10
// the envelope is flat, so deeper encounters stay at the anchor).
function anchoredBossHp(baseHp: number, anchorFloor: number, floor: number): number {
  return Math.round((baseHp * (floorHpMult(floor) / floorHpMult(anchorFloor))) / 10) * 10;
}

export function marrowHpForFloor(floor: number): number {
  return anchoredBossHp(MARROW.baseHp, MARROW.baseHpFloor, floor);
}

// ---- §5c THE HOLLOW CHOIR (curriculum F30 finale; gate §3 initial 1,800, median 45–65s, high-roll 25–35s) ----
// The grieving ghost mass: it does not zone you with bodies — it UNMAKES itself. On
// cadence it fades intangible and drifts through you (a breather you must keep moving
// through), then rematerializes into a burst; its volleys are slow HOMING wails you juke
// by turning, not by standing behind cover. Transition beats SPLIT it into three wisps —
// kill them to force it back together early (the wisps ARE the boss during the beat).

export const CHOIR = {
  // Gate §3 initial Standard-solo calibration at the run's finale (curriculum F30),
  // verified by telemetry against the depth's median build — see balance tests.
  baseHp: 1800,
  baseHpFloor: 30,
  contactDamage: 2,
  entranceGrace: 1.2,
  attackCd: [0, 3.2, 2.8, 2.4] as readonly number[],
  // The fade: telegraph, then intangible drift toward the target, then a rematerialize
  // burst (P2+) into a long recover — the punish window for tracking it through the fade.
  fadeEvery: 3,
  fadeWindup: 0.6,
  fadeDuration: 1.8,
  fadeSpeedMult: 1.6,
  fadeRecover: 0.8,
  burstShards: [0, 0, 8, 10] as readonly number[], // rematerialize ring per phase
  burstSpeed: 240,
  // Homing wails: slow, readable seekers with a capped turn rate — orbit them off.
  // Gate §3: strike tells ≥0.75s, and volleys RAIN SEQUENTIALLY — one wail per release
  // step, never a simultaneous wall (the doubled P3 volume stays dodgeable).
  wailWindup: 0.75,
  wailLock: 0.4,
  wailRecover: 0.6,
  wailReleaseGap: 0.12,   // seconds between wails inside one volley
  wailCount: [0, 2, 3, 4] as readonly number[],
  wailSpread: 0.5,
  wailSpeed: 150,
  wailTurnRate: 2.4,
  wailRadius: 8,
  wailDamage: 1,
  wailLife: 2.6,
  shardRadius: 7,
  shardDamage: 1,
  shardLife: 2.6,
  // Transition beats: the Choir scatters into wisps (it is GONE — untargetable) until the
  // wisps die or the cap elapses. Queued overflow lands when it reforms, same §5 contract.
  // Gate §3 thresholds 66%/33%; forced time (the unbreakable minimum) 1.2s each.
  phaseAt: [0.66, 0.33] as readonly number[],
  phaseFloor: [0.58, 0.25] as readonly number[],
  splitDuration: 3.2,
  splitMinDuration: 1.2,
  splitWisps: 3,
  splitBulletClearRadius: 70,
} as const;

export function choirHpForFloor(floor: number): number {
  return anchoredBossHp(CHOIR.baseHp, CHOIR.baseHpFloor, floor);
}

// ---- §5d THE WEAVER (curriculum F20 milestone; gate §3 median 40–55s, high-roll 22–30s) ----
// The duelist that fights the FLOOR: webs are persistent slow-zones that shrink your
// dance space (never damage — routing pressure), and its pounce is a marked drop from
// above that chains in later phases. Small, fast, evasive — hard to pin, exactly like
// the roster spec's duelist.

export const WEAVER = {
  // Gate §3 lists 1,340 as the initial, assuming ≈28 median DPS; measured Stage-C
  // telemetry at the depth's median build runs ≈34 DPS, so the gate's own recalibration
  // rule (§3: telemetry over sheet DPS) lands 1,500 — median ≈44s, inside the 40–55 band
  // with margin on both edges (see balance tests). Curriculum floor: F20 (curve clamps).
  baseHp: 1500,
  baseHpFloor: 20,
  contactDamage: 2,
  entranceGrace: 1.2,
  attackCd: [0, 3.0, 2.7, 2.3] as readonly number[],
  // Weave: plants a locked pattern of webs on and around the target's position.
  weaveWindup: 0.7,
  weaveLock: 0.35,
  weaveRecover: 0.7,
  webCount: [0, 3, 3, 4] as readonly number[],
  webRingDist: 130,
  webRadius: 62,
  webLife: 12,
  webSlow: 0.55,       // player move-speed multiplier inside a web (enemies unaffected)
  // Gate §3: max 2 web ZONES — a zone is one commitment's planting (a 4-web P3 weave), so
  // the hard cap is two full zones; planting past it expires the oldest webs first.
  maxWebs: 8,
  // Pounce per the gate's blink contract: tell .65, lock .35, recover .60. P2+ is the
  // 2-hit: a chained second leap re-telegraphs on a .45s land-to-land gap.
  pounceWindup: 0.65,
  pounceLock: 0.35,
  pounceChainWindup: 0.10,
  pounceChainLock: 0.10,
  pounceAir: 0.35,
  pounceRecover: 0.60,
  pounceRadius: 74,
  pounceInnerRadius: 44,
  pounceCenterDamage: 2,
  pounceOuterDamage: 1,
  pounceChains: [0, 1, 2, 1] as readonly number[], // EXTRA chained leaps per commitment
  // Gate §3 P3: "one real + two afterimages" — the single P3 leap throws two feint
  // markers (pure telegraph noise; only the real mark lands damage).
  pounceFeints: [0, 0, 0, 2] as readonly number[],
  pounceFeintDist: 90,  // feint marker offset from the real mark
  pounceWebRadius: 52,
  // Molt beat: a fixed cocoon (roar semantics) that bursts into a web-bolt ring + broodlings.
  // Gate §3 thresholds 66%/33%; forced time 0.8s each.
  phaseAt: [0.66, 0.33] as readonly number[],
  phaseFloor: [0.58, 0.25] as readonly number[],
  moltDuration: 0.8,
  moltDamageReduction: 0.35,
  moltBoltCount: 8,
  moltBoltSpeed: 260,
  moltBulletClearRadius: 70,
  moltAdds: 2,
  shardRadius: 7,
  shardDamage: 1,
  shardLife: 2.6,
} as const;

export function weaverHpForFloor(floor: number): number {
  return anchoredBossHp(WEAVER.baseHp, WEAVER.baseHpFloor, floor);
}

// ---- §5e THE GILDED WARDEN (curriculum F25 milestone; gate §3 formula-calibrated, median 42–58s, high-roll 24–32s) ----
// The armored tempo boss: its plate chips incoming damage to 30% at ALL times except the
// EXPOSED window — the long recover after each committed quake/sweep, when the plate
// hangs open. You do not out-DPS the Warden whenever you like; you dodge the commitment,
// then unload into the opening. Reduction, never immunity: impatient chip still works,
// it is just the slow way.
// NOTE: the balance gate named a "Jet" slot — the curriculum overrides: Jet is later
// post-F30 endgame content, and the Gilded Warden holds the F25 milestone. HP rides the
// gate §3 formula: its raw 1,520 assumes an unarmored body; the plate's 0.3 chip outside
// exposed windows raises effective health ≈1.35×, so the raw anchor lands lower —
// telemetry at the depth's median build (Hair Trigger Lv3 + Glass Cannon Lv3) calibrates
// 1,280 into the 42–58s median band with margin (see balance tests).

export const GILDED = {
  baseHp: 1280,
  baseHpFloor: 25,
  contactDamage: 2,
  entranceGrace: 1.2,
  attackCd: [0, 3.6, 3.2, 2.8] as readonly number[],
  armorChip: 0.3,       // closed-plate damage multiplier (never zero)
  // Anvil slam: a marked in-place quake with a directional aftershock line, then the
  // exposed recover — the fight's core loop.
  slamWindup: 0.8,
  slamLock: 0.45,
  slamActive: 0.3,
  slamRecover: 2.2,     // the EXPOSED window
  slamRadius: 110,
  slamInnerRadius: 66,
  slamCenterDamage: 2,
  slamOuterDamage: 1,
  slamLineShards: 3,
  slamLineSpeed: 300,
  slamLineGap: 0.16,    // radians between aftershock shards
  // Gold sweep: slow, heavy rings you walk through; P3 releases two offset waves.
  sweepWindup: 0.75,
  sweepRecover: 2.0,    // also exposed
  sweepCount: 10,
  sweepSpeed: 190,
  sweepWaves: [0, 1, 1, 2] as readonly number[],
  sweepWaveGap: 0.4,
  shardRadius: 8,
  shardDamage: 1,
  shardLife: 3.0,
  // Sanctify beat: fixed-duration roar semantics. Gate §3 F20 slot: thresholds 66%/33%,
  // forced time 1.0s each.
  phaseAt: [0.66, 0.33] as readonly number[],
  phaseFloor: [0.58, 0.25] as readonly number[],
  sanctifyDuration: 1.0,
  sanctifyDamageReduction: 0.35,
  sanctifyBulletClearRadius: 70,
} as const;

export function gildedHpForFloor(floor: number): number {
  return anchoredBossHp(GILDED.baseHp, GILDED.baseHpFloor, floor);
}

// ---- §5f the F10 MINIBOSS GAUNTLET (curriculum §2 F10 + §5) ----
// The Rootbound Warrens close on an authored Arena Gauntlet, not a boss: three sequential
// minibosses — the Flock Commander (an elite bat leading a small escort), an Orbiter
// elite, and a Shielder brute — with an authored breath between stages, NEVER
// simultaneous. Each miniboss carries 45–70% of the depth's boss-effective HP (§5:
// authored arena only, 1–2 moves, never a random-room roll), and the last stage drops
// the floor's premium boss chest.

export interface GauntletStage {
  kind: EnemyKind;
  tier: EnemyTier;
  hpFrac: number; // fraction of bossHpForFloor(GAUNTLET.floor), §5's 45–70% band
  escort: number; // swarm-kin escort spawned WITH the stage (part of the stage's clear)
}

export const GAUNTLET = {
  floor: 10,
  breath: 1.2, // seconds between a stage's last death and the next stage's entrance
  stages: [
    { kind: "bat", tier: "elite", hpFrac: 0.45, escort: 4 },
    { kind: "orbiter", tier: "elite", hpFrac: 0.45, escort: 0 },
    { kind: "shielder", tier: "brute", hpFrac: 0.50, escort: 0 },
  ] as readonly GauntletStage[],
  // The premium reward: the gauntlet's boss chest bakes the Burst rifle — Rootbound's
  // formation-fire signature (no full boss signature is duplicated).
  chestWeapon: "burst" as WeaponId,
} as const;

// ---- §6 power budget: raw caps (temporary per-run blessings) ----
// The 4–6× strong-run fantasy is EXPRESSIVE capability (pellets/pierce/status/crit/
// positioning), never a product of raw flat stats. Enforced in the authoritative sim
// after a full build recompute from item levels.

export const CAPS = {
  damageMult: 2.25,
  fireRateMult: 1.80,
  moveSpeedMult: 1.35,
  maxHpBonus: 4,
  pierce: 3,          // blessing-ADDED pierce (weapon-intrinsic pierce is separate)
  elementalChance: 0.5,
} as const;

// Permanent (Foundation) power: no permanent gear system exists in the runtime yet; when
// it lands, the strongest legal loadout advantage must stay under this ceiling (§6/§7 gate 8).
export const PERMANENT_ADVANTAGE_CEILING = 0.30;

// ---- §8 co-op scaling (Stage C authoritative combat) ----
// P = living players snapshotted at encounter creation (floor build), clamped 1–4; living
// enemies are never rescaled on disconnect/down.

export const COOP = {
  maxPlayers: 4,
  mobHpPerExtra: 0.55,    // 1.00 / 1.55 / 2.10 / 2.65
  bossHpPerExtra: 0.65,   // 1.00 / 1.65 / 2.30 / 2.95
  threatPerExtra: 0.35,   // 1.00 / 1.35 / 1.70 / 2.05
  kbResistPerExtra: 0.20,
  heartRatePerExtra: 0.30,
  // Enemy damage: unchanged P1–3; ×1.10 at P4 authored as explicit integers — every
  // current source is 1 or 2, and both round back to themselves, so damage stays as-is.
} as const;

export function clampPlayers(players: number): number {
  return Math.max(1, Math.min(COOP.maxPlayers, Math.floor(players)));
}

export function coopMobHpMult(players: number): number {
  return 1 + COOP.mobHpPerExtra * (clampPlayers(players) - 1);
}

export function coopBossHpMult(players: number): number {
  return 1 + COOP.bossHpPerExtra * (clampPlayers(players) - 1);
}

export function coopThreatMult(players: number): number {
  return 1 + COOP.threatPerExtra * (clampPlayers(players) - 1);
}

export function coopKbResistMult(players: number): number {
  return 1 + COOP.kbResistPerExtra * (clampPlayers(players) - 1);
}

export function coopHeartRateMult(players: number): number {
  return 1 + COOP.heartRatePerExtra * (clampPlayers(players) - 1);
}
