// The bestiary AUDIO HOOK CONTRACT: how every enemy sounds, as pure data the director
// (waveAudio.ts) and the QA suite (test/bestiaryaudio.test.ts) both consume.
//
// The identity model (contract):
//  - SEMANTIC SIM EVENTS drive everything — windup / lock / active / impact / recover /
//    hurt / death, read off the authoritative attack state and sim events, NEVER
//    animation frames (the tell watcher diffs AttackState; hurt/death ride enemyHit /
//    enemyKill).
//  - The BEHAVIOR VERB teaches counterplay (a charge sounds like a charge on every
//    chassis); the BODY MATERIAL identifies the species (bone charge vs chitin charge);
//    the TIER adds an authored body/debris LAYER on top — never a pitch-down.
//  - Danger arbitration: lock cues fire only off accepted attack commitments (the
//    authoritative aim-lock edge; releases are already gated by the sim's release
//    arbiter), at most MAX_CONCURRENT_MOB_LOCKS mob locks in one audible window, the
//    flock sounds as ONE aggregate bed, and hurt/death cues are rate-limited rows.
//  - Lock cues are DRY and positional (spatial, zero jitter) so they localize.
//  - No `stem: null` anywhere in the bestiary surface EXCEPT selection-driven rows
//    (explicit shipped take lists — the burrow emitter components), which are authored
//    by construction; fallbacks are SAME-MATERIAL shipped samples only, inside a sane
//    rate window (no oscillator identities, no extreme pitching).
//
// This module is manifest + resolution only; authored asset generation stays with the
// main agent's locked pipeline.

import type { EnemyKind } from "../sim/types.js";
import type { WaveEventId } from "./waveSpec.js";
import type { SfxName } from "./audio.js";

// ---- behavior verbs ----

export type AudioBehavior =
  | "hunt"      // walk + commit (slime, skeleton)
  | "flock"     // aggregate bed + pack beats (bat)
  | "kite"      // ranged hold: warn/lock/fire (spitter)
  | "charge"    // plant/lock/rush/crash/dazed (charger, seamcutter)
  | "burrow"    // dive/emitter/lock/erupt/recover — NO continuous loop (burrower)
  | "orbit"     // acquire/one group loop/warn/lock/fire (orbiter)
  | "shield"    // raise/block/bash/guardBreak/rearHurt (shielder, rootward)
  | "anchor"    // place/laneWarn/lock/active/deflate (caskbellows)
  | "trickster" // decoy + relocation (echojack)
  | "ember"     // heat-feeder: stoke/jet/burst (sinderling)
  | "voice"     // tether harmonics (fragment)
  | "worker"    // topology mason: survey the site, raise the construction (mason)
  | "decoy"     // planted noise bodies (echo, knell)
  | "captain"   // miniboss grammar (marshal, toll)
  | "boss";     // full boss grammar (king, marrow, choir, weaver, gilded)

export const AUDIO_BEHAVIOR: Readonly<Record<EnemyKind, AudioBehavior>> = {
  slime: "hunt",
  bat: "flock",
  skeleton: "hunt",
  ghost: "hunt",
  spitter: "kite",
  charger: "charge",
  burrower: "burrow",
  orbiter: "orbit",
  shielder: "shield",
  rootward: "shield",
  echojack: "trickster",
  seamcutter: "charge",
  caskbellows: "anchor",
  sinderling: "ember",
  mason: "worker",
  fragment: "voice",
  echo: "decoy",
  knell: "decoy",
  knot: "decoy",
  sac: "decoy",
  marshal: "captain",
  toll: "captain",
  boss: "boss",
  marrow: "boss",
  choir: "boss",
  weaver: "boss",
  gilded: "boss",
  // Wave 1 deep bosses run full boss grammar; the satellite bodies are decoy-grade
  // (planted mechanic bodies, like the Weaver's knot/sac).
  jet: "boss", tithe: "boss", quorum: "boss",
  tithe_slab: "decoy", quorum_shield: "decoy", quorum_heal: "decoy", quorum_dmg: "decoy",
};

// ---- body materials ----

export type AudioMaterial =
  | "goo" | "leather" | "bone" | "mist" | "chitin" | "earth"
  | "wood" | "root" | "brass" | "bell" | "ember" | "voice" | "stone" | "gold";

export const AUDIO_MATERIAL: Readonly<Record<EnemyKind, AudioMaterial>> = {
  slime: "goo",
  bat: "leather",
  skeleton: "bone",
  ghost: "mist",
  spitter: "chitin",
  charger: "bone",
  burrower: "earth",
  orbiter: "chitin",
  shielder: "wood",
  rootward: "root",
  echojack: "mist",
  seamcutter: "chitin",
  caskbellows: "brass",
  sinderling: "ember",
  mason: "stone",
  fragment: "voice",
  echo: "mist",
  knell: "bell",
  knot: "chitin",  // the Weaver's thread lattice — its own body material
  sac: "chitin",
  marshal: "root",
  toll: "bell",
  boss: "goo",
  marrow: "bone",
  choir: "voice",
  weaver: "chitin",
  gilded: "gold",
  // Wave 1 placeholders (real per-boss audio is the audio director's separate task —
  // amber-motif stems for JET, the feeder swell for the Tithe, three voice stems for the
  // Quorum). The material here only picks the same-family fallback bank until those land:
  // JET reuses the King's goo bank (the mirror of the player), the Tithe the Warden's gold
  // (its stolen amber), the Quorum the bone roster; the mechanic bodies reuse the chitin
  // lattice bank (like the Weaver's knots/sacs).
  jet: "goo", tithe: "gold", quorum: "bone",
  tithe_slab: "chitin", quorum_shield: "chitin", quorum_heal: "chitin", quorum_dmg: "chitin",
};

// SAME-MATERIAL fallback law: until a row's generated stem lands, its declared fallback
// must come from this material's shipped-sample family — a bone body may fall back onto
// bone-adjacent impacts, never onto a bell. The QA suite validates every bestiary row's
// fallback sample against its owner's material set.
export const MATERIAL_FALLBACK_SAMPLES: Readonly<Record<AudioMaterial, readonly SfxName[]>> = {
  goo: ["enemyAttack", "enemyHit", "enemyDeath", "bossSpawn"],
  leather: ["dash", "enemyAttack", "coin", "enemyDeath"],
  bone: ["meleeHit", "enemyAttack", "enemyDeath", "cannon", "dash", "bossSpawn"],
  mist: ["tesla", "enemyAttack", "enemyDeath", "dash", "coin"],
  chitin: ["dash", "meleeSwing", "meleeHit", "uiClick", "enemyAttack", "tesla", "homing", "parry", "bossSpawn", "enemyDeath"],
  earth: ["cannon", "dash", "enemyAttack", "meleeHit", "enemyHit", "barrel"],
  wood: ["chest", "barrel", "meleeHit", "enemyAttack", "parry"],
  root: ["chest", "barrel", "enemyAttack", "enemyDeath", "meleeHit"],
  brass: ["chest", "barrel", "coin", "enemyAttack", "cannon"],
  bell: ["floorClear", "chest", "coin", "uiClick", "enemyAttack"],
  ember: ["barrel", "enemyAttack", "dash"],
  voice: ["enemyAttack", "tesla", "bossSpawn", "shootShotgun", "enemyDeath", "floorClear", "cannon"],
  stone: ["cannon", "meleeHit", "bossSpawn"],
  gold: ["coin", "chest", "cannon", "meleeHit", "enemyAttack", "dash", "floorClear", "homing", "parry", "bossSpawn", "blessing", "enemyDeath"],
};

// Fallback pitch window (contract: "no oscillator or extreme rate"): a transform may
// re-voice a sample, never turn it into a different instrument.
export const FALLBACK_RATE_MIN = 0.4;
export const FALLBACK_RATE_MAX = 2.0;

// ---- tier layers ----
// An elite/brute adds an AUTHORED body/debris layer on its death — a second stem played
// alongside the material death, never a pitch-down of it (the QA suite asserts the
// layer rows carry no rate transform).
export const TIER_LAYERS: Readonly<Partial<Record<string, WaveEventId>>> = {
  brute: "tier.bruteBody",
  elite: "tier.eliteSheen",
};

// ---- danger arbitration policy ----

// At most this many MOB lock cues inside one audible window (boss locks are exempt —
// they own the bossLock priority band and its reserved voices).
export const MAX_CONCURRENT_MOB_LOCKS = 2;
export const MOB_LOCK_WINDOW_MS = 600;
// Group loops are keyed ONCE per behavior — the flock is one bed, the orbit ring is one
// hum, regardless of body count. Gain may scale with count; voices never do.
export const GROUP_LOOP_KEY = "group";
export const FLOCK_BED_RADIUS = 520;
export const ORBIT_LOOP_RADIUS = 420;
// The flock's close-pass whoosh: a body crossing from OUTER to INNER of the listener.
export const FLOCK_PASS_OUTER = 96;
export const FLOCK_PASS_INNER = 60;
// Hurt/death rate limits live ON the rows (mob.hurt / mob.death cooldownMs) — recorded
// here so the QA suite pins them.
export const HURT_RATE_LIMIT_MS = 90;
export const DEATH_RATE_LIMIT_MS = 120;

// ---- the minimum hook set per behavior ----
// Every kind must resolve EVERY hook its behavior declares (the QA completeness gate).
export const BEHAVIOR_HOOKS: Readonly<Record<AudioBehavior, readonly string[]>> = {
  hunt: ["move", "commit"],
  flock: ["bed", "windup", "lock", "pass", "leaderBreak", "rally"],
  kite: ["warn", "lock", "fire"],
  charge: ["plant", "lock", "rush", "crash", "dazed"],
  burrow: ["dive", "emitter", "lock", "erupt", "recover"],
  orbit: ["acquire", "loop", "warn", "lock", "fire"],
  shield: ["raise", "block", "bash", "guardBreak", "rearHurt"],
  anchor: ["place", "laneWarn", "lock", "active", "deflate"],
  trickster: ["plant", "blink"],
  ember: ["stoke", "jet", "burst"],
  voice: ["windup", "active"],
  worker: ["survey", "raise"],
  decoy: ["fuse", "toll"],
  captain: ["windup", "lock", "active", "impact", "recover", "entrance", "phase", "death"],
  boss: ["windup", "lock", "active", "impact", "recover", "entrance", "phase", "special", "death"],
};

// ---- the per-kind hook resolution ----
// kind + hook -> manifest event id. Hooks may share rows where the CONTRACT says so
// (both charge kinds crash on their own material rows; the pack beats ride the shared
// elite rally/panic pair because the commander IS the pack's one commit).
export const BESTIARY_CUES: Readonly<Record<EnemyKind, Readonly<Record<string, WaveEventId>>>> = {
  slime: { move: "slime.move", commit: "slime.commit" },
  bat: {
    bed: "flock.bed", windup: "elite.rally", lock: "flock.surge", pass: "flock.pass",
    leaderBreak: "elite.panic", rally: "elite.rally",
  },
  skeleton: { move: "skeleton.move", commit: "skeleton.commit" },
  ghost: { move: "slime.move", commit: "slime.commit" }, // drift-hunter: goo-mist shared hunt bank until its own lands
  spitter: { warn: "orbiter.diveWarn", lock: "seamcutter.lock", fire: "orbiter.fire" },
  charger: { plant: "charger.windup", lock: "charger.lock", rush: "charger.rush", crash: "charger.crash", dazed: "charger.dazed" },
  // The underground emitter hook resolves to the authored component set's signature
  // channel (audio director FINAL: burrow_track is retired; stepBurrowEmitter schedules
  // dirtGrind/pebble/shellScrape on seeded cadences, all preloaded via bossWaveEvents).
  burrower: { dive: "burrower.submerge", emitter: "burrow.dirtGrind", lock: "burrower.lock", erupt: "burrower.erupt", recover: "burrower.recover" },
  orbiter: { acquire: "orbiter.enterBand", loop: "orbit.loop", warn: "orbiter.diveWarn", lock: "orbiter.lock", fire: "orbiter.fire" },
  shielder: { raise: "shielder.raise", block: "shielder.block", bash: "shielder.bash", guardBreak: "guard.break", rearHurt: "shielder.rearHurt" },
  rootward: {
    raise: "root.raise", block: "root.block", bash: "root.raise", guardBreak: "guard.break",
    rearHurt: "shielder.rearHurt", divider: "root.divider", // the worker verb rides the shield chassis
  },
  echojack: { plant: "echojack.jangle", blink: "echojack.blink" },
  seamcutter: {
    plant: "seamcutter.preview", lock: "seamcutter.lock", rush: "seamcutter.cut",
    crash: "seamcutter.stop", dazed: "seamcutter.dazed", berm: "keel.berm", // the plow's worker payload
  },
  caskbellows: { place: "anchor.place", laneWarn: "caskbellows.crank", lock: "caskbellows.lock", active: "caskbellows.fire", deflate: "caskbellows.stagger" },
  sinderling: { stoke: "sinderling.stoke", jet: "sinderling.jet", burst: "sinderling.burst" },
  mason: { survey: "mason.survey", raise: "mason.raise" },
  fragment: { windup: "fragment.harmonize", active: "fragment.pulse" },
  echo: { fuse: "echojack.jangle", toll: "echojack.blink" }, // the echo IS the jack's noise
  knell: { fuse: "knell.fuse", toll: "toll.ring" },
  // The Weaver's mechanic bodies sing its lattice rows: the knot hums the thread it
  // anchors; the sac is the clutch's slow swell.
  knot: { fuse: "weaver.latticeWarn", toll: "weaver.latticeFire" },
  sac: { fuse: "weaver.feint", toll: "weaver.feint" },
  marshal: {
    windup: "marshal.order", lock: "marshal.lock", active: "marshal.order", impact: "marshal.shatter",
    recover: "marshal.recover", entrance: "marshal.entrance", phase: "marshal.shatter", death: "marshal.death",
  },
  toll: {
    windup: "toll.ringWarn", lock: "toll.lock", active: "toll.ring", impact: "toll.ring",
    recover: "toll.recover", entrance: "toll.entrance", phase: "toll.phase", death: "toll.death",
  },
  boss: {
    windup: "king.hopWarn", lock: "king.hopLock", active: "king.radialFire", impact: "king.slam",
    recover: "king.recover", entrance: "king.entrance", phase: "king.phase", special: "king.squeezeWarn", death: "king.death",
  },
  marrow: {
    windup: "marrow.listenStart", lock: "marrow.aimLock", active: "marrow.chargeStart", impact: "marrow.wallImpact",
    recover: "marrow.recover", entrance: "marrow.entrance", phase: "marrow.phase", special: "marrow.stompImpact", death: "marrow.death",
  },
  choir: {
    windup: "choir.strikeWarn", lock: "choir.strikeLock", active: "choir.swellFire", impact: "choir.strikeImpact",
    recover: "choir.recover", entrance: "choir.entrance", phase: "choir.phase", special: "choir.floorDischarge", death: "choir.death",
  },
  weaver: {
    windup: "weaver.blinkTell", lock: "weaver.latticeWarn", active: "weaver.blinkDepart", impact: "weaver.blinkArriveStrike",
    recover: "weaver.recover", entrance: "weaver.entrance", phase: "weaver.phase", special: "weaver.latticeFire", death: "weaver.death",
  },
  gilded: {
    windup: "warden.prisonWarn", lock: "warden.turretLock", active: "warden.turretFire", impact: "warden.prisonClose",
    recover: "warden.exposed", entrance: "gilded.entrance", phase: "warden.phase", special: "warden.glyphWarn", death: "warden.death",
  },
  // Wave 1 deep bosses — PLACEHOLDER audio reusing an in-family bank until the audio
  // director's bespoke stems land (JET = King goo bank, Tithe = Warden gold, Quorum = bone
  // roster). The mechanic bodies sing the chitin lattice rows the Weaver's knots/sacs use.
  jet: {
    windup: "king.hopWarn", lock: "king.hopLock", active: "king.radialFire", impact: "king.slam",
    recover: "king.recover", entrance: "king.entrance", phase: "king.phase", special: "king.squeezeWarn", death: "king.death",
  },
  tithe: {
    windup: "warden.prisonWarn", lock: "warden.turretLock", active: "warden.turretFire", impact: "warden.prisonClose",
    recover: "warden.exposed", entrance: "gilded.entrance", phase: "warden.phase", special: "warden.glyphWarn", death: "warden.death",
  },
  quorum: {
    windup: "marrow.listenStart", lock: "marrow.aimLock", active: "marrow.chargeStart", impact: "marrow.wallImpact",
    recover: "marrow.recover", entrance: "marrow.entrance", phase: "marrow.phase", special: "marrow.stompImpact", death: "marrow.death",
  },
  tithe_slab: { fuse: "weaver.latticeWarn", toll: "weaver.latticeFire" },
  quorum_shield: { fuse: "weaver.feint", toll: "weaver.feint" },
  quorum_heal: { fuse: "weaver.feint", toll: "weaver.feint" },
  quorum_dmg: { fuse: "weaver.feint", toll: "weaver.feint" },
};

export function bestiaryCue(kind: EnemyKind, hook: string): WaveEventId | null {
  return BESTIARY_CUES[kind]?.[hook] ?? null;
}

// Every event a kind can raise — its preload group (contract: preload the current
// encounter's kinds alongside the biome bed and the floor's boss).
export function bestiaryPreloadEvents(kind: EnemyKind): WaveEventId[] {
  const out: WaveEventId[] = [];
  const cues = BESTIARY_CUES[kind];
  if (!cues) return out;
  for (const hook of Object.keys(cues)) {
    const id = cues[hook];
    if (out.indexOf(id) === -1) out.push(id);
  }
  return out;
}
