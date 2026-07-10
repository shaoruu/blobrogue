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
  // The bestiary expansion's first wave (see enemies.ts for each identity):
  //  - rootward: slow formation anchor with a slow-turning frontal guard (flank/melee/pierce);
  //  - echojack: fleeing trickster that plants a false-noise decoy, then blinks sideways;
  //  - seamcutter (the SILT KEEL): previews an oblique wall-to-wall seam, then plows it,
  //    raising ONE persistent berm of destructible silt mounds beside the furrow;
  //  - caskbellows: stationary lane sentry — locked 3-shot volleys, rear-crank stagger;
  //  - sinderling: consumes environmental heat to arm a flame-jet dash + a death burst;
  //  - fragment: tethers to another enemy; the tether is the attack lane (kill/LOS-break defuses).
  //  - mason (the CLINKER MASON, Emberreach worker): builds one handed L-corner of
  //    destructible clinker bricks around a heat vent — persistent topology, replaced
  //    whenever it builds anew.
  | "rootward" | "echojack" | "seamcutter" | "caskbellows" | "sinderling" | "fragment"
  | "mason"
  // Summon-only bodies (never in the floor planner):
  //  - echo: the echojack's 1-HP false-noise decoy — soaks homing/attention, expires quietly;
  //  - knell: The Toll's noise-lure bomb — shoot it before it tolls, or leave its radius.
  //  - knot: the Weaver's lattice ANCHOR NODE — the glowing crossing its thread-lines
  //    meet at, and the anchor of a strung silk LANE. Shooting it collapses the lane
  //    (P1 it EXPOSES the Weaver; P3 the broken lane is the dash-overshoot bait).
  //  - sac: the Weaver's P2 EGG-SAC — bloomed in on an omen tell while she climbs.
  //    Destroying every sac of a clutch forces her down for the earned window.
  | "echo" | "knell" | "knot" | "sac"
  // Miniboss templates (captain machinery, seeded mid-band cadence — see minibossKindForFloor):
  | "marshal" | "toll"
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
//  - "decoy"/"blink": the echojack's plant-a-false-noise beat and its perpendicular
//    relocation dash (blink is the visible escape, never a teleport).
//  - "seam": the seamcutter's full lane — windup previews the wall-to-wall cut, active
//    travels it, recover is the punish window at the far wall.
//  - "stoke": the sinderling's self-arming channel when no environmental heat is near.
//  - "harmonize": the fragment's tether pulse — the line to its source becomes the lane.
//  - "knell": The Toll's ring — a radial sound wave (its aimed lane reuses "volley").
//  - "volley" is shared grammar: MARROW's fan, the caskbellows' 3-shot lane, The Toll's
//    aimed peal, the marshal's P2 fan — one read (aimed ranged commitment) everywhere.
//  - "crash" is shared grammar for every punishable self-stun: wall crashes AND the
//    caskbellows' rear-crank stagger.
//  - "roar" is shared fixed-beat grammar: boss transitions AND the commander elite's rally.
export type AttackMove =
  | "none" | "lunge" | "spit" | "hopslam" | "radial" | "roar" | "squeeze"
  | "rush" | "crash" | "dive" | "erupt" | "volley" | "spin" | "shield"
  | "fade" | "wail" | "split" | "pounce" | "weave" | "slam" | "sweep" | "brace"
  | "decoy" | "blink" | "seam" | "stoke" | "harmonize" | "knell"
  // The worker verb: a long stationary tell, then ONE persistent construction is raised
  // (the bailiff's root divider, the mason's clinker L-corner). Never aimed at a body —
  // the site is the mark.
  | "build";

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
  // ---- EARNED WINDOWS (deep bosses: Weaver / Warden / MARROW / Choir) ----
  // By default an earned-window boss is GUARDED (damage chipped to its guardMult, never
  // immunity). Performing the phase's mechanic — breaking a lattice knot, baiting the
  // pounce onto thread debris, silencing the Choir fragments, punishing the wall crash —
  // opens a fixed EXPOSED window of full damage. Seconds left in that window (0 = guarded).
  exposed: number;
  // Per-window damage bank: what the CURRENT window may still remove before it slams
  // shut early. Armed when a fresh window opens (bankFrac × maxHp — the phase chunk), so
  // stacked firepower converts a window harder but can never one-shot a phase through it.
  windowBank: number;
  // Mechanic adds gating the NEXT window (the Choir's fragments): killing every one
  // opens the window. Empty when no silence set is live. Distinct from beatAddIds —
  // those belong to the transition beat, these to the earned-window loop.
  windowAddIds: number[];
  // The Weaver's committed lane: the knot id (+1) whose thread it is traveling — the
  // P1 blink (shoot the knot to SNAG it) and the P3 charge-dash (a dead knot can't
  // brake it: the overshoot) both ride it. 0 = no lane committed.
  laneKnotId: number;
  // Fair surprise §1: the add pool's previous draw index (-1 = none yet) — weighted
  // selection never repeats the exact entry twice in a row, so waves can't be rote.
  lastAddPick: number;
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
  // The elite brace affix's cooldown (keeps its duty cycle ≤35%). Only elites tick it.
  braceCd?: number;
  // The one per-kind/per-affix AUXILIARY channel that rides the wire (EnemyWire.aux) so
  // the client can render authoritative special state without a bespoke field per kind:
  //  - sinderling: 0 = unarmed, 1 = armed (stoked — jet + death burst live);
  //  - echo/knell: remaining decoy life in seconds (drives the client fade/fuse);
  //  - knot: remaining lattice life in seconds; sac: 0 (its read is the body itself);
  //  - fragment: tethered source enemy id + 1 (0 = untethered — the simplified pattern);
  //  - bulwark elites: remaining plate HP (0 = shattered);
  //  - earned-window bosses (Weaver/Warden/MARROW/Choir): seconds left in the current
  //    EXPOSED window (0 = guarded) — the client's guard/exposed render keys off it;
  //  - everyone else: 0.
  aux: number;
  // Generic per-behavior sequence counter (sim-internal, never on the wire): the
  // seamcutter's sweep emissions, the caskbellows' volley shots, the sinderling's wedge
  // drops, the marshal/toll attack alternation. Reset by each move's begin. The
  // Weaver's mechanic bodies (knot/sac) never attack and carry their CASTER's enemy
  // id + 1 here instead (a lattice always belongs to the weaver that spun it).
  seq: number;
  // Commander-elite pack panic: seconds this body flees leaderless (no attack triggers
  // from idle while it runs). Sim-internal — clients read the movement itself.
  panicTime: number;
  // Echoed-elite scratch: a scheduled repeat of the last ranged release (echoTime counts
  // down; echoAngle is the locked bearing it refires along). Sim-internal.
  echoTime: number;
  echoAngle: number;
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
  // The crit multiplier baked into damage when isCrit (the boss vulnerability channel
  // divides it back out at strike time). Undefined = 1.
  critX?: number;
  // Boss-facing pellet/weapon coefficient baked at fire time (rooms take full damage).
  // Undefined = 1.
  bossCoef?: number;
  // Optional per-weapon behaviors. Undefined for the base weapons, so their bullets
  // take the exact same paths they always did.
  bounce?: number;         // ricochet: wall reflections left before the bullet dies
  homing?: number;         // homing: steering turn rate (rad/s) toward the nearest enemy
  chain?: number;          // tesla: lightning jumps left after the first hit
  chainRange?: number;     // tesla: max px a chain jump can reach
  blast?: number;          // mortar: AoE radius — the shell detonates on impact/expiry
  // The Weaver's aimed SILK (sim-internal, enemy fire only): the bolt WEBS where it
  // dies — wall, floor or the player it caught. Undefined on every other round.
  isSilk?: boolean;
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

// Free world loot only. Anything PRICED lives in Patch's shop room (src/sim/shop.ts)
// behind an explicit buy command — walking over a pickup never spends a coin.
export type PickupKind = "heart" | "coin" | "weapon";

export interface Pickup {
  id: number;      // stable per-floor id (wire identity: interest view + client anim keying)
  kind: PickupKind;
  x: number; y: number;
  radius: number;
  weapon: WeaponId | null; // set when kind === "weapon"
  // Coins: the coin worth baked in at drop time (combo multiplier applied then); undefined
  // falls back to the collector's base coin gain, so non-kill coins stay at face value.
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
// root_wall / silt_mound / clinker_brick are WORKER CONSTRUCTIONS (the ecology gate's
// persistent topology edits): raised by living workers, destructible by either side,
// replaced when their owner builds anew.
export type PropKind =
  | "crate" | "pot" | "barrel" | "barrel_explosive" | "brazier"
  | "root_wall" | "silt_mound" | "clinker_brick";

export interface Prop {
  id: number;      // stable per-world id (client keys its cosmetic anim map by this)
  kind: PropKind;
  x: number; y: number;
  radius: number;
  hp: number;
  dead: boolean;
  breakT?: number; // seconds into the break clip once destroyed (undefined = intact)
  // Worker constructions carry their builder's enemy id (sim-internal, not on the wire):
  // the replacement rule — a worker raising anew crumbles everything it owns first.
  owner?: number;
}

// Authored ground hazards. Shared, authoritative floor state like props: placed by
// enemy/boss moves, expire on a timer, rebuilt empty on every floor load.
//  - web: the Weaver's slow-zone — slows players standing inside (never enemies); it
//    never damages, so the pressure is routing, not attrition.
//  - cinder: the sinderling's burning wake — 1 damage to a standing player, gated by the
//    same protection rules as enemy contact. Enemies are immune (their fire).
//  - charge: a volatile elite's death fuse — harmless while it burns (life > 0), then
//    detonates a SHARED-risk burst (players 1, enemies more) when it expires.
//  - omen: an AMBUSH pre-spawn tell (fair surprise §2) — a harmless marked bloom
//    (burst web / dust / egg-sac swell) that stands for its whole life BEFORE the body
//    it announces exists; the spawn resolves where the omen stood when it expires.
export type HazardKind = "web" | "cinder" | "charge" | "omen";

export interface Hazard {
  id: number;      // stable per-floor id (wire identity + client anim keying)
  kind: HazardKind;
  x: number; y: number;
  radius: number;
  life: number;    // seconds until it fades
  maxLife: number; // authored duration (drives the client's fade render)
  // Omen payload (sim-internal, never on the wire): the ambush body this tell
  // announces, spawned at the omen's spot when its life expires. The spawned add keeps
  // its ordinary spawn grace on top — tell, then body, then teeth.
  spawnKind?: EnemyKind;
  spawnTier?: EnemyTier;
  // The summoning boss's enemy id + 1 (0/undefined = none): a Choir verse omen feeds
  // its fragment into the summoner's silence set when it resolves.
  forBossId?: number;
}

// Environmental FLOOR hazards — the depth-escalation danger layer, DISTINCT from the
// dynamic boss hazards above: placed deterministically per floor (seeded from
// seed+floor+difficulty, like props) so every client and the server derive the SAME
// layout with zero wire cost — they never ride the snapshot. All floor hazards are
// tile-bound (readable, dodgeable areas). Pulse hazards (spikes/vent/rift) cycle
// idle -> telegraph -> active off the shared floor-hazard clock; pools are static,
// always-visible damage floors. Cycle math lives in src/sim/hazards.ts.
export type FloorHazardKind = "spikes" | "toxic_pool" | "fire_vent" | "void_rift";

export interface FloorHazard {
  id: number;
  kind: FloorHazardKind;
  tx: number; ty: number; // tile coords (damage area = exactly this tile)
  // Pulse phase offset in seconds. Hazards placed as one formation share a group so their
  // offsets step together (rows of spikes fire as a travelling wave, a vent channel erupts
  // in unison) — authored-feeling rhythm instead of random noise.
  phase: number;
  group: number;
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
  // Authoritative revive-channel progress on THIS (downed) player, in seconds — drives the
  // reviver-side progress ring. 0 when up / not being revived / on the legacy co-op path.
  reviveProgress: number;
  // Past the floor's down limit (gate §1): down AND unrevivable until the descent rescue —
  // teammates stop being prompted to revive. Always false on the legacy co-op path.
  isOut: boolean;
  // Network-absent: their connection dropped and the server is holding their body for the
  // reconnect grace window. Rendered as a ghost with an explicit RECONNECTING label.
  isAbsent: boolean;
  aimAngle: number;
  shotSeq: number;    // increments each time they fire, so we can flash a tracer
  // The player's AUTHORITATIVE identity color (verified ticket claim / presence row).
  // null = not resolved yet (claimless legacy/dev ticket) — renderers show an explicit
  // neutral placeholder, NEVER a locally-guessed color that would pop to the real one.
  colorIndex: number | null;
  // Equipped visual-only cosmetics from the verified ticket identity (plain id labels here —
  // the sim never interprets them; the renderer maps ids to overlay art). null = none.
  hat: string | null;
  face: string | null;
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
  | "rootward" | "echojack" | "seamcutter" | "caskbellows" | "sinderling" | "fragment" | "mason"
  | "echo" | "knell" | "knot" | "sac" | "marshal" | "toll"
  | "boss" | "marrow" | "choir" | "weaver" | "gilded"
  | "patch"
  | "heart" | "coin" | "gun" | "spit";
