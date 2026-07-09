// The CURRENT WAVE SOUND MANIFEST (docs/audio/WAVE_SOUND_MANIFEST.md) as typed data — the
// single source of truth binding semantic gameplay events to audio: file stems the
// generation pipeline ships to, per-event mix (gain/bus/priority/ducking), trigger
// hygiene (cooldowns, spatialization, jitter lanes), and each event's AUTHORED fallback.
// Pure data + pure functions only: no DOM, no audio context, no engine imports — the
// whole contract is testable headless and reviewable row-by-row against the manifest.
//
// AUTHORED-ONLY CONTRACT (playtest audit):
//   - There are no synth recipes. An event sounds through its shipped wave file, or its
//     declared safe-reuse fallback (an existing AUTHORED library sample through mild
//     pitch/filter transforms), or not at all. Runtime oscillators are banned.
//   - Safe reuse: every fallback rate sits inside [SAFE_DERIVE_RATE_MIN, SAFE_DERIVE_RATE_MAX]
//     (0.85–1.15). Anything that needed a more extreme transform lost its fallback and
//     keeps only the asset hook — those rows fail quietly until their file lands.
//   - Variant counts advertise EXACTLY the files shipped under public/audio/ (or, for a
//     pure hook whose files are all pending, the generation target). Partial takes are
//     pinned to their explicit _vN stem so a trigger never rolls a missing take.
//     The full pending list lives in docs/audio/AUDIO_ASSET_INVENTORY.md.
//
// File layout contract (generation box): a stem `boss/marrow_lock` ships as
// public/audio/boss/marrow_lock.ogg + .mp3; a stem with variants N > 1 ships _v1.._vN.
// `stem: null` rows are REUSE/DERIVE-only by Audio Director decision — never fetched,
// never generated; they play through their authored fallback forever.

import type { SfxName } from "./audio.js";

export type WaveBusId = "sfx" | "voiceTell" | "ambient" | "ui" | "pet";
export type DuckBusId = "music" | "ambient" | "pet";

// The safe runtime-repitch band for reusing an authored sample. The anti-repeat jitter
// (≤5%) rides on top of this; anything outside needs a dedicated offline asset.
export const SAFE_DERIVE_RATE_MIN = 0.85;
export const SAFE_DERIVE_RATE_MAX = 1.15;

// Manifest §1 duck notation `targetBus:multiplier / hold / recover` (seconds).
export interface WaveDuck {
  readonly bus: DuckBusId;
  readonly to: number;
  readonly hold: number;
  readonly recover: number;
}

// An existing shipped-library sample played through optional pitch/filter transforms —
// the manifest's safe-reuse DERIVE lane (§0), used verbatim as the pre-generation
// fallback. `rate` must sit inside the safe band above (registry-tested).
export interface WaveSampleFallback {
  readonly sample: SfxName;
  readonly rate?: number;
  readonly lowpassHz?: number;
  readonly highpassHz?: number;
}

// Manifest §10 WaveSoundSpec, extended with the trigger-hygiene fields §1 prescribes in
// prose (jitter lanes, per-entity cooldowns, off-camera cap exemption, combat gating).
export interface WaveSoundSpec {
  readonly stem: string | null;
  readonly variants: number;
  readonly gain: number;
  readonly bus: WaveBusId;
  readonly priority: number;
  readonly jitter: number;
  readonly cooldownMs?: number;
  readonly isPerEntityCooldown?: boolean;
  readonly loop?: boolean;
  readonly spatial?: boolean;
  readonly isOffCameraUncapped?: boolean;
  readonly isCombatSuppressed?: boolean;
  // Audio-director-decided silence: the row is reachable and stays registered, but it
  // ships NO file and never sounds (the Deep's continuous bed) — distinct from a
  // pending-asset hook.
  readonly isAuthoredSilence?: boolean;
  readonly duck?: readonly WaveDuck[];
  readonly fallback?: WaveSampleFallback;
}

// Manifest §1 priority ladder. bossLock also gates the voice-reserve + pet sidechain.
export const WAVE_PRIORITY = {
  bossLock: 100,
  revive: 95,
  bossTell: 90,
  enemyLock: 85,
  hazardWarn: 85,
  hazardActive: 80,
  enemyTell: 75,
  weapon: 70,
  impact: 60,
  pet: 35,
  ui: 30,
  ambient: 20,
  uiHover: 10,
} as const;

// Manifest §1 bus gains for the NEW buses (master/music/sfx ride the existing settings
// sliders, whose defaults .7/.5/.9 already match the manifest).
export const WAVE_BUS_GAIN: Readonly<Record<WaveBusId, number>> = {
  sfx: 1.0, // routed through the existing sfx bus (already settings-scaled)
  voiceTell: 1.0,
  ambient: 0.32,
  ui: 0.6,
  pet: 1.0,
};

// Manifest §1: pet cues never overlap boss locks — any bossLock play mutes the pet bus.
export const PET_SIDECHAIN: WaveDuck = { bus: "pet", to: 0, hold: 0.5, recover: 0.15 };
// Manifest §10: no ambient one-shots inside a bossLock window (±250ms — we can enforce
// the trailing side; the leading side is unknowable without clairvoyance).
export const BOSS_LOCK_AMBIENT_MUTE_MS = 250;
// Manifest §10: voice budget — 24 global, 4 per event, 3 reserved for bossLock plays.
export const MAX_GLOBAL_VOICES = 24;
export const MAX_VOICES_PER_EVENT = 4;
export const BOSS_LOCK_RESERVED_VOICES = 3;

const dM = (to: number, hold: number, recover: number): WaveDuck => ({ bus: "music", to, hold, recover });
const dA = (to: number, hold: number, recover: number): WaveDuck => ({ bus: "ambient", to, hold, recover });

export const WAVE_SOUNDS = {
  // ---- §2 MARROW — bone/shale + sub impact ------------------------------------------
  // Shipped: one listen take, one charge take (pinned to their _v1 stems until the full
  // variant sets land). No fallback for the growl rows: the old enemyAttack/dash
  // transforms sat far outside the safe band.
  "marrow.listenStart": {
    stem: "boss/marrow_listen_v1", variants: 1, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.65, 0.2, 0.35)],
  },
  "marrow.aimLock": {
    stem: "boss/marrow_lock", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossLock,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.35, 0.15, 0.45)],
    fallback: { sample: "meleeHit", rate: 0.85, lowpassHz: 3200 }, // dry crack, darkened inside the safe band
  },
  "marrow.chargeStart": {
    stem: "boss/marrow_charge_v1", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
  },
  "marrow.wallImpact": {
    stem: "boss/marrow_wall", variants: 3, gain: 1.0, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true,
    duck: [dM(0.45, 0.18, 0.55)],
    fallback: { sample: "cannon", rate: 0.85 }, // heavy authored boom at the band floor
  },
  "marrow.stompWindup": {
    stem: "boss/marrow_stomp_warn", variants: 1, gain: 0.78, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
  },
  "marrow.stompImpact": {
    stem: "boss/marrow_stomp", variants: 2, gain: 0.95, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true,
    duck: [dM(0.55, 0.15, 0.45)],
    fallback: { sample: "cannon", rate: 0.85, lowpassHz: 1400 },
  },
  // Phase/death: the manifest bans the generic bossRoar beyond entrances, and every prior
  // transform (bossSpawn ±20-45%, enemyDeath slowed >2×) was outside the safe band — pure
  // asset hooks, silent until their files land.
  "marrow.phase": {
    stem: "boss/marrow_phase", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.35, 0.8)],
  },
  "marrow.death": {
    stem: "boss/marrow_death", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.25, 0.8, 1.2)],
  },

  // ---- §2 HOLLOW CHOIR — fused nonverbal voices + cyan electricity -------------------
  "choir.strikeWarn": {
    stem: "boss/choir_strike_warn_v1", variants: 1, gain: 0.82, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.6, 0.15, 0.4)],
  },
  "choir.strikeLock": {
    stem: "boss/choir_strike_lock", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossLock,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.35, 0.12, 0.35)],
    fallback: { sample: "tesla", rate: 1.15, highpassHz: 1500 }, // electric snap, safe-band brightened
  },
  "choir.strikeImpact": {
    stem: "boss/choir_strike", variants: 3, gain: 0.86, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true,
    fallback: { sample: "tesla", rate: 1.15, highpassHz: 600 },
  },
  "choir.swellWarn": {
    stem: "boss/choir_swell_warn", variants: 1, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.55, 0.2, 0.5)],
    fallback: { sample: "enemyAttack", rate: 0.85, highpassHz: 400 },
  },
  "choir.swellFire": {
    stem: "boss/choir_swell", variants: 2, gain: 0.92, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true,
    duck: [dM(0.5, 0.12, 0.5)],
  },
  "choir.floorCharge": {
    stem: "boss/choir_floor_warn", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.25, 0.4, 0.8)],
  },
  "choir.floorDischarge": {
    stem: "boss/choir_floor_blast", variants: 1, gain: 1.0, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.2, 0.35, 1.0)],
    fallback: { sample: "cannon", rate: 0.85 },
  },
  "choir.phase": {
    stem: "boss/choir_phase", variants: 2, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.25, 0.45, 1.0)],
  },
  "choir.death": {
    stem: "boss/choir_death", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.2, 1.0, 1.5)],
  },

  // ---- §2 WEAVER — silk tension + cold glass/knife transients ------------------------
  "weaver.blinkTell": {
    stem: "boss/weaver_blink_warn", variants: 3, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossLock,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    duck: [dM(0.55, 0.1, 0.3)],
    fallback: { sample: "parry", rate: 1.15, highpassHz: 2000 }, // cold metallic shimmer inside the band
  },
  "weaver.blinkDepart": {
    stem: "boss/weaver_blink_out", variants: 2, gain: 0.65, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.03, spatial: true, // the reversed-dash derive was a runtime transform — asset hook only now
  },
  "weaver.blinkArriveStrike": {
    stem: "boss/weaver_strike", variants: 3, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true,
    duck: [dM(0.65, 0.08, 0.3)],
    fallback: { sample: "meleeHit", rate: 1.15, highpassHz: 900 },
  },
  "weaver.latticeWarn": {
    stem: "boss/weaver_lattice_warn", variants: 1, gain: 0.82, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.6, 0.15, 0.4)],
    fallback: { sample: "parry", rate: 1.15, highpassHz: 1500 },
  },
  "weaver.latticeFire": {
    stem: "boss/weaver_lattice", variants: 2, gain: 0.8, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true,
    fallback: { sample: "meleeSwing", rate: 1.15, highpassHz: 1000 },
  },
  "weaver.feint": {
    stem: "boss/weaver_feint", variants: 1, gain: 0.86, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    duck: [dM(0.55, 0.12, 0.35)],
  },
  "weaver.phase": {
    stem: "boss/weaver_phase", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.35, 0.25, 0.7)],
  },
  "weaver.death": {
    stem: "boss/weaver_death", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.25, 0.7, 1.1)],
    fallback: { sample: "enemyDeath", rate: 0.85, highpassHz: 500 },
  },

  // ---- §2 GILDED WARDEN — amber crystal + orderly bell geometry -----------------------
  // Binding note: the content-wave Warden fields slam/sweep (no turrets/glyph roots/prison
  // yet), so slam borrows the prison pair (big enclosing danger), sweep the glyph/turret
  // rows (orderly radial geometry). Unused rows stay registered for the authored kit.
  "warden.turretPlace": {
    stem: "boss/warden_turret_place", variants: 2, gain: 0.75, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true,
    fallback: { sample: "blessing", rate: 0.9 },
  },
  "warden.turretLock": {
    stem: "boss/warden_turret_lock", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossLock,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.65, 0.1, 0.3)],
    fallback: { sample: "coin", rate: 1.15, highpassHz: 1200 }, // bright bell tick inside the band
  },
  "warden.turretFire": {
    stem: "boss/warden_turret_fire", variants: 3, gain: 0.75, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true,
    fallback: { sample: "homing", rate: 1.1, lowpassHz: 4000 },
  },
  "warden.glyphWarn": {
    stem: "boss/warden_glyph_warn", variants: 2, gain: 0.84, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.6, 0.18, 0.4)],
    fallback: { sample: "blessing", rate: 0.85, lowpassHz: 3000 },
  },
  "warden.glyphSet": {
    stem: "boss/warden_glyph_set", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true,
    duck: [dM(0.55, 0.1, 0.4)],
    fallback: { sample: "parry", rate: 0.9 },
  },
  "warden.prisonWarn": {
    stem: "boss/warden_prison_warn", variants: 1, gain: 0.92, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.25, 0.4, 0.8)],
  },
  "warden.prisonClose": {
    stem: "boss/warden_prison_close", variants: 1, gain: 0.95, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true,
    duck: [dM(0.4, 0.2, 0.65)],
  },
  "warden.phase": {
    stem: "boss/warden_phase", variants: 1, gain: 0.92, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.4, 0.85)],
  },
  "warden.death": {
    stem: "boss/warden_death", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.2, 0.9, 1.3)],
  },

  // ---- §3 standard archetype cues ------------------------------------------------------
  "charger.windup": {
    stem: "enemy/charger_warn_v1", variants: 1, gain: 0.72, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 0.85 },
  },
  "charger.lock": {
    stem: "enemy/charger_lock", variants: 1, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.enemyLock,
    jitter: 0, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.8, 0.05, 0.2)],
    fallback: { sample: "meleeHit", rate: 1.1, highpassHz: 800 },
  },
  // Bound to the content-wave chargeCrash punish window; §0's rubble/rock derive lane,
  // brought inside the safe band.
  "charger.crash": {
    stem: "enemy/charger_crash", variants: 1, gain: 0.8, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "cannon", rate: 0.85, lowpassHz: 1600 },
  },
  "burrower.submerge": {
    stem: "enemy/burrow_down_v1", variants: 1, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.85, lowpassHz: 1200 },
  },
  // Burrow underground presence (audio director FINAL): NO continuous loop. A
  // deterministic keyed positional emitter (director, stepBurrowEmitter) schedules these
  // authored component one-shots while the burrower tunnels; the thud fires exactly once
  // per commitment, on the direction-lock edge. All four are pending component assets.
  "burrow.dirtGrind": {
    stem: "enemy/burrow_dirt", variants: 3, gain: 0.22, bus: "sfx", priority: WAVE_PRIORITY.pet,
    jitter: 0, spatial: true,
  },
  "burrow.pebble": {
    stem: "enemy/burrow_pebble", variants: 3, gain: 0.14, bus: "sfx", priority: WAVE_PRIORITY.pet,
    jitter: 0, spatial: true,
  },
  "burrow.shellScrape": {
    stem: "enemy/burrow_scrape", variants: 2, gain: 0.18, bus: "sfx", priority: WAVE_PRIORITY.pet,
    jitter: 0, spatial: true,
  },
  "burrow.thud": {
    stem: "enemy/burrow_thud", variants: 1, gain: 0.28, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0, spatial: true,
  },
  "burrower.lock": {
    stem: "enemy/burrow_lock", variants: 1, gain: 0.86, bus: "voiceTell", priority: WAVE_PRIORITY.enemyLock,
    jitter: 0, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.75, 0.08, 0.25)],
    fallback: { sample: "enemyHit", rate: 1.15 },
  },
  "burrower.erupt": {
    stem: "enemy/burrow_erupt_v1", variants: 1, gain: 0.78, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "barrel", rate: 1.15, lowpassHz: 2600 },
  },
  "orbiter.enterBand": {
    stem: "enemy/orbiter_acquire", variants: 2, gain: 0.45, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 600000, isPerEntityCooldown: true, // once per entity (§3)
    fallback: { sample: "homing", rate: 0.85, highpassHz: 600 },
  },
  "orbiter.diveWarn": {
    stem: "enemy/orbiter_dive_warn", variants: 3, gain: 0.72, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 1.15 },
  },
  "shielder.raise": {
    stem: "enemy/shield_raise_v1", variants: 1, gain: 0.65, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 0.85, lowpassHz: 1800 },
  },
  "shielder.block": {
    stem: "enemy/shield_block", variants: 3, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 120, isPerEntityCooldown: true, // manifest rate limit 120ms
    fallback: { sample: "parry", rate: 0.85, lowpassHz: 5000 }, // manifest: parry .85–.95, lowpass 5k, reduced gain
  },
  "shielder.break": {
    stem: "enemy/shield_break", variants: 1, gain: 0.82, bus: "sfx", priority: WAVE_PRIORITY.hazardActive,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.8, 0.08, 0.3)],
    fallback: { sample: "parry", rate: 0.85, lowpassHz: 4000 },
  },

  // ---- §4 Thumper (mortar) / Sunlance (beam) ------------------------------------------
  "shootMortar": {
    stem: "sfx/thumper_fire_v1", variants: 1, gain: 0.82, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true,
    duck: [dM(0.8, 0.06, 0.2)],
    fallback: { sample: "cannon", rate: 1.12, lowpassHz: 1100 }, // launch thump, not an explosion
  },
  "mortarDetonate": {
    stem: "sfx/thumper_impact_v1", variants: 1, gain: 0.9, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true,
    duck: [dM(0.75, 0.08, 0.3)],
    fallback: { sample: "barrel", rate: 0.9, lowpassHz: 2800 },
  },
  "beamStart": {
    stem: "sfx/sunlance_start", variants: 2, gain: 0.58, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0,
    fallback: { sample: "crit", rate: 0.85 },
  },
  "beamLoop": {
    stem: "sfx/sunlance_loop", variants: 1, gain: 0.34, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0, loop: true,
  },
  "beamStop": {
    stem: "sfx/sunlance_stop", variants: 1, gain: 0.34, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0,
  },
  "beamHit": {
    stem: "sfx/sunlance_hit", variants: 2, gain: 0.42, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 120, isPerEntityCooldown: true, // manifest: 120ms per target
    fallback: { sample: "enemyHit", rate: 1.15, highpassHz: 900 },
  },

  // ---- §5 six audio zones (ambient bus loops; never one full-volume global loop) -------
  // Pure loop hooks: an ambient bed sounds only once its authored file is decoded.
  "ambient.verdant": {
    stem: "amb/verdant_loop", variants: 1, gain: 0.24, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true,
  },
  "ambient.sunless": {
    stem: "amb/sunless_loop", variants: 1, gain: 0.25, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true,
  },
  // The Deep's continuous bed is authored SILENCE (audio director FINAL — the rejected
  // deep_loop file is gone): its ambience is the sparse positional DEEP_EMITTER below.
  "ambient.deep": {
    stem: null, variants: 1, gain: 0.22, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true, isAuthoredSilence: true,
  },
  "ambient.ember": {
    stem: "amb/ember_loop", variants: 1, gain: 0.28, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true,
  },
  "ambient.fracture": {
    stem: "amb/fracture_loop", variants: 1, gain: 0.2, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true,
  },
  // The Deep's sparse positional ambience (audio director FINAL): scheduled authored
  // one-shots — resin creak 35% / mineral tick 35% / architecture shift 15% / resin
  // drip 15% — every 1.5–3.5s, max 2 overlapping, gains inside .08–.16, suppressed
  // ±250ms around combat locks. Component assets pending generation.
  "deep.resinCreak": {
    stem: "amb/deep_resin_creak", variants: 2, gain: 0.14, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, spatial: true,
  },
  "deep.mineralTick": {
    stem: "amb/deep_mineral_tick", variants: 3, gain: 0.12, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, spatial: true,
  },
  "deep.architectureShift": {
    stem: "amb/deep_arch_shift", variants: 2, gain: 0.16, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, spatial: true,
  },
  "deep.resinDrip": {
    stem: "amb/deep_resin_drip", variants: 2, gain: 0.1, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, spatial: true,
  },
  "ambient.null": {
    stem: "amb/null_loop", variants: 1, gain: 0.18, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true,
  },

  // ---- §6 canonical hazards (depth-progression kinds/cycles) ---------------------------
  "spikes.telegraph": {
    stem: "hazard/spikes_warn", variants: 2, gain: 0.7, bus: "voiceTell", priority: WAVE_PRIORITY.hazardWarn,
    jitter: 0.05, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    duck: [dM(0.65, 0.12, 0.35), dA(0.45, 0.9, 0.3)],
    fallback: { sample: "ricochet", rate: 1.15, highpassHz: 1000 },
  },
  "spikes.active": {
    stem: "hazard/spikes_fire", variants: 3, gain: 0.76, bus: "sfx", priority: WAVE_PRIORITY.hazardActive,
    jitter: 0.05, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    fallback: { sample: "meleeSwing", rate: 1.15, highpassHz: 700 },
  },
  "toxic_pool.enter": {
    stem: "hazard/toxic_enter", variants: 1, gain: 0.44, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 800,
    fallback: { sample: "enemyDeath", rate: 1.15, lowpassHz: 1800 },
  },
  "toxic_pool.loop": {
    stem: "hazard/toxic_loop", variants: 1, gain: 0.18, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true, // proximity-gated by the caller; max one mixed voice by loop key
  },
  "fire_vent.telegraph": {
    stem: "hazard/vent_warn", variants: 2, gain: 0.74, bus: "voiceTell", priority: WAVE_PRIORITY.hazardWarn,
    jitter: 0.05, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    duck: [dM(0.65, 0.12, 0.35), dA(0.45, 1.0, 0.3)],
    fallback: { sample: "enemyAttack", rate: 0.85, lowpassHz: 1200 },
  },
  "fire_vent.active": {
    stem: "hazard/vent_blast", variants: 2, gain: 0.84, bus: "sfx", priority: WAVE_PRIORITY.hazardActive,
    jitter: 0.05, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    fallback: { sample: "barrel", rate: 1.15, highpassHz: 300 },
  },
  "void_rift.telegraph": {
    // The reversed low groan needs its dedicated asset — no library sample reads as a
    // rift warning inside the safe band. Hook only.
    stem: "hazard/rift_warn", variants: 2, gain: 0.78, bus: "voiceTell", priority: WAVE_PRIORITY.hazardWarn,
    jitter: 0.05, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    duck: [dM(0.65, 0.12, 0.35), dA(0.45, 1.1, 0.3)],
  },
  "void_rift.active": {
    stem: "hazard/rift_open", variants: 2, gain: 0.8, bus: "sfx", priority: WAVE_PRIORITY.hazardActive,
    jitter: 0.05, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.85, lowpassHz: 800 }, // inward air, never an electric zap
  },

  // ---- §7 pets (species-neutral state cues) --------------------------------------------
  "pet.summon": {
    stem: "pet/summon", variants: 1, gain: 0.38, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05,
    fallback: { sample: "blessing", rate: 1.15 },
  },
  "pet.attack": {
    stem: "pet/attack", variants: 3, gain: 0.32, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05, spatial: true, cooldownMs: 150,
  },
  "pet.abilityReady": {
    stem: "pet/ready", variants: 1, gain: 0.3, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0,
    fallback: { sample: "coin", rate: 1.15 },
  },
  "pet.hurt": {
    stem: "pet/hurt", variants: 2, gain: 0.34, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05, cooldownMs: 1000, // manifest: cooldown 1s
  },
  "pet.down": {
    stem: "pet/down", variants: 1, gain: 0.42, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0,
    fallback: { sample: "blessing", rate: 0.85 },
  },
  "pet.revive": {
    stem: "pet/revive", variants: 1, gain: 0.38, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0,
    fallback: { sample: "revive", rate: 1.15, highpassHz: 250 },
  },
  "pet.idle": {
    stem: "pet/idle", variants: 3, gain: 0.16, bus: "pet", priority: 25,
    jitter: 0.05, cooldownMs: 8000, isCombatSuppressed: true, // manifest: random ≥8s, suppressed in combat
  },

  // ---- §8 co-op states -----------------------------------------------------------------
  "revive.channelStart": {
    stem: "coop/revive_start", variants: 1, gain: 0.65, bus: "sfx", priority: WAVE_PRIORITY.revive,
    jitter: 0, spatial: true, isOffCameraUncapped: true,
    duck: [dM(0.8, 0.1, 0.3)],
    fallback: { sample: "heart", rate: 0.85 },
  },
  "revive.channelLoop": {
    stem: "coop/revive_loop", variants: 1, gain: 0.42, bus: "sfx", priority: WAVE_PRIORITY.revive,
    jitter: 0, loop: true,
  },
  "revive.cancel": {
    stem: "coop/revive_cancel", variants: 1, gain: 0.62, bus: "sfx", priority: WAVE_PRIORITY.revive,
    jitter: 0,
    fallback: { sample: "parry", rate: 0.85, lowpassHz: 2000 },
  },
  // revive.complete REUSES the existing `revive` sample verbatim (played by the existing
  // SimEvent handler); the director only stops the channel loop + applies the manifest's
  // music duck (.5/.18/.55) around it.
  "spectate.enter": {
    stem: "coop/spectate_enter", variants: 1, gain: 0.55, bus: "ui", priority: WAVE_PRIORITY.impact,
    jitter: 0,
    duck: [dM(0.75, 0.1, 0.4)],
    fallback: { sample: "dash", rate: 0.85, lowpassHz: 1400 },
  },
  "spectate.switch": {
    stem: null, variants: 1, gain: 0.35, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0, cooldownMs: 100,
    fallback: { sample: "uiClick", rate: 1.0, lowpassHz: 5000 }, // manifest DERIVE: uiClick lowpass 5k
  },
  "reconnect.lost": {
    stem: "coop/disconnect", variants: 1, gain: 0.65, bus: "ui", priority: WAVE_PRIORITY.hazardActive,
    jitter: 0,
    duck: [dM(0.75, 0.1, 0.5)],
    fallback: { sample: "uiClick", rate: 0.85 },
  },
  "reconnect.try": {
    stem: null, variants: 1, gain: 0.28, bus: "ui", priority: 40,
    jitter: 0, cooldownMs: 2000, // manifest: max 1 per 2s
    fallback: { sample: "uiClick", rate: 0.89 }, // manifest DERIVE: uiClick pitch -2, no jitter
  },
  "reconnect.restored": {
    stem: "coop/reconnect_ok", variants: 1, gain: 0.65, bus: "ui", priority: WAVE_PRIORITY.hazardActive,
    jitter: 0,
    duck: [dM(0.75, 0.1, 0.45)],
    fallback: { sample: "levelup", rate: 0.9, lowpassHz: 4000 },
  },
  "party.readyOn": {
    stem: "coop/ready_on", variants: 1, gain: 0.45, bus: "ui", priority: 55,
    jitter: 0,
    fallback: { sample: "coin", rate: 0.95 },
  },
  "party.readyOff": {
    stem: "coop/ready_off", variants: 1, gain: 0.38, bus: "ui", priority: 55,
    jitter: 0,
    fallback: { sample: "coin", rate: 0.85 },
  },
  "party.allReady": {
    stem: "coop/all_ready", variants: 1, gain: 0.7, bus: "ui", priority: WAVE_PRIORITY.weapon,
    jitter: 0,
    duck: [dM(0.7, 0.1, 0.45)],
    fallback: { sample: "levelup", rate: 1.05 },
  },

  // ---- §9 difficulty / UI / profile / leaderboard ---------------------------------------
  // The uiClick sample is itself an asset hook (sfx/uiClick pending) with an authored
  // coin-chime reuse behind it — see SAMPLES in audio.ts.
  "ui.hover": {
    stem: null, variants: 1, gain: 0.1, bus: "ui", priority: WAVE_PRIORITY.uiHover,
    jitter: 0, cooldownMs: 80, // manifest: UI hover ≥80ms
    fallback: { sample: "uiClick", rate: 1.1 },
  },
  "ui.click": {
    stem: null, variants: 1, gain: 0.22, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "uiClick" },
  },
  "ui.confirm": {
    stem: "ui/confirm", variants: 1, gain: 0.38, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "uiClick", rate: 1.15 },
  },
  "ui.back": {
    stem: null, variants: 1, gain: 0.3, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "uiClick", rate: 0.85 },
  },
  "ui.error": {
    stem: "ui/error", variants: 1, gain: 0.45, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "uiClick", rate: 0.85 },
  },
  "difficulty.change": {
    stem: null, variants: 1, gain: 0.32, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0, cooldownMs: 90,
    fallback: { sample: "uiClick" },
  },
  "difficulty.confirm": {
    stem: "ui/difficulty_confirm", variants: 1, gain: 0.5, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "blessing", rate: 0.85 },
  },
  "profile.open": {
    stem: "ui/profile_open", variants: 1, gain: 0.28, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "chest", rate: 1.15, highpassHz: 400 },
  },
  "profile.statMilestone": {
    stem: null, variants: 1, gain: 0.55, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0, cooldownMs: 1000, // true milestones only, never every stat update
    fallback: { sample: "levelup" }, // manifest REUSE at gain .55
  },
  "profile.save": {
    stem: "ui/profile_save", variants: 1, gain: 0.3, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "uiClick", rate: 0.9 },
  },
  "leaderboard.open": {
    stem: "ui/leaderboard_open", variants: 1, gain: 0.3, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "chest", rate: 1.15, highpassHz: 600 },
  },
  "leaderboard.rowMove": {
    stem: null, variants: 1, gain: 0.08, bus: "ui", priority: WAVE_PRIORITY.uiHover,
    jitter: 0, cooldownMs: 100, // manifest: rate limit 100ms, never per network update
    fallback: { sample: "uiClick", rate: 1.1 },
  },
  "leaderboard.personalBest": {
    stem: "ui/personal_best", variants: 1, gain: 0.55, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "levelup" },
  },
  "leaderboard.topRank": {
    stem: "ui/top_rank", variants: 1, gain: 0.65, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "floorClear", rate: 0.9 },
  },
} as const satisfies Record<string, WaveSoundSpec>;

export type WaveEventId = keyof typeof WAVE_SOUNDS;

export function isWaveEventId(name: string): name is WaveEventId {
  return Object.prototype.hasOwnProperty.call(WAVE_SOUNDS, name);
}

export function waveSpecOf(event: WaveEventId): WaveSoundSpec {
  return WAVE_SOUNDS[event];
}

// ---- content-wave bindings (PR #31 move/phase grammar -> manifest events) ---------------

// Per-(kind, move) cue set consumed by the tell watcher. Edges over the authoritative
// AttackState (never animation frames): `windup` on phase entry, `lock` on the
// isAimLocked flip, `active` on windup->active, `release` on windup->recover (fire-and-
// settle moves), `impact` on leaving active (landings, crashes, rematerializes). A move
// absent here stays silent through the wave layer (its existing sim cues keep playing).
export interface MoveTells {
  readonly windup?: WaveEventId;
  readonly lock?: WaveEventId;
  readonly active?: WaveEventId;
  readonly release?: WaveEventId;
  readonly impact?: WaveEventId;
}

export const WAVE_TELLS: Readonly<Record<string, Readonly<Record<string, MoveTells>>>> = {
  marrow: {
    rush: { windup: "marrow.listenStart", lock: "marrow.aimLock", active: "marrow.chargeStart" },
    crash: { impact: "marrow.wallImpact" }, // the move flips to "crash" as the stun recover begins
    volley: { windup: "marrow.stompWindup", lock: "marrow.aimLock", release: "marrow.stompImpact" },
    spin: { windup: "marrow.stompWindup", active: "marrow.stompImpact" },
  },
  choir: {
    wail: { windup: "choir.strikeWarn", lock: "choir.strikeLock", release: "choir.strikeImpact" },
    fade: { windup: "choir.swellWarn", impact: "choir.swellFire" }, // impact = the rematerialize burst
  },
  weaver: {
    pounce: { windup: "weaver.blinkTell", active: "weaver.blinkDepart", impact: "weaver.blinkArriveStrike" },
    weave: { windup: "weaver.latticeWarn", release: "weaver.latticeFire" },
  },
  gilded: {
    slam: { windup: "warden.prisonWarn", lock: "warden.turretLock", impact: "warden.prisonClose" },
    sweep: { windup: "warden.glyphWarn", active: "warden.turretFire" },
  },
  charger: {
    rush: { windup: "charger.windup", lock: "charger.lock" },
    crash: { impact: "charger.crash" },
  },
  burrower: {
    dive: { active: "burrower.submerge" },
    erupt: { windup: "burrower.lock", active: "burrower.erupt" },
  },
  orbiter: {
    spit: { windup: "orbiter.diveWarn" },
  },
  shielder: {
    lunge: { windup: "shielder.raise" },
  },
};

export const WAVE_BOSS_PHASE: Readonly<Record<string, WaveEventId>> = {
  marrow: "marrow.phase", choir: "choir.phase", weaver: "weaver.phase", gilded: "warden.phase",
};

export const WAVE_BOSS_DEATH: Readonly<Record<string, WaveEventId>> = {
  marrow: "marrow.death", choir: "choir.death", weaver: "weaver.death", gilded: "warden.death",
};

// Every event a boss OR regular archetype kind can raise — its preload group (§10:
// preload before the encounter can trigger it).
export function bossWaveEvents(kind: string): WaveEventId[] {
  const out: WaveEventId[] = [];
  const moves = WAVE_TELLS[kind];
  if (moves) {
    for (const key of Object.keys(moves)) {
      const tells = moves[key];
      for (const ev of [tells.windup, tells.lock, tells.active, tells.release, tells.impact]) {
        if (ev && out.indexOf(ev) === -1) out.push(ev);
      }
    }
  }
  if (kind === "orbiter") out.push("orbiter.enterBand");
  if (kind === "burrower") {
    for (const ch of BURROW_EMITTER) out.push(ch.event);
    out.push(BURROW_THUD_EVENT);
  }
  const phase = WAVE_BOSS_PHASE[kind];
  if (phase) out.push(phase);
  const death = WAVE_BOSS_DEATH[kind];
  if (death) out.push(death);
  return out;
}

// PR #33 hazard kinds -> manifest events (kind strings match src/sim HazardKind there).
export interface HazardWaveCues {
  readonly telegraph?: WaveEventId;
  readonly active?: WaveEventId;
  readonly enter?: WaveEventId;
  readonly loop?: WaveEventId;
}

export const WAVE_HAZARDS: Readonly<Record<string, HazardWaveCues>> = {
  spikes: { telegraph: "spikes.telegraph", active: "spikes.active" },
  toxic_pool: { enter: "toxic_pool.enter", loop: "toxic_pool.loop" },
  fire_vent: { telegraph: "fire_vent.telegraph", active: "fire_vent.active" },
  void_rift: { telegraph: "void_rift.telegraph", active: "void_rift.active" },
};

export const HAZARD_WAVE_EVENTS: readonly WaveEventId[] = [
  "spikes.telegraph", "spikes.active", "toxic_pool.enter", "toxic_pool.loop",
  "fire_vent.telegraph", "fire_vent.active", "void_rift.telegraph", "void_rift.active",
];

// Weapon + co-op cues reachable on ANY floor (player-driven) — part of every floor's
// preload plan so a first trigger never races its decode.
export const ALWAYS_REACHABLE_EVENTS: readonly WaveEventId[] = [
  "shootMortar", "mortarDetonate", "beamStart", "beamLoop", "beamStop", "beamHit",
  "revive.channelStart", "revive.channelLoop", "revive.cancel",
];

// PR #31 WeaponIds -> wave fire events; beam is EXCLUDED on purpose (its lifecycle is
// start/loop/stop through the director, never a per-shot one-shot at 22Hz).
export const WAVE_WEAPON_FIRE: Readonly<Record<string, WaveEventId>> = {
  mortar: "shootMortar",
};

export const BEAM_WEAPON_ID = "beam";
// Manifest §4 hysteresis: start after >120ms idle; stop when >90ms since the last shot.
export const BEAM_START_IDLE_MS = 120;
export const BEAM_STOP_GAP_MS = 90;

// Manifest §5 zone order == biomeIndexForFloor order (six-band ladder from PR #33; main's
// four biomes are the first four indices, so this is correct before AND after that lands).
export const AMBIENT_ZONE_EVENTS: readonly WaveEventId[] = [
  "ambient.verdant", "ambient.sunless", "ambient.deep", "ambient.ember", "ambient.fracture", "ambient.null",
];

// ---- pure trigger helpers ----------------------------------------------------------------

// Manifest §1 distance law: full ≤240px, linear to 0.25 @700px, off-camera cap .35 except
// boss/hazard locks (isOffCameraUncapped rows).
export function spatialGainFor(distPx: number, isOffCamera: boolean, isUncapped: boolean): number {
  const base = distPx <= 240 ? 1 : distPx >= 700 ? 0.25 : 1 - ((distPx - 240) / (700 - 240)) * 0.75;
  if (isOffCamera && !isUncapped) return Math.min(base, 0.35);
  return base;
}

// The attack-state snapshot the tell watcher diffs, structurally satisfied by both the sim
// Enemy (enemy.attack) and any wire-decoded enemy view.
export interface TellSnapshot {
  readonly phase: string;
  readonly move: string;
  readonly isAimLocked: boolean;
}

export function tellCuesFor(kind: string, prev: TellSnapshot | null, next: TellSnapshot): WaveEventId[] {
  const moves = WAVE_TELLS[kind];
  if (!moves) return [];
  const out: WaveEventId[] = [];
  const wasPhase = prev?.phase ?? "none";
  const wasLocked = prev?.isAimLocked ?? false;
  if (next.phase === "windup" && wasPhase !== "windup") {
    const cue = moves[next.move]?.windup;
    if (cue) out.push(cue);
  }
  if (next.phase === "windup" && wasPhase === "windup" && !wasLocked && next.isAimLocked) {
    const cue = moves[next.move]?.lock;
    if (cue) out.push(cue);
  }
  if (next.phase === "active" && wasPhase === "windup") {
    const cue = moves[next.move]?.active;
    if (cue) out.push(cue);
  }
  if (next.phase === "recover" && wasPhase === "windup") {
    const cue = moves[next.move]?.release;
    if (cue) out.push(cue);
  }
  if (wasPhase === "active" && next.phase !== "active" && prev) {
    // Landings/crashes key the impact on the move the attacker LANDED IN (a crash flips
    // rush->crash as recover begins; a chained pounce leaves active straight into windup).
    const cue = moves[next.move]?.impact ?? moves[prev.move]?.impact;
    if (cue) out.push(cue);
  }
  return out;
}

// Whether a burrower is tunnelling underground in this state — the window the keyed
// positional burrow emitter runs (audio director FINAL: no continuous loop).
export function isBurrowUnderground(kind: string, state: TellSnapshot): boolean {
  return kind === "burrower" && state.phase === "active" && state.move === "dive";
}

// ---- deterministic positional emitters (audio director FINAL) ---------------------------
// Scheduling and layering AUTHORED files is allowed; waveform synthesis is not. Both
// emitters run on a seeded LCG so a given entity id / floor entry always produces the
// same event/variant/timing sequence (headless-testable, replay-stable).

// mulberry32 step: pure, deterministic, good-enough distribution for scheduling.
export function emitterRand(state: number): { value: number; state: number } {
  let s = (state + 0x6D2B79F5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: s };
}

// Burrow underground presence: three independent authored component channels, each on
// its own deterministic cadence, positional at the tunnelling body. The thud channel is
// edge-only (direction-lock), never scheduled.
export interface BurrowEmitterChannel {
  readonly event: WaveEventId;
  readonly minGapSec: number;
  readonly maxGapSec: number;
}

export const BURROW_EMITTER: readonly BurrowEmitterChannel[] = [
  { event: "burrow.dirtGrind", minGapSec: 1.0, maxGapSec: 1.4 },
  { event: "burrow.pebble", minGapSec: 0.35, maxGapSec: 0.75 },
  { event: "burrow.shellScrape", minGapSec: 1.3, maxGapSec: 2.0 },
];

export const BURROW_THUD_EVENT: WaveEventId = "burrow.thud";

// The Deep's sparse positional ambience scheduler.
export interface DeepEmitterCategory {
  readonly event: WaveEventId;
  readonly weight: number;
}

export const DEEP_EMITTER = {
  categories: [
    { event: "deep.resinCreak", weight: 0.35 },
    { event: "deep.mineralTick", weight: 0.35 },
    { event: "deep.architectureShift", weight: 0.15 },
    { event: "deep.resinDrip", weight: 0.15 },
  ] as readonly DeepEmitterCategory[],
  minGapSec: 1.5,
  maxGapSec: 3.5,
  // Never more than two events sounding together: a third draw inside the overlap
  // window holds until the window clears.
  maxOverlap: 2,
  overlapWindowSec: 1.2,
  // Suppress ambience around combat locks (enemy/boss lock tells and hazard warnings,
  // priority ≥ enemyLock); we enforce the trailing ±250ms side — the leading side is
  // unknowable without clairvoyance.
  lockMuteMs: 250,
  // Deterministic emitter placement ring around the listener.
  minDistPx: 140,
  maxDistPx: 380,
} as const;

export function pickDeepCategory(roll: number): WaveEventId {
  let r = roll * DEEP_EMITTER.categories.reduce((s, c) => s + c.weight, 0);
  for (const c of DEEP_EMITTER.categories) {
    r -= c.weight;
    if (r <= 0) return c.event;
  }
  return DEEP_EMITTER.categories[DEEP_EMITTER.categories.length - 1].event;
}
