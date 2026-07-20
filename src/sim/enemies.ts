import type { Enemy, EnemyKind, SpriteName } from "./types.js";
import type { Dungeon } from "./dungeon.js";
import { TILE } from "./types.js";
import { Rng } from "./rng.js";
import { biomeIndexForFloor } from "./biomes.js";
import {
  TIERS, BIOME_PRESSURE, BOSS, MARROW, CHOIR, WEAVER, GILDED, GAUNTLET,
  JET, TITHE, QUORUM, GORGE, SEVER, CHOIRMASTER, UNDERTOW, PALE, CLAIMANT, WAKE,
  MINIBOSS, ELITE_BULWARK, ELITE_COST_CAP, ENVELOPE, LIVE_CAPS, activeMoverCapFor,
  floorHpMult, floorSpeedMult, floorThreat, activeThreatCap, roundHalfToEven,
  bossHpForFloor, marrowHpForFloor, choirHpForFloor, weaverHpForFloor, gildedHpForFloor,
  jetHpForFloor, titheHpForFloor, quorumHpForFloor, gorgeHpForFloor, severHpForFloor, choirmasterHpForFloor, choirPillarHpForFloor, undertowHpForFloor, paleHpForFloor, claimantHpForFloor, wakeHpForFloor,
  captainHpForFloor, bossHpFracFor,
  coopMobHpMult, coopBossHpMult, coopThreatMult, coopKbResistMult,
  MAX_COMPLEX_PER_ROOM, BRUTE_ELITE_COMBO_FLOOR,
  MAX_BURROWERS_PER_ROOM, MAX_SHIELDERS_PER_ROOM, MAX_WORKERS_PER_ROOM,
  FLOCK_THREAT_SHARE_MAX, ROLL_AFFIX, AFFIX_THREAT_SURCHARGE, DEEP_FLOOR_MIN,
} from "./balance.js";
import type { EnemyTier, EliteAffix } from "./balance.js";
// Type-only (erased at runtime, so no import cycle with floorRolls, which imports isBossFloor
// from here): the rolled elite-affix slots the caller resolved from the frozen descriptor.
import type { EliteAffixRoll } from "./floorRolls.js";
import { isControllerKind, isWorkerKind, ENEMY_MODULE } from "./bestiary.js";
import { floorRoster, FAMILY_INTRO_FLOOR } from "./roster.js";
// Re-exported from its new home (roster.ts, the encounter-deck curriculum data) so existing
// consumers importing it from enemies.ts keep working.
export { FAMILY_INTRO_FLOOR } from "./roster.js";

export type Movement = "chase" | "flock" | "drift" | "kite" | "charge" | "burrow" | "orbit" | "boss";

// Seconds a freshly-spawned enemy stays passive before it may start a windup, so
// boss-spat adds (or a room's mob on entry) never telegraph-and-hit on frame one.
// Reinforcement releases get the same grace (the timer only ticks once active).
export const SPAWN_GRACE = 0.8;

export interface EnemyArchetype {
  kind: EnemyKind;
  sprite: SpriteName;
  movement: Movement;
  isPhasing: boolean; // ghosts drift through geometry
  radius: number;
  drawSize: number;     // sprite draw size in px (standard tier; tiers scale it)
  alpha: number;        // render opacity (ghost is semi-transparent)
  tint: string;         // gib / impact-puff color for this enemy
  kbResist: number;     // knockback divisor — heavier things budge less (boss ~unmovable)
  baseHp: number;       // floor-1 baseline; per-floor tables in balance.ts scale it
  baseSpeed: number;    // floor-1 baseline px/s
  touchDamage: number;
  threat: number;       // §4 threat-budget cost (simple chaser 1.0, ranged/kiter 1.5)
}

// Standard-tier baselines satisfy the studio gate's early-melt floor: a focused starter
// pistol takes ≥0.45s median to delete any archetype on its entry floor (gate §7.1 raised
// slime 3→5, bat 2→4, spitter 3→5 — "raise archetype HP, not body count"). Swarm-tier
// bodies stay the deliberate 0.55× melt chaff.
export const ENEMY_ARCHETYPES: Record<EnemyKind, EnemyArchetype> = {
  slime: {
    kind: "slime", sprite: "slime", movement: "chase", isPhasing: false,
    radius: 16, drawSize: 44, alpha: 1, tint: "#a855f7", kbResist: 1,
    baseHp: 5, baseSpeed: 42, touchDamage: 1, threat: 1.0,
  },
  // Bats fly as a FLOCK (deterministic boids: separation/alignment/cohesion + target
  // attraction) — a wheeling, readable swarm instead of independent zigzag beelines.
  bat: {
    kind: "bat", sprite: "bat", movement: "flock", isPhasing: false,
    radius: 13, drawSize: 40, alpha: 1, tint: "#9aa4bf", kbResist: 0.7,
    baseHp: 4, baseSpeed: 96, touchDamage: 1, threat: 1.0,
  },
  skeleton: {
    kind: "skeleton", sprite: "skeleton", movement: "chase", isPhasing: false,
    radius: 15, drawSize: 46, alpha: 1, tint: "#e8e0cf", kbResist: 1.6,
    baseHp: 6, baseSpeed: 62, touchDamage: 1, threat: 1.0,
  },
  ghost: {
    kind: "ghost", sprite: "ghost", movement: "drift", isPhasing: true,
    radius: 15, drawSize: 46, alpha: 0.62, tint: "#bfe9ff", kbResist: 1.1,
    baseHp: 4, baseSpeed: 56, touchDamage: 1, threat: 1.0,
  },
  // Glass-cannon ranged caster. Kites the player and lobs projectiles on a telegraph.
  // TODO(art): using beetle.png as a placeholder body — the art director is making a
  // dedicated bright-caster Spitter sprite (distinct from the purple boss).
  spitter: {
    kind: "spitter", sprite: "spitter", movement: "kite", isPhasing: false,
    radius: 15, drawSize: 42, alpha: 1, tint: "#ff5a7a", kbResist: 0.8,
    baseHp: 5, baseSpeed: 30, touchDamage: 1, threat: 1.5,
  },
  // Line-rush bruiser: a slow stalker whose telegraphed straight charge crosses most of a
  // room — sidestep it, then punish the wall-crash stun. Heavy on its feet (high kbResist),
  // so the answer is footwork, not knockback. The corrected gate pins the in-flight base
  // (threat 1.5, like every special-answer mob).
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: charger).
  charger: {
    kind: "charger", sprite: "charger", movement: "charge", isPhasing: false,
    radius: 17, drawSize: 48, alpha: 1, tint: "#d9a066", kbResist: 1.8,
    baseHp: 5, baseSpeed: 46, touchDamage: 1, threat: 2.0,
  },
  // Kite-denial: dives underground (untargetable, bounded), tunnels to the target, and
  // erupts on a marked, telegraphed circle. You cannot outrange it — you dodge its marker
  // and punish the surfaced recover window.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: burrower).
  burrower: {
    kind: "burrower", sprite: "burrower", movement: "burrow", isPhasing: false,
    radius: 15, drawSize: 44, alpha: 1, tint: "#caa27e", kbResist: 1.2,
    baseHp: 4, baseSpeed: 40, touchDamage: 1, threat: 2.0,
  },
  // Ring strafer: circles the target at mid range (rotational tracking — a different aim
  // problem from the spitter's straight kiting) and stops to fire a quick telegraphed bolt.
  // The stop IS the tell: an orbiter standing still is an orbiter about to shoot.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: orbiter).
  orbiter: {
    kind: "orbiter", sprite: "orbiter", movement: "orbit", isPhasing: false,
    radius: 13, drawSize: 40, alpha: 1, tint: "#8fb8ff", kbResist: 0.8,
    baseHp: 3, baseSpeed: 95, touchDamage: 1, threat: 1.5,
  },
  // Walking wall: absorbs bullets arriving inside its front arc — the answer is the flank,
  // melee over the top, or splash. Its bash is an ordinary short telegraphed lunge; the
  // enemy itself is a POSITIONING problem, not a stat problem.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: shielder).
  shielder: {
    kind: "shielder", sprite: "shielder", movement: "chase", isPhasing: false,
    radius: 16, drawSize: 46, alpha: 1, tint: "#9fb4a8", kbResist: 2.2,
    baseHp: 5, baseSpeed: 50, touchDamage: 1, threat: 2.0,
  },
  // The FORKROOT BAILIFF (Rootbound's topology worker — ecology-gate consolidation of
  // the wave-1 walking wall): the slow-turning frontal guard stays its defense, and its
  // ONE commitment is now the worker verb — a long stationary tell, then it RAISES an
  // asymmetric root divider across its facing. Raising anew crumbles the old divider;
  // wall standoff guarantees walkable gaps at both ends. Flank the guard, break or
  // round the divider — or use the divider as YOUR cover (props block either side).
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: rootward).
  rootward: {
    kind: "rootward", sprite: "rootward", movement: "chase", isPhasing: false,
    radius: 17, drawSize: 48, alpha: 1, tint: "#86c06c", kbResist: 2.6,
    baseHp: 7, baseSpeed: 34, touchDamage: 1, threat: 2.0,
  },
  // Flee support / trickster: keeps its distance, plants a 1-HP false-noise decoy on a
  // telegraphed beat, then blinks perpendicular — visible, never a teleport. The decoy
  // soaks homing fire and attention; kill the jack first or ignore the noise.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: echojack).
  echojack: {
    kind: "echojack", sprite: "echojack", movement: "kite", isPhasing: false,
    radius: 13, drawSize: 42, alpha: 1, tint: "#d7b8ff", kbResist: 0.9,
    baseHp: 4, baseSpeed: 95, touchDamage: 1, threat: 2.25,
  },
  // The SILT KEEL (the Deep's topology worker — ecology-gate consolidation of the wave-1
  // seamcutter): previews an oblique wall-to-wall seam, then PLOWS it at a flat speed,
  // piling ONE persistent berm of destructible silt mounds beside the furrow (the old
  // sweep-bolt payload is superseded — the zoning is the ridge, not projectiles). Its
  // next plow sinks the old berm. Cross the lane early (post-lock it never turns), round
  // or break the berm; the far-wall recover is the punish window.
  // Movement verb "charge" so the complex-mover cap governs it like the charger.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: seamcutter).
  seamcutter: {
    kind: "seamcutter", sprite: "seamcutter", movement: "charge", isPhasing: false,
    radius: 15, drawSize: 46, alpha: 1, tint: "#e88fb1", kbResist: 1.5,
    baseHp: 6, baseSpeed: 55, touchDamage: 1, threat: 2.0,
  },
  // Stationary lane sentry: locks a target, fires a 3-shot volley down the locked lane,
  // and staggers hard (crash grammar) when a round lands on its rear crank mid-attack —
  // circle behind it between volleys. Waddles back to range when crowded.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: caskbellows).
  caskbellows: {
    kind: "caskbellows", sprite: "caskbellows", movement: "kite", isPhasing: false,
    radius: 16, drawSize: 46, alpha: 1, tint: "#e0a95a", kbResist: 2.0,
    baseHp: 8, baseSpeed: 30, touchDamage: 1, threat: 1.5,
  },
  // The heat-feeder: consumes one environmental heat pulse (an active fire vent, a
  // brazier) — or stokes itself on a long stationary channel — to ARM. Armed: a locked
  // flame-jet dash that lays a burning cinder wake, and its death bursts SHARED-risk
  // fire. Kill it unarmed, or kill it armed from range.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: sinderling).
  sinderling: {
    kind: "sinderling", sprite: "sinderling", movement: "chase", isPhasing: false,
    radius: 13, drawSize: 40, alpha: 1, tint: "#ff8a3b", kbResist: 0.9,
    baseHp: 4, baseSpeed: 80, touchDamage: 1, threat: 2.0,
  },

  // The CLINKER MASON (Emberreach's topology worker): walks to the nearest heat vent —
  // the sinderling's feeding ground — and masons ONE handed L-corner of destructible
  // clinker bricks around it (corner apex toward the nearest player, long arm handed by
  // id parity). The bricks deny your clean lane at the feeders and hand you cover to
  // approach. Old corner collapses when it builds anew; kill it during the long tell.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: mason).
  mason: {
    kind: "mason", sprite: "mason", movement: "chase", isPhasing: false,
    radius: 14, drawSize: 44, alpha: 1, tint: "#c9743f", kbResist: 1.8,
    baseHp: 6, baseSpeed: 46, touchDamage: 1, threat: 2.0,
  },
  // The tethered voice (the Null's echo of the F30 Choir): binds to the nearest other
  // enemy in line of sight and, on cadence, HARMONIZES — the tether line becomes a
  // damaging lane for a pulse. Kill its source (or break line of sight) and the pattern
  // simplifies to a slow contact drifter.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: fragment).
  fragment: {
    kind: "fragment", sprite: "fragment", movement: "drift", isPhasing: false,
    radius: 13, drawSize: 40, alpha: 0.75, tint: "#a9d4f0", kbResist: 1.0,
    baseHp: 3, baseSpeed: 60, touchDamage: 1, threat: 2.25,
  },
  // The echojack's false-noise decoy: a stationary 1-HP fake body. It attacks nothing
  // and touches for nothing; it exists to be shot at (and to soak homing fire). Expires
  // quietly on its aux fuse. Summon-only — never in the floor plan, never drops loot.
  echo: {
    kind: "echo", sprite: "echo", movement: "drift", isPhasing: false,
    radius: 13, drawSize: 40, alpha: 0.7, tint: "#d7b8ff", kbResist: 3.0,
    baseHp: 1, baseSpeed: 0, touchDamage: 0, threat: 0.25,
  },
  // The Toll's noise-lure: a planted 1-HP bell-bomb. Harmless until its fuse (aux) runs
  // out, then it tolls its own ring. Shoot the noise or leave its radius. Summon-only.
  knell: {
    kind: "knell", sprite: "knell", movement: "drift", isPhasing: false,
    radius: 12, drawSize: 36, alpha: 0.9, tint: "#c9b458", kbResist: 3.0,
    baseHp: 1, baseSpeed: 0, touchDamage: 0, threat: 0.25,
  },
  // The Weaver's lattice ANCHOR NODE: the glowing crossing its thread-lines meet at,
  // and the anchor of a strung silk LANE. Stationary, harmless, and the earned-window
  // mechanic target — a few focused rounds break it (P1: EXPOSES the Weaver; always
  // crumbles the lane's silk, and P3 the broken lane is the dash-overshoot bait).
  // Never placed where a player already stands. Summon-only.
  knot: {
    kind: "knot", sprite: "knot", movement: "drift", isPhasing: false,
    radius: 13, drawSize: 38, alpha: 1, tint: "#e6c2ff", kbResist: 3.0,
    baseHp: 10, baseSpeed: 0, touchDamage: 0, threat: 0.25,
  },
  // The Weaver's P2 EGG-SAC: bloomed in on an omen tell while she climbs. Harmless,
  // shootable, and the forced-down switch — destroy the whole clutch to bring her to
  // the floor for the window. Summon-only, never where a player stands.
  sac: {
    kind: "sac", sprite: "sac", movement: "drift", isPhasing: false,
    radius: 16, drawSize: 46, alpha: 1, tint: "#d8a7e8", kbResist: 3.0,
    baseHp: 12, baseSpeed: 0, touchDamage: 0, threat: 0.25,
  },
  // ROOT MARSHAL (miniboss template: the formation fight). P1: a wide slow-turning
  // guard + a live rootward formation it raises and rallies. At 50% the shield SHATTERS
  // INTO DESTRUCTIBLE COVER (real crates where the guard hung) and P2 trades the wall
  // for tempo: ring sweeps alternating aimed fans. Two-phase captain contract.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: marshal).
  marshal: {
    kind: "marshal", sprite: "marshal", movement: "chase", isPhasing: false,
    radius: 24, drawSize: 72, alpha: 1, tint: "#86c06c", kbResist: 5,
    baseHp: 60, baseSpeed: 30, touchDamage: 1, threat: 0,
  },
  // THE TOLL (miniboss template: the sound-lane fight). P1: expanding knell rings
  // alternating an aimed three-bolt peal. P2 (50%): every knell also plants a NOISE-LURE
  // at the nearest player's feet — kill the noise before it tolls. Two-phase captain.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: toll).
  toll: {
    kind: "toll", sprite: "toll", movement: "chase", isPhasing: false,
    radius: 26, drawSize: 80, alpha: 1, tint: "#c9b458", kbResist: 6,
    baseHp: 60, baseSpeed: 22, touchDamage: 1, threat: 0,
  },
  boss: {
    kind: "boss", sprite: "boss", movement: "boss", isPhasing: false,
    radius: 34, drawSize: 100, alpha: 1, tint: "#ffb43b", kbResist: 6,
    baseHp: BOSS.baseHp, baseSpeed: 40, touchDamage: BOSS.contactDamage, threat: 0,
  },
  // MARROW (the boss-roster spec's blind charger, deep roster): line charges with a
  // wall-crash daze, bone-shard volleys, a P3 spiral barrage, and an interactive shield
  // transition beat (§5b). Eyeless — it commits to where it HEARD you (the aim lock),
  // which is why the last stretch of every windup is un-tracked and sidesteppable.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: marrow).
  marrow: {
    kind: "marrow", sprite: "marrow", movement: "boss", isPhasing: false,
    radius: 30, drawSize: 92, alpha: 1, tint: "#bfd8e0", kbResist: 6,
    baseHp: MARROW.baseHp, baseSpeed: 46, touchDamage: MARROW.contactDamage, threat: 0,
  },
  // THE HOLLOW CHOIR (deep roster): the grieving ghost mass — fades intangible on cadence,
  // sings slow homing wails you juke by turning, and SPLITS into wisps at its transition
  // beats (kill them to force it back together early). §5c.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: choir).
  choir: {
    kind: "choir", sprite: "choir", movement: "boss", isPhasing: true,
    radius: 30, drawSize: 96, alpha: 0.85, tint: "#bfe9ff", kbResist: 6,
    baseHp: CHOIR.baseHp, baseSpeed: 44, touchDamage: CHOIR.contactDamage, threat: 0,
  },
  // THE WEAVER (deep roster): the duelist that fights the floor — plants persistent web
  // slow-zones that shrink your dance space and pounces from above onto a locked marker,
  // chaining leaps in later phases. Small, fast, lower HP. §5d.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: weaver).
  weaver: {
    kind: "weaver", sprite: "weaver", movement: "boss", isPhasing: false,
    radius: 26, drawSize: 76, alpha: 1, tint: "#c98bff", kbResist: 4,
    baseHp: WEAVER.baseHp, baseSpeed: 120, touchDamage: WEAVER.contactDamage, threat: 0,
  },
  // THE GILDED WARDEN (deep roster): the armored tempo boss — its plate chips damage to
  // 30% except during the EXPOSED recover after each committed quake/sweep. The only
  // warm-angular body in the bestiary (amber is the one friendly-angular thing). §5e.
  // TODO(art): needs a dedicated sprite — see PR notes (fal recipe: gilded).
  gilded: {
    kind: "gilded", sprite: "gilded", movement: "boss", isPhasing: false,
    radius: 36, drawSize: 108, alpha: 1, tint: "#ffd166", kbResist: 8,
    baseHp: GILDED.baseHp, baseSpeed: 26, touchDamage: GILDED.contactDamage, threat: 0,
  },
  // ---- WAVE 1 deep bosses (The Sump, F35–45) ----
  // JET (F35): the corrupted MIRROR of the player — a cold remap of the hero silhouette
  // (64px body). Casts its frozen archetype MIRROR pool; spent after each salvo (§5g).
  jet: {
    kind: "jet", sprite: "jet", movement: "boss", isPhasing: false,
    radius: 22, drawSize: 96, alpha: 1, tint: "#7882aa", kbResist: 6, // AD presence bump 76→96
    baseHp: JET.baseHp, baseSpeed: 96, touchDamage: JET.contactDamage, threat: 0,
  },
  // THE TITHE (F40): the low/wide armored feeder — builds a slab and re-armors behind it (§5h).
  tithe: {
    kind: "tithe", sprite: "tithe", movement: "boss", isPhasing: false,
    radius: 40, drawSize: 104, alpha: 1, tint: "#c77320", kbResist: 9, // AD presence bump 96→104
    baseHp: TITHE.baseHp, baseSpeed: 30, touchDamage: TITHE.contactDamage, threat: 0,
  },
  // The Tithe's SEPARATE feeding slab: a stationary 2-state destructible (reads as
  // architecture). Not the feeder — a mechanic body like the Weaver's knot/sac.
  tithe_slab: {
    kind: "tithe_slab", sprite: "tithe_slab", movement: "chase", isPhasing: false,
    radius: 26, drawSize: 91, alpha: 1, tint: "#c77320", kbResist: 100, // scales with the feeder (84→91, ×104/96)
    baseHp: TITHE.slabBaseHp, baseSpeed: 0, touchDamage: 0, threat: 0,
  },
  // QUORUM (F45): the merge-form CORE — untargetable behind its husks until the merge,
  // then the fused body with its own window. Its sprite is the merge-form (§5i).
  quorum: {
    kind: "quorum", sprite: "quorum", movement: "boss", isPhasing: false,
    radius: 30, drawSize: 112, alpha: 1, tint: "#e8e2d0", kbResist: 8, // AD presence bump 100→112
    baseHp: QUORUM.baseHp, baseSpeed: 40, touchDamage: QUORUM.contactDamage, threat: 0,
  },
  // The three role-husks (bone family). They share the core's pool + telegraph; roles
  // gate kill-order (shield guards, heal regens, dmg attacks). Directional 86px bodies (AD 80→86).
  quorum_shield: {
    kind: "quorum_shield", sprite: "quorum_shield", movement: "chase", isPhasing: false,
    radius: 22, drawSize: 86, alpha: 1, tint: "#cfc8b6", kbResist: 6,
    baseHp: 1, baseSpeed: 44, touchDamage: 1, threat: 0,
  },
  quorum_heal: {
    kind: "quorum_heal", sprite: "quorum_heal", movement: "chase", isPhasing: false,
    radius: 22, drawSize: 86, alpha: 1, tint: "#d8b6e0", kbResist: 6,
    baseHp: 1, baseSpeed: 48, touchDamage: 1, threat: 0,
  },
  quorum_dmg: {
    kind: "quorum_dmg", sprite: "quorum_dmg", movement: "chase", isPhasing: false,
    radius: 22, drawSize: 86, alpha: 1, tint: "#e0cdb6", kbResist: 6,
    baseHp: 1, baseSpeed: 56, touchDamage: 1, threat: 0,
  },
  // The Tithe's TRIBUTE (surplus add): a slow amber-glob crawler that shuffles toward the
  // feeding slab to REINFORCE it — a task threat, not a body threat (touchDamage 0). A simple
  // low-HP chaser (never a complex mover). (TODO(art): placeholder slime sprite, amber tint.)
  tithe_tribute: {
    kind: "tithe_tribute", sprite: "tithe_tribute", movement: "chase", isPhasing: false,
    radius: 13, drawSize: 40, alpha: 1, tint: "#e0952a", kbResist: 0.9,
    baseHp: 5, baseSpeed: 40, touchDamage: 0, threat: 1.0,
  },
  // QUORUM's SPLINTER (surplus add): a small role-echo shard that breaks off a dying husk,
  // carrying a WEAK version of its role (role rides aux: 0 shield / 1 heal / 2 dmg). A simple
  // low-HP chaser (never a complex mover). (TODO(art): placeholder skeleton sprite.)
  quorum_splinter: {
    kind: "quorum_splinter", sprite: "quorum_splinter", movement: "chase", isPhasing: false,
    radius: 11, drawSize: 34, alpha: 1, tint: "#d8d0be", kbResist: 0.8,
    baseHp: 4, baseSpeed: 62, touchDamage: 1, threat: 1.0,
  },
  // JET's MIRROR-IMAGE ECHO (§5g B2): a player-sized cold reflection that arrives on the
  // fair-ambush omen, fires ONE mirrored-school salvo, then dissolves. Stationary (a
  // reflection, not a chaser) and FRAGILE (a few rounds pop it early) so it can never read
  // as a second durable JET. Cold jet-indigo body; the client draws it translucent +
  // hollow-eyed with a cold rim + dead-amber seams so it never reads as a warm teammate.
  jet_echo: {
    kind: "jet_echo", sprite: "jet_echo", movement: "drift", isPhasing: false,
    // AD hard gates (JET_SURPRISE_LAYER_DIRECTION): the echo body is NEAR-BLACK (lum ~0.05,
    // an enormous value gap under a teammate's ~0.68) and TRANSLUCENT (<=40%, floor shows
    // through) — never brightened toward the teammate range. tint feeds the near-black body
    // fill + resin flecks; the client renders rim/seams/eyes/telegraph on top.
    radius: 26, drawSize: 60, alpha: 0.38, tint: "#0e0b1a", kbResist: 6,
    baseHp: 6, baseSpeed: 0, touchDamage: 0, threat: 1.5,
  },
  // GORGE (F50 GIANT #1): a colossal ~192px (3× hero) half-sunk STATIONARY set-piece — baseSpeed
  // 0 (it never chases), effectively immovable (kbResist huge). Its sprite is the current SHELL
  // state (the client swaps rind → chitin → core off boss.phase). radius ~60 = the hittable core
  // during exposed windows (the 192px draw is the half-sunk shell around it). baseHp = the giant
  // pool (gorgeHpForFloor); threat 0 (a boss). tint = warm amber (the core reveal's material).
  gorge: {
    kind: "gorge", sprite: "gorge", movement: "boss", isPhasing: false,
    radius: 60, drawSize: 192, alpha: 1, tint: "#ffb43b", kbResist: 200,
    // Nominal — the real per-floor pool is gorgeHpForFloor (the back-loaded per-shell sum); a boss's
    // HP is set from enemyHpForFloor × the R curve in createEnemy, never from this archetype base.
    baseHp: gorgeHpForFloor(GORGE.baseHpFloor), baseSpeed: 0, touchDamage: GORGE.contactDamage, threat: 0,
  },
  // The GORGE's tectonic WEAK-POINT: a destructible mechanic body that juts out of the current
  // shell (a "seam"/node). Stationary, harmless (touchDamage 0), no loot/combo (a decoy kind) —
  // it exists purely as a counterplay target, like the Weaver's knot / the Tithe's slab. Drawn
  // small (a chunk of the molten core material showing through the crack) + additively lit.
  gorge_seam: {
    kind: "gorge_seam", sprite: "gorge_seam", movement: "drift", isPhasing: false,
    radius: 13, drawSize: 34, alpha: 1, tint: "#ffcf6b", kbResist: 100,
    baseHp: GORGE.seamHp, baseSpeed: 0, touchDamage: 0, threat: 0.25,
  },
  // SEVER (F55 HUNT/INTERCEPT): ONE chase core (isBossKind). Flees through RoomEdges;
  // signature WORLDSPLIT. Placeholder art reuses Weaver sheets (hooks only).
  sever: {
    kind: "sever", sprite: "sever", movement: "boss", isPhasing: false,
    radius: 28, drawSize: 72, alpha: 1, tint: "#c8b4ff", kbResist: 40,
    baseHp: severHpForFloor(SEVER.baseHpFloor), baseSpeed: 95, touchDamage: SEVER.contactDamage, threat: 0,
  },
  // Resin ANCHOR tooth — mechanic body (trap both checkpoint exits). Never a boss kind.
  sever_anchor: {
    kind: "sever_anchor", sprite: "sever_anchor", movement: "drift", isPhasing: false,
    radius: 14, drawSize: 36, alpha: 1, tint: "#e8d6ff", kbResist: 100,
    baseHp: SEVER.anchorHp, baseSpeed: 0, touchDamage: 0, threat: 0.25,
  },
  // HOLLOW CHOIRMASTER (F60 SPLIT/SILENCE): ONE conductor (isBossKind) in a multi-lobed
  // super-room. Signature THE LAST NOTE. Placeholder art reuses Choir sheets (hooks only).
  choirmaster: {
    kind: "choirmaster", sprite: "choirmaster", movement: "boss", isPhasing: false,
    radius: 30, drawSize: 80, alpha: 1, tint: "#c9b6ff", kbResist: 50,
    baseHp: choirmasterHpForFloor(CHOIRMASTER.baseHpFloor), baseSpeed: 0, touchDamage: CHOIRMASTER.contactDamage, threat: 0,
  },
  // Resonating pillar — mechanic body in a linked lobe. Never a boss kind.
  choir_pillar: {
    kind: "choir_pillar", sprite: "choir_pillar", movement: "drift", isPhasing: false,
    radius: 14, drawSize: 40, alpha: 1, tint: "#e0d4ff", kbResist: 100,
    baseHp: CHOIRMASTER.pillarHp, baseSpeed: 0, touchDamage: 0, threat: 0.25,
  },
  // UNDERTOW (F65 STEAL/ESCAPE): ONE chase/manifest core (isBossKind when manifested).
  // Signature THE RIVER COMES BACK. Placeholder art reuses Weaver sheets (hooks only).
  undertow: {
    kind: "undertow", sprite: "undertow", movement: "boss", isPhasing: false,
    radius: 30, drawSize: 80, alpha: 1, tint: "#6ec8ff", kbResist: 45,
    baseHp: undertowHpForFloor(UNDERTOW.baseHpFloor), baseSpeed: 70, touchDamage: UNDERTOW.contactDamage, threat: 0,
  },
  // Warm Pulse — steal/carry/deposit mechanic body. Never a boss kind.
  warm_pulse: {
    kind: "warm_pulse", sprite: "warm_pulse", movement: "drift", isPhasing: false,
    radius: 12, drawSize: 28, alpha: 1, tint: "#ffe08a", kbResist: 100,
    baseHp: UNDERTOW.pulseHp, baseSpeed: 0, touchDamage: 0, threat: 0.1,
  },
  // Relief vent — highlighted deposit / redirect target. Never a boss kind.
  relief_vent: {
    kind: "relief_vent", sprite: "relief_vent", movement: "drift", isPhasing: false,
    radius: 14, drawSize: 36, alpha: 1, tint: "#7ad0ff", kbResist: 100,
    baseHp: UNDERTOW.ventHp, baseSpeed: 0, touchDamage: 0, threat: 0.25,
  },
  // Flood front — untargetable advancing pursuit marker. Never a boss kind / never second core.
  flood_front: {
    kind: "flood_front", sprite: "flood_front", movement: "drift", isPhasing: true,
    radius: 18, drawSize: 48, alpha: 0.7, tint: "#3a6a9a", kbResist: 100,
    baseHp: 9999, baseSpeed: 0, touchDamage: 0, threat: 0,
  },
  // CLAIMANT (F70 PASS-THE-CLAIM): ONE guarded coordination core (isBossKind). Signature ALL
  // THINGS OWED. Placeholder art reuses Weaver sheets (hooks only).
  claimant: {
    kind: "claimant", sprite: "claimant", movement: "boss", isPhasing: false,
    radius: 30, drawSize: 80, alpha: 1, tint: "#e0b64a", kbResist: 45,
    baseHp: claimantHpForFloor(CLAIMANT.baseHpFloor), baseSpeed: 60, touchDamage: CLAIMANT.contactDamage, threat: 0,
  },
  // Claim token — carried/socketed/world-pickup coordination token. Never a boss kind.
  claim_token: {
    kind: "claim_token", sprite: "claim_token", movement: "drift", isPhasing: false,
    radius: 12, drawSize: 28, alpha: 1, tint: "#ffe08a", kbResist: 100,
    baseHp: CLAIMANT.tokenHp, baseSpeed: 0, touchDamage: 0, threat: 0.1,
  },
  // Claim socket — deposit socket; exactly one lights after aim lock as the Owed counter.
  claim_socket: {
    kind: "claim_socket", sprite: "claim_socket", movement: "drift", isPhasing: false,
    radius: 14, drawSize: 36, alpha: 1, tint: "#d9a441", kbResist: 100,
    baseHp: CLAIMANT.socketHp, baseSpeed: 0, touchDamage: 0, threat: 0.25,
  },
  // THE WAKE (F80 PROTECT/ADVANCE): ONE guarded shadow (isBossKind) that trails the convoy and
  // manifests at thresholds. Signature THE LAST PROCESSION. Placeholder art reuses Weaver sheets.
  wake: {
    kind: "wake", sprite: "wake", movement: "boss", isPhasing: false,
    radius: 30, drawSize: 80, alpha: 1, tint: "#6b5a9a", kbResist: 45,
    baseHp: wakeHpForFloor(WAKE.baseHpFloor), baseSpeed: 60, touchDamage: WAKE.contactDamage, threat: 0,
  },
  // Warm bier — the autonomous last-light convoy body / continuous safe corridor. Never a boss kind.
  warm_bier: {
    kind: "warm_bier", sprite: "warm_bier", movement: "drift", isPhasing: false,
    radius: 16, drawSize: 40, alpha: 1, tint: "#ffd98a", kbResist: 100,
    baseHp: WAKE.bierHp, baseSpeed: 0, touchDamage: 0, threat: 0.1,
  },
  // Convoy blocker — the ONE highlighted blocker cleared before a threshold (peel target).
  convoy_blocker: {
    kind: "convoy_blocker", sprite: "convoy_blocker", movement: "drift", isPhasing: false,
    radius: 14, drawSize: 36, alpha: 1, tint: "#c8b45a", kbResist: 100,
    baseHp: WAKE.blockerHp, baseSpeed: 0, touchDamage: 0, threat: 0.25,
  },
  // Shadow front — the untargetable dark front that follows the convoy from behind (mechanic
  // marker, never a second boss core). Same untargetable-marker grammar as flood_front.
  shadow_front: {
    kind: "shadow_front", sprite: "shadow_front", movement: "drift", isPhasing: false,
    radius: 18, drawSize: 48, alpha: 0.7, tint: "#2a2440", kbResist: 100,
    baseHp: 9999, baseSpeed: 0, touchDamage: 0, threat: 0,
  },
  // PALE THRONE (F75 GIANT #2): the second giant, mechanically identical to Gorge (a stationary
  // ~192px set-piece the client swaps stone → cracked → core off boss.phase, radius ~60 hittable
  // core). Only the MATERIAL differs: tint = COLD crystalline core-blaze (#bfeaff), never amber.
  // baseHp is nominal (the real pool is paleHpForFloor, the explicit F75 back-loaded per-shell sum).
  pale: {
    kind: "pale", sprite: "pale", movement: "boss", isPhasing: false,
    radius: 60, drawSize: 192, alpha: 1, tint: "#bfeaff", kbResist: 200,
    baseHp: paleHpForFloor(), baseSpeed: 0, touchDamage: PALE.contactDamage, threat: 0,
  },
  // The PALE THRONE's tectonic WEAK-POINT: the same peel-target mechanic body as gorge_seam (no
  // loot/combo), its material COLD — a cold-blue crack-node (#57b6ff) showing through the shell.
  pale_seam: {
    kind: "pale_seam", sprite: "pale_seam", movement: "drift", isPhasing: false,
    radius: 13, drawSize: 34, alpha: 1, tint: "#57b6ff", kbResist: 100,
    baseHp: PALE.seamHp, baseSpeed: 0, touchDamage: 0, threat: 0.25,
  },
};

// Which archetypes each tier may inhabit: swarms are small fast bodies, brutes are the
// bulky telegraph-hitters (only an authored commitment — the skeleton's lunge or the
// charger's rush — carries the heavy +1).
const SWARM_KINDS: readonly EnemyKind[] = ["slime", "bat"];
const BRUTE_KINDS: readonly EnemyKind[] = ["slime", "skeleton", "charger"];

// The behavior-elite affix per kind (bestiary wave): exactly one, deterministic BY KIND
// so the read is learnable — an elite slime is ALWAYS a commander, an elite spitter is
// ALWAYS echoed. Kinds that never roll elite (summon-only bodies, captains, bosses)
// simply never consult this. Brace remains the roster default where no sharper identity
// fits the chassis.
export const ELITE_AFFIXES: Readonly<Record<EnemyKind, EliteAffix>> = {
  slime: "commander",   // the pack kind — its elite leads the pack
  bat: "commander",     // flock commander: the wheeling swarm surges on its horn
  skeleton: "brace",    // the balancer's calibrated brace chassis stays put
  ghost: "volatile",    // a ghost that dies loudly
  spitter: "echoed",    // dodge the glob, then its echo
  charger: "bulwark",   // a plated line-bruiser: flank it while it lines up
  burrower: "brace",
  orbiter: "echoed",
  shielder: "brace",    // already a wall — brace keeps it one mechanic, not two
  rootward: "commander",// the formation anchor rallies its formation
  echojack: "volatile", // the trickster's last trick
  seamcutter: "brace",
  mason: "brace",       // the worker's wall is already its loud mechanic
  caskbellows: "bulwark", // frontal plate + rear crank = a strongly directional sentry
  sinderling: "brace",  // its armed death burst is already its loud exit
  fragment: "volatile",
  echo: "brace", knell: "brace", knot: "brace", sac: "brace", // never elite in practice
  marshal: "brace", toll: "brace",
  boss: "brace", marrow: "brace", choir: "brace", weaver: "brace", gilded: "brace",
  // Wave 1 deep bosses + their satellite bodies never roll elite (bosses/summon-only).
  jet: "brace", tithe: "brace", tithe_slab: "brace",
  quorum: "brace", quorum_shield: "brace", quorum_heal: "brace", quorum_dmg: "brace",
  tithe_tribute: "brace", quorum_splinter: "brace", // surplus adds never roll elite
  jet_echo: "brace", // JET's mirror echo is a summon-only reflection, never an elite roll
  gorge: "brace", gorge_seam: "brace", // the giant + its weak-points never roll elite
  sever: "brace", sever_anchor: "brace", // Sever + resin anchors never roll elite
  choirmaster: "brace", choir_pillar: "brace", // Choirmaster + pillars never roll elite
  undertow: "brace", warm_pulse: "brace", relief_vent: "brace", flood_front: "brace", // Undertow + mechanics never roll elite
  claimant: "brace", claim_token: "brace", claim_socket: "brace", // Claimant + mechanics never roll elite
  wake: "brace", warm_bier: "brace", convoy_blocker: "brace", shadow_front: "brace", // Wake + mechanics never roll elite
  pale: "brace", pale_seam: "brace", // the F75 giant + its weak-points never roll elite
};

export function eliteAffixOf(kind: EnemyKind): EliteAffix {
  return ELITE_AFFIXES[kind];
}

export const BOSS_EVERY = 5;
export function isBossFloor(floor: number): boolean {
  return floor % BOSS_EVERY === 0;
}

// Only the three FIGHT bodies are boss kinds (chest drop, danger-end, HP scaling, the
// HUD bar). The Tithe's slab and the Quorum husks are satellite/mechanic bodies, never
// boss kinds themselves.
export const BOSS_KINDS: readonly EnemyKind[] = ["boss", "marrow", "choir", "weaver", "gilded", "jet", "tithe", "quorum", "gorge", "sever", "choirmaster", "undertow", "claimant", "wake", "pale"];

export function isBossKind(kind: EnemyKind): boolean {
  return BOSS_KINDS.indexOf(kind) !== -1;
}

// The roster's authored names (docs/specs/blobrogue_BOSS_NAMES_flavor.md): the HUD boss
// bar titles the fight with the real name instead of a generic "BOSS". Keyed by the
// authoritative kind the bar already tracks; presentation (casing/truncation) is the
// HUD's job.
const BOSS_DISPLAY_NAME: Readonly<Partial<Record<EnemyKind, string>>> = {
  boss: "The Slime King",
  marrow: "Marrow",
  weaver: "The Weaver",
  gilded: "The Gilded Warden",
  choir: "The Hollow Choir",
  jet: "JET",
  tithe: "The Tithe",
  quorum: "Quorum",
  gorge: "The Gorge",
  sever: "Sever",
  choirmaster: "The Hollow Choirmaster",
  undertow: "Undertow",
  claimant: "The Claimant",
  wake: "The Wake",
  pale: "The Pale Throne",
};

export function bossDisplayName(kind: EnemyKind): string {
  return BOSS_DISPLAY_NAME[kind] ?? "Boss";
}

// The canonical first-clear chain (curriculum §0): Slime King F5 → Miniboss Gauntlet F10
// (a non-boss milestone — see world.ts's gauntlet controller) → Marrow F15 → Weaver F20 →
// Gilded Warden F25 → Hollow Choir F30. WAVE 1 extends the authored chain into THE UNMAKING
// (The Sump): JET F35 → THE TITHE F40 → QUORUM F45 are FIXED fresh bosses (the payoff to
// "repeats at 35 are boring"). `null` marks the gauntlet slot.
const AUTHORED_BOSS_LADDER: readonly (EnemyKind | null)[] =
  ["boss", null, "marrow", "weaver", "gilded", "choir", "jet", "tithe", "quorum"];

// Beyond the authored chain (F50+ endgame), boss floors draw from the FULL roster (now
// including the Wave 1 bosses), seeded per run — variety between runs, identical across a
// run's clients/restarts.
const DEEP_BOSS_ROSTER: readonly EnemyKind[] =
  ["marrow", "choir", "weaver", "gilded", "boss", "jet", "tithe", "quorum"];

// Each boss floor's kin — the floor's ambient minions and its cadence/beat adds. The Wave 1
// bosses draw their own thematic kin (ghost mists for JET's hollow mirror, skeletons for the
// Tithe's gnawed hoard, bone kin for the Quorum husk-family).
export const BOSS_KIN: Readonly<Partial<Record<EnemyKind, EnemyKind>>> = {
  boss: "slime", marrow: "skeleton", choir: "ghost", weaver: "bat", gilded: "shielder",
  jet: "ghost", tithe: "skeleton", quorum: "skeleton",
  // The GORGE giant summons NO adds itself (its threat is space-control patterns, not chasing);
  // this kin is only the approach-room escort the floor scatters (the Sump hoard).
  gorge: "skeleton",
  sever: "bat", // approach escort only; Sever summons no chase adds itself
  choirmaster: "ghost", // approach escort only; Choirmaster summons no adds itself
  undertow: "bat", // approach escort only; Undertow summons no chase adds itself
  claimant: "ghost", // approach escort only; Claimant summons no chase adds itself
  wake: "ghost", // approach escort only; the Wake summons no chase adds itself (the convoy is the beat)
  // The PALE THRONE giant likewise summons no adds; its kin is only the F75 approach-room escort
  // (the Pale region's frozen hoard) — same space-control-not-chasing giant contract as Gorge.
  pale: "skeleton",
};

// The F10 Arena Gauntlet floor (curriculum §2): sequential authored minibosses instead of
// a boss. The stage machine lives in world.ts; spawn/clear plumbing branches here.
export function isGauntletFloor(floor: number): boolean {
  return floor === GAUNTLET.floor;
}

// ---- the mid-band miniboss cadence (bestiary wave) ----

const MINIBOSS_ROSTER: readonly EnemyKind[] = ["marshal", "toll"];

export function isMinibossKind(kind: EnemyKind): boolean {
  return MINIBOSS_ROSTER.indexOf(kind) !== -1;
}

// Which miniboss template holds this floor, or null off the cadence. Floors 13, 18, 23,
// 28, … (every 5 from firstFloor — always the mid-band beat between boss floors) draw
// from the template roster on a seeded no-immediate-repeat walk, exactly like the deep
// boss rotation: variety between runs, identical across a run's clients/restarts.
// The mid-band miniboss CADENCE as a pure function of floor (seed-independent): floors 13, 18, 23,
// 28, … carry a captain. Used by the pre-F30 fairness ramp (floorRolls) to cap those floors to ≤1
// mild mutator + 1 affix slot — the captain is the floor's spike.
export function isMinibossFloor(floor: number): boolean {
  return floor >= MINIBOSS.firstFloor && floor % BOSS_EVERY === MINIBOSS.firstFloor % BOSS_EVERY;
}

export function minibossKindForFloor(seed: number, floor: number): EnemyKind | null {
  if (floor < MINIBOSS.firstFloor) return null;
  if (floor % BOSS_EVERY !== MINIBOSS.firstFloor % BOSS_EVERY) return null;
  const step = Math.floor((floor - MINIBOSS.firstFloor) / BOSS_EVERY);
  let prev = -1;
  for (let s = 0; ; s++) {
    let pick = new Rng((seed ^ 0x707E11) + s * 2654435761).int(0, MINIBOSS_ROSTER.length - 1);
    if (pick === prev) pick = (pick + 1) % MINIBOSS_ROSTER.length;
    if (s === step) return MINIBOSS_ROSTER[pick];
    prev = pick;
  }
}

// The miniboss captain's HP at its floor: the captain anchor (the pre-earned-windows
// full-uptime calibration — captains have no guard, so they never ride the guarded
// bosses' recalibrated anchors) ridden up the same clamped §3 curve, rounded to tens.
// Party scaling applies at spawn (spawnFloorEnemies), like the gauntlet captains.
export function minibossHpForFloor(kind: EnemyKind, floor: number): number {
  const frac = MINIBOSS.hpFrac[kind] ?? 0.3;
  return Math.round((frac * captainHpForFloor(floor)) / 10) * 10;
}

// Which boss holds each boss-cadence floor: the authored F5–F30 chain (null = the F10
// gauntlet), then the seeded deep rotation with no immediate repeats (its first pick also
// never repeats the F30 Choir finale).
export function bossKindForFloor(seed: number, floor: number): EnemyKind | null {
  // F50 is the GORGE GIANT — a FIXED set-piece (the Sump cap), NOT part of the seeded deep
  // rotation. Pure early return (no RNG touch).
  if (floor === GORGE_FLOOR) return "gorge";
  // F55 is SEVER — FIXED HUNT/INTERCEPT set-piece (Batch1 OWNER LOCK). Also an early return so
  // the seeded deep rotation (F60+) stays deterministic. deepBossIndex step 0 still treats the
  // F45 Quorum as predecessor; F55's Sever pin simply skips the first rotation slot that used
  // to live at F55 (now F60 is step 0 of the deep walk — see SEVER_FLOOR comment).
  if (floor === SEVER_FLOOR) return "sever";
  // F60 is HOLLOW CHOIRMASTER — FIXED SPLIT/SILENCE set-piece (Batch2A OWNER LOCK). Early return
  // so the seeded deep rotation (F65+) stays deterministic. Choirmaster consumes the old F60
  // deep-rotation slot (step 0); deep walk resumes at F65.
  if (floor === CHOIRMASTER_FLOOR) return "choirmaster";
  // F65 is UNDERTOW — FIXED STEAL/ESCAPE set-piece (Batch2B OWNER LOCK). Early return so the
  // seeded deep rotation (F70+) stays deterministic. Undertow consumes the old F65 deep-rotation
  // slot; deep walk resumes at F70 (Pale F75 remains its own pin).
  if (floor === UNDERTOW_FLOOR) return "undertow";
  // F70 is the CLAIMANT — FIXED PASS-THE-CLAIM coordination set-piece (Batch3A OWNER LOCK).
  // Early return so the seeded deep rotation stays deterministic. Claimant consumes the old F70
  // deep-rotation slot; the deepStep formula below is UNCHANGED (like Choirmaster F60 / Undertow
  // F65 / Pale F75 — an early-returned pin never consumes an extra deepStep subtract), so F75+
  // goldens stay byte-identical. CROWNFALL retired — never revive.
  if (floor === CLAIMANT_FLOOR) return "claimant";
  // F80 is THE WAKE — FIXED PROTECT/ADVANCE escort/convoy set-piece (Batch3B OWNER LOCK). Early
  // return so the seeded deep rotation stays deterministic. Wake consumes the old F80 deep-rotation
  // slot; the deepStep formula below is UNCHANGED (like Choirmaster F60 / Undertow F65 / Claimant
  // F70 / Pale F75 — an early-returned pin never consumes an extra deepStep subtract), so F85+
  // goldens stay byte-identical. NIGHTFALL_PROCESSION retired — never revive.
  if (floor === WAKE_FLOOR) return "wake";
  // F75 is the PALE THRONE GIANT — the SECOND fixed set-piece (the Pale region cap), pinned the
  // exact same way as the F50 gorge: a pure early return that never touches the RNG, so the seeded
  // ladder stays byte-identical (deepBossIndex still walks unchanged, and pale — like gorge — can
  // never be a rotation pick, so no seeded floor repeats it either).
  if (floor === PALE_FLOOR) return "pale";
  const ladder = Math.floor(floor / BOSS_EVERY);
  if (ladder <= AUTHORED_BOSS_LADDER.length) return AUTHORED_BOSS_LADDER[Math.max(1, ladder) - 1];
  // Deep rotation: F60 Choirmaster + F65 Undertow + F70 Claimant + F80 Wake pins consume old seeded
  // slots via early return; F85+ keeps the pre-pin deepStep formula so Gorge/Sever/Choirmaster/Pale
  // goldens stay green. step = ladder - authoredLen - 1 (Gorge F50) - 1 (Sever F55). Choirmaster F60 /
  // Undertow F65 / Claimant F70 / Pale F75 / Wake F80 are early-returned (none consumes an extra
  // deepStep subtract — same pattern), so the seeded floors below stay byte-identical.
  const deepStep = ladder - AUTHORED_BOSS_LADDER.length - 1 - 1;
  if (deepStep < 0) return DEEP_BOSS_ROSTER[deepBossIndex(seed, 0)];
  return DEEP_BOSS_ROSTER[deepBossIndex(seed, deepStep)];
}

// The floor the GORGE giant caps (the Sump). Kept as a named constant so the F75 Pale Throne /
// F100 Unmaker giants (which inherit this LOCKED template) slot in the same way.
export const GORGE_FLOOR = 50;

// F55 SEVER HUNT/INTERCEPT (Batch1 OWNER LOCK) — fixed set-piece, not seeded rotation.
export const SEVER_FLOOR = 55;
// F60 HOLLOW CHOIRMASTER SPLIT/SILENCE (Batch2A OWNER LOCK) — fixed set-piece, not seeded rotation.
export const CHOIRMASTER_FLOOR = 60;
// F65 UNDERTOW STEAL/ESCAPE (Batch2B OWNER LOCK) — fixed set-piece, not seeded rotation.
export const UNDERTOW_FLOOR = 65;
// F70 CLAIMANT PASS-THE-CLAIM (Batch3A OWNER LOCK) — fixed coordination set-piece, not seeded rotation.
export const CLAIMANT_FLOOR = 70;
// F80 THE WAKE PROTECT/ADVANCE (Batch3B OWNER LOCK) — fixed escort/convoy set-piece, not seeded rotation.
export const WAKE_FLOOR = 80;
// The floor the PALE THRONE giant caps (the Pale region — F71-90). The SECOND giant set-piece,
// pinned exactly like GORGE_FLOOR; F100 Unmaker will add its own pin the same way.
export const PALE_FLOOR = 75;

export const BOSS_FLOORS: readonly number[] = [
  ...AUTHORED_BOSS_LADDER.flatMap((kind, index) => kind === null ? [] : [(index + 1) * BOSS_EVERY]),
  GORGE_FLOOR,
  SEVER_FLOOR,
  CHOIRMASTER_FLOOR,
  UNDERTOW_FLOOR,
  CLAIMANT_FLOOR,
  PALE_FLOOR,
  WAKE_FLOOR,
];

// Walk the seeded ladder from the top so "no immediate repeats" is well-defined and
// deterministic at any depth (each step rerolls, shifting off the previous pick). Step 0
// treats the authored finale before the rotation (the F45 Quorum) as its predecessor, so
// the first seeded floor (F50) never repeats it.
function deepBossIndex(seed: number, step: number): number {
  let prev = DEEP_BOSS_ROSTER.indexOf("quorum");
  for (let s = 0; ; s++) {
    let pick = new Rng((seed ^ 0xB055ED) + s * 2654435761).int(0, DEEP_BOSS_ROSTER.length - 1);
    if (pick === prev) pick = (pick + 1) % DEEP_BOSS_ROSTER.length;
    if (s === step) return pick;
    prev = pick;
  }
}

// §3 exact tables: HP(f) = roundHalfToEven(baseHP × HPmult(f)), same for speed. Damage
// never scales with floor.
export function enemyHpForFloor(kind: EnemyKind, floor: number): number {
  switch (kind) {
    case "boss": return bossHpForFloor(floor);
    case "marrow": return marrowHpForFloor(floor);
    case "choir": return choirHpForFloor(floor);
    case "weaver": return weaverHpForFloor(floor);
    case "gilded": return gildedHpForFloor(floor);
    case "jet": return jetHpForFloor(floor);
    case "tithe": return titheHpForFloor(floor);
    case "quorum": return quorumHpForFloor(floor);
    case "gorge": return gorgeHpForFloor(floor);
    case "sever": return severHpForFloor(floor);
    case "choirmaster": return choirmasterHpForFloor(floor);
    case "choir_pillar": return choirPillarHpForFloor(floor);
    case "undertow": return undertowHpForFloor(floor);
    case "warm_pulse": return UNDERTOW.pulseHp;
    case "relief_vent": return UNDERTOW.ventHp;
    case "flood_front": return 9999;
    case "claimant": return claimantHpForFloor(floor);
    case "claim_token": return CLAIMANT.tokenHp;
    case "claim_socket": return CLAIMANT.socketHp;
    case "wake": return wakeHpForFloor(floor);
    case "warm_bier": return WAKE.bierHp;
    case "convoy_blocker": return WAKE.blockerHp;
    case "shadow_front": return 9999;
    case "pale": return paleHpForFloor(); // F75 fixed anchor (floor-independent — see paleHpForFloor)
    default: return roundHalfToEven(ENEMY_ARCHETYPES[kind].baseHp * floorHpMult(floor));
  }
}

export function enemySpeedForFloor(kind: EnemyKind, floor: number): number {
  return roundHalfToEven(ENEMY_ARCHETYPES[kind].baseSpeed * floorSpeedMult(floor));
}

// §4 threat-budget cost of one unit: archetype cost × tier cost, with the envelope's
// elite clamp — an elite on a complex/controller chassis never prices past
// ELITE_COST_CAP (the affix is one behavior, not a doubled tax).
export function threatCostOf(kind: EnemyKind, tier: EnemyTier): number {
  const cost = ENEMY_ARCHETYPES[kind].threat * TIERS[tier].threatCost;
  return tier === "elite" ? Math.min(cost, ELITE_COST_CAP) : cost;
}

// The complex MOVERS of studio gate §1: the movement verbs that deny standard answers
// (the charger's lane, the burrower's tunnel). At most MAX_COMPLEX_MOVERS_ACTIVE of them
// may be live at once on Standard.
export function isComplexMover(kind: EnemyKind): boolean {
  const m = ENEMY_ARCHETYPES[kind].movement;
  return m === "charge" || m === "burrow";
}

export interface CreateEnemyOpts {
  tier?: EnemyTier;
  isSummoned?: boolean;
  players?: number; // encounter player snapshot (co-op HP/KB scaling); 1 = solo
  // The pull's measured power ratio R (party+gear, sampled at encounter creation) —
  // BOSS HP scales off THIS, never off headcount alone (R already includes it). 1 =
  // baseline (solo / unmeasured).
  power?: number;
}

// The seeded sim Rng supplies the bat's initial `zig` heading so enemy creation is
// deterministic (golden-master oracle + later prediction). spawnFloorEnemies passes its
// own per-floor Rng; runtime spawns (boss adds, elite splits, dev) pass the live world Rng.
export function createEnemy(kind: EnemyKind, x: number, y: number, floor: number, rng: Rng, id: number, opts: CreateEnemyOpts = {}): Enemy {
  const a = ENEMY_ARCHETYPES[kind];
  const tier = opts.tier ?? "standard";
  const tierDef = TIERS[tier];
  const players = opts.players ?? 1;
  const isBoss = isBossKind(kind);
  // Boss HP: the R framework's sublinear, hard-capped effective HP (party+gear in one
  // measured number — headcount is never multiplied in separately). Mobs keep the
  // per-player co-op curve.
  const hp = isBoss
    ? Math.round((enemyHpForFloor(kind, floor) * bossHpFracFor(opts.power ?? 1)) / 10) * 10
    : Math.max(1, roundHalfToEven(a.baseHp * floorHpMult(floor) * tierDef.hpMult * coopMobHpMult(players)));
  const speed = isBoss
    ? a.baseSpeed
    : roundHalfToEven(a.baseSpeed * floorSpeedMult(floor) * tierDef.speedMult);
  // Seed the slime hop clock from the sim Rng (not Math.random): the slime's hop-cadence
  // reads it, so it must be deterministic. Drawn BEFORE zig to match the historical rng
  // stream order. Still desyncs each enemy, but reproducibly.
  const hopClock = rng.next() * 10;
  // The bulwark elite's plate arrives with the body (aux carries its remaining HP to the
  // wire); every other kind starts its aux channel at 0 — echo/knell fuses are stamped
  // by their spawners.
  const aux = tier === "elite" && ELITE_AFFIXES[kind] === "bulwark"
    ? roundHalfToEven(ELITE_BULWARK.plateHp * floorHpMult(floor))
    : 0;
  return {
    id,
    kind, x, y, vx: 0, vy: 0,
    tier,
    isSummoned: opts.isSummoned ?? false,
    radius: a.radius * tierDef.radiusMult,
    hp, maxHp: hp, dead: false,
    speed,
    touchDamage: a.touchDamage,
    kbResist: a.kbResist * (tier === "brute" ? 2 : 1) * coopKbResistMult(players),
    surgeDelay: 0, surgeTime: 0,
    rollAffix: "", affixState: 0, affixClock: 0,
    aux, seq: 0, panicTime: 0, echoTime: 0, echoAngle: 0,
    zig: rng.next() * Math.PI * 2,
    hopClock, hopMove: 0,
    spawnTimer: SPAWN_GRACE,
    stuckTimer: 0,
    avoidSide: 0,
    avoidTime: 0,
    burn: 0, burnDmg: 0, chill: 0, meleeSlowT: 0, meleeSlowMult: 1, meleeSlowAppliedTick: -1,
    shock: 0, markT: 0, petMarkT: 0, revealT: 0, statusTick: 0, burnOwner: null,
    mirrorOf: null,
    attack: {
      phase: "none", time: 0, move: "none", windup: 0,
      // Bosses wait a beat after their dramatic entrance before the first commitment.
      cooldown: BOSS_ENTRANCE_GRACE[kind] ?? 0,
      lockedAngle: 0, isAimLocked: false, markX: 0, markY: 0,
    },
    boss: isBoss
      ? {
        phase: 1, transitionsDone: 0, roar: null,
        addTimer: BOSS_ADD_FIRST_AT[kind] ?? 0,
        attackCount: 0, isNextRadial: false, burstParity: 0,
        beatAddIds: [], spinCount: 0,
        exposed: 0, windowBank: 0, windowAddIds: [], laneKnotId: 0, lastAddPick: -1, mirrorFamily: -1,
        mirrorLastFamily: -1,
        huskRaised: false, huskGuardUp: true, huskReformTimer: 0,
        phaseTime: 0, enrage: 0, isSurpriseSpent: false, affixCd: 0,
        seamLife: 0,
      }
      : null,
  };
}

const BOSS_ENTRANCE_GRACE: Readonly<Partial<Record<EnemyKind, number>>> = {
  boss: BOSS.entranceGrace, marrow: MARROW.entranceGrace, choir: CHOIR.entranceGrace,
  weaver: WEAVER.entranceGrace, gilded: GILDED.entranceGrace,
  jet: JET.entranceGrace, tithe: TITHE.entranceGrace, quorum: QUORUM.entranceGrace,
  gorge: GORGE.entranceGrace,
  sever: SEVER.entranceGrace, choirmaster: CHOIRMASTER.entranceGrace, undertow: UNDERTOW.entranceGrace,
  claimant: CLAIMANT.entranceGrace,
  wake: WAKE.entranceGrace,
  pale: PALE.entranceGrace,
};

// The summoner bosses run a cadence add drip; the Choir's timer paces its earned-window
// FRAGMENT verses instead (the Weaver's broodlings still arrive only on its molt beat;
// the Warden fights alone).
const BOSS_ADD_FIRST_AT: Readonly<Partial<Record<EnemyKind, number>>> = {
  boss: BOSS.addFirstAt, marrow: MARROW.addFirstAt, choir: CHOIR.fragmentFirstAt,
  jet: JET.echoFirstAt, // JET's first mirror-echo cadence beat after the pull settles
  // GORGE runs no add drip — it reuses the generic addTimer as its WEAK-POINT exposure cadence,
  // so this is when the first tectonic seams jut out after the pull settles.
  gorge: GORGE.seamFirstAt,
  // PALE THRONE runs the same weak-point exposure cadence (no add drip) — when its first cold
  // seams jut out after the pull settles.
  pale: PALE.seamFirstAt,
};

// The per-floor enemy pool is now Gate 1's biome-selective encounter deck (roster.ts): a
// per-region INCLUDE + CARRYOVER deck drawn into a floor's hand, replacing the old cumulative
// global roster. FAMILY_INTRO_FLOOR (the intro-cadence table) also lives there — it is deck
// curriculum data — and is re-imported here for the encounter-CARD availability gate below.

function weightedPick(rng: Rng, roster: Array<{ kind: EnemyKind; weight: number }>): EnemyKind {
  const total = roster.reduce((s, r) => s + r.weight, 0);
  let roll = rng.next() * total;
  for (const r of roster) {
    roll -= r.weight;
    if (roll <= 0) return r.kind;
  }
  return roster[roster.length - 1].kind;
}

// ---- the encounter deck (curriculum §4) ----
// Each combat room draws one CARD from a seeded shuffle bag; the card decides the room's
// composition flavor. Simple cards host only simple families; a complex card is the only
// place its family may land. The bag is drawn without replacement (an exact card cannot
// repeat until the bag turns over), never deals the same card twice in a row across a
// reshuffle, never deals more than two complex cards consecutively, keeps ≥30% of the
// floor's rooms simple (dropping complexity before repeating pressure, §4's own remedy),
// and deals an authored BREATHER as the first room after a milestone floor.

export type EncounterCard = "breather" | "pack" | "hunt" | "ranged" | "mover" | "wall";

const COMPLEX_CARDS: readonly EncounterCard[] = ["ranged", "mover", "wall"];

function isComplexCard(card: EncounterCard): boolean {
  return COMPLEX_CARDS.indexOf(card) !== -1;
}

// Which card a complex family plays under (simple families fit any room).
function cardOfKind(kind: EnemyKind): EncounterCard | null {
  switch (kind) {
    case "spitter": case "orbiter": case "caskbellows": case "echojack": case "fragment":
      return "ranged";
    case "charger": case "burrower": case "seamcutter": case "sinderling":
      return "mover";
    case "shielder": case "rootward": case "mason":
      return "wall";
    default: return null;
  }
}

// A complex card joins the pool once ANY of its families has been introduced. The card
// order is fixed (ranged, mover, wall) so the seeded shuffle bag stays byte-identical on
// every floor whose pool composition is unchanged.
function availableCards(floor: number): EncounterCard[] {
  const has = (kind: EnemyKind): boolean => floor >= (FAMILY_INTRO_FLOOR[kind] ?? Infinity);
  const cards: EncounterCard[] = ["pack", "hunt"];
  const kinds = Object.keys(ENEMY_ARCHETYPES) as EnemyKind[];
  for (const card of ["ranged", "mover", "wall"] as const) {
    if (kinds.some((k) => cardOfKind(k) === card && has(k))) cards.push(card);
  }
  return cards;
}

// The deck is a pure function of (seed, floor, combatRoomCount) — its own derived Rng
// stream, shared by the planner and the cadence tests.
export function encounterDeckForFloor(seed: number, floor: number, combatRoomCount: number): EncounterCard[] {
  const rng = new Rng((seed ^ 0xDECCB4A9) + floor * 92821);
  const pool = availableCards(floor);
  const bag: EncounterCard[] = [];
  const cards: EncounterCard[] = [];
  let complexRun = 0;
  for (let i = 0; i < combatRoomCount; i++) {
    // The first room after a milestone floor (boss or gauntlet) is the authored breather.
    if (i === 0 && floor > 1 && isBossFloor(floor - 1)) {
      cards.push("breather");
      complexRun = 0;
      continue;
    }
    if (bag.length === 0) {
      bag.push(...pool);
      // Fisher-Yates off the seeded stream.
      for (let k = bag.length - 1; k > 0; k--) {
        const j = rng.int(0, k);
        [bag[k], bag[j]] = [bag[j], bag[k]];
      }
      // Never deal the same card twice in a row across the reshuffle boundary.
      if (cards.length > 0 && bag[bag.length - 1] === cards[cards.length - 1] && bag.length > 1) {
        [bag[bag.length - 1], bag[0]] = [bag[0], bag[bag.length - 1]];
      }
    }
    // Max two complex cards consecutively: prefer the topmost simple card when the run
    // would exceed the limit; if the bag holds only pressure, deal a simple filler
    // instead (drop complexity before repeating it — §4's remedy) and keep the bag.
    // Every path also refuses to deal the same card back-to-back.
    const last = cards.length > 0 ? cards[cards.length - 1] : null;
    let take = -1;
    for (let k = bag.length - 1; k >= 0; k--) {
      if (bag[k] === last) continue;
      if (complexRun >= 2 && isComplexCard(bag[k])) continue;
      take = k;
      break;
    }
    const card = take === -1 ? (last === "hunt" ? "pack" : "hunt") : bag.splice(take, 1)[0];
    complexRun = isComplexCard(card) ? complexRun + 1 : 0;
    cards.push(card);
  }
  // ≥35% simple/mastery rooms (envelope; raised from the interim 30%): drop complexity
  // from the tail before repeating pressure, picking whichever simple card keeps
  // neighbors distinct.
  const simpleQuota = Math.ceil(combatRoomCount * ENVELOPE.simpleRoomShare);
  let simple = cards.filter((c) => !isComplexCard(c)).length;
  for (let i = cards.length - 1; i >= 0 && simple < simpleQuota; i--) {
    if (!isComplexCard(cards[i])) continue;
    const neighbors = [cards[i - 1], cards[i + 1]];
    cards[i] = (["hunt", "pack", "breather"] as const).find((c) => !neighbors.includes(c)) ?? "hunt";
    simple++;
  }
  return cards;
}

// A spawn point on OPEN FLOOR inside the room. Rooms carry interior walls now (pillared
// halls, cavern edges, vault rings), so a raw rect sample can land inside geometry;
// resample a few times and fall back to the room center, which the generator guarantees
// open. Deterministic: same seed -> same draw sequence.
function pointInRoom(rng: Rng, dungeon: Dungeon, roomIndex: number): { x: number; y: number } {
  const room = dungeon.rooms[roomIndex];
  for (let attempt = 0; attempt < 12; attempt++) {
    const x = (room.x + 1 + rng.next() * Math.max(1, room.w - 2)) * TILE;
    const y = (room.y + 1 + rng.next() * Math.max(1, room.h - 2)) * TILE;
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (dungeon.tiles[ty * dungeon.w + tx] === 0) return { x, y };
  }
  return { x: (room.cx + 0.5) * TILE, y: (room.cy + 0.5) * TILE };
}

// The floor's spawn set, split into the immediately-active wave and the pending
// reinforcement queue (released by the world when the living threat drops under the cap).
export interface FloorSpawns {
  active: Enemy[];
  pending: Enemy[];
}

interface PlannedUnit {
  kind: EnemyKind;
  tier: EnemyTier;
  room: number;
  // Mid-band miniboss anchor: spawns as a two-phase captain (HP override + captainPhase)
  // and always enters the active wave — it IS its room's encounter.
  isMiniboss?: boolean;
}

// Per-room composition bookkeeping for the §4 readability guards + the envelope's
// exposure caps (≤4 distinct archetypes, ≤1 controller, no control+denial pairing).
interface RoomLoad {
  card: EncounterCard;
  units: number;
  complex: number;
  burrowers: number;
  shielders: number;
  workers: number; // topology workers (ecology gate: one persistent edit per room)
  controllers: number;
  hasDenial: boolean; // a guard-module wall (shielder/rootward) holds this room
  kinds: Set<EnemyKind>;
  hasBrute: boolean;
  hasElite: boolean;
}

// Flock spacing: swarm-tier units (the boid packs — see flock.ts) need open air to move
// as a flock, so their placement prefers rooms with at least this many open floor tiles.
// Exported so the depth suite can assert the invariant.
export const SWARM_ROOM_MIN_AREA = 30;

function roomOpenArea(dungeon: Dungeon, roomIndex: number): number {
  const room = dungeon.rooms[roomIndex];
  let open = 0;
  for (let ty = room.y; ty < room.y + room.h; ty++) {
    for (let tx = room.x; tx < room.x + room.w; tx++) {
      if (dungeon.tiles[ty * dungeon.w + tx] === 0) open++;
    }
  }
  return open;
}

// Deterministic threat-budget floor composition (§4): spend FloorThreat on a tiered unit
// mix instead of counting bodies. Elites/brutes are planned first (they anchor the opening
// wave); swarm packs and standards fill the remainder and overflow into reinforcements.
function planFloorUnits(rng: Rng, dungeon: Dungeon, seed: number, floor: number, players: number, extraElites = 0, eliteAffixes: readonly EliteAffixRoll[] = []): PlannedUnit[] {
  const roomCount = dungeon.rooms.length;
  const pressure = BIOME_PRESSURE[biomeIndexForFloor(floor)];
  let budget = floorThreat(floor) * pressure.budgetMult * coopThreatMult(players);
  // The affix budget surcharge (PRE_F30_LEVEL_VARIETY_NUMBERS.md §1): an elite whose ascending
  // ordinal rolled a non-null affix costs +AFFIX_THREAT_SURCHARGE, folded pre-clamp under
  // ELITE_COST_CAP so the affix trades chaff (budget-neutral) instead of stacking on top. Affixes
  // map to elites by ordinal exactly as applyRollAffix assigns them at spawn.
  const isEliteAffixed = (ordinal: number): boolean =>
    eliteAffixes.some((slot) => slot.ordinal === ordinal && slot.affix !== null);
  const roster = floorRoster(seed, floor, pressure.complexShare);
  const plan: PlannedUnit[] = [];

  // Combat rooms: 3–5 of the non-spawn rooms carry the floor's threat, in PROGRESSION
  // order (ascending room index) so the deck's sequencing rules — breather first after a
  // milestone, complex-run limits — read along the player's actual path. The shop room
  // is sanctuary ground and never a candidate (Patch's waystation hosts no encounter).
  const candidates: number[] = [];
  for (let i = 1; i < roomCount; i++) {
    if (dungeon.rooms[i].kind !== "shop") candidates.push(i);
  }
  const combatRoomCount = Math.min(5, Math.max(Math.min(3, candidates.length), Math.floor(candidates.length * 0.75)));
  const combatRooms: number[] = [];
  while (combatRooms.length < combatRoomCount && candidates.length > 0) {
    combatRooms.push(candidates.splice(rng.int(0, candidates.length - 1), 1)[0]);
  }
  combatRooms.sort((a, b) => a - b);

  // The mid-band miniboss (F13/18/23/…): the DEEPEST combat room becomes its arena —
  // pulled out of the ordinary plan entirely (the captain is that room's whole
  // encounter) — and the floor keeps only part of its threat budget for regular units,
  // so the floor reads as "the miniboss floor", never "a boss plus a full mob".
  const minibossKind = minibossKindForFloor(seed, floor);
  let minibossRoom = -1;
  if (minibossKind !== null && combatRooms.length >= 2) {
    minibossRoom = combatRooms.pop()!;
    // The captain pays its ENVELOPE threat cost (8–12 band) straight out of the floor's
    // budget; a small floor of simple bodies always remains so the approach isn't empty.
    budget = Math.max(2, budget - MINIBOSS.threatCost);
  }

  const deck = encounterDeckForFloor(seed, floor, combatRooms.length);
  const load = new Map<number, RoomLoad>();
  for (let i = 0; i < combatRooms.length; i++) {
    load.set(combatRooms[i], {
      card: deck[i], units: 0, complex: 0, burrowers: 0, shielders: 0, workers: 0,
      controllers: 0, hasDenial: false, kinds: new Set<EnemyKind>(), hasBrute: false, hasElite: false,
    });
  }
  // §4: at most 35% of the floor's rooms may carry TWO complex units.
  let twoComplexRooms = 0;
  const twoComplexCap = Math.floor(combatRooms.length * 0.35);
  // Envelope exposure cap: a floor exposes at most floorArchetypeCap distinct regular
  // archetypes — depth grows the POOL, never one floor's simultaneous vocabulary.
  const exposure = new Set<EnemyKind>();
  // Envelope co-op rule: the party's EXTRA threat buys mostly simple bodies — the
  // floor's heavy spend (any unit costing more than a simple standard) is capped at
  // the SOLO budget, so P>1 scales pressure with bodies, not stacked verbs. At P1 the
  // whole budget IS the solo budget, so the constraint never binds solo.
  const soloBudget = floorThreat(floor) * pressure.budgetMult;
  let heavySpent = 0;

  // Swarm placement (flock spacing, gate: flocks need open air): combat rooms with real
  // open floor host the packs; the ordinary card-constrained draw is the fallback. Room
  // shapes get roomier with depth (halls, arenas, caverns), so deep flocks reliably get
  // their theater.
  const roomyCombat = combatRooms.filter((r) => roomOpenArea(dungeon, r) >= SWARM_ROOM_MIN_AREA);

  const roomFits = (room: number, unit: { kind: EnemyKind; tier: EnemyTier }): boolean => {
    const l = load.get(room)!;
    const family = cardOfKind(unit.kind);
    // A complex family may only land in a room playing ITS card; breathers stay small
    // and simple (the curriculum's mastery/recovery room).
    if (family !== null && l.card !== family) return false;
    if (l.card === "breather" && (family !== null || unit.tier === "elite" || unit.tier === "brute" || l.units >= 3)) return false;
    if (ENEMY_ARCHETYPES[unit.kind].threat > 1) {
      if (l.complex >= MAX_COMPLEX_PER_ROOM) return false;
      if (l.complex === 1 && twoComplexRooms >= twoComplexCap) return false;
    }
    if (unit.kind === "burrower" && l.burrowers >= MAX_BURROWERS_PER_ROOM) return false;
    if (unit.kind === "shielder" && l.shielders >= MAX_SHIELDERS_PER_ROOM) return false;
    // The ecology gate: at most ONE topology worker per room — one persistent edit.
    if (isWorkerKind(unit.kind) && l.workers >= MAX_WORKERS_PER_ROOM) return false;
    // Envelope exposure caps: ≤ roomArchetypeCap distinct kinds per room, ≤ 7 per
    // floor; ≤ 1 controller per room; a controller NEVER shares a room with a
    // guard-module wall (the banned control+denial pairing — a room that both lies to
    // you and denies your fire has no honest answer).
    if (!l.kinds.has(unit.kind) && l.kinds.size >= ENVELOPE.roomArchetypeCap) return false;
    if (!exposure.has(unit.kind) && exposure.size >= ENVELOPE.floorArchetypeCap) return false;
    const isDenial = ENEMY_MODULE[unit.kind] === "guard";
    if (isControllerKind(unit.kind)) {
      if (l.controllers >= ENVELOPE.roomControllerCap) return false;
      if (l.hasDenial) return false;
    } else if (isDenial && l.controllers > 0) {
      return false;
    }
    // Envelope co-op rule: heavy spend (cost > 1) caps at the solo budget.
    const cost = threatCostOf(unit.kind, unit.tier);
    if (cost > 1 && heavySpent + cost > soloBudget) return false;
    // Corrected gate §2 tier cadence: one brute and one elite per room.
    if (unit.tier === "brute" && l.hasBrute) return false;
    if (unit.tier === "elite" && l.hasElite) return false;
    if (floor < BRUTE_ELITE_COMBO_FLOOR) {
      if (unit.tier === "brute" && l.hasElite) return false;
      if (unit.tier === "elite" && l.hasBrute) return false;
    }
    return true;
  };

  const claimRoom = (room: number, unit: { kind: EnemyKind; tier: EnemyTier }): number => {
    const l = load.get(room)!;
    l.units++;
    if (ENEMY_ARCHETYPES[unit.kind].threat > 1) {
      l.complex++;
      if (l.complex === 2) twoComplexRooms++;
    }
    if (unit.kind === "burrower") l.burrowers++;
    if (unit.kind === "shielder") l.shielders++;
    if (isWorkerKind(unit.kind)) l.workers++;
    if (isControllerKind(unit.kind)) l.controllers++;
    if (ENEMY_MODULE[unit.kind] === "guard") l.hasDenial = true;
    l.kinds.add(unit.kind);
    exposure.add(unit.kind);
    const cost = threatCostOf(unit.kind, unit.tier);
    if (cost > 1) heavySpent += cost;
    if (unit.tier === "brute") l.hasBrute = true;
    if (unit.tier === "elite") l.hasElite = true;
    return room;
  };

  // Random placement first, then a deterministic scan — the composition guards are HARD
  // (a floor plants fewer units before it ever breaks one).
  const pickRoom = (unit: { kind: EnemyKind; tier: EnemyTier }): number | null => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const room = combatRooms[rng.int(0, combatRooms.length - 1)];
      if (roomFits(room, unit)) return claimRoom(room, unit);
    }
    for (const room of combatRooms) {
      if (roomFits(room, unit)) return claimRoom(room, unit);
    }
    return null;
  };

  // Swarm units prefer the roomy combat rooms (same card guards, roomier draw pool);
  // when no roomy room fits, the ordinary draw decides — caps beat preference.
  const pickSwarmRoom = (kind: EnemyKind): number | null => {
    if (roomyCombat.length > 0) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const room = roomyCombat[rng.int(0, roomyCombat.length - 1)];
        if (roomFits(room, { kind, tier: "swarm" })) return claimRoom(room, { kind, tier: "swarm" });
      }
    }
    return pickRoom({ kind, tier: "swarm" });
  };

  const add = (kind: EnemyKind, tier: EnemyTier, surcharge = 0): boolean => {
    // The surcharge is only ever passed for an affixed elite; fold it in pre-clamp under the cap.
    const cost = surcharge > 0 ? Math.min(threatCostOf(kind, tier) + surcharge, ELITE_COST_CAP) : threatCostOf(kind, tier);
    if (cost > budget) return false;
    const room = tier === "swarm" ? pickSwarmRoom(kind) : pickRoom({ kind, tier });
    if (room === null) return false;
    budget -= cost;
    plan.push({ kind, tier, room });
    return true;
  };

  // Every complex card's room is anchored by ONE unit of its family first — the card IS
  // that room's lesson; the fill loop then textures around the anchors.
  for (const room of combatRooms) {
    const l = load.get(room)!;
    if (!isComplexCard(l.card)) continue;
    const anchors = roster.filter((r) => cardOfKind(r.kind) === l.card);
    if (anchors.length === 0) continue;
    const kind = anchors.length === 1 ? anchors[0].kind : weightedPick(rng, anchors);
    const cost = threatCostOf(kind, "standard");
    if (cost > budget || !roomFits(room, { kind, tier: "standard" })) continue;
    claimRoom(room, { kind, tier: "standard" });
    budget -= cost;
    plan.push({ kind, tier: "standard", room });
  }

  if (floor >= TIERS.elite.minFloor) {
    // The Twinned Elites mutator adds one elite to the plan (paired elite pressure); the
    // LIVE_CAPS.elites active cap + reinforcement release still gate how many are live at once.
    const elites = (floor >= 9 ? 2 : 1) + Math.max(0, extraElites);
    // Elites take their spawn ordinal in placement order (matching spawnFloorEnemies' eliteOrdinal
    // walk); an ordinal that rolled an affix pays the budget surcharge when it lands.
    let eliteOrdinal = 0;
    for (let i = 0; i < elites; i++) {
      // Pre-F30 ONLY: the surcharge is a pre-#244 budget lever, so it must never retune the
      // already-shipped post-F30 "Unmaking" balance (F31+ stays byte-stable with the pre-#244 curve).
      const surcharge = (floor < DEEP_FLOOR_MIN && isEliteAffixed(eliteOrdinal)) ? AFFIX_THREAT_SURCHARGE : 0;
      // Up to three rolls: an elite of a complex family needs a room playing its card.
      let placed = false;
      for (let roll = 0; roll < 3 && !placed; roll++) placed = add(weightedPick(rng, roster), "elite", surcharge);
      if (placed) eliteOrdinal++;
    }
  }
  if (floor >= TIERS.brute.minFloor) {
    const brutes = floor >= 7 ? 2 : 1;
    for (let i = 0; i < brutes; i++) add(BRUTE_KINDS[rng.int(0, BRUTE_KINDS.length - 1)], "brute");
  }

  // Gate §2: no pack (the bat flock especially) may consume more than 35% of the floor's
  // threat spend — a swarm is texture, never the room's whole budget.
  const packSpendCap = FLOCK_THREAT_SHARE_MAX * floorThreat(floor) * pressure.budgetMult * coopThreatMult(players);
  const minCost = threatCostOf("slime", "swarm");
  let guard = 0;
  while (budget >= minCost && guard++ < 200) {
    const kind = weightedPick(rng, roster);
    const isSwarmable = SWARM_KINDS.includes(kind);
    if (isSwarmable && rng.chance(0.3 * pressure.packBias)) {
      const pack = rng.int(2, 3);
      const room = pickSwarmRoom(kind);
      if (room === null) continue;
      let packSpent = threatCostOf(kind, "swarm");
      budget -= packSpent;
      plan.push({ kind, tier: "swarm", room });
      for (let i = 1; i < pack; i++) {
        const cost = threatCostOf(kind, "swarm");
        if (cost > budget || packSpent + cost > packSpendCap) break;
        // Each extra pack body re-checks the room's guards (a breather stays small).
        if (!roomFits(room, { kind, tier: "swarm" })) break;
        claimRoom(room, { kind, tier: "swarm" });
        budget -= cost;
        packSpent += cost;
        plan.push({ kind, tier: "swarm", room });
      }
    } else if (!add(kind, "standard")) {
      // No compatible room (or too expensive) — reroll; a swarm unit may still fit.
      if (isSwarmable) add(kind, "swarm");
    }
  }
  // The miniboss lands last in plan order (spawn ids stay stable for the regular units)
  // but owns the floor's deepest room outright.
  if (minibossKind !== null && minibossRoom !== -1) {
    plan.push({ kind: minibossKind, tier: "standard", room: minibossRoom, isMiniboss: true });
  }
  return plan;
}

// The Wave-1 randomness inputs the floor descriptor supplies: the Twinned Elites mutator's extra
// elite count, and the elite-affix slots (by ascending ordinal) rolled for this floor. Defaulted
// so pre-F30 floors + every existing caller stay byte-identical.
export interface SpawnOpts {
  extraElites?: number;
  eliteAffixes?: readonly EliteAffixRoll[];
}

// Assign an elite's rolled affix (splits/shielded/hazardTrail/reflect/enrage) from the frozen
// descriptor slot at its ascending spawn ordinal, and stamp the affix's per-body scalar on its
// OWN channel (affixState — never `aux`, so a kind's aux mechanic is untouched): a shielded
// slab's HP, a reflect facet's armed state. Ordinals past the rolled slot count get no rolled
// affix. Pure — every client that resolves the same descriptor assigns identically.
function applyRollAffix(e: Enemy, ordinal: number, floor: number, eliteAffixes: readonly EliteAffixRoll[]): void {
  const slot = eliteAffixes.find((r) => r.ordinal === ordinal);
  const affix = slot?.affix ?? null;
  if (affix === null) return;
  e.rollAffix = affix;
  if (affix === "shielded") e.affixState = roundHalfToEven(ROLL_AFFIX.slabHp * floorHpMult(floor));
  else if (affix === "reflect") e.affixState = ROLL_AFFIX.reflectArmed; // the facet starts ARMED
}

export function spawnFloorEnemies(dungeon: Dungeon, seed: number, floor: number, players = 1, power = 1, opts: SpawnOpts = {}): FloorSpawns {
  const rng = new Rng((seed ^ 0x9e3779b9) + floor * 2654435761);
  const roomCount = dungeon.rooms.length;
  if (roomCount <= 1) return { active: [], pending: [] };
  const eliteAffixes = opts.eliteAffixes ?? [];

  if (isGauntletFloor(floor)) {
    // The F10 Arena Gauntlet: the arena (last room) starts EMPTY — the world's gauntlet
    // controller stages the sequential minibosses — while the approach rooms carry a
    // light flock escort sprinkle (the region's kin, never the arena's pressure).
    const active: Enemy[] = [];
    const minions = 2 + Math.floor(floor / BOSS_EVERY);
    for (let i = 0; i < minions; i++) {
      const roomIndex = 1 + rng.int(0, Math.max(1, roomCount - 2) - 1);
      const p = pointInRoom(rng, dungeon, roomIndex);
      active.push(createEnemy("bat", p.x, p.y, floor, rng, active.length, { players }));
    }
    return { active, pending: [] };
  }

  if (isBossFloor(floor)) {
    // The floor's boss lives in the last room (next to the exit), with a few of its own
    // kin for company — EXCEPT Sever F55, which spawns in the hunt blueprint's approach room
    // (Batch1: spawn ≠ forced last-arena-only).
    const active: Enemy[] = [];
    const bossKind = bossKindForFloor(seed, floor) ?? "boss";
    const minionKind: EnemyKind = BOSS_KIN[bossKind] ?? "slime";
    const bpSpawn = dungeon.blueprint?.spawnRoomId;
    const bossRoom = (
      (bossKind === "sever" || bossKind === "choirmaster" || bossKind === "undertow" || bossKind === "wake")
      && bpSpawn !== undefined && bpSpawn >= 0 && bpSpawn < roomCount
    ) ? bpSpawn : roomCount - 1;
    // pointInRoom is called unconditionally (it advances the seeded RNG the same way for every
    // boss). The GIANTS (Gorge F50, Pale Throne F75) are STATIONARY set-pieces that must anchor at
    // the arena CENTER so their radial rings/spokes have symmetric dodge space on every side (a
    // wall-hugged giant would be unfair). Choirmaster is also a stationary conductor at center.
    // Every other boss uses the sampled interior point.
    const b = pointInRoom(rng, dungeon, bossRoom);
    const room = dungeon.rooms[bossRoom];
    const isGiant = bossKind === "gorge" || bossKind === "pale";
    // Claimant centers like the Choirmaster conductor: a compact coordination arena needs
    // symmetric pass/socket space on every side (a wall-hugged Claimant would be unfair).
    const isCentered = isGiant || bossKind === "choirmaster" || bossKind === "claimant";
    const spawn = isCentered ? { x: (room.cx + 0.5) * TILE, y: (room.cy + 0.5) * TILE } : b;
    active.push(createEnemy(bossKind, spawn.x, spawn.y, floor, rng, active.length, { players, power }));
    const minions = 2 + Math.floor(floor / BOSS_EVERY);
    for (let i = 0; i < minions; i++) {
      const roomIndex = 1 + rng.int(0, roomCount - 2);
      const p = pointInRoom(rng, dungeon, roomIndex);
      active.push(createEnemy(minionKind, p.x, p.y, floor, rng, active.length, { players }));
    }
    return { active, pending: [] };
  }

  const plan = planFloorUnits(rng, dungeon, seed, floor, players, opts.extraElites ?? 0, eliteAffixes);
  const cap = activeThreatCap(floor) * coopThreatMult(players);
  let eliteOrdinal = 0; // ascending spawn ordinal for elite-affix assignment (plan order)
  const moverCap = activeMoverCapFor(players);
  const active: Enemy[] = [];
  const pending: Enemy[] = [];
  let activeThreat = 0;
  let activeComplexMovers = 0;
  let activeBrutes = 0;
  let activeElites = 0;
  let activeControllers = 0;
  let id = 0;
  for (const unit of plan) {
    const p = pointInRoom(rng, dungeon, unit.room);
    const enemy = createEnemy(unit.kind, p.x, p.y, floor, rng, id++, { tier: unit.tier, players });
    // Rolled elite affixes, by ASCENDING SPAWN ORDINAL (plan order), independent of the
    // active/pending split — slot N is stable no matter how many elites end up live.
    if (unit.tier === "elite" && !unit.isMiniboss) applyRollAffix(enemy, eliteOrdinal++, floor, eliteAffixes);
    if (unit.isMiniboss) {
      // The mid-band captain: gauntlet HP formula anchored to its template fraction,
      // party-scaled at THIS spawn, two-phase contract armed. Always active — the
      // miniboss is the floor's authored beat, never a queued reinforcement.
      const hp = Math.round((minibossHpForFloor(unit.kind, floor) * coopBossHpMult(players)) / 10) * 10;
      enemy.hp = enemy.maxHp = hp;
      enemy.captainPhase = 1;
      // The captain phase rides the aux channel for the client (the marshal's shield
      // render keys off it; captainPhase itself never travels the wire).
      enemy.aux = 1;
      active.push(enemy);
      continue;
    }
    const cost = threatCostOf(unit.kind, unit.tier);
    const isMover = isComplexMover(unit.kind);
    // The envelope's LIVE caps: never exceed the ActiveThreatCap, the body cap, or any
    // per-class simultaneity cap (movers — +1 only at a full P4 party — brutes, elites,
    // controllers). Overflow becomes reinforcements, released under the same gates.
    const fitsClasses = (!isMover || activeComplexMovers < moverCap)
      && (unit.tier !== "brute" || activeBrutes < LIVE_CAPS.brutes)
      && (unit.tier !== "elite" || activeElites < LIVE_CAPS.elites)
      && (!isControllerKind(unit.kind) || activeControllers < LIVE_CAPS.controllers);
    if (activeThreat + cost <= cap && active.length < LIVE_CAPS.bodies && fitsClasses) {
      activeThreat += cost;
      if (isMover) activeComplexMovers++;
      if (unit.tier === "brute") activeBrutes++;
      if (unit.tier === "elite") activeElites++;
      if (isControllerKind(unit.kind)) activeControllers++;
      active.push(enemy);
    } else {
      pending.push(enemy);
    }
  }
  return { active, pending };
}
