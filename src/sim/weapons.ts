import type {
  Bullet, WeaponId, WeaponRarity, MysteryTwist, SluiceMode, OddsmakerOutcome,
} from "./types.js";
import type { PlayerId } from "./input.js";
import type { Rng } from "./rng.js";
import {
  CURRENT_CONTENT_CATALOG_VERSION,
  contentCatalogFor,
} from "./contentCatalog.js";
import type { ContentCatalogVersion } from "./contentCatalog.js";
import {
  BOSS_EXTRA_PELLET_COEF, BOSS_NATIVE_PELLET_COEF, WEAPON_BOSS_COEF,
  WEAPON_RARITY_WEIGHT, LEGENDARY_MIN_FLOOR, BOSS_CHEST_LEGENDARY_MULT, MYSTERY,
  HOMING_SPLIT,
} from "./balance.js";

export interface MeleeSpec {
  arc: number;         // swing arc in radians (thrust uses a narrow forward cone)
  reach: number;       // hitbox reach in px from the player center
  isThrust?: boolean;  // spear: line/capsule forward instead of a wide sweep
  swingDur?: number;   // active swing seconds (defaults to 0.2)
}

// ---- effect-wave behavior specs (one optional struct per archetype, like MeleeSpec) ----
// Universal modifiers map onto these coherently at fire/plant time (see resolveShot and
// the updateShooting branches): size -> footprint/reach, speed -> travel/orbit/arm, life
// -> duration, pellets -> authored extra entities (capped), pierce only where a shot
// exists, damage/crit/status on every authored damage event. Where a stat is truly
// inapplicable the weapon simply doesn't read it (and its tooltip omits the line).

// Hold-to-charge lob (the Breach): the trigger charges a landing distance; release fires
// a shell that sails over bodies and detonates where it lands.
export interface ChargeSpec {
  time: number;     // seconds of hold for a full charge
  minDist: number;  // release-at-tap landing distance (px)
  maxDist: number;  // full-charge landing distance (px); bulletLifeMult scales it
  slow: number;     // move-speed multiplier while charging (the exposure tradeoff)
}

// Armed line trap (the Snapwire).
export interface WireSpec {
  length: number;  // wire span from the planting spot toward aim (px, wall-clamped)
  width: number;   // trigger band (px); bulletSizeMult scales it
  arm: number;     // seconds until armed; bulletSpeedMult shortens it
  life: number;    // armed seconds before the wire decays; bulletLifeMult scales it
  max: number;     // armed wires per owner; extraPellets adds (hard cap below)
}

// Ground-painting projectile (the Frostline).
export interface PaintSpec {
  spacing: number;    // px of bead travel between painted zones
  radius: number;     // zone radius; bulletSizeMult scales it
  life: number;       // zone seconds; bulletLifeMult scales it
  chillRate: number;  // seconds of chill per second standing inside
  isPaving?: boolean;
}

// Orbiting blades (the Razor Halo).
export interface OrbitSpec {
  blades: number;      // authored blade count; extraPellets adds (hard cap below)
  ring: number;        // resting ring radius (px)
  bladeRadius: number; // per-blade contact radius; bulletSizeMult scales it
  speed: number;       // orbit angular speed (rad/s); bulletSpeedMult scales it
  rehit: number;       // per-enemy re-hit cadence (seconds)
  flareRing: number;   // ring radius while the active flares outward
  flareDur: number;    // seconds the flare holds
  flareBonus: number;  // damage multiplier while flared
}

// Destructible lane turret (the Prism Sentry).
export interface SentrySpec {
  hp: number;
  radius: number;     // body radius
  range: number;      // LOS acquire/fire range (px)
  fireCd: number;     // bolt cadence (seconds); the owner's fire-rate mult scales it
  boltSpeed: number;  // bulletSpeedMult scales it
  boltRadius: number; // bulletSizeMult scales it
  life: number;       // deployed seconds; bulletLifeMult scales it
  deployDist: number; // px in front of the owner the sentry lands
}

// Windup tether/pull (the Crooked Chain).
export interface TetherSpec {
  range: number;       // latch scan reach along aim (px)
  width: number;       // latch scan capsule width (px)
  pullSpeed: number;   // px/s the chain reels; bulletSpeedMult scales it
  holdDist: number;    // pull resolves once the target is this close
  hold: number;        // sweep window seconds; bulletLifeMult scales it
  reach: number;       // sweep radius around the owner; bulletSizeMult scales it
  playerPullTime: number; // seconds the INVERTED pull may drag the owner (heavy targets)
}

export interface GrappleSpec {
  pull: number;
}

export interface ModeShiftSpec {
  alternate: {
    damage: number;
    pellets: number;
    spread: number;
    speed: number;
    life: number;
    bulletRadius: number;
    basePierce: number;
  };
}

export interface GambleSpec {
  outcomes: readonly OddsmakerOutcome[];
}

export const WEAPON_CYCLE_IDS = ["sluicegate", "oddsmaker"] as const;
export type WeaponCycleId = typeof WEAPON_CYCLE_IDS[number];
export type WeaponCycles = Record<WeaponCycleId, number>;
export type WeaponFireCooldowns = Partial<Record<WeaponId, number>>;

export function createWeaponCycles(): WeaponCycles {
  return { sluicegate: 0, oddsmaker: 0 };
}

export interface Weapon {
  id: WeaponId;
  name: string;
  rarity: WeaponRarity; // drop-quality tier: weighting, gating, pricing, UI treatment
  fireCd: number;      // seconds between shots / swings
  speed: number;       // bullet speed px/s (unused on melee)
  life: number;        // bullet lifetime (doubles as range; unused on melee)
  damage: number;      // per pellet / per swing hit
  pellets: number;
  spread: number;      // total cone width in radians
  bulletRadius: number;
  color: string;
  muzzle: number;      // muzzle-flash particle count
  melee?: MeleeSpec;   // present => melee class (swing hitbox, no bullets)
  basePierce?: number;  // intrinsic pass-through count before item pierce
  // Optional bullet behaviors. Absent on the base weapons; each stamps one field onto
  // every bullet it fires (see fire) to switch on an isolated update-loop branch.
  bounce?: number;     // ricochet: wall reflections before the bullet dies
  homing?: number;     // homing: steering turn rate (rad/s)
  chain?: number;      // tesla: lightning jumps after the first hit
  chainRange?: number; // tesla: max px per chain jump
  blast?: number;      // mortar: AoE radius — the shell detonates on impact/wall/expiry
  // Elemental status the weapon stamps on every round (seconds of the effect). The
  // flamethrower is the only base weapon that carries one; item blessings roll the
  // rest at hit time (see PlayerMods.burnChance etc.), so any weapon can go elemental.
  burn?: number;
  chill?: number;
  shock?: number;
  // Effect-wave behaviors (each present on exactly one weapon; see the spec structs above).
  // lowHpBonus is the Lastlight's intrinsic risk curve: damage scales up to (1 + bonus)x
  // as HP empties — weapon data like the Thunderbolt's 9, deliberately outside the mods
  // caps (the caps bind BLESSING stacking, not authored weapon identity).
  lowHpBonus?: number;
  charge?: ChargeSpec;
  wire?: WireSpec;
  paint?: PaintSpec;
  orbit?: OrbitSpec;
  sentry?: SentrySpec;
  tether?: TetherSpec;
  grapple?: GrappleSpec;
  modeShift?: ModeShiftSpec;
  gamble?: GambleSpec;
  // Legendary signature mechanics — one per legendary, never shared, never a stat reskin.
  // Each stamps one field onto its bullets (or gates the trigger pull, for the Midas) and
  // switches an isolated branch in the update loop, exactly like the Tier B fields above.
  killShards?: number; // reaper: shards released from a body THIS round kills (cascades, decaying)
  accel?: number;      // swarm: px/s² each dart gains in flight
  coinBoost?: number;  // midas: eats 1 coin per shot to multiply damage by this (weak when broke)
  isPhase?: boolean;   // phase: rounds ignore walls (and destructible props) entirely
  implode?: number;    // vortex: implosion radius — the payload drags the pack onto the point
  // singularity: paired with implode — the collapse point births a delayed nova blast of
  // this radius once the pull has clumped the pack (two-stage: gather THEN detonate). One
  // isolated field + one branch in implodeBullet, exactly like the Tier B behaviors above.
  nova?: number;
  // Canonical special-mechanic tooltip copy (data-driven: the HUD drawer, the pickup
  // inspect surfaces and the dev sandbox all read THIS string, never re-describe it).
  special?: string;
}

export const WEAPONS: Record<WeaponId, Weapon> = {
  pistol: {
    id: "pistol", name: "Pistol", rarity: "common", fireCd: 0.16, speed: 560, life: 1.1,
    damage: 2, pellets: 1, spread: 0, bulletRadius: 6, color: "#ffd27a", muzzle: 2,
  },
  shotgun: {
    id: "shotgun", name: "Shotgun", rarity: "common", fireCd: 0.52, speed: 500, life: 0.32,
    damage: 1.7, pellets: 5, spread: 0.52, bulletRadius: 5, color: "#ffb43b", muzzle: 6,
  },
  rapid: {
    id: "rapid", name: "Rapid", rarity: "common", fireCd: 0.07, speed: 660, life: 0.85,
    damage: 0.9, pellets: 1, spread: 0.07, bulletRadius: 4, color: "#8affe0", muzzle: 1,
  },
  // Tier A — pure data (no engine branches).
  smg: {
    id: "smg", name: "Hornet", rarity: "common", fireCd: 0.09, speed: 640, life: 0.9,
    damage: 1.1, pellets: 1, spread: 0.03, bulletRadius: 4, color: "#b6ff6a", muzzle: 1,
  },
  cannon: {
    id: "cannon", name: "Thunderbolt", rarity: "rare", fireCd: 0.72, speed: 520, life: 1.3,
    damage: 9, pellets: 1, spread: 0, bulletRadius: 11, color: "#ff8a3b", muzzle: 5,
    basePierce: 2,
    special: "Heavy slug punches through 2 bodies.",
  },
  // Damage 2.2 -> 2.1 (balancer envelope): the Triplet quietly held the boss, room and
  // safety top quartiles at once — the all-rounder review trigger. The damage trim plus
  // a boss-coefficient step (0.75 -> 0.7, WEAPON_BOSS_COEF) drops it out of the crown
  // races while keeping its authored fan-volley identity.
  burst: {
    id: "burst", name: "Triplet", rarity: "common", fireCd: 0.34, speed: 680, life: 1.0,
    damage: 2.1, pellets: 3, spread: 0.14, bulletRadius: 4, color: "#6ad0ff", muzzle: 2,
  },
  // Tier B — each carries one optional behavior field stamped onto its bullets.
  ricochet: {
    id: "ricochet", name: "Rebound", rarity: "rare", fireCd: 0.28, speed: 600, life: 1.6,
    damage: 2.4, pellets: 1, spread: 0.02, bulletRadius: 5, color: "#c98bff", muzzle: 2,
    bounce: 2,
    special: "Rounds bank off walls twice.",
  },
  homing: {
    id: "homing", name: "Wisp", rarity: "rare", fireCd: 0.16, speed: 420, life: 1.4,
    damage: 1.6, pellets: 1, spread: 0.25, bulletRadius: 5, color: "#8affe0", muzzle: 1,
    homing: 6,
    special: "Rounds seek the nearest enemy.",
  },
  tesla: {
    id: "tesla", name: "Tesla", rarity: "rare", fireCd: 0.4, speed: 900, life: 0.5,
    damage: 3, pellets: 1, spread: 0, bulletRadius: 5, color: "#7fe9ff", muzzle: 2,
    chain: 3, chainRange: 130,
    special: "Arcs chain to 3 nearby enemies.",
  },
  // Tier A — pure data. Point-blank devastator: a dense, short-range pellet wall.
  sawnoff: {
    id: "sawnoff", name: "Boomstick", rarity: "common", fireCd: 0.62, speed: 440, life: 0.22,
    damage: 2.4, pellets: 8, spread: 0.85, bulletRadius: 5, color: "#ff7a3b", muzzle: 8,
  },
  // Tier A — pure data. Near-hitscan precision slug (pierce comes from the Full Metal item).
  // The 6px radius keeps the slug precise but forgiving enough that a near-graze on a small
  // body connects (collision is swept, so its 1400px/s can never tunnel between ticks).
  railgun: {
    id: "railgun", name: "Longshot", rarity: "rare", fireCd: 0.85, speed: 1400, life: 1.6,
    damage: 11, pellets: 1, spread: 0, bulletRadius: 6, color: "#e8f0ff", muzzle: 3,
  },
  // Tier B — reuses the ricochet bounce field: fast full-auto that ricochets once.
  nailer: {
    id: "nailer", name: "Nailer", rarity: "common", fireCd: 0.12, speed: 720, life: 1.1,
    damage: 1.4, pellets: 1, spread: 0.05, bulletRadius: 3, color: "#d9d2c0", muzzle: 1,
    bounce: 1,
    special: "Nails ricochet once off walls.",
  },
  // Tier B — carries the `burn` status field. Fast tiny short-life wide puffs read as a
  // continuous flame cone; low per-hit damage but every round stamps burn, so the DoT
  // (and any elemental blessings) do the real work. See the status system in game.ts.
  flamer: {
    id: "flamer", name: "Dragon", rarity: "rare", fireCd: 0.04, speed: 300, life: 0.28,
    damage: 0.6, pellets: 2, spread: 0.5, bulletRadius: 7, color: "#ff8a3b", muzzle: 2,
    burn: 2,
    special: "Every round ignites (burn damage over time).",
  },
  // Tier B — carries the `blast` field: a lobbed shell that detonates where it lands
  // (impact, wall or end-of-arc airburst). The room verb is AREA: convert a pack or a
  // chokepoint into a blast zone, and detonate explosive barrels from safety — weak
  // single-target on purpose (the blast is the whole payload; no pierce, no direct hit).
  mortar: {
    id: "mortar", name: "Thumper", rarity: "rare", fireCd: 0.75, speed: 380, life: 0.6,
    damage: 6, pellets: 1, spread: 0, bulletRadius: 8, color: "#ffc46a", muzzle: 5,
    blast: 64,
    special: "Shells detonate where they land — the blast is the payload.",
  },
  // Tier A — pure data. A sustained lance of light: near-instant thin rounds at a very
  // fast cadence blur into a continuous beam (the render draws the streak). The room verb
  // is TRACKING: hold the line on one target and melt it — no spread, no travel time to
  // lead, but short range and it punches only one body deep (basePierce 1).
  // Damage 0.75 -> 0.62 (arsenal QA dominance calibration): the lance held a >25%
  // clear-time edge over the room median in four QA rooms at once — the strongest
  // sustained single-lane DPS in the arsenal plus zero travel time made it a
  // do-everything pick under perfect aim. The trim keeps its authored single-target
  // melt (30 HP in ~2.2s) while pulling the generalist edge back inside the review
  // threshold; its aim-discipline pricing vs bosses (WEAPON_BOSS_COEF) is unchanged.
  beam: {
    id: "beam", name: "Sunlance", rarity: "rare", fireCd: 0.045, speed: 2000, life: 0.24,
    damage: 0.62, pellets: 1, spread: 0, bulletRadius: 4, color: "#ffe6a0", muzzle: 1,
    basePierce: 1,
    special: "A sustained lance that punches one body deep.",
  },
    sword: {
    id: "sword", name: "Cutlass", rarity: "common", fireCd: 0.22, speed: 0, life: 0, damage: 3.5,
    pellets: 1, spread: 0, bulletRadius: 0, color: "#c8e0ff", muzzle: 0,
    melee: { arc: 1.25, reach: 48, swingDur: 0.2 },
  },
  longsword: {
    id: "longsword", name: "Claymore", rarity: "rare", fireCd: 0.38, speed: 0, life: 0, damage: 6.2,
    pellets: 1, spread: 0, bulletRadius: 0, color: "#d8dce8", muzzle: 0,
    melee: { arc: 1.85, reach: 58, swingDur: 0.25 },
  },
  spear: {
    id: "spear", name: "Pike", rarity: "rare", fireCd: 0.28, speed: 0, life: 0, damage: 4.8,
    pellets: 1, spread: 0, bulletRadius: 0, color: "#9ee8c8", muzzle: 0,
    melee: { arc: 0.32, reach: 74, isThrust: true, swingDur: 0.18 },
  },
  // ---- the effect wave: seven distinct room verbs on four shared primitives ----
  // TRADE SAFETY FOR A KILL WINDOW: an ordinary slug at full health, a monster at one
  // heart. Pure risk curve on the existing low-HP hooks — no new engine branch.
  lastlight: {
    id: "lastlight", name: "Lastlight", rarity: "rare", fireCd: 0.55, speed: 620, life: 1.2,
    damage: 3.2, pellets: 1, spread: 0, bulletRadius: 7, color: "#ff6a5a", muzzle: 4,
    lowHpBonus: 2.2,
    special: "Hits up to 3x harder the lower your HP.",
  },
  // ERASE AN ANCHOR: hold to charge a landing point, release to lob a shell OVER the
  // pack onto the shielder/spitter propping the room up. Charging slows the walk.
  // Damage 7 -> 9 (arsenal QA calibration): at 7 the shelling could not finish its own
  // signature job — a covered 50 HP anchor outlasted the 12s room cap. 9 keeps the
  // charge cycle honest (~5.6 sustained DPS) while the boss coefficient prices it.
  breach: {
    id: "breach", name: "Breach", rarity: "rare", fireCd: 0.9, speed: 460, life: 0.9,
    damage: 9, pellets: 1, spread: 0, bulletRadius: 8, color: "#ffb06a", muzzle: 5,
    blast: 76,
    charge: { time: 0.9, minDist: 140, maxDist: 420, slow: 0.55 },
    special: "Hold to charge the landing point; shells sail over enemies and cover. A FULL charge walks a line of three blasts back along the shell's path.",
  },
  // HOLD A DOORWAY: string an armed wire across the chokepoint; the first body across
  // snaps it on everything in the band. Zero direct damage — setup IS the weapon.
  snapwire: {
    id: "snapwire", name: "Snapwire", rarity: "rare", fireCd: 0.65, speed: 0, life: 0,
    damage: 9, pellets: 1, spread: 0, bulletRadius: 0, color: "#e8e05a", muzzle: 0,
    wire: { length: 120, width: 14, arm: 0.7, life: 12, max: 3 },
    special: "Strings an armed tripwire (up to 3). The first enemy across snaps it on everything touching the wire.",
  },
  // CUT THE ROOM IN TWO: the bead paints a chill lane where it flies; bodies crossing
  // the lane slow, campers freeze solid. Weak direct hit on purpose — the floor is the
  // payload.
  frostline: {
    id: "frostline", name: "Frostline", rarity: "rare", fireCd: 0.14, speed: 300, life: 1.1,
    damage: 0.7, pellets: 1, spread: 0.04, bulletRadius: 6, color: "#9fd8ff", muzzle: 1,
    chill: 1.2,
    paint: { spacing: 30, radius: 26, life: 3.5, chillRate: 2.4 },
    special: "Beads paint a chilling trail on the ground; enemies standing in it slow, then freeze.",
  },
  // OWN YOUR PERSONAL SPACE: blades orbit you and shred whatever presses in; the active
  // flares the ring outward for a beat. You have no reach — the pack must come to you
  // (or you to it).
  // Damage 1.5 -> 2.2 (balancer envelope calibration): at 1.5 the ring cleared its own
  // brawl showcase slower than mid-pack guns — the exposure cost bought nothing. 2.2
  // keeps its persistent-family boss ceiling comfortably under 0.55 PU (contact is
  // rehit-gated and coefficient-priced) while the point-blank room job lands.
  halo: {
    id: "halo", name: "Razor Halo", rarity: "rare", fireCd: 0.9, speed: 0, life: 0,
    damage: 2.2, pellets: 1, spread: 0, bulletRadius: 0, color: "#d8f0e8", muzzle: 0,
    orbit: { blades: 3, ring: 46, bladeRadius: 12, speed: 3.6, rehit: 0.5, flareRing: 96, flareDur: 0.4, flareBonus: 1.6 },
    special: "Blades orbit you, shredding anything that presses in. Fire flares the ring outward for a beat.",
  },
  // HOLD A SECOND LANE: park a destructible turret on the other approach and fight the
  // first one yourself. Its kills credit you; enemies can chew it down.
  // Bolt 1.4 -> 2.4 (balancer envelope calibration): at 1.4 the turret lost its own
  // second-lane showcase to fighting both lanes with the pistol. 2.4 (6 bolt DPS,
  // 0.48 PU) keeps it under the 0.55 PU passive ceiling and inside the party's
  // persistent boss budget while making the parked lane a real trade.
  sentry: {
    id: "sentry", name: "Prism Sentry", rarity: "rare", fireCd: 1.2, speed: 0, life: 0,
    damage: 2.4, pellets: 1, spread: 0, bulletRadius: 0, color: "#c8a8ff", muzzle: 0,
    sentry: { hp: 12, radius: 13, range: 240, fireCd: 0.35, boltSpeed: 520, boltRadius: 4, life: 12, deployDist: 40 },
    special: "Deploys a turret that shoots the nearest enemy it can see. Destructible; redeploying moves it.",
  },
  // REPOSITION THE THREAT: latch the chain and reel the target to your feet — then fire
  // again to sweep it (and everything beside you). A brute or boss reels YOU in instead.
  crook: {
    id: "crook", name: "Crooked Chain", rarity: "rare", fireCd: 0.9, speed: 0, life: 0,
    damage: 5, pellets: 1, spread: 0, bulletRadius: 0, color: "#c9b06a", muzzle: 0,
    tether: { range: 210, width: 30, pullSpeed: 560, holdDist: 64, hold: 1.2, reach: 90, playerPullTime: 0.35 },
    special: "Latches and reels an enemy to you; fire again to sweep it. Brutes and bosses drag YOU in instead.",
  },
  // ---- LEGENDARIES — one signature mechanic each, never bigger numbers ----
  // Reaper: modest single shots, but every KILL bursts the body into seeking soul shards
  // that cascade (each generation halves damage — geometric, bounded). The room verb is
  // MOMENTUM: the first kill in a pack starts an avalanche; against a lone tough body it
  // is just an ordinary rifle — that restraint is the tradeoff.
  reaper: {
    id: "reaper", name: "Reaper", rarity: "legendary", fireCd: 0.45, speed: 620, life: 1.2,
    damage: 3.2, pellets: 1, spread: 0.02, bulletRadius: 6, color: "#b8ffd9", muzzle: 3,
    killShards: 3,
    special: "Kills burst into 3 seeking soul shards; shard kills cascade.",
  },
  // Hive: one SLOW trigger pull releases a whole volley of seeker darts that accelerate
  // in flight. The verb is ALPHA STRIKE: commit early, watch the swarm hunt — but the
  // 1.15s cycle means a missed window costs a real beat (and darts launch slow, so
  // point-blank panic fire is its weakest use).
  swarm: {
    id: "swarm", name: "Hive", rarity: "legendary", fireCd: 1.15, speed: 260, life: 2.2,
    damage: 1.8, pellets: 5, spread: 1.4, bulletRadius: 5, color: "#ffe86a", muzzle: 5,
    homing: 7, accel: 420,
    special: "One pull releases 5 seeker darts that accelerate in flight.",
  },
  // Midas: eats 1 coin per shot to hit at double damage — your purse is the magazine.
  // The verb is SPEND POWER: strong exactly as long as you bankroll it (shop, hearts and
  // rerolls compete for the same coins); broke, it fires an honest but weak base round.
  midas: {
    id: "midas", name: "Midas", rarity: "legendary", fireCd: 0.18, speed: 640, life: 1.1,
    damage: 2.2, pellets: 1, spread: 0.02, bulletRadius: 5, color: "#ffd700", muzzle: 2,
    coinBoost: 2,
    special: "Eats 1 coin per shot for \u00d72 damage; fires weak when broke.",
  },
  // Umbra: rounds pass straight through walls and props. The verb is DENY COVER: shoot
  // the pack through the room's geometry from total safety — at a slow cadence, mid
  // damage, and zero pierce, so it wins position, never raw DPS.
  phase: {
    id: "phase", name: "Umbra", rarity: "legendary", fireCd: 0.5, speed: 520, life: 1.5,
    damage: 4, pellets: 1, spread: 0, bulletRadius: 6, color: "#9a7fff", muzzle: 2,
    isPhase: true,
    special: "Rounds pass straight through walls and cover.",
  },
  // Lodestone: every shot implodes on impact, dragging the whole nearby pack onto the
  // point and splashing modest damage. The verb is GATHER: yank scattered bodies into one
  // clump for your follow-up (or a barrel) — weak alone, devastating as a setup tool.
  vortex: {
    id: "vortex", name: "Lodestone", rarity: "legendary", fireCd: 0.6, speed: 480, life: 1.1,
    damage: 2.5, pellets: 1, spread: 0, bulletRadius: 7, color: "#7fb0ff", muzzle: 4,
    implode: 120,
    special: "Shots implode, dragging the nearby pack onto the impact point.",
  },
  // ---- THE CONTENT WAVE — new guns on the existing one-behavior-field pattern ----
  // Each reuses an isolated behavior field (basePierce / pellets+bounce / burst / status /
  // blast+burn / homing / implode) so the bullet update loop takes the exact same paths the
  // base arsenal already does; only the legendary adds one new (nova) branch.
  //
  // SHRED A LINE: a heavy slow saw disc that punches through a whole file of bodies. The
  // Thunderbolt is fast and stops at 2; the Cleaver is a slow, wide, deep-pierce room tool.
  cleaver: {
    id: "cleaver", name: "Cleaver", rarity: "common", fireCd: 0.72, speed: 360, life: 1.25,
    damage: 3.6, pellets: 1, spread: 0, bulletRadius: 10, color: "#cfe8ff", muzzle: 3,
    basePierce: 5,
    special: "A slow saw disc shreds through a whole line of bodies.",
  },
  // HOSE A CROWD WIDE: a twin-pellet full-auto that fronts a spread across a soft crowd —
  // wider and faster than the Hornet, softer per hit than the Triplet.
  scrapper: {
    id: "scrapper", name: "Scrapper", rarity: "common", fireCd: 0.12, speed: 600, life: 0.85,
    damage: 1.0, pellets: 2, spread: 0.2, bulletRadius: 4, color: "#b6d36a", muzzle: 2,
  },
  // WORK THE CORNERS UP CLOSE: a bouncing buckshot — the fan banks off walls, so a corner
  // shot fills a room. A close-range ricochet pack tool, distinct from the single-round banks.
  skipper: {
    id: "skipper", name: "Skipper", rarity: "common", fireCd: 0.5, speed: 520, life: 0.55,
    damage: 1.5, pellets: 4, spread: 0.6, bulletRadius: 4, color: "#ffd08a", muzzle: 5,
    bounce: 1,
    special: "Buckshot banks once off walls — shoot the corner to fill a room.",
  },
  // TAX A MARKED BODY: every round stamps shock (amp + arc) on one target. A precise
  // single-lane shocker — the shock does the work the modest slug can't.
  arcbolt: {
    id: "arcbolt", name: "Arcbolt", rarity: "rare", fireCd: 0.26, speed: 440, life: 0.48,
    damage: 2.4, pellets: 1, spread: 0.05, bulletRadius: 5, color: "#7fe9ff", muzzle: 2,
    shock: 2,
    special: "Every round shocks (extra damage, then arcs to a neighbour) — short range.",
  },
  // FREEZE THE ROOM: a chilling shard that slows on contact and freezes a camper solid.
  // The Frostline paints the FLOOR; the Cryobolt chills the BODY it hits — control on
  // demand, feeble direct damage on purpose.
  cryobolt: {
    id: "cryobolt", name: "Cryobolt", rarity: "rare", fireCd: 0.3, speed: 560, life: 1.2,
    damage: 1.2, pellets: 1, spread: 0.03, bulletRadius: 6, color: "#9fd8ff", muzzle: 2,
    chill: 1.4,
    special: "Every round chills; sustained fire freezes a body solid.",
  },
  // BURN THE CHOKEPOINT: a lobbed firebomb that detonates where it lands and leaves the
  // whole blast ablaze. The Thumper is a clean AoE; the firebomb trades raw blast for a
  // lingering burn DoT across everything it catches.
  firebomb: {
    id: "firebomb", name: "Firebomb", rarity: "rare", fireCd: 0.8, speed: 360, life: 0.6,
    damage: 3.6, pellets: 1, spread: 0, bulletRadius: 8, color: "#ff7a3b", muzzle: 5,
    blast: 56, burn: 2,
    special: "Shells detonate on impact and set the whole blast ablaze — a short-armed lob.",
  },
  // RUN DOWN A RUNNER: one heavy seeking slug for the body that keeps slipping your aim.
  // The Wisp sprays soft seekers; the Tracker commits a single hard-hitting hunter.
  tracker: {
    id: "tracker", name: "Tracker", rarity: "rare", fireCd: 0.85, speed: 460, life: 1.5,
    damage: 9.3, pellets: 1, spread: 0, bulletRadius: 6, color: "#8affe0", muzzle: 3,
    homing: 5,
    special: "One slow, heavy round that seeks the nearest enemy — a hunter that never misses.",
  },
  // ---- legendary ----
  // COLLAPSE, THEN DETONATE: the round implodes to yank the scattered pack onto one point,
  // then a beat later a nova bursts on the clump. The Lodestone only gathers; the
  // Singularity gathers AND finishes — a two-stage black hole into a star.
  singularity: {
    id: "singularity", name: "Singularity", rarity: "legendary", fireCd: 1.15, speed: 470, life: 1.3,
    damage: 2.0, pellets: 1, spread: 0, bulletRadius: 7, color: "#c58bff", muzzle: 4,
    implode: 116, nova: 78,
    special: "Shots collapse the pack onto one point, then a nova detonates on the clump.",
  },
  mooring_nail: {
    id: "mooring_nail", name: "MOORING NAIL", rarity: "common", fireCd: 0.42, speed: 760, life: 1.2,
    damage: 2, pellets: 1, spread: 0, bulletRadius: 5, color: "#d6c7a1", muzzle: 2,
    basePierce: 4,
    grapple: { pull: 150 },
    special: "ANCHOR / GRAPPLE — a nail biting a wall yanks you toward its anchor point.",
  },
  sluicegate: {
    id: "sluicegate", name: "SLUICEGATE", rarity: "rare", fireCd: 0.58, speed: 430, life: 0.45,
    damage: 1.1, pellets: 5, spread: 0.76, bulletRadius: 5, color: "#78cbd1", muzzle: 5,
    modeShift: {
      alternate: {
        damage: 7, pellets: 1, spread: 0, speed: 900, life: 1.1,
        bulletRadius: 5, basePierce: 2,
      },
    },
    special: "MODESHIFT — alternates a wide FLOOD fan with a long, piercing DRAIN lance.",
  },
  oddsmaker: {
    id: "oddsmaker", name: "ODDSMAKER", rarity: "legendary", fireCd: 0.4, speed: 600, life: 1.1,
    damage: 3.3, pellets: 1, spread: 0, bulletRadius: 6, color: "#efb85f", muzzle: 3,
    gamble: { outcomes: ["ricochet", "seeker", "blast", "pierce"] },
    special: "GAMBLE — every shot independently rolls a ricochet, seeker, blast, or piercing payload; repeats are possible.",
  },
  pathmaker: {
    id: "pathmaker", name: "PATHMAKER", rarity: "rare", fireCd: 0.18, speed: 340, life: 1.15,
    damage: 0.9, pellets: 1, spread: 0.03, bulletRadius: 6, color: "#a8d7a0", muzzle: 1,
    paint: { spacing: 28, radius: 27, life: 3.2, chillRate: 0, isPaving: true },
    special: "CLEANSE / PAVE — beads erase hostile ground and leave a safe route across floor hazards.",
  },
};

export const DEFAULT_WEAPON: WeaponId = "pistol";

// Weapons that can appear as floor pickups (the pistol is the always-owned default).
export const PICKUP_WEAPONS: readonly WeaponId[] =
  contentCatalogFor(CURRENT_CONTENT_CATALOG_VERSION).pickupWeapons;

// The legendary tier of the pickup pool (derived once — gates and premium rolls read it).
export const LEGENDARY_WEAPONS: readonly WeaponId[] =
  PICKUP_WEAPONS.filter((id) => WEAPONS[id].rarity === "legendary");

// ---- the ONE rarity tier roll (every weapon drop source reads this) ----
// Free drops compose rarity with the per-run shuffled bag (weaponBag.ts): the roll first
// decides a TIER here — weighted by (tier weight x pool count), floor-gated, identical
// solo/co-op per §4 — then deals the next undealt weapon OF that tier from the bag, so
// rarity weighting and the anti-repeat deal never fight. Shop stock rolls tiers off its
// own pure stream the same way. Consumes EXACTLY one rand() per call (deterministic draw
// count — placement streams stay reproducible).

export interface RarityRollOpts {
  // Boss chests: the premium container — the legendary tier weight is boosted.
  isPremium?: boolean;
  // Mystery reveals gamble PAST the legendary floor gate at the boosted mystery weight.
  isMystery?: boolean;
  // The premium economy's depth-boosted mystery gamble: an explicit legendary tier
  // weight (per milestone band — see premiumMysteryLegendaryWeight) over the same roll.
  legendaryWeight?: number;
}

export function rollWeaponRarity(
  rand: () => number,
  floor: number,
  opts: RarityRollOpts = {},
  catalogVersion: ContentCatalogVersion = CURRENT_CONTENT_CATALOG_VERSION,
): WeaponRarity {
  const pickupWeapons = contentCatalogFor(catalogVersion).pickupWeapons;
  const isLegendaryOpen = opts.isMystery === true || floor >= LEGENDARY_MIN_FLOOR;
  const tiers: WeaponRarity[] = ["common", "rare", "legendary"];
  const weightOf = (tier: WeaponRarity): number => {
    if (tier === "legendary" && !isLegendaryOpen) return 0;
    const perWeapon = tier === "legendary" && opts.legendaryWeight !== undefined ? opts.legendaryWeight
      : tier === "legendary" && opts.isMystery ? MYSTERY.legendaryWeight
      : tier === "legendary" && opts.isPremium ? WEAPON_RARITY_WEIGHT.legendary * BOSS_CHEST_LEGENDARY_MULT
      : WEAPON_RARITY_WEIGHT[tier];
    return perWeapon * pickupWeapons.filter((id) => WEAPONS[id].rarity === tier).length;
  };
  let total = 0;
  for (const tier of tiers) total += weightOf(tier);
  let r = rand() * total;
  for (const tier of tiers) {
    r -= weightOf(tier);
    if (r <= 0 && weightOf(tier) > 0) return tier;
  }
  return "common";
}

// The one rarity accent palette (pickup glow, loot flash, hotbar frame, tooltip badge —
// every surface reads the same swatch). MYSTERY_COLOR is the "???" treatment.
export const WEAPON_RARITY_COLOR: Record<WeaponRarity, string> = {
  common: "#ffb43b",
  rare: "#7fb8ff",
  legendary: "#ffd700",
};
export const MYSTERY_COLOR = "#c98bff";

// The mystery pickup's blessed/cursed twist, baked at spawn (one rand() per roll).
export function rollMysteryTwist(rand: () => number): MysteryTwist {
  const r = rand();
  if (r < MYSTERY.blessedChance) return "blessed";
  if (r < MYSTERY.blessedChance + MYSTERY.cursedChance) return "cursed";
  return "plain";
}

// Hard caps on authored entity counts the pellet mods can raise (Split Shot/Scattergun
// map onto "more authored entities" for the effect weapons — bounded so the wire and the
// frame stay bounded too).
export const MAX_WIRES = 5;
// Party-wide trap budget (balancer envelope): the WORLD holds at most this many armed
// wires regardless of who planted them — the globally oldest gives way. Traps hold
// doorways; four players may not lattice the whole floor.
export const MAX_WIRES_PARTY = 6;
export const MAX_ORBIT_BLADES = 6;

// A resolved shot: the base weapon merged with the player's in-run item mods. Built
// once per trigger-pull in the game core so fire() stays a pure geometry helper.
export interface ShotSpec {
  pellets: number;
  // The weapon's NATIVE pellet count (before Split Shot / Scattergun additions): added
  // pellets hit boss-grade bodies at a reduced coefficient (balancer remediation).
  basePellets: number;
  spread: number;
  speed: number;
  life: number;
  radius: number;
  color: string;
  damage: number;      // per-pellet damage, already scaled by damage mods
  pierce: number;
  critChance: number;
  critMult: number;
  fx?: WeaponId;       // render recipe tag, stamped onto each bullet (see renderBullets)
  // Carried straight from the weapon (item mods never touch these) and stamped onto
  // each bullet. Undefined for weapons without the behavior.
  bounce?: number;
  homing?: number;
  chain?: number;
  chainRange?: number;
  blast?: number;
  burn?: number;
  chill?: number;
  shock?: number;
  killShards?: number;
  accel?: number;
  isPhase?: boolean;
  implode?: number;
  nova?: number;
  // Frostline painting, resolved with mods at fire time (size -> zone radius, life ->
  // zone duration) and stamped onto each bead.
  paintSpacing?: number;
  paintRadius?: number;
  paintLife?: number;
  paintRate?: number;
  isPaving?: boolean;
  grapplePull?: number;
  reclaimedBounceDamage?: number;
  paintZonesLeft?: number;
  shotSeq?: number;
  sluiceMode?: SluiceMode;
  oddsmakerOutcome?: OddsmakerOutcome;
}

const CRIT_COLOR = "#fff3c4";

// The seeded sim Rng is threaded in so pellet jitter + crit rolls are deterministic
// (required for the golden-master oracle and for later client prediction). `owner` is the
// firing player's id, stamped onto each bullet for authoritative kill/loot attribution.
export function fire(spec: ShotSpec, x: number, y: number, aim: number, rng: Rng, owner: PlayerId): Bullet[] {
  const shots: Bullet[] = [];
  // Boss-facing shot coefficient, baked per bullet (rooms always take full damage):
  // native pellets beyond the first count at BOSS_NATIVE_PELLET_COEF, ADDED pellets
  // (Split Shot / Scattergun) at BOSS_EXTRA_PELLET_COEF, and a few weapons carry their
  // own coefficient (WEAPON_BOSS_COEF). Spread uniformly over the volley so bullet
  // order never matters (deterministic, replay-safe).
  const extra = Math.max(0, spec.pellets - spec.basePellets);
  const native = spec.pellets - extra;
  const isHomingSplit = spec.homing !== undefined && extra > 0;
  const allowedExtraHomers = Math.max(0, HOMING_SPLIT.maxHomingPellets - spec.basePellets);
  const extraDamageMult = isHomingSplit ? HOMING_SPLIT.extraDamageMult : 1;
  const volleyDamageWeight = native + extra * extraDamageMult;
  const effective = 1 + Math.max(0, native - 1) * BOSS_NATIVE_PELLET_COEF + extra * BOSS_EXTRA_PELLET_COEF;
  const pelletBossCoef = (effective / volleyDamageWeight) * (spec.fx !== undefined ? WEAPON_BOSS_COEF[spec.fx] ?? 1 : 1);
  for (let i = 0; i < spec.pellets; i++) {
    const isExtra = i >= spec.basePellets;
    const damageMult = isExtra ? extraDamageMult : 1;
    let homing = spec.homing;
    if (isHomingSplit && isExtra) {
      const extraIndex = i - spec.basePellets;
      homing = homing !== undefined && extraIndex < allowedExtraHomers
        ? homing * HOMING_SPLIT.extraTurnRateMult
        : undefined;
    }
    const isAnchorPellet = spec.grapplePull !== undefined && i === 0;
    // Mooring Nail: pellet0 is the sole centered grapple anchor. Extra pellets fan
    // symmetrically around aim via t=(i/(n-1))-0.5 over the EXTRA set only — never
    // pin-asymmetry from including the anchored center in the fan denominator.
    const grappleExtraCount = spec.grapplePull !== undefined ? spec.pellets - 1 : 0;
    const t = spec.pellets === 1 || isAnchorPellet
      ? 0
      : spec.grapplePull !== undefined
        ? grappleExtraCount === 1 ? 0 : ((i - 1) / (grappleExtraCount - 1)) - 0.5
        : (i / (spec.pellets - 1)) - 0.5;
    const jitter = spec.grapplePull !== undefined
      ? 0
      : (rng.next() - 0.5) * (spec.spread * 0.3);
    const a = aim + t * spec.spread + jitter;
    const isCrit = spec.critChance > 0 && rng.next() < spec.critChance;
    shots.push({
      x, y,
      vx: Math.cos(a) * spec.speed,
      vy: Math.sin(a) * spec.speed,
      radius: spec.radius,
      life: spec.life,
      friendly: true,
      owner,
      damage: (isCrit ? spec.damage * spec.critMult : spec.damage) * damageMult,
      color: isCrit ? CRIT_COLOR : spec.color,
      pierce: spec.pierce,
      hitList: null,
      isCrit,
      enemyHits: 0,
      critX: isCrit ? spec.critMult : 1,
      bossCoef: pelletBossCoef,
      fx: spec.fx,
      bounce: spec.bounce,
      homing,
      chain: spec.chain,
      chainRange: spec.chainRange,
      blast: spec.blast,
      burn: spec.burn,
      chill: spec.chill,
      shock: spec.shock,
      killShards: spec.killShards,
      accel: spec.accel,
      isPhase: spec.isPhase,
      phaseFireX: spec.isPhase === true ? x : undefined,
      phaseFireY: spec.isPhase === true ? y : undefined,
      implode: spec.implode,
      nova: spec.nova,
      paintSpacing: spec.paintSpacing,
      paintRadius: spec.paintRadius,
      paintLife: spec.paintLife,
      paintRate: spec.paintRate,
      paintDist: spec.paintSpacing !== undefined ? 0 : undefined,
      isPaving: spec.isPaving,
      grapplePull: spec.grapplePull,
      reclaimedBounceDamage: spec.reclaimedBounceDamage,
      paintZonesLeft: spec.paintZonesLeft,
      shotSeq: spec.shotSeq,
      sluiceMode: spec.sluiceMode,
      oddsmakerOutcome: spec.oddsmakerOutcome,
    });
  }
  return shots;
}
