// The shared PRACTICAL-DPS + BOSS-TTK harness (extracted from test/balance.test.ts so the
// balance ship gates AND the kit/ult balance gates read the SAME model — one estimator, one
// sim measurement, never a re-implementation). Nothing here is live telemetry: the DPS
// estimator is the documented 12s-moving-target model and the TTK measurements are seeded
// sim-harness runs with scripted aggression. Constants (RefDPS, boss coefficients, the
// pistol baseline) are read from src/sim/balance.ts so the gates track future retunes.

import {
  createWorld, stepWorld, devSpawnEnemy, acquireWeaponInWorld, applyItemToWorld,
  isBossExposed, setPlayerKit,
} from "../src/sim/world.js";
import type { WorldState } from "../src/sim/world.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import { LOCAL_ID } from "../src/sim/input.js";
import type { Bullet, EnemyKind, WeaponId } from "../src/sim/types.js";
import {
  BOSS_EXTRA_PELLET_COEF, BOSS_NATIVE_PELLET_COEF, SIDE_CHANNEL, WEAPON_BOSS_COEF, BOSS_VULN_CAP,
} from "../src/sim/balance.js";
import {
  canonicalItemId, itemById, createMods, recomputeMods, normalItemsForCatalog, rollItemChoicesWith,
} from "../src/sim/items.js";
import type { PlayerMods } from "../src/sim/items.js";
import { WEAPONS, isSideChannelProjectileWeapon } from "../src/sim/weapons.js";
import { Rng } from "../src/sim/rng.js";
import { OVERDRIVE, ULT, ticksToSec } from "../src/sim/kits.js";
import type { KitId } from "../src/sim/kits.js";
import * as C from "../src/sim/constants.js";
import {
  CURRENT_CONTENT_CATALOG_VERSION,
  contentCatalogFor,
} from "../src/sim/contentCatalog.js";
import type { ContentCatalogVersion } from "../src/sim/contentCatalog.js";

export const DT = 1 / 60;

// A three-level pick shorthand (a maxed blessing), shared by the build fixtures.
export const L3 = (id: string): string[] => [id, id, id];

// A friendly test bullet planted directly on a target (resolves through the ordinary strike
// path: attribution, boss transition machinery, kill, loot).
export function plantBullet(w: WorldState, x: number, y: number, damage: number, radius = 20): void {
  const b: Bullet = {
    x, y, vx: 1, vy: 0, radius, life: 0.05, friendly: true, owner: LOCAL_ID,
    damage, color: "#fff", pierce: 0, hitList: null, isCrit: false,
  };
  w.bullets.push(b);
}

export function idle(seq: number): InputCmd {
  return { seq, moveX: 0, moveY: 0, aim: 0, firing: false, dash: false };
}

export function step(w: WorldState, cmd: InputCmd): SimEvent[] {
  return stepWorld(w, new Map<PlayerId, InputCmd>([[LOCAL_ID, cmd]]), DT);
}

export function grant(w: WorldState, pid: PlayerId, ids: string[]): void {
  for (const id of ids) {
    const def = itemById(id);
    if (!def) throw new Error(`unknown item ${id}`);
    applyItemToWorld(w, pid, def);
  }
}

// ---- the boss-TTK sim harness (studio gate §3) ----

export interface TtkResult {
  seconds: number;
  killed: boolean;
  transitions: Array<{ entering: boolean; at: number; queued: number }>;
  // Balancer report channels: total forced-transition time, (Warden) closed-plate time,
  // and — the earned-windows gate currency — total time the boss was EXPOSED.
  transitionSeconds: number;
  closedArmorSeconds: number;
  exposedSeconds: number;
}

// Optional kit + OVERDRIVE overlay for the kit gates. Default {} reproduces the plain
// balance-suite measurement byte-for-byte.
//   - `kit` puts the player on a kit (its stat lean + passive apply through the shipped path).
//   - `forceOverdrive` drives the SHIPPED Overdrive fire-boost window (p.overdriveT, read by
//     currentFireRate) at its cooldown-limited MAXIMUM: one 5s window per 8s lockout, for the
//     WHOLE fight. The shipped currentFireRate applies Overdrive ONLY for the gunner kit, so
//     forceOverdrive is meaningful only with kit: "gunner". Forcing overdriveT (rather than a
//     natural cast) grants the balancer's "Overdrive AVAILABLE and perfectly-timed" premise —
//     the design's 8s cooldown is the only limiter, an upper bound on realizable uptime.
export interface MeasureBossOpts {
  kit?: KitId;
  forceOverdrive?: boolean;
}

// The scripted-aggression harness PLAYS THE MECHANICS (an earned-window boss measured by a
// bot that ignores its mechanics would only measure the guard chip):
//  - Weaver: shoot the EGG-SAC clutch first (P2's forced-down switch), then a live lattice
//    KNOT (P1 breaks; P3 lane denial makes her dashes overshoot), then the body.
//  - Choir: shoot the live FRAGMENT verse first (silence opens the window), circle-strafing.
//  - MARROW: shadow it wall-side, freeze until the rush LOCKS, then sidestep — the committed
//    rush carries past into the wall (the bait that opens its window).
//  - Warden/King: stationary focus (the Warden's windows are its recovers).
export function measureBossTtk(
  weapon: WeaponId,
  picks: string[],
  boss: { kind: EnemyKind; floor: number } = { kind: "boss", floor: 5 },
  opts: MeasureBossOpts = {},
): TtkResult {
  const w = createWorld(0xBA1A4CE, boss.floor, { isSandbox: true });
  w.isGodMode = true;
  const p = w.players.get(LOCAL_ID)!;
  if (opts.kit) setPlayerKit(w, LOCAL_ID, opts.kit);
  acquireWeaponInWorld(w, LOCAL_ID, weapon);
  grant(w, LOCAL_ID, picks);
  const target = devSpawnEnemy(w, boss.kind, p.x + 170, p.y);
  // The sandbox arena's inner bounds (buildArena: 34×24 tiles, 1-tile border) and the marrow
  // bait geometry: hold this far off the boss toward its nearest wall.
  const arena = { x0: 48, y0: 48, x1: 33 * 48, y1: 23 * 48 };
  const baitPoint = (): { x: number; y: number } => {
    const dW = target.x - arena.x0, dE = arena.x1 - target.x;
    const dN = target.y - arena.y0, dS = arena.y1 - target.y;
    const min = Math.min(dW, dE, dN, dS);
    const dir = min === dW ? [-1, 0] : min === dE ? [1, 0] : min === dN ? [0, -1] : [0, 1];
    return {
      x: Math.max(arena.x0 + 110, Math.min(arena.x1 - 110, target.x + dir[0] * 130)),
      y: Math.max(arena.y0 + 110, Math.min(arena.y1 - 110, target.y + dir[1] * 130)),
    };
  };
  const transitions: TtkResult["transitions"] = [];
  let ticks = 0;
  let killed = false;
  let closedArmorSeconds = 0;
  let exposedSeconds = 0;
  // Overdrive re-arm bookkeeping (in SECONDS — the harness runs at 60fps, the ULT constants are
  // authored in 20Hz ticks). The design's 8s lockout is the tightest cadence a cast can reach,
  // so a fresh 5s window may open at most once every lockout after the last one opened.
  const overdriveWindowSec = ticksToSec(OVERDRIVE.durationTicks); // 5.0s
  const overdriveLockoutSec = ticksToSec(ULT.lockoutTicks);       // 8.0s
  let overdriveReadySec = 0;
  const maxTicks = 60 * 180;
  while (!killed && ticks < maxTicks) {
    const isExposedNow = !target.dead && isBossExposed(target);
    let aimAt: { x: number; y: number } = target;
    if (!isExposedNow) {
      if (boss.kind === "weaver") {
        aimAt = w.enemies.find((e) => !e.dead && e.kind === "sac")
          ?? w.enemies.find((e) => !e.dead && e.kind === "knot")
          ?? target;
      } else if (boss.kind === "choir") {
        // The verse silences the Choir regardless of WHICH voice was drawn (fair
        // surprise §1): target the verse TASK (the summoner's silence set), not a kind.
        const ids = target.boss?.windowAddIds ?? [];
        aimAt = w.enemies.find((e) => !e.dead && e.isSummoned && ids.includes(e.id)) ?? target;
      }
    }
    const aim = Math.atan2(aimAt.y - p.y, aimAt.x - p.x);
    let moveX = 0, moveY = 0;
    const atk = target.attack;
    if (boss.kind === "marrow" && !target.dead) {
      if (atk.move === "rush" && ((atk.phase === "windup" && atk.isAimLocked) || atk.phase === "active")) {
        const side = atk.lockedAngle + Math.PI / 2;
        moveX = Math.cos(side); moveY = Math.sin(side);
      } else {
        const bait = baitPoint();
        if (Math.hypot(bait.x - p.x, bait.y - p.y) > 24) {
          const back = Math.atan2(bait.y - p.y, bait.x - p.x);
          moveX = Math.cos(back); moveY = Math.sin(back);
        }
      }
    } else if (boss.kind === "choir" && !target.dead) {
      const d = Math.hypot(target.x - p.x, target.y - p.y);
      if (d < 170) {
        const away = Math.atan2(p.y - target.y, p.x - target.x) + 0.7;
        moveX = Math.cos(away); moveY = Math.sin(away);
      }
    } else if (boss.kind === "weaver") {
      const d = Math.hypot(aimAt.x - p.x, aimAt.y - p.y);
      if (d > 280) {
        const toward = Math.atan2(aimAt.y - p.y, aimAt.x - p.x);
        moveX = Math.cos(toward); moveY = Math.sin(toward);
      }
    }
    if (!target.dead) {
      if (boss.kind === "gilded" && !isBossExposed(target)) closedArmorSeconds += DT;
      if (isExposedNow) exposedSeconds += DT;
    }
    // Overdrive worst case: open a fresh 5s fire-boost window the instant the 8s cooldown allows,
    // for the WHOLE fight — the design's cooldown-limited MAXIMUM Overdrive uptime (5s on / 8s
    // cooldown). Not gated on the exposed flag: the King has no earned window (always damageable),
    // and on guarded bosses the extra fire is simply chipped, so max uptime is the true ceiling
    // for "can Overdrive break the floor?". Sets the shipped p.overdriveT the resolveUlt cast
    // would set, so currentFireRate applies the real clamped fire layer
    // (min(fireRateMult × fireFactor, expressiveFireCeiling)).
    const nowSec = ticks * DT;
    if (opts.forceOverdrive && !target.dead && p.overdriveT <= 0 && nowSec >= overdriveReadySec) {
      p.overdriveT = overdriveWindowSec;
      overdriveReadySec = nowSec + overdriveLockoutSec;
    }
    const evs = step(w, { seq: ticks, moveX, moveY, aim, firing: true, dash: false });
    for (const e of evs) {
      if (e.t === "bossTransition") transitions.push({ entering: e.entering, at: ticks * DT, queued: e.queued });
      if (e.t === "enemyKill" && e.kind === boss.kind) killed = true;
    }
    ticks++;
  }
  let transitionSeconds = 0;
  const enterAts = transitions.filter((x) => x.entering).map((x) => x.at);
  const exitAts = transitions.filter((x) => !x.entering).map((x) => x.at);
  for (let i = 0; i < Math.min(enterAts.length, exitAts.length); i++) transitionSeconds += exitAts[i] - enterAts[i];
  return { seconds: ticks * DT, killed, transitions, transitionSeconds, closedArmorSeconds, exposedSeconds };
}

// ---- the practical-DPS estimator (documented 12s moving-target model, not telemetry) ----

// Moving-target accuracy factors per weapon family: base hit fraction × spread penalty ×
// projectile-speed penalty.
export function practicalAccuracy(id: WeaponId, spreadTotal: number, speed: number): number {
  const MELEE: Record<string, number> = { sword: 0.65, longsword: 0.65, spear: 0.7 };
  if (MELEE[id] !== undefined) return MELEE[id];
  const base =
    id === "homing" ? 0.95
    : id === "beam" ? 0.9
    : id === "tesla" ? 0.8
    : id === "mortar" ? 0.7
    : id === "ricochet" ? 0.75
    : id === "flamer" ? 0.6
    : id === "shotgun" || id === "sawnoff" ? 0.55
    : 0.85;
  const spreadPenalty = Math.max(0.35, 1 - spreadTotal * 0.55);
  const speedPenalty = speed > 0 ? Math.min(1, Math.max(0.6, speed / 420)) : 1;
  return base * spreadPenalty * speedPenalty;
}

export function practicalBossDps(
  id: WeaponId,
  mods: PlayerMods,
  ownedItemIds: readonly string[] = [],
): number {
  const wep = WEAPONS[id];
  const isMelee = wep.melee !== undefined;
  const pellets = isMelee ? 1 : wep.pellets + mods.extraPellets;
  const extra = Math.max(0, pellets - wep.pellets);
  // The fire-time pellet/weapon coefficients, exactly as fire() bakes them.
  const effPellets = isMelee ? 1 : 1 + Math.max(0, wep.pellets - 1) * BOSS_NATIVE_PELLET_COEF + extra * BOSS_EXTRA_PELLET_COEF;
  const wepCoef = WEAPON_BOSS_COEF[id] ?? 1;
  const spreadTotal = isMelee ? 0 : (pellets > 1 ? Math.max(wep.spread, C.MIN_MULTI_SPREAD) + mods.spreadAdd : wep.spread);
  // The boss vulnerability channel: statuses amplify NOTHING against boss-grade bodies
  // (utility only), and the crit multiplier counts at most BOSS_VULN_CAP.
  const vuln = (1 - mods.critChance) + mods.critChance * Math.min(BOSS_VULN_CAP, mods.critMult);
  const rate = (1 / wep.fireCd) * mods.fireRateMult;
  // Burn is a flat DoT (never an amp): bounded at +3 practical DPS when present.
  const burnDot = mods.burnChance > 0 ? 3 : 0;
  // The Midas models its FED damage: a stocked purse is no brake inside a boss window, so the
  // estimator assumes every shot eats a coin (the honest worst case).
  const coinFed = wep.coinBoost ?? 1;
  const accuracy = practicalAccuracy(id, spreadTotal, isMelee ? 0 : wep.speed * mods.bulletSpeedMult);
  const perProjectile = wep.damage * coinFed * mods.damageMult * wepCoef * vuln;
  const primaryDps = perProjectile * effPellets * rate * accuracy;
  const hasSideChannel = isSideChannelProjectileWeapon(id)
    && ownedItemIds.some((itemId) => canonicalItemId(itemId) === "side_channel");
  const ghostRate = hasSideChannel ? Math.min(rate, 1 / SIDE_CHANNEL.icd) : 0;
  const ghostDps = wep.damage * coinFed * mods.damageMult * wepCoef
    * SIDE_CHANNEL.bossDamageMult * ghostRate * accuracy;
  return primaryDps + ghostDps + burnDot;
}

// ---- the deterministic 100k legal-build set ----
// The one seeded generator the god-build ceiling gate AND the kit ceiling gates iterate, so
// both read the identical build stream (random offer → random pick, up to 12 picks) — the
// numbers stay comparable and a future retune flows to every gate at once.

export const GOD_BUILD_COUNT = 100_000;
export const GOD_PICK_COUNTS = [4, 8, 9, 12] as const;

export function godBuildArsenal(
  catalogVersion: ContentCatalogVersion = CURRENT_CONTENT_CATALOG_VERSION,
): WeaponId[] {
  return [...contentCatalogFor(catalogVersion).pickupWeapons, "pistol"];
}

export interface LegalBuild {
  index: number;
  weapon: WeaponId;
  owned: string[];
  mods: PlayerMods;
}

export function forEachLegalBuild(
  cb: (build: LegalBuild) => void,
  catalogVersion: ContentCatalogVersion = CURRENT_CONTENT_CATALOG_VERSION,
): void {
  const rng = new Rng(0x60D5EED);
  const arsenal = godBuildArsenal(catalogVersion);
  const eligibleItems = normalItemsForCatalog(catalogVersion);
  for (let i = 0; i < GOD_BUILD_COUNT; i++) {
    const owned: string[] = [];
    const picks = GOD_PICK_COUNTS[i % GOD_PICK_COUNTS.length];
    for (let n = 0; n < picks; n++) {
      const choices = rollItemChoicesWith(3, () => rng.next(), owned, { eligibleItems });
      if (choices.length === 0) break;
      owned.push(choices[rng.int(0, choices.length - 1)].id);
    }
    const mods = createMods();
    recomputeMods(mods, owned);
    const weapon = arsenal[i % arsenal.length];
    cb({ index: i, weapon, owned, mods });
  }
}
