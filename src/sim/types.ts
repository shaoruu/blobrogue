import type { PlayerId } from "./input.js";
import type { EnemyTier } from "./balance.js";

export interface Vec2 { x: number; y: number; }

export interface Entity {
  x: number; y: number;
  vx: number; vy: number;
  radius: number;
  hp: number;
  maxHp: number;
  dead: boolean;
}

export type EnemyKind =
  | "slime" | "bat" | "skeleton" | "ghost" | "spitter" | "charger" | "burrower"
  | "orbiter" | "shielder"
  | "boss" | "marrow" | "choir" | "weaver" | "gilded";

// Telegraphed-attack state machine. Committed attacks read as
// CHASE -> WINDUP (telegraph, aim locks partway) -> ACTIVE -> RECOVER -> cooldown.
export type AttackPhase = "none" | "windup" | "active" | "recover";
// Which move an attacker is mid-executing. The bosses own several; others own one or two.
// Shared grammar is deliberately reused across bodies so reads transfer:
//  - "rush"/"crash": a telegraphed straight rush (charger + MARROW) whose wall impact swaps
//    the move to "crash" for the longer, punishable stun recover.
//  - "dive"/"erupt": the burrower's underground cycle.
//  - "volley"/"spin"/"shield": MARROW's fans, spiral barrage, and husk-shield beat.
//  - "fade"/"wail"/"split": the Hollow Choir's intangible drift, homing wails, and
//    wisp-split transition beat.
//  - "pounce"/"weave": the Weaver's marked leap and web-planting.
//  - "slam"/"sweep": the Gilded Warden's in-place marked quake and heavy ring waves
//    (its sanctify beat reuses "roar" — same fixed-beat semantics as the King).
export type AttackMove =
  | "none" | "lunge" | "spit" | "hopslam" | "radial" | "roar" | "squeeze"
  | "rush" | "crash" | "dive" | "erupt" | "volley" | "spin" | "shield"
  | "fade" | "wail" | "split" | "pounce" | "weave" | "slam" | "sweep";

// Grouped so the whole attack subsystem lives in one cohesive place per enemy
// (allocated once at spawn, never per frame).
export interface AttackState {
  phase: AttackPhase;
  time: number;        // seconds elapsed in the current phase
  move: AttackMove;
  windup: number;      // 0..1 telegraph progress; drives tint pulse / aim line / marker
  cooldown: number;    // seconds until this enemy may commit again
  lockedAngle: number; // aim direction captured partway through the windup
  isAimLocked: boolean;// whether lockedAngle has been captured this windup
  markX: number;       // world-space AoE marker point (locked hop-slam tile)
  markY: number;
}

// A live phase-transition roar (the anti-burst beat): hard HP floor + queued overflow that
// applies only after the roar exits. queuedBy remembers the last damaging actor so an
// overflow kill still credits a player.
export interface BossRoar {
  floorHp: number;
  queued: number;
  queuedBy: PlayerId | null;
}

// Boss-only extra state (HP-phase tracking + add/attack pacing), shared by every boss.
// Phase transitions are driven by damage events (checked after every authoritative hit),
// never idle polling. The transition beat — the King's roar, MARROW's shield, the Choir's
// split, the Weaver's molt, the Warden's sanctify — is ONE anti-burst mechanism
// (reduction + HP floor + queued overflow), five presentations.
export interface BossState {
  phase: number;           // 1..3
  transitionsDone: number; // 0..2 — which of the two transition beats have fired
  roar: BossRoar | null;   // non-null while a transition beat is active
  addTimer: number;        // countdown until the next cadence add spawn
  attackCount: number;     // attacks committed in the current phase (special-move cadence)
  isNextRadial: boolean;   // per-boss two-move alternation flag (hop/radial, rush/volley, …)
  burstParity: number;     // per-boss parity scratch (radial offset, spiral direction, …)
  // Interactive transition beats (MARROW husks, Choir wisps): the beat's summoned add ids —
  // killing them ALL drops the beat early. Empty on fixed-duration beats (King/Weaver/Warden).
  beatAddIds: number[];
  // Sequenced-emission scratch: shard pairs fired this spiral (MARROW), waves released this
  // sweep (Gilded Warden), pounces chained this commitment (Weaver).
  spinCount: number;
}

export interface Enemy extends Entity {
  id: number;          // stable per-world id (client keys its cosmetic anim map by this)
  kind: EnemyKind;
  // Variety tier (§4): swarm/standard/brute/elite stat + cost + render-scale profile.
  tier: EnemyTier;
  // Boss-spawned / elite-split adds: excluded from natural heart drops and Fang procs so
  // summons are pressure, never a sustain farm.
  isSummoned: boolean;
  speed: number;
  touchDamage: number;
  // Knockback divisor, baked at spawn (archetype × tier × co-op stagger resist).
  kbResist: number;
  // Boss P2 pack-surge scratch: a delayed order (surgeDelay counts down) followed by a
  // short burst of chase speed (surgeTime). Zero on everything untouched by the order.
  surgeDelay: number;
  surgeTime: number;
  // Gauntlet captains (corrected gate §3): 1 before the 50% split, 2 after. Undefined on
  // every ordinary enemy — the two-phase check runs only on captains.
  captainPhase?: number;
  // Per-behavior scratch state.
  zig: number;         // heading offset used by the bat's erratic drift
  // Deterministic slime hop-cadence clock. The slime pulses its speed off sin(hopClock);
  // hopMove eases 0..1 with movement to modulate the clock rate. Seeded from the sim Rng
  // (not the cosmetic anim clock) so movement stays reproducible. Mirrors the anim clock's
  // old evolution exactly, so behavior is unchanged.
  hopClock: number;
  hopMove: number;
  spawnTimer: number;  // spawn-in grace: counts to 0 before the enemy may attack
  // Anti-stuck safety net: seconds a chaser has been trying to move but barely
  // progressing (wedged on geometry / another body). Nudged perpendicular once it trips.
  stuckTimer: number;
  // Prop-avoidance side commitment: which way this chaser is detouring around the prop
  // blocking its path (-1/+1; 0 = none). Held for a short window after the last block so a
  // dead-on approach can't ping-pong left/right into the prop every tick.
  avoidSide: number;
  avoidTime: number;   // seconds the current side commitment persists after the last block
  // Elemental status scratch (allocated at spawn, ticked in updateEnemies). Same local
  // per-enemy model as hp/knockback — driven by bullets, so co-op stays desync-free.
  burn: number;       // seconds of burn DoT left
  burnDmg: number;    // burn damage per second (stacks up to a cap)
  chill: number;      // seconds of slow left (high stacks freeze solid)
  shock: number;      // seconds the shocked tag is active (amp + on-hit arc)
  statusTick: number; // burn DoT accumulator (fires a tick every 0.25s)
  // Who applied the current burn (authoritative kill attribution for the DoT). Solo: always
  // the single local player. Multiplayer: the shooter/exploder who lit the enemy, so the burn
  // tick that finishes a kill credits the correct player's combo/loot. null before any burn.
  burnOwner: PlayerId | null;
  // The damage-intake governor (corrected gate: "no legal build below high-roll minimum").
  // Bosses and gauntlet captains accept damage through a per-second envelope; the excess
  // QUEUES here and drains at the same rate — rate reduction, never lost damage. Absent on
  // ordinary enemies.
  intake?: { rate: number; budget: number; queue: number; by: PlayerId | null };
  attack: AttackState;
  boss: BossState | null; // set only on the boss
}

export type WeaponId =
  | "pistol" | "shotgun" | "rapid"
  | "smg" | "cannon" | "burst" | "ricochet" | "homing" | "tesla"
  | "sawnoff" | "railgun" | "nailer" | "flamer" | "mortar" | "beam"
  | "sword" | "longsword" | "spear";

export interface Bullet {
  x: number; y: number;
  vx: number; vy: number;
  radius: number;
  life: number;
  friendly: boolean;
  // The player who fired this bullet (authoritative attribution: kills/coins/combo/lifesteal go
  // here). null for enemy fire. Solo: always the single local player, so behavior is unchanged.
  owner: PlayerId | null;
  damage: number;
  color: string;
  pierce: number;          // remaining enemies this bullet can punch through
  hitList: Enemy[] | null; // enemies already struck (only allocated for piercing shots)
  isCrit: boolean;         // rolled at fire time; drives the brighter hit feedback
  // Optional per-weapon behaviors. Undefined for the base weapons, so their bullets
  // take the exact same paths they always did.
  bounce?: number;         // ricochet: wall reflections left before the bullet dies
  homing?: number;         // homing: steering turn rate (rad/s) toward the nearest enemy
  chain?: number;          // tesla: lightning jumps left after the first hit
  chainRange?: number;     // tesla: max px a chain jump can reach
  blast?: number;          // mortar: AoE radius — the shell detonates on impact/expiry
  // Elemental status a bullet stamps on the enemy it hits (see applyBulletStatuses).
  // Undefined on plain rounds; the value is the status duration in seconds.
  burn?: number;           // seconds of burn DoT the round applies
  chill?: number;          // seconds of chill the round applies
  shock?: number;          // seconds of shock the round applies
  // Render recipe tag (the firing weapon). Selects the layered sprite FX in
  // renderBullets; absent on enemy fire, which keeps its own halo-and-core look.
  fx?: WeaponId;
  // Lag compensation anchored at FIRE time (not collision time). bornTick is the world tick the
  // shot was fired; lagRewind is the shooter's rewind depth (ticks) at that moment. The effective
  // rewind used for a hit test decays as the projectile travels (max(0, lagRewind - age)), so a
  // slow projectile that collides many ticks later is tested against PRESENT positions, while a
  // near-instant hit is tested against the shooter's fire-time view. Undefined/0 in solo.
  bornTick?: number;
  lagRewind?: number;
  // Position before this tick's move (stamped by updateBullets): the swept-collision segment
  // [prev -> current] is what hit tests check, so a fast round (the Longshot's 1400px/s slug
  // crosses ~70px per 20Hz tick) can never tunnel between endpoint samples. Sim-internal
  // scratch — never on the wire. Undefined only before the bullet's first move.
  prevX?: number;
  prevY?: number;
}

// dealer_heart: the Dealer's purchasable heart (floors 3/6/9, …) — walking over it with
// enough coins buys +1 HP; `value` carries the coin price.
export type PickupKind = "heart" | "coin" | "weapon" | "dealer_heart" | "dealer_weapon";

export interface Pickup {
  id: number;      // stable per-floor id (wire identity: interest view + client anim keying)
  kind: PickupKind;
  x: number; y: number;
  radius: number;
  weapon: WeaponId | null; // set when kind === "weapon" | "dealer_weapon"
  // Coins: the coin worth baked in at drop time (combo multiplier applied then); undefined
  // falls back to the collector's base coin gain, so non-kill coins stay at face value.
  // Dealer hearts/weapons: the coin PRICE.
  value?: number;
  // Boss weapon reward (studio gate §4): one of the chest's P+1 personal CHOICES. Each
  // player claims exactly one; a claim never removes a teammate's options, so the pedestal
  // persists until every living player has claimed.
  isBossChoice?: boolean;
}

// Destructible / atmosphere world props. Placed deterministically per floor (seeded Rng)
// so co-op clients agree on layout; destruction resolves via bullets/explosions on the
// shared floor state, exactly like enemies. `breakT` is set the moment a prop is
// destroyed and drives its one-shot break animation before it's removed.
export type PropKind = "crate" | "pot" | "barrel" | "barrel_explosive" | "brazier";

export interface Prop {
  id: number;      // stable per-world id (client keys its cosmetic anim map by this)
  kind: PropKind;
  x: number; y: number;
  radius: number;
  hp: number;
  dead: boolean;
  breakT?: number; // seconds into the break clip once destroyed (undefined = intact)
}

// Authored ground hazards (the Weaver's webs). Shared, authoritative floor state like
// props: placed by boss moves, expire on a timer, rebuilt empty on every floor load.
// Webs SLOW players standing inside (never enemies — it's their home turf); they never
// damage, so the pressure is routing, not attrition.
export type HazardKind = "web";

export interface Hazard {
  id: number;      // stable per-floor id (wire identity + client anim keying)
  kind: HazardKind;
  x: number; y: number;
  radius: number;
  life: number;    // seconds until it fades
  maxLife: number; // authored duration (drives the client's fade render)
}

// Touch-to-open treasure. Placement is seeded (shared layout); `opened` + `openT` are
// local, so each client opens their own chest and gets their own blessing pick, while
// the coins/hearts/weapons it spawns are ordinary first-come world pickups.
export type ChestKind = "wood" | "boss";

export interface Chest {
  id: number;      // stable per-floor id (wire identity: interest view + client anim keying)
  kind: ChestKind;
  x: number; y: number;
  radius: number;
  opened: boolean;
  openT?: number; // seconds into the open clip once opened (undefined = closed)
  // Baked contents: the floor's weapon drops live in chests, never loose on the floor.
  // Opening ejects it as a real pickup. Sim-side only (not on the wire) — contents stay
  // hidden until the open. undefined = the ordinary loot roll only.
  weapon?: WeaponId;
}

export type ParticleKind = "dot" | "gib" | "spark" | "puff" | "shell" | "sparkfx";

export interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  color: string;
  size: number;
  kind: ParticleKind;
  rot: number;     // current rotation (rad) — only spun kinds (gib/shell) render rotated
  vr: number;      // angular velocity (rad/s)
  gravity: number; // downward acceleration (px/s²)
  drag: number;    // per-frame velocity multiplier (0.92 == the classic dot puff)
}

// A floating damage number that rises off an enemy on hit and fades out. Purely a visual
// readout of damage already dealt — never touches balance/logic. Updated/drawn like Particle.
export interface DmgNumber {
  x: number; y: number;
  vy: number;      // upward drift (negative = up); eased toward 0 each frame
  life: number; maxLife: number;
  value: number;   // the (already-rounded) damage shown
  crit: boolean;   // crits render bigger + gold + a "!"
  color: string;
}

// A teammate as the local client sees them (mapped from Convex presence rows).
export interface RemotePlayer {
  playerId: string;
  name: string;
  x: number; y: number;
  facing: number;
  hp: number; maxHp: number;
  weapon: WeaponId;
  floor: number;
  isDown: boolean;
  // Network-absent: their connection dropped and the server is holding their body for the
  // reconnect grace window. Rendered as a ghost with an explicit RECONNECTING label.
  isAbsent: boolean;
  aimAngle: number;
  shotSeq: number;    // increments each time they fire, so we can flash a tracer
  colorIndex: number; // stable palette slot for this player
  updatedAt: number;
}

export const TILE = 48;
export type TileKind = 0 | 1; // 0 = floor, 1 = wall

// Sprite-atlas keys. These are cosmetic (the client's asset loader maps them to images), but
// the enemy archetype table in the pure sim references its own sprite by name, so the union
// lives here in the pure types module rather than in the client's asset loader. That keeps
// src/sim free of any import into src/game (which pulls in DOM types). The client re-exports
// this from assets.ts for its render call sites.
export type SpriteName =
  | "hero" | "slime" | "bat" | "skeleton" | "ghost" | "spitter" | "charger" | "burrower"
  | "orbiter" | "shielder"
  | "boss" | "marrow" | "choir" | "weaver" | "gilded"
  | "heart" | "coin" | "gun" | "spit";
