// The v1 KIT / CLASS + ULT-METER + account-MASTERY model (docs/specs/blobrogue_KIT_XP_SYSTEM_spec.md).
// One deterministic, dependency-light module the pure sim, the authoritative server, the Convex
// mint, and the client lobby all read — the SAME data on every side, exactly like balance.ts.
//
// Design contract (spec §0, §1, §7):
//  - A kit is one stat lean + one passive + one signature ULTIMATE. It is a different ROUTE to
//    the committed raw caps, never a higher ceiling (clampModCaps still rules — see items.ts).
//  - The ult METER is server-owned authoritative FIXED-POINT: an integer 0..ULT_METER_MAX. All
//    accrual is integer arithmetic, so the meter never carries float drift and reads crisply in a
//    golden master. The time trickle keys off the integer world tick (never wall-clock).
//  - Mastery XP is an ACCOUNT-level access track — it gates WHICH kits you may pick, never a stat
//    or a spendable balance (§4). The unlock check is pure + shared so the server, the Convex
//    mint, and the lobby all agree byte-for-byte.
//
// Numbers here are the spec's design targets; the balancer owns final tuning of the K_* charge
// coefficients + ult magnitudes and may retune them without touching the model.
//
// §10 BALANCER STRUCTURAL ADDENDUM (2026-07-10): this module is the ONE kit-tuning surface —
// every K_* charge weight, per-source share cap, Overdrive fire factor + expressive ceiling,
// Mender HoT + the per-target/party incoming-heal clamp, Aegis HP constant + duration, and the
// Phase invuln/speed/duration live here as named constants so the balancer sets finals WITHOUT
// touching logic. The charge model is normalized target-agnostic (charge% per hit scales by the
// floor's RefEncounterHP, not raw damage) so ults don't charge faster on low-HP early floors.

import type { PlayerMods } from "./items.js";
import { refDpsForFloor, floorHpMult } from "./balance.js";

// "none" is the pre-kit NEUTRAL baseline: a player who never went through kit-select (legacy
// solo quick-start, the harness, every existing golden/balance scenario) carries it, and ALL
// kit behaviour (stat lean, passive, ult meter, ult) is a no-op for it — so the shipped sim
// stays byte-identical unless a real kit is chosen. The four v1 kits are the spec's roster.
export type KitId = "none" | "gunner" | "mender" | "bulwark" | "phantom";

// The playable v1 kits in stable pick order (lobby layout + deterministic iteration).
export const KIT_IDS: readonly Exclude<KitId, "none">[] = ["gunner", "mender", "bulwark", "phantom"];

export function isKitId(v: unknown): v is KitId {
  return v === "none" || v === "gunner" || v === "mender" || v === "bulwark" || v === "phantom";
}

// A real (non-neutral) kit — the one predicate every "does kit logic run for this player?" gate
// keys off, so the neutral baseline is inert everywhere by construction.
export function isRealKit(kit: KitId): kit is Exclude<KitId, "none"> {
  return kit !== "none";
}

// ---- the universal ULT METER (spec §3) ----

// The charge SOURCES the meter tracks. "time" is the combat-gated trickle FLOOR (uncapped —
// it fills whatever the capped sources leave); every other source is share-capped so no single
// input dominates one fill (§10).
export type UltSource = "dmg" | "kill" | "taken" | "heal" | "dash" | "time";

export const ULT = {
  // The meter is a fixed-point INTEGER 0..meterMax = 0..100.00% (hundredths of a percent), so
  // the target-agnostic normalization keeps crisp resolution and reads cleanly in a golden.
  meterMax: 10000,
  // ---- BALANCER charge WEIGHTS (§10): charge% per hit is target-agnostic ----
  //   dmg:  charge = meterMax × (dmgDealt / RefEncounterHP) × K_dmg
  //   kill: charge = meterMax × K_kill                      (flat meter fraction per kill)
  //   taken (BULWARK): meterMax × (dmgTaken / maxHp) × K_taken
  //   heal  (MENDER):  meterMax × K_heal × hpHealed         (meter fraction per HP healed)
  //   dash  (PHANTOM): meterMax × K_dash                    (flat meter fraction per dash)
  K_dmg: 0.35,
  K_kill: 0.015,
  K_taken: 0.70,
  K_heal: 0.02,
  K_dash: 0.04,
  // Per-source contribution SHARE caps toward ONE meter fill (§10: no single input dominates —
  // AoE-farming trash can't perma-charge while a boss-only fight starves). Fractions of meterMax;
  // "time" is uncapped (it is the floor). A source stops contributing once it hits its share.
  shareCap: { dmg: 0.70, kill: 0.40, taken: 0.85, heal: 0.70, dash: 0.70, time: 1 } as Record<UltSource, number>,
  // Time FLOOR (§10): encounter-relative + combat-gated. Guarantee ~1 ult by ~combatFillSeconds
  // of sustained combat even at low DPS; accrues ONLY while a hostile enemy is alive/aggro
  // (never in empty rooms). Per-tick grant = meterMax / (combatFillSeconds × TICK_HZ).
  combatFillSeconds: 55,
  // 8.0s hard floor between casts (spec §3), in ticks at TICK_HZ 20. Charge KEEPS accruing during
  // the lockout (clamped ≤ meterMax) and never resets on floor descent or weapon swap (§10).
  lockoutTicks: 160,
  // RefEncounterHP normalization ANCHOR (§10): a floor-1 encounter's expected effective HP,
  // scaled by the §3 floor HP curve — so a fill tracks per-ENCOUNTER progress, not raw damage,
  // and deep floors don't charge slower/faster than early ones per encounter.
  refEncounterHpAnchor: 600,
} as const;

// The authoritative tick rate (TICK_HZ), mirrored here so this module stays dependency-light
// (no protocol import). Ult windows are authored in ticks; the sim's buff timers decay in
// seconds, so this converts at cast time.
export const TICKS_PER_SECOND = 20;
export function ticksToSec(ticks: number): number {
  return ticks / TICKS_PER_SECOND;
}

// Ready === meter full. (Cooldown is the SEPARATE ultReadyAtTick gate.)
export function isUltMeterFull(charge: number): boolean {
  return charge >= ULT.meterMax;
}

// The authoritative "may this player cast right now?" predicate: meter full AND past the 8s
// lockout. Server-only truth — a client can request, never decide.
export function canCastUlt(charge: number, tick: number, readyAtTick: number): boolean {
  return isUltMeterFull(charge) && tick >= readyAtTick;
}

// Clamp a raw charge value into the fixed-point meter range.
export function clampUltCharge(charge: number): number {
  return charge < 0 ? 0 : charge > ULT.meterMax ? ULT.meterMax : Math.floor(charge);
}

// The floor's expected effective HP (§10): the RefEncounterHP the charge calc normalizes damage
// against, so a fill tracks per-encounter progress across depths. A per-floor value the sim reads.
export function refEncounterHpForFloor(floor: number): number {
  return ULT.refEncounterHpAnchor * floorHpMult(floor);
}
// The floor's reference DPS (§10): drives the encounter-scaled Aegis HP budget. Wraps the R
// framework's per-floor practical output so the two never drift.
export function refEncounterDpsForFloor(floor: number): number {
  return refDpsForFloor(floor);
}

// ---- target-agnostic charge contributions (§10), in fixed-point meter units ----
export function ultChargeFromDamageDealt(dmg: number, refEncounterHp: number): number {
  if (dmg <= 0 || refEncounterHp <= 0) return 0;
  return Math.max(0, Math.round(ULT.meterMax * (dmg / refEncounterHp) * ULT.K_dmg));
}
export function ultChargeFromKill(): number {
  return Math.max(0, Math.round(ULT.meterMax * ULT.K_kill));
}
export function ultChargeFromDamageTaken(dmg: number, maxHp: number): number {
  if (dmg <= 0 || maxHp <= 0) return 0;
  return Math.max(0, Math.round(ULT.meterMax * (dmg / maxHp) * ULT.K_taken));
}
export function ultChargeFromHealDone(hp: number): number {
  return Math.max(0, Math.round(ULT.meterMax * ULT.K_heal * hp));
}
export function ultChargeFromDash(): number {
  return Math.max(0, Math.round(ULT.meterMax * ULT.K_dash));
}
// The combat-gated time-floor grant per tick (≥1 so a long low-DPS boss fight still charges).
export function ultTimeChargePerTick(): number {
  return Math.max(1, Math.round(ULT.meterMax / (ULT.combatFillSeconds * TICKS_PER_SECOND)));
}
// A source's absolute share cap in meter units (§10). "time" is uncapped (the floor).
export function ultShareCapUnits(source: UltSource): number {
  return Math.round(ULT.shareCap[source] * ULT.meterMax);
}

// ---- per-kit ULTIMATE numbers (spec §2), quantized to the 50ms tick ----
// Every second-value is expressed in ticks (TICK_HZ 20) so the sim reasons in integer ticks.

export const OVERDRIVE = {
  durationTicks: 100,   // 5.0s self-buff window (spec §2.1)
  // §10: a SEPARATE multiplicative fire-rate LAYER — never added to mods.fireRateMult (which
  // would collide with the 1.8x raw cap). fireFactor multiplies the live fire rate; the COMBINED
  // result (blessings × fireFactor) is then clamped to expressiveFireCeiling — the fire-rate
  // portion of the ~7x expressive DPS ceiling — so a strong build + Overdrive can't blow past it.
  fireFactor: 1.9,
  expressiveFireCeiling: 3.6, // max effective fire-rate mult under Overdrive (balancer-owned)
  bonusPierce: 2,       // temporary +pierce (spec §2.1)
} as const;

export const SANCTUARY = {
  radius: 120,          // ~2.5 tiles (spec §2.2)
  lifetimeTicks: 80,    // 4.0s deterministic zone lifetime
  burstHeal: 2,         // on-cast burst heal to allies inside (HP)
  // HoT: +1 HP every heal period to each ally inside, but ALL Mender healing (Lifebloom +
  // Sanctuary, any number of Menders) shares ONE per-target/party incoming-heal budget below —
  // so it tops people off but can NEVER out-heal all incoming damage and never double-stacks (§10).
  healEveryTicks: 20,   // 1.0s cadence -> 1 HP/s
  healPerTick: 1,
} as const;

// §10 per-target SERVER-SIDE incoming-heal clamp: the ONE budget Lifebloom + Sanctuary (and any
// number of Menders) share, so combined Mender output to one ally never exceeds perTargetHpPerSec
// and party-wide never exceeds partyHpPerSec — regardless of Mender count. Overheal is discarded
// on top. HP is integer, so a fractional per-second budget admits whole HP up to its floor.
export const MENDER_HEAL_CLAMP = {
  perTargetHpPerSec: 1.5, // one ally: combined Mender HoT ≤ this
  partyHpPerSec: 3.0,     // whole party: combined Mender HoT ≤ this
} as const;

export const LIFEBLOOM = {
  // Fraction of damage DEALT returned as heal credit to the lowest-HP ally in range (self if
  // none). Credit accumulates in the per-kit passive channel and pays out in WHOLE HP on a
  // capped cadence, so it never exceeds the heal/sec cap and HP stays integer (spec §2.2).
  fraction: 0.10,       // ~8-12% band
  poolCap: 4,           // never bank more than this much pending heal (anti-burst)
  healEveryTicks: 20,   // 1.0s cadence
  healPerTick: 1,       // <= ~1 HP/s
  range: 260,           // "in range" radius for the lowest-HP ally search
} as const;

export const AEGIS = {
  radius: 110,          // deployed dome (spec §2.3)
  lifetimeTicks: 80,    // 4.0s OR the HP budget, whichever first (spec §9.2)
  // §10: the barrier HP budget SCALES WITH THE ENCOUNTER, not a flat value —
  //   hpBudget = clamp(round(hpConstant × RefEncounterDPS(floor) × durationSeconds), hpMin, hpMax)
  // so a deep-floor dome blocks proportionally more incoming fire. Each blocked enemy projectile
  // costs 1 HP; the dome falls on duration OR HP, whichever first.
  hpConstant: 0.14,
  hpMin: 8,
  hpMax: 40,
} as const;

// The encounter-scaled Aegis HP budget for a floor (§10). Pure so the sim + tests agree.
export function aegisHpBudgetForFloor(floor: number): number {
  const raw = AEGIS.hpConstant * refEncounterDpsForFloor(floor) * ticksToSec(AEGIS.lifetimeTicks);
  return Math.max(AEGIS.hpMin, Math.min(AEGIS.hpMax, Math.round(raw)));
}

export const PHASE = {
  // Brief invuln — authored ≤ 1.0s (§10), HARD-CAPPED ≤ 1.2s to stay under the boss "no invuln
  // > 1.2s" rule (spec §9.1). One Phase can't trivialize a single ≤1.2s forced transition, and
  // the 8s lockout stops chaining across one.
  invulnTicks: 20,      // 1.0s
  invulnCapTicks: 24,   // 1.2s absolute cap (server clamps invulnTicks to this)
  speedTicks: 60,       // 3.0s speed surge
  // §10: the speed surge is an EXEMPT short ULT BURST (≤1.4× ≤3s) — plumbed as a SEPARATE
  // multiplier applied AFTER the capped mods, so the shared 1.35× raw mover cap never clamps it.
  speedMult: 1.4,
  allyRadius: 90,       // self + allies within ~90px at cast (spec §2.4)
} as const;

// GUNNER MOMENTUM (spec §2.1): consecutive hits WITHOUT taking damage ramp a small live bonus,
// fully decaying on taking ANY damage. Stacks are the per-kit passive channel (integer).
export const MOMENTUM = {
  maxStacks: 5,          // ramps over ~5 landed hits
  damagePerStack: 0.03,  // +15% damage at max (5 x 3%)
  fireRatePerStack: 0.02,// +10% fire rate at max (5 x 2%)
} as const;

export const HARDENED = {
  // Flat small damage reduction (spec §2.3) — NO invuln. Applied inside the damage-taken math
  // BEFORE any co-op/mode pressure (§10). Integer HP is preserved by SOAKING the reduced fraction
  // into the passive channel and only ever negating WHOLE points, so the realized reduction
  // converges on this rate without fractional hearts.
  reduction: 0.15,
} as const;

// §10: total damage reduction from ALL sources is clamped here — Hardened (0.15) is the only DR
// today, but any future DR must sum under this ceiling (no stacking past ~25% total DR).
export const MAX_TOTAL_DR = 0.25;

// The MENDER's faster ally revive (spec §2.2): the channel accrues at this multiple while a
// mender is the reviver.
export const MENDER_REVIVE_SPEED = 1.5;

// Apply a kit's static STAT LEAN onto a freshly-recomputed mods struct (called from
// recomputeMods AFTER blessings, BEFORE clampModCaps — so the lean composes with blessings and
// is clamped to the SAME raw caps: a different route to the cap, never a higher one, spec §1).
export function applyKitStatLean(m: PlayerMods, kit: KitId): void {
  switch (kit) {
    case "gunner":
      m.damageMult += 0.12;
      m.fireRateMult += 0.12;
      break;
    case "mender":
      m.maxHpBonus += 2; // counts vs the shared +4 cap
      break;
    case "bulwark":
      m.maxHpBonus += 2; // counts vs the shared +4 cap
      m.moveSpeedMult *= 0.92; // slightly slower, still well above any floor
      break;
    case "phantom":
      m.moveSpeedMult += 0.15; // clamped to the 1.35x move cap
      m.extraDashCharge += 1;  // +1 dash charge (clamped at 1)
      m.dashCdMult *= 0.85;    // shorter dash cooldown (Slipstream)
      break;
    case "none":
      break;
  }
}

// ---- account MASTERY (spec §4): XP -> level -> which kits are UNLOCKED ----
// XP is NOT a currency and NOT spendable — it gates ACCESS only. The unlock thresholds are the
// spec's v1 numbers (balancer/CD may retune the level values, never the model).

export const MASTERY = {
  // XP granted at run end from run PERFORMANCE (spec §4): floors cleared (primary), bosses
  // defeated (bonus), run depth. Earned every run, win or lose — a cleared floor always pays.
  xpPerFloorCleared: 100,
  xpPerBossDefeated: 250,
  xpPerDepth: 20,
  // A simple linear XP-per-level curve; the level is what unlock thresholds read.
  xpPerLevel: 500,
  // Unlock thresholds (spec §4): account level a kit becomes selectable at.
  unlockLevel: { gunner: 1, mender: 1, bulwark: 3, phantom: 5 } as Record<Exclude<KitId, "none">, number>,
} as const;

// The account MASTERY level for a lifetime XP total (level 1 at 0 XP).
export function masteryLevelForXp(xp: number): number {
  if (!Number.isFinite(xp) || xp <= 0) return 1;
  return 1 + Math.floor(xp / MASTERY.xpPerLevel);
}

// The account level a kit unlocks at (gunner/mender start at 1).
export function kitUnlockLevel(kit: Exclude<KitId, "none">): number {
  return MASTERY.unlockLevel[kit];
}

// SERVER-SIDE unlock gate (spec §9.5): is this kit unlocked for an account at `level`? Never
// trust a client claiming an unowned kit — this is the one predicate the mint AND the game
// server validate against.
export function isKitUnlocked(kit: KitId, level: number): boolean {
  if (kit === "none") return true;
  if (!isKitId(kit)) return false;
  return level >= kitUnlockLevel(kit);
}

// The set of kits unlocked at an account level, in pick order (lobby convenience).
export function unlockedKits(level: number): KitId[] {
  return KIT_IDS.filter((k) => isKitUnlocked(k, level));
}

// Deterministic run-end XP grant (spec §4). Pure so the Convex fold, the server, and any test
// compute the identical amount from the same run stats.
export interface RunMasteryStats {
  floorsCleared: number;
  bossesDefeated: number;
  depth: number; // deepest floor reached
}
export function masteryXpForRun(s: RunMasteryStats): number {
  const floors = Math.max(0, Math.floor(s.floorsCleared));
  const bosses = Math.max(0, Math.floor(s.bossesDefeated));
  const depth = Math.max(0, Math.floor(s.depth));
  return floors * MASTERY.xpPerFloorCleared + bosses * MASTERY.xpPerBossDefeated + depth * MASTERY.xpPerDepth;
}

// Human-facing kit metadata (lobby cards + the locked-kit aspiration readout, spec §5). Pure
// data — the sim never reads it.
export interface KitMeta {
  id: Exclude<KitId, "none">;
  name: string;
  role: string;
  ult: string;
  blurb: string;
}
export const KIT_META: Readonly<Record<Exclude<KitId, "none">, KitMeta>> = {
  gunner: { id: "gunner", name: "Gunner", role: "DPS", ult: "Overdrive", blurb: "Reliable rifle carry. Momentum ramps as you go unhit; Overdrive melts an exposed boss." },
  mender: { id: "mender", name: "Mender", role: "Healer", ult: "Sanctuary", blurb: "Beam support with real offense. Lifebloom tops the lowest ally; Sanctuary drops a heal pocket." },
  bulwark: { id: "bulwark", name: "Bulwark", role: "Tank", ult: "Aegis", blurb: "Scattergun anchor. Hardened shrugs off chip; Aegis deploys a bullet-blocking dome." },
  phantom: { id: "phantom", name: "Phantom", role: "Mobility", ult: "Phase", blurb: "Fast dual-wield trickster. Slipstream adds a dash; Phase blinks the team out of danger." },
};

// The kit each kit STARTS with equipped (spec §2). The sim already owns the weapon roster; this
// is the archetype hand-off the lobby/spawn applies.
export const KIT_START_WEAPON: Record<Exclude<KitId, "none">, string> = {
  gunner: "pistol",   // reliable mid-range rifle (Camp Iron neutral archetype)
  mender: "beam",     // mid-range beam/wand with steady damage (solo-viable)
  bulwark: "sawnoff", // short-range scattergun
  phantom: "smg",     // fast SMG
};
