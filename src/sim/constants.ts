// Simulation ENGINE constants: mechanical tuning that drives stepWorld but is not part of
// the balance contract (that lives in balance.ts — the versioned BalanceDef). Cosmetic
// magnitudes (trauma/freeze amounts, recoil, camera kick, tints, sprite tables) stay
// client-side in game.ts.

import type { WeaponId, PropKind } from "./types.js";

export const HALF_PI = Math.PI / 2;

// Pathfinding rebuild throttle.
export const FLOW_REBUILD = 0.2;

// Slime hop cadence (speed pulse synced to its squash clock; mean 1x -> balance intact).
export const SLIME_HOP_FREQ = 3.4;
export const SLIME_HOP_AMOUNT = 0.55;

// Bat flock steering (deterministic boids): separation/alignment/cohesion + target
// attraction, blended into a persistent heading (stored in the bat's `zig` scratch) that
// turns at a capped rate — a readable flock, never a stack, never independent beelines.
// The neighbor scan is BOUNDED: same-kind bodies inside FLOCK_RADIUS, first
// FLOCK_MAX_NEIGHBORS in deterministic array order, so cost is O(n·k) with a small k.
export const FLOCK_RADIUS = 90;
export const FLOCK_SEP_RADIUS = 30;
export const FLOCK_MAX_NEIGHBORS = 5;
export const FLOCK_SEP_WEIGHT = 1.7;
export const FLOCK_ALIGN_WEIGHT = 0.5;
export const FLOCK_COHESION_WEIGHT = 0.35;
export const FLOCK_TARGET_WEIGHT = 1.0;
export const FLOCK_TURN_RATE = 7;   // rad/s cap on heading change
export const FLOCK_MIN_SPEED = 0.5; // airspeed floor while the desired pull opposes the heading
export const FLOCK_HARD_CORE = 18;  // px: inside this, separation overrides every other pull

// Anti-stuck nudge for wedged chasers.
export const STUCK_TIME = 0.12;
export const STUCK_PROGRESS = 0.5;
export const STUCK_MIN_STEP = 0.05;

// Local prop avoidance — the FINISHING layer. Routes come from the prop-aware nav fields
// (see nav.ts); this steering only rounds the ring of a prop the current leg happens to
// graze, so it can no longer be trapped by clusters/rows/pockets the route already avoids.
export const AVOID_LOOKAHEAD = 30;   // px past touching distance a chaser anticipates a prop
export const AVOID_CLEARANCE = 5;    // px of extra clearance the detour tangent aims for
export const AVOID_COMMIT = 0.45;    // seconds a chosen detour side persists after the last block
export const AVOID_SIDE_PROBE = 20;  // px beyond the body the side-clearance probes test

// The fraction of a prop's radius that actually blocks movement. Single source of truth
// shared by collision (blockedByProp) and the navigation clearance grid (nav.ts): the
// routes enemies follow must reflect exactly the rings their bodies collide with.
export const PROP_BLOCK_RING = 0.8;

// Inside this range a chaser commits to the direct line whenever it has wall LOS: the
// last prop between the bodies is the tangent steering's job (single-obstacle rounding is
// what it is good at), and melee contact must never be gated on tile-resolution routing.
export const NAV_DIRECT_RANGE = 76;

// Spawn settling (see settleSpawnPoint): how many Chebyshev tile rings the deterministic
// relocation scan walks around an invalid spawn point before giving up and leaving the
// intended point as-is. 8 rings cover any room a floor can generate.
export const SPAWN_SCAN_RINGS = 8;

// How long a pending blessing offer may sit unanswered (sim seconds) before it expires and
// the run moves on without the pick. Matches the server's offer TTL default, and — because
// it ticks on the SIM clock — it can never hold the party's descend gate hostage.
export const BLESSING_OFFER_TTL = 60;

// Mercy window on spawning into a freshly BUILT floor (run start, every descend, run
// reset): no damage can land while the level is still fading in and the player is
// reorienting after the blessing pick. Belt-and-suspenders on top of the enemies' own
// SPAWN_GRACE and the boss's entranceGrace — every foe also begins idle and must telegraph
// its first attack, so nothing can even START an attack inside this window, let alone
// land one. Rides the ordinary post-hit invuln timer (it protects, decays, and renders
// exactly like post-hit protection).
export const PLAYER_SPAWN_GRACE = 1.75;

export const MIN_MULTI_SPREAD = 0.26;

// Enemy knockback impulse.
export const WEAPON_KB: Record<WeaponId, number> = {
  pistol: 4, shotgun: 8, rapid: 2,
  smg: 2, cannon: 14, burst: 3, ricochet: 5, homing: 2, tesla: 3,
  sawnoff: 10, railgun: 12, nailer: 3, flamer: 1, mortar: 6, beam: 1,
  sword: 14, longsword: 20, spear: 16,
  lastlight: 9, breach: 7, snapwire: 12, frostline: 1, halo: 6, sentry: 2, crook: 10,
  // The vortex's KB is INWARD (implodeBullet aims it at the impact point) — this number
  // is the pull strength, resisted exactly like ordinary knockback.
  reaper: 5, swarm: 3, midas: 4, phase: 6, vortex: 22,
  // Content wave. The Cleaver's heavy disc shoves hard; the Skipper buckshot and Shoulderfire
  // lanes stay light; the Firebomb blast and Singularity implosion (inward, like vortex)
  // carry their own impulse.
  cleaver: 10, scrapper: 2, skipper: 4, arcbolt: 5, cryobolt: 3, firebomb: 6, tracker: 3,
  singularity: 20,
  mooring_nail: 6, sluicegate: 5, oddsmaker: 6, pathmaker: 1,
  resonant_fork: 4, red_pen: 3, margin_call: 5, sidewinder: 3,
  hushiron: 4, backtalk: 4, lamplighter: 3, faultlink: 4,
};
export const KB_LAMBDA = 16;
export const KB_MAX_SPEED = 520;
export const MELEE_THRUST_WIDTH = 18;

// Friendly-fire "playful bonk" (approved game-designer spec): a player's DIRECT projectile
// grazing a TEAMMATE deals 0 damage and applies a gentle positional impulse ALONG the
// bullet vector — never scaled by the shooter's weapon KB (so a shotgun can't launch a
// friend). The magnitude is ~30% of a standard enemy-hit knockback: a decaying WEAPON_KB
// impulse travels ~WEAPON_KB px total (v/lambda, KB_LAMBDA == the decay lambda), so the
// reference here is that same px space. It is applied as ONE wall-aware displacement and
// clamped to <= 1/6 of a dash distance as a hard ceiling. A per-ORDERED-pair cooldown
// (A->B independent of B->A) gates it to one bonk per window, never per-bullet.
export const FRIENDLY_NUDGE_REF_KB = 18;      // the "standard enemy-hit knockback" reference (px)
export const FRIENDLY_NUDGE_FRAC = 0.30;      // ~30% of that reference
export const FRIENDLY_NUDGE_DASH_FRAC = 1 / 6; // hard ceiling as a fraction of a dash distance
export const FRIENDLY_NUDGE_CD = 0.5;         // per-ORDERED-pair cooldown (seconds)

// Weapon self-knockback (shoves the firing player) — a real sim position change.
export const FIRE_KNOCKBACK: Record<WeaponId, number> = {
  pistol: 0, shotgun: 22, rapid: 0,
  smg: 0, cannon: 10, burst: 0, ricochet: 0, homing: 0, tesla: 0,
  sawnoff: 26, railgun: 6, nailer: 0, flamer: 0, mortar: 8, beam: 0,
  sword: 0, longsword: 0, spear: 8,
  lastlight: 12, breach: 10, snapwire: 0, frostline: 0, halo: 0, sentry: 0, crook: 0,
  reaper: 0, swarm: 6, midas: 0, phase: 4, vortex: 6,
  // Content wave self-kick: the Cleaver's heavy disc and the Firebomb lob shove the firer;
  // the rest are light.
  cleaver: 4, scrapper: 0, skipper: 6, arcbolt: 2, cryobolt: 0, firebomb: 6, tracker: 0,
  singularity: 4,
  mooring_nail: 0, sluicegate: 4, oddsmaker: 3, pathmaker: 0,
  resonant_fork: 2, red_pen: 2, margin_call: 3, sidewinder: 1,
  hushiron: 2, backtalk: 2, lamplighter: 1, faultlink: 2,
};

// ---- legendary gimmick tuning ----
// Reaper kill shards: released from a killed body, seeking, cascading with halved damage
// per generation (geometric decay; the cascade stops under KILL_SHARD_MIN_DMG).
export const KILL_SHARD_DMG_FRAC = 0.5;
export const KILL_SHARD_MIN_DMG = 0.6;
export const KILL_SHARD_SPEED = 540;
export const KILL_SHARD_LIFE = 0.8;
export const KILL_SHARD_HOMING = 9; // steering rad/s (well above the Wisp's 6 — short-lived)
export const KILL_SHARD_RADIUS = 4;
// Vortex implosion: everything in the radius takes this fraction of the round's damage
// (the direct hit included — the implosion IS the payload) and is yanked inward via
// WEAPON_KB.vortex.
export const IMPLODE_SPLASH_FRAC = 0.75;
// Singularity nova: seconds the second-stage blast waits at the collapse point before it
// detonates. Long enough for the implosion's inward knockback to clump the pack onto the
// point, short enough to read as one collapse-then-burst beat.
export const NOVA_FUSE = 0.22;

// ---- weapon effect entities (the effect wave; see types.ts Effect) ----
// Hard world bounds: effects ride every snapshot unfiltered (like hazards), so the sim
// caps each family — the wire and the frame stay bounded no matter how a build stacks.
export const MAX_ZONE_EFFECTS = 48;      // oldest chill zones fade early past the cap
export const MAX_CHILL_ZONE_EFFECTS = 32;
export const MAX_PAVE_ZONE_EFFECTS = 16;
export const MAX_PAVE_ZONES_PER_OWNER = 8;
export const MAX_PAVE_ZONES_PER_SHOT = 8;
export const GRAPPLE_SWEEP_STEP = 4;

// ---- Content Wave B: shared anti-degenerate safety locks (Quill FINAL) ----
// Every Wave B secondary/proc system routes through these: the proc-rate hard clamp is
// per player, per target; overflow procs are discarded (never queued). The same-target
// repeat share caps how much of a system's secondary damage may re-hit ONE target within
// the window after its first legal hit.
export const WAVE_B_PROC_RATE_PER_SEC = 4;       // ≤4 secondary procs /s /player /target
export const WAVE_B_PROC_WINDOW = 1.0;           // rolling second the clamp measures over
export const WAVE_B_SAME_TARGET_REPEAT = 0.35;   // ≤0.35 of a system's DPS may re-hit one body
// Secondary-body scoring (budget model): the first secondary body counts at 0.60, later
// bodies at 0.35. Runtime damage is authored raw; these govern the PU envelope math.
export const WAVE_B_SECONDARY_FIRST = 0.60;
export const WAVE_B_SECONDARY_LATER = 0.35;
// Sidewinder arc geometry: the curving round's swept radius grows over its life.
export const SIDEWINDER_ARC_RADIUS_MIN = 90;
export const SIDEWINDER_ARC_RADIUS_MAX = 130;
// ---- Content Wave C: shared safety locks (Quill FINAL) ----
// Wave C reuses the Wave B proc window (≤4/s/player/target). Faultlink echoes carry a
// TIGHTER same-target-repeat share (0.25 vs Sidewinder's 0.35) — a single-endpoint echo
// chain can re-hit one body for at most this fraction of the primary hit.
export const WAVE_C_FAULT_ECHO_REPEAT = 0.25;
// Hushiron stance: the flusher vulnerability adds a flat, readable +damage on an enemy
// blast/KB that displaces the ramped owner far enough (see StanceSpec.flusherDisplace).
export const WAVE_C_HUSH_FLUSHER_DAMAGE = 1;
export const EFFECT_TICK = 0.1;          // shared cadence for zone chill + sentry contact
export const ORBIT_RING_EASE = 10;       // 1/s the halo ring eases toward its target radius
export const SENTRY_CONTACT_CD = 0.4;    // seconds between enemy-contact chews on a sentry
// Breach full-charge line (creative gate: a FULL charge changes the blast GEOMETRY, not
// numbers): at or past the tier, the shell walks trailing detonations back along its
// approach. hitList dedupe keeps every body at ONE hit — the line extends AREA only.
export const BREACH_LINE_TIER = 0.9;   // charge fraction that turns the point into a line
export const BREACH_LINE_BLASTS = 3;   // landing blast + trailing detonations
export const BREACH_LINE_STEP = 76;    // px between detonations along the approach
export const TETHER_PULL_BUDGET = 0.8;   // max seconds a standard-body pull may reel
export const TETHER_LATCH_FIRE_LOCK = 0.3; // fireCd after a latch (the sweep is a SECOND press)
export const WIRE_SNAP_STUN_KB = 1.6;    // snap knockback multiplier (the wire THROWS bodies)


// Point-blank shotgun hit distance that triggers the (client-side) freeze.
export const SHOTGUN_FREEZE_RANGE = 96;

// Elemental status.
export const BURN_TICK = 0.25;
export const BURN_DMG_STACK = 2;
export const BURN_DMG_MAX = 6;
// Boss-grade bodies cap the burn DoT lower (envelope: DoT rides a normalized shared
// clock and can never dominate a boss's health bar the way it eats a room's).
export const BURN_DMG_MAX_BOSS = 4;
export const CHILL_SLOW = 0.5;
export const CHILL_MAX = 4;
export const FREEZE_AT = 3;
export const FROZEN_DMG_MULT = 1.5;
export const SHOCK_DMG_MULT = 1.25;
export const SHOCK_ARC_RANGE = 130;
export const SHOCK_ARC_DMG = 1;
export const ITEM_BURN_SECS = 2;
export const ITEM_CHILL_SECS = 1.2;
export const ITEM_SHOCK_SECS = 2;
export const BARREL_BURN_SECS = 2;

// Skeleton lunge. Aim locks early enough to leave the ≥0.30s post-lock dodge window the
// balance spec (§4) guarantees on every commitment.
export const SKELETON_TRIGGER = 200;
export const SKELETON_WINDUP = 0.55;
export const SKELETON_LOCK = 0.25;
export const SKELETON_LUNGE_DUR = 0.28;
export const SKELETON_LUNGE_SPEED = 520;
export const SKELETON_RECOVER = 0.5;
export const SKELETON_CD = 2.0;

// Spitter caster. Same §4 guarantees: ≥0.30s post-lock dodge, ≥0.35s recovery.
export const SPITTER_FLEE = 160;
export const SPITTER_APPROACH = 420;
export const SPITTER_WINDUP = 0.7;
export const SPITTER_LOCK = 0.4;
export const SPITTER_RECOVER = 0.35;
export const SPITTER_CD = 1.8;
export const SPITTER_SPREAD_FLOOR = 4;
export const GLOB_SPREAD = 0.18;

// Ghost solidify.
export const GHOST_SOLID_RANGE = 120;
export const GHOST_SOLID_TIME = 0.4;
export const GHOST_SOLID_AT = 0.98;

// Charger line rush. A much longer lane than the skeleton's hop-lunge (sidestep, don't
// backpedal), and a wall crash self-stuns for CHARGER_CRASH_STUN — the authored punish
// window. Same §4 guarantees: ≥0.30s post-lock dodge, ≥0.35s recovery.
export const CHARGER_TRIGGER = 320;
export const CHARGER_WINDUP = 0.75;
export const CHARGER_LOCK = 0.4;
export const CHARGER_RUSH_SPEED = 480;
export const CHARGER_RUSH_DUR = 0.85;
export const CHARGER_RECOVER = 0.5;
export const CHARGER_CRASH_STUN = 1.4;
export const CHARGER_CD = 3.0;

// Burrower dive cycle: submerge (untargetable), tunnel to the target at a flat burst speed
// (like the skeleton's flat lunge speed — the commitment, not the walk, is the threat),
// then a marked, telegraphed eruption. Travel is hard-capped so the untargetable window is
// bounded; the eruption marker is armed for the FULL windup (≥0.30s dodge by construction).
export const BURROW_TRIGGER = 380;
export const BURROW_DIVE_WINDUP = 0.45;
// Slightly faster than the player's 200px/s run: walking away from the mound is not an
// answer (that's the point) — dodging the eruption marker is.
export const BURROW_TRAVEL_SPEED = 230;
export const BURROW_MAX_TRAVEL = 1.5;
export const BURROW_EMERGE_DIST = 52;
export const BURROW_ERUPT_WINDUP = 0.6;
export const BURROW_ERUPT_RADIUS = 52;
export const BURROW_POP = 0.22;
export const BURROW_RECOVER = 0.6;
export const BURROW_CD = 3.2;

// Orbiter: circles the target at ring distance, strafing sideways (rotational tracking —
// a different aim problem from the spitter's radial kiting), and stops to fire a quick
// telegraphed bolt. The orbit direction flips on its seeded zig clock.
export const ORBITER_RING = 170;
export const ORBITER_RING_SLACK = 30;
export const ORBITER_FLIP_RATE = 0.45; // zig advance (rad/s); sign of sin(zig) picks the direction
export const ORBITER_WINDUP = 0.6;
export const ORBITER_LOCK = 0.3;
export const ORBITER_RECOVER = 0.5;
export const ORBITER_CD = 2.2;
export const ORBITER_BOLT_SPEED = 380;
export const ORBITER_BOLT_RADIUS = 5;
export const ORBITER_BOLT_LIFE = 1.6;

// Shielder: a walking wall. Bullets arriving inside its front arc are ABSORBED (the
// answer is the flank, melee over the top, or splash) — the arc is anchored on the same
// lockedAngle the wire already carries, so the client renders the exact authoritative
// guard. Its bash is an ordinary short telegraphed lunge.
export const SHIELDER_BLOCK_ARC = 2.1;   // radians of protected frontage (~120°)
export const SHIELDER_TRIGGER = 150;
export const SHIELDER_WINDUP = 0.6;
export const SHIELDER_LOCK = 0.3;
export const SHIELDER_BASH_DUR = 0.22;
export const SHIELDER_BASH_SPEED = 420;
export const SHIELDER_RECOVER = 0.55;
export const SHIELDER_CD = 2.6;

// Rootward: the formation anchor. A slow-turning frontal guard that eats non-piercing
// bullets (flank, melee over the top, pierce through, or splash) with a small reach pad
// so allies trailing its shadow get real cover. It has NO committed attack — the body is
// a moving wall, the pressure is positioning.
export const ROOTWARD_GUARD_ARC = 2.6;   // radians of protected frontage (~150°)
export const ROOTWARD_GUARD_PAD = 12;    // px beyond the body the guard still blocks
export const ROOTWARD_TURN_RATE = 1.4;   // rad/s the guard can track — flanking wins
// The FORKROOT BAILIFF consolidation (the ecology gate's Rootbound worker): the anchor's
// one commitment is raising an asymmetric root divider ACROSS its facing — 2 segments to
// the handed side, 1 to the other, planted a short reach ahead. Raising anew crumbles the
// old divider; wall standoff guarantees walkable gaps at both ends (the escape route).
export const BAILIFF_BUILD_TRIGGER = 300; // px to target before it commits to a raise
export const BAILIFF_BUILD_MIN_DIST = 120; // closer than this it walls with its body, not roots
export const BAILIFF_BUILD_ALIGN = 0.3;    // rad the guard must face the target before raising
export const BAILIFF_REBUILD_DIST = 260;   // px from its divider before it MOVES it (re-raise)
export const BAILIFF_BUILD_WINDUP = 1.3;
export const BAILIFF_BUILD_RECOVER = 0.7;
export const BAILIFF_BUILD_CD = 9.0;
export const BAILIFF_DIVIDER_DIST = 78;   // px ahead of the body the divider line sits
export const BAILIFF_SEG_SPACING = 40;    // px between root-wall segment centers

// The CLINKER MASON (the ecology gate's Emberreach worker): walks to the nearest heat
// vent (the sinderling's feeding ground) and masons ONE handed L-corner of clinker
// bricks around it — the corner points at the nearest player, the long arm is handed by
// id parity. No vent in range: it builds the corner around itself. Old corner collapses
// when a new one is raised.
export const MASON_VENT_RANGE = 420;      // px it will travel to claim a vent site
export const MASON_SITE_REACH = 96;       // px from the site before the tell may start
export const MASON_BUILD_WINDUP = 1.4;    // the long masonry tell (kill it mid-course)
export const MASON_BUILD_RECOVER = 0.8;
export const MASON_BUILD_CD = 11.0;
export const MASON_CORNER_DIST = 84;      // px from the vent the corner apex sits
export const MASON_SEG_SPACING = 40;      // px between brick centers along each arm
export const MASON_ARM_LONG = 3;          // bricks on the handed arm (incl. the apex)
export const MASON_ARM_SHORT = 2;         // bricks on the off arm (excl. the apex)

// Worker construction placement law (raiseConstruction): the escape-route gate.
export const CONSTRUCT_WALL_STANDOFF = 1; // tiles of clearance to any wall (end gaps!)
export const CONSTRUCT_EXIT_STANDOFF = 2; // tiles of clearance to the floor exit

// Echojack: the fleeing trickster. Keeps its distance, plants a false-noise decoy on a
// telegraphed beat, then BLINKS — a visible perpendicular relocation dash, never a
// teleport. The decoy (kind "echo") is a 1-HP fake body that soaks homing/attention.
export const ECHOJACK_FLEE = 220;
export const ECHOJACK_APPROACH = 460;
export const ECHOJACK_DECOY_WINDUP = 0.7;
export const ECHOJACK_BLINK_DUR = 0.35;
export const ECHOJACK_BLINK_SPEED = 520;
export const ECHOJACK_RECOVER = 0.4;
export const ECHOJACK_CD = 5.0;
export const ECHO_LIFE = 4.0;            // decoy lifetime (rides the aux channel)
export const ECHO_CAP = 3;               // live decoys before new plants are held

// Seamcutter: the lane. Windup previews the whole wall-to-wall seam (mark = the far
// wall), active travels it at a flat speed emitting timed PERPENDICULAR sweep bolts,
// recover is the punish window at the far wall. Cross early or stay behind it.
export const SEAM_TRIGGER = 360;
export const SEAM_WINDUP = 1.0;
export const SEAM_LOCK = 0.55;           // long post-lock window: the lane is readable
export const SEAM_SPEED = 300;
export const SEAM_MAX_DUR = 2.2;
// The plow's berm (the SILT KEEL consolidation — the ecology gate's Deep worker): the
// cut piles ONE persistent line of destructible silt mounds beside the furrow, handed by
// id parity. The keel's next plow sinks its old berm (replacement rule).
export const BERM_SEG_SPACING = 42;      // px between mound centers along the furrow
export const BERM_MAX_SEGS = 6;          // capped length: a berm zones, it never seals
export const BERM_SIDE_OFFSET = 34;      // px the mounds pile beside the furrow line
export const SEAM_RECOVER = 0.9;
export const SEAM_CD = 4.0;

// Caskbellows: the stationary lane sentry. Locks a target, fires a 3-shot volley down
// the locked lane, and STAGGERS (crash grammar — the long punish window) when a shot
// lands on its rear crank mid-commitment. Backpedals when crowded; otherwise it holds.
export const CASK_TRIGGER = 460;
export const CASK_WINDUP = 0.85;
export const CASK_LOCK = 0.5;
export const CASK_SHOTS = 3;
export const CASK_SHOT_GAP = 0.22;
export const CASK_BOLT_SPEED = 340;
export const CASK_BOLT_RADIUS = 6;
export const CASK_BOLT_LIFE = 2.0;
export const CASK_RECOVER = 0.6;
export const CASK_CD = 2.8;
export const CASK_REAR_ARC = 2.1;        // radians centered on its back (the crank)
export const CASK_STAGGER = 1.5;         // the rear-crank stun (crash recover)
export const CASK_TOO_CLOSE = 180;       // inside this it waddles back to its lane range

// Sinderling: the heat-feeder. Unarmed it seeks environmental heat (an active fire vent
// or a brazier) and consumes one pulse to ARM; with no heat in reach it stokes itself on
// a long stationary channel. Armed: a locked flame-jet dash that lays a burning cinder
// wake, and an armed DEATH bursts shared-risk fire (players 1, enemies more).
export const SINDER_HEAT_RANGE = 600;
export const SINDER_BRAZIER_RANGE = 30;
export const SINDER_STOKE_WINDUP = 1.3;
export const SINDER_ARMED_SPEED_MULT = 1.3;
export const SINDER_JET_TRIGGER = 300;
export const SINDER_JET_WINDUP = 0.6;
// Locks early enough to keep the §4 ≥0.30s post-lock dodge window the envelope's
// acceptance manifest records (0.6 − 0.3).
export const SINDER_JET_LOCK = 0.3;
export const SINDER_JET_SPEED = 420;
export const SINDER_JET_DUR = 0.45;
export const SINDER_JET_RECOVER = 0.5;
export const SINDER_CD = 3.4;
export const SINDER_CINDER_GAP = 0.08;   // seconds between cinder drops along the jet
export const SINDER_CINDER_RADIUS = 24;
export const SINDER_CINDER_LIFE = 3.0;
export const SINDER_CINDER_CAP = 12;     // hard cap on live cinders (squeeze, never fill)
export const SINDER_BURST_RADIUS = 60;
export const SINDER_BURST_PLAYER_DMG = 1;
export const SINDER_BURST_ENEMY_DMG = 3;

// Choir fragment: the tethered voice. It binds to the nearest other enemy in line of
// sight; on cadence the tether HARMONIZES — the line between the two bodies becomes a
// damaging lane for a short pulse. Kill the source (or break line of sight) and the
// fragment falls silent: a slow drifting body with contact only.
export const FRAGMENT_TETHER_RANGE = 380;
export const FRAGMENT_HOLD_DIST = 240;   // it hovers at mid-range, singing
export const FRAGMENT_PULSE_WINDUP = 0.9;
export const FRAGMENT_PULSE_ACTIVE = 0.5;
export const FRAGMENT_PULSE_RECOVER = 0.5;
export const FRAGMENT_CD = 3.2;
export const FRAGMENT_BEAM_HALF_WIDTH = 14;

// Destructible props + chests.
export const PROP_RADIUS = 15;
export const PROP_HP: Record<PropKind, number> = {
  crate: 4, pot: 1, barrel: 3, barrel_explosive: 3, brazier: 0,
  // Worker constructions: cover for either side, breakable by either side.
  root_wall: 3, silt_mound: 2, clinker_brick: 3,
  // GORGE shell debris: a heavy chunk (a peeled layer of the giant) — sturdier cover than a
  // crate so a peel's evidence stands as a real barricade the fight can be fought around.
  gorge_debris: 6,
  // PALE THRONE shell debris (F75): the same heavy-chunk cover primitive as gorge_debris — a
  // peeled layer of the second giant's cold-stone shell.
  pale_debris: 6,
};
// Physical world impacts (damagePropsInRadius): a committed charge or slam does not chip
// cover, it obliterates it — one figure comfortably above every PROP_HP entry.
export const CHARGE_PROP_DAMAGE = 100;
export const SLAM_PROP_DAMAGE = 100;
export const PROP_BREAK_DUR = 0.25;
export const CHEST_OPEN_DUR = 0.4;
// Chest loot ejection (see ejectChestLoot). Every drop a chest produces — coin, heart or
// weapon — lands on a candidate ring around the chest, toward the opener. Radii are tried
// inner-to-outer and angles fan out from the opener direction; the fixed candidate order
// keeps every landing spot deterministic across clients and replays.
export const CHEST_EJECT_RADII: readonly number[] = [36, 52, 68];
export const CHEST_EJECT_ANGLES: readonly number[] = [0, 0.6, -0.6, 1.2, -1.2, 2.0, -2.0, Math.PI];
// Preferred minimum spacing between drops of ONE opening (the pleasing spread); dropped
// when space is too tight for it (overlapping loot beats hidden loot).
export const CHEST_LOOT_SEPARATION = 20;
// Last-resort ring at the source chest's rim: peeking out from under the opened chest's
// sprite, ignoring only the source chest's own hide-exclusion — never other chests.
export const CHEST_EJECT_RIM = 24;
// A loot spot must keep this margin of open floor on all four sides so the sprite never
// visually clips into a wall.
export const CHEST_LOOT_WALL_MARGIN = 10;
// Weapon pickup collision matches the ±19px floor sprite: with the 18px player body,
// center distances below 38px collect.
export const WEAPON_PICKUP_RADIUS = 20;
// Player weapon drop (Q / inventory UI): candidate rings around the dropper, preferred
// toward the aim direction. The inner radius sits beyond pickup range (18 + 20 = 38), so
// a stationary dropper never instantly re-collects the drop.
export const WEAPON_DROP_RADII: readonly number[] = [44, 60, 76];
// The hotbar cap — the ONE inventory size knob. The authoritative inventory never grows
// past this, and every slot maps to its number key (1..MAX). 6 keeps the bar readable and
// the whole row reachable without leaving WASD; must stay <= 9 (the number-key row).
export const MAX_OWNED_WEAPONS = 6;
// Authoritative range for the full-hotbar swap command: how far a player may stand from
// the blocked weapon pickup they claim. Collect range is 18 + 20 = 38 (where the client
// shows the prompt); the extra slack only forgives drift between the input and command
// landing (online latency) — never a cross-room swap.
export const WEAPON_SWAP_RANGE = 56;
export const BARREL_EXPLOSION_RADIUS = 70;
export const BARREL_EXPLOSION_DAMAGE = 6;
export const BARREL_EXPLOSION_SELF_DMG = 2;
// Cap the explosive-barrel chain per tick: once this many barrels have detonated this tick,
// further barrels caught in a blast are left as cover (they can be set off again later)
// instead of all cascading in ONE frame — bounds the FX/damage burst a dense cluster fires.
export const MAX_BARREL_EXPLOSIONS_PER_TICK = 6;

// Lag compensation (Stage C). The world keeps a short ring of past enemy positions so the
// server can rewind a shooter's hit test to where they actually saw the target (their
// render-time view), then apply damage in the present. Bounded to anti-cheat-safe depth: a
// rewind can never reach further back than the history window, and the per-player rewind
// (derived from measured RTT + interp delay) is clamped to LAGCOMP_MAX_TICKS.
export const LAGCOMP_HISTORY = 6;    // stored past ticks (~300ms at 20Hz)
export const LAGCOMP_MAX_TICKS = 6;  // max ticks a hit test may be rewound

// Kill-chain combo. The multiplier is sim (drives coin value); the color is a HUD accent
// (client) kept here so the tiers have a single source of truth.
export const COMBO_WINDOW = 3;
export const COMBO_MAX_MULT = 3;
export interface ComboTier { min: number; mult: number; color: string; }
export const COMBO_TIERS: ComboTier[] = [
  { min: 20, mult: 3, color: "#ff3a3a" },
  { min: 10, mult: 2, color: "#ff8a3b" },
  { min: 5, mult: 1.5, color: "#ffd166" },
  { min: 0, mult: 1, color: "#d9d2c0" },
];

export function comboTierFor(combo: number): ComboTier {
  for (const t of COMBO_TIERS) if (combo >= t.min) return t;
  return COMBO_TIERS[COMBO_TIERS.length - 1];
}
