// The CURRENT WAVE SOUND MANIFEST (docs/audio/WAVE_SOUND_MANIFEST.md) as typed data — the
// single source of truth binding semantic gameplay events to audio: file stems the
// generation pipeline ships to, per-event mix (gain/bus/priority/ducking), trigger
// hygiene (cooldowns, spatialization, jitter lanes), and the fallback every event keeps
// until its generated file lands (an existing shipped sample, transformed, else a synth
// recipe). Pure data + pure functions only: no DOM, no audio context, no engine imports —
// the whole contract is testable headless and reviewable row-by-row against the manifest.
//
// File layout contract (generation box): a stem `boss/marrow_lock` ships as
// public/audio/boss/marrow_lock.ogg + .mp3; a stem with variants N > 1 ships _v1.._vN.
// `stem: null` rows are REUSE/DERIVE-only by Audio Director decision — never fetched,
// never generated; they play through their fallback/synth forever.

import type { SfxName } from "./audio.js";

export type WaveBusId = "sfx" | "voiceTell" | "ambient" | "ui" | "pet";
export type DuckBusId = "music" | "ambient" | "pet";

// Manifest §1 duck notation `targetBus:multiplier / hold / recover` (seconds).
export interface WaveDuck {
  readonly bus: DuckBusId;
  readonly to: number;
  readonly hold: number;
  readonly recover: number;
}

// An existing shipped-library sample played through optional pitch/filter transforms —
// the manifest's DERIVE lane (§0), used verbatim as the pre-generation fallback.
export interface WaveSampleFallback {
  readonly sample: SfxName;
  readonly rate?: number;
  readonly lowpassHz?: number;
  readonly highpassHz?: number;
  readonly isReversed?: boolean;
}

// Last-resort procedural voice per event family; parameters keep each event readable and
// distinct even with ZERO audio files on disk (fresh checkout, CDN failure, dev server).
export type WaveSynthSpec =
  | { readonly kind: "tick"; readonly freq: number; readonly count: number; readonly spreadMs: number; readonly isBright: boolean }
  | { readonly kind: "swell"; readonly durMs: number; readonly fromHz: number; readonly toHz: number; readonly mode: "noise" | "voice" | "growl" }
  | { readonly kind: "impact"; readonly durMs: number; readonly depthHz: number }
  | { readonly kind: "whoosh"; readonly durMs: number; readonly fromHz: number; readonly toHz: number }
  | { readonly kind: "shimmer"; readonly durMs: number; readonly freq: number; readonly isRising: boolean }
  | { readonly kind: "notes"; readonly freqs: readonly number[]; readonly stepMs: number; readonly noteMs: number; readonly shape: "sine" | "square" | "triangle" | "sawtooth" }
  | { readonly kind: "knock"; readonly freq: number; readonly count: number }
  | { readonly kind: "burst"; readonly durMs: number; readonly centerHz: number }
  | { readonly kind: "loopPad"; readonly mode: "noise" | "harmonic" | "pulse"; readonly filterType: "lowpass" | "bandpass" | "highpass"; readonly filterHz: number; readonly q: number; readonly lfoHz: number; readonly level: number };

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
  readonly duck?: readonly WaveDuck[];
  readonly fallback?: WaveSampleFallback;
  readonly synth: WaveSynthSpec;
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
  "marrow.listenStart": {
    stem: "boss/marrow_listen", variants: 2, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.65, 0.2, 0.35)],
    fallback: { sample: "enemyAttack", rate: 0.55, lowpassHz: 900 },
    synth: { kind: "swell", durMs: 700, fromHz: 55, toHz: 130, mode: "growl" },
  },
  "marrow.aimLock": {
    stem: "boss/marrow_lock", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossLock,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.35, 0.15, 0.45)],
    fallback: { sample: "meleeHit", rate: 0.7, lowpassHz: 3200 },
    synth: { kind: "tick", freq: 2400, count: 2, spreadMs: 60, isBright: false },
  },
  "marrow.chargeStart": {
    stem: "boss/marrow_charge", variants: 2, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.55 },
    synth: { kind: "swell", durMs: 650, fromHz: 90, toHz: 60, mode: "growl" },
  },
  "marrow.wallImpact": {
    stem: "boss/marrow_wall", variants: 3, gain: 1.0, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true,
    duck: [dM(0.45, 0.18, 0.55)],
    fallback: { sample: "cannon", rate: 0.72 }, // manifest DERIVE: cannon pitch .72
    synth: { kind: "impact", durMs: 850, depthHz: 48 },
  },
  "marrow.stompWindup": {
    stem: "boss/marrow_stomp_warn", variants: 1, gain: 0.78, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 0.5, lowpassHz: 600 },
    synth: { kind: "swell", durMs: 600, fromHz: 45, toHz: 90, mode: "noise" },
  },
  "marrow.stompImpact": {
    stem: "boss/marrow_stomp", variants: 2, gain: 0.95, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true,
    duck: [dM(0.55, 0.15, 0.45)],
    fallback: { sample: "cannon", rate: 0.78, lowpassHz: 1400 }, // manifest DERIVE: cannon lowpass + pitch .78
    synth: { kind: "impact", durMs: 700, depthHz: 55 },
  },
  "marrow.phase": {
    stem: "boss/marrow_phase", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.35, 0.8)],
    fallback: { sample: "bossSpawn", rate: 0.8, lowpassHz: 2200 },
    synth: { kind: "swell", durMs: 1100, fromHz: 50, toHz: 180, mode: "growl" },
  },
  "marrow.death": {
    stem: "boss/marrow_death", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.25, 0.8, 1.2)],
    fallback: { sample: "enemyDeath", rate: 0.45, lowpassHz: 1000 },
    synth: { kind: "impact", durMs: 2000, depthHz: 40 },
  },

  // ---- §2 HOLLOW CHOIR — fused nonverbal voices + cyan electricity -------------------
  "choir.strikeWarn": {
    stem: "boss/choir_strike_warn", variants: 2, gain: 0.82, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.6, 0.15, 0.4)],
    fallback: { sample: "tesla", rate: 0.6, highpassHz: 800 },
    synth: { kind: "swell", durMs: 900, fromHz: 220, toHz: 440, mode: "voice" },
  },
  "choir.strikeLock": {
    stem: "boss/choir_strike_lock", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossLock,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.35, 0.12, 0.35)],
    fallback: { sample: "tesla", rate: 1.6, highpassHz: 1500 }, // manifest DERIVE lane: high-pass/shorten tesla
    synth: { kind: "tick", freq: 3200, count: 1, spreadMs: 0, isBright: true },
  },
  "choir.strikeImpact": {
    stem: "boss/choir_strike", variants: 3, gain: 0.86, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true,
    fallback: { sample: "tesla", rate: 1.2, highpassHz: 600 },
    synth: { kind: "burst", durMs: 550, centerHz: 2600 },
  },
  "choir.swellWarn": {
    stem: "boss/choir_swell_warn", variants: 1, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.55, 0.2, 0.5)],
    fallback: { sample: "enemyAttack", rate: 0.8, highpassHz: 400 },
    synth: { kind: "swell", durMs: 800, fromHz: 180, toHz: 520, mode: "voice" },
  },
  "choir.swellFire": {
    stem: "boss/choir_swell", variants: 2, gain: 0.92, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true,
    duck: [dM(0.5, 0.12, 0.5)],
    fallback: { sample: "shootShotgun", rate: 0.6 },
    synth: { kind: "burst", durMs: 900, centerHz: 900 },
  },
  "choir.floorCharge": {
    stem: "boss/choir_floor_warn", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.25, 0.4, 0.8)],
    fallback: { sample: "tesla", rate: 0.45, lowpassHz: 2000 },
    synth: { kind: "swell", durMs: 1200, fromHz: 90, toHz: 700, mode: "voice" },
  },
  "choir.floorDischarge": {
    stem: "boss/choir_floor_blast", variants: 1, gain: 1.0, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.2, 0.35, 1.0)],
    fallback: { sample: "cannon", rate: 0.62 },
    synth: { kind: "impact", durMs: 1200, depthHz: 52 },
  },
  "choir.phase": {
    stem: "boss/choir_phase", variants: 2, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.25, 0.45, 1.0)],
    fallback: { sample: "bossSpawn", rate: 1.2, highpassHz: 300 },
    synth: { kind: "swell", durMs: 1400, fromHz: 260, toHz: 170, mode: "voice" },
  },
  "choir.death": {
    stem: "boss/choir_death", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.2, 1.0, 1.5)],
    fallback: { sample: "enemyDeath", rate: 0.6, highpassHz: 250 },
    synth: { kind: "notes", freqs: [523, 466, 392, 311, 233], stepMs: 220, noteMs: 500, shape: "sine" },
  },

  // ---- §2 WEAVER — silk tension + cold glass/knife transients ------------------------
  "weaver.blinkTell": {
    stem: "boss/weaver_blink_warn", variants: 3, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossLock,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    duck: [dM(0.55, 0.1, 0.3)],
    fallback: { sample: "parry", rate: 1.5, highpassHz: 2000 },
    synth: { kind: "shimmer", durMs: 350, freq: 2800, isRising: true },
  },
  "weaver.blinkDepart": {
    stem: "boss/weaver_blink_out", variants: 2, gain: 0.65, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.03, spatial: true,
    fallback: { sample: "dash", rate: 1.35, highpassHz: 1500, isReversed: true }, // manifest DERIVE: reverse+pitch dash
    synth: { kind: "whoosh", durMs: 250, fromHz: 1500, toHz: 5200 },
  },
  "weaver.blinkArriveStrike": {
    stem: "boss/weaver_strike", variants: 3, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true,
    duck: [dM(0.65, 0.08, 0.3)],
    fallback: { sample: "meleeHit", rate: 1.35, highpassHz: 900 },
    synth: { kind: "tick", freq: 3600, count: 2, spreadMs: 35, isBright: true },
  },
  "weaver.latticeWarn": {
    stem: "boss/weaver_lattice_warn", variants: 1, gain: 0.82, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.6, 0.15, 0.4)],
    fallback: { sample: "parry", rate: 1.25, highpassHz: 1500 },
    synth: { kind: "shimmer", durMs: 700, freq: 1900, isRising: true },
  },
  "weaver.latticeFire": {
    stem: "boss/weaver_lattice", variants: 2, gain: 0.8, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true,
    fallback: { sample: "meleeSwing", rate: 1.5, highpassHz: 1000 },
    synth: { kind: "whoosh", durMs: 650, fromHz: 4200, toHz: 1600 },
  },
  "weaver.feint": {
    stem: "boss/weaver_feint", variants: 1, gain: 0.86, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    duck: [dM(0.55, 0.12, 0.35)],
    fallback: { sample: "parry", rate: 1.7, highpassHz: 2400 },
    synth: { kind: "shimmer", durMs: 450, freq: 3400, isRising: false },
  },
  "weaver.phase": {
    stem: "boss/weaver_phase", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.35, 0.25, 0.7)],
    fallback: { sample: "bossSpawn", rate: 1.45, highpassHz: 600 },
    synth: { kind: "notes", freqs: [880, 1046, 1244, 1567, 1864], stepMs: 90, noteMs: 220, shape: "triangle" },
  },
  "weaver.death": {
    stem: "boss/weaver_death", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.25, 0.7, 1.1)],
    fallback: { sample: "enemyDeath", rate: 0.85, highpassHz: 500 },
    synth: { kind: "notes", freqs: [1864, 1567, 1244, 932, 622], stepMs: 160, noteMs: 380, shape: "triangle" },
  },

  // ---- §2 GILDED WARDEN — amber crystal + orderly bell geometry -----------------------
  // Binding note: the content-wave Warden fields slam/sweep (no turrets/glyph roots/prison
  // yet), so slam borrows the prison pair (big enclosing danger), sweep the glyph/turret
  // rows (orderly radial geometry). Unused rows stay registered for the authored kit.
  "warden.turretPlace": {
    stem: "boss/warden_turret_place", variants: 2, gain: 0.75, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true,
    fallback: { sample: "blessing", rate: 0.9 },
    synth: { kind: "notes", freqs: [740, 932, 1108], stepMs: 110, noteMs: 240, shape: "triangle" },
  },
  "warden.turretLock": {
    stem: "boss/warden_turret_lock", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossLock,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.65, 0.1, 0.3)],
    fallback: { sample: "coin", rate: 1.3, highpassHz: 1200 },
    synth: { kind: "tick", freq: 2100, count: 2, spreadMs: 90, isBright: true },
  },
  "warden.turretFire": {
    stem: "boss/warden_turret_fire", variants: 3, gain: 0.75, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true,
    fallback: { sample: "homing", rate: 1.1, lowpassHz: 4000 },
    synth: { kind: "burst", durMs: 420, centerHz: 1400 },
  },
  "warden.glyphWarn": {
    stem: "boss/warden_glyph_warn", variants: 2, gain: 0.84, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.6, 0.18, 0.4)],
    fallback: { sample: "blessing", rate: 0.7, lowpassHz: 3000 },
    synth: { kind: "shimmer", durMs: 850, freq: 1560, isRising: false },
  },
  "warden.glyphSet": {
    stem: "boss/warden_glyph_set", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true,
    duck: [dM(0.55, 0.1, 0.4)],
    fallback: { sample: "parry", rate: 0.9 },
    synth: { kind: "tick", freq: 1800, count: 3, spreadMs: 55, isBright: false },
  },
  "warden.prisonWarn": {
    stem: "boss/warden_prison_warn", variants: 1, gain: 0.92, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.25, 0.4, 0.8)],
    fallback: { sample: "enemyAttack", rate: 0.45, lowpassHz: 1500 },
    synth: { kind: "swell", durMs: 1300, fromHz: 120, toHz: 480, mode: "voice" },
  },
  "warden.prisonClose": {
    stem: "boss/warden_prison_close", variants: 1, gain: 0.95, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true,
    duck: [dM(0.4, 0.2, 0.65)],
    fallback: { sample: "parry", rate: 0.55, lowpassHz: 3500 },
    synth: { kind: "impact", durMs: 900, depthHz: 70 },
  },
  "warden.phase": {
    stem: "boss/warden_phase", variants: 1, gain: 0.92, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.4, 0.85)],
    fallback: { sample: "blessing", rate: 0.55 },
    synth: { kind: "notes", freqs: [523, 659, 784, 1046], stepMs: 140, noteMs: 420, shape: "triangle" },
  },
  "warden.death": {
    stem: "boss/warden_death", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.2, 0.9, 1.3)],
    fallback: { sample: "parry", rate: 0.42 },
    synth: { kind: "notes", freqs: [1046, 987, 830, 622, 415], stepMs: 200, noteMs: 460, shape: "triangle" },
  },

  // ---- §3 standard archetype cues ------------------------------------------------------
  "charger.windup": {
    stem: "enemy/charger_warn", variants: 3, gain: 0.72, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 0.75 },
    synth: { kind: "swell", durMs: 550, fromHz: 110, toHz: 220, mode: "growl" },
  },
  "charger.lock": {
    stem: "enemy/charger_lock", variants: 1, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.enemyLock,
    jitter: 0, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.8, 0.05, 0.2)],
    fallback: { sample: "meleeHit", rate: 1.1, highpassHz: 800 },
    synth: { kind: "tick", freq: 2000, count: 1, spreadMs: 0, isBright: false },
  },
  // Bound to the content-wave chargeCrash punish window; DERIVE-only per §0's
  // "low-pass/pitch-down cannon for rubble/rock impact" lane — no new generation.
  "charger.crash": {
    stem: "enemy/charger_crash", variants: 1, gain: 0.8, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "cannon", rate: 0.8, lowpassHz: 1600 },
    synth: { kind: "impact", durMs: 500, depthHz: 60 },
  },
  "burrower.submerge": {
    stem: "enemy/burrow_down", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.7, lowpassHz: 1200 },
    synth: { kind: "whoosh", durMs: 550, fromHz: 1600, toHz: 300 },
  },
  // The underground tracking is a COMPONENT EMITTER, never a continuous loop (bestiary
  // audio contract): the director re-triggers this row while the mound travels and the
  // per-entity cooldown IS the emitter cadence.
  "burrower.track": {
    stem: "enemy/burrow_track", variants: 2, gain: 0.42, bus: "sfx", priority: WAVE_PRIORITY.pet,
    jitter: 0.05, spatial: true, cooldownMs: 450, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.5, lowpassHz: 900 },
    synth: { kind: "impact", durMs: 260, depthHz: 70 },
  },
  "burrower.lock": {
    stem: "enemy/burrow_lock", variants: 1, gain: 0.86, bus: "voiceTell", priority: WAVE_PRIORITY.enemyLock,
    jitter: 0, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.75, 0.08, 0.25)],
    fallback: { sample: "enemyHit", rate: 1.25 },
    synth: { kind: "tick", freq: 1500, count: 3, spreadMs: 70, isBright: false },
  },
  "burrower.erupt": {
    stem: "enemy/burrow_erupt", variants: 3, gain: 0.78, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "barrel", rate: 1.15, lowpassHz: 2600 },
    synth: { kind: "burst", durMs: 650, centerHz: 700 },
  },
  "orbiter.enterBand": {
    stem: "enemy/orbiter_acquire", variants: 2, gain: 0.45, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 600000, isPerEntityCooldown: true, // once per entity (§3)
    fallback: { sample: "homing", rate: 0.85, highpassHz: 600 },
    synth: { kind: "shimmer", durMs: 380, freq: 980, isRising: true },
  },
  "orbiter.diveWarn": {
    stem: "enemy/orbiter_dive_warn", variants: 3, gain: 0.72, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 1.5 },
    synth: { kind: "whoosh", durMs: 450, fromHz: 3400, toHz: 900 },
  },
  "shielder.raise": {
    stem: "enemy/shield_raise", variants: 2, gain: 0.65, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 0.6, lowpassHz: 1800 },
    synth: { kind: "knock", freq: 190, count: 2 },
  },

  // ---- the bestiary wave (generation stems queued; fallbacks/synths carry each identity
  // ---- until the audio pipeline ships the files) --------------------------------------
  "echojack.jangle": {
    stem: "enemy/echojack_jangle", variants: 2, gain: 0.7, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "coin", rate: 0.7, highpassHz: 900 },
    synth: { kind: "shimmer", durMs: 600, freq: 1900, isRising: true },
  },
  "echojack.blink": {
    stem: "enemy/echojack_blink", variants: 2, gain: 0.65, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 1.7 },
    synth: { kind: "whoosh", durMs: 350, fromHz: 2600, toHz: 700 },
  },
  "seamcutter.preview": {
    stem: "enemy/seam_preview", variants: 2, gain: 0.75, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "tesla", rate: 0.5, lowpassHz: 2400 },
    synth: { kind: "swell", durMs: 800, fromHz: 140, toHz: 480, mode: "noise" },
  },
  "seamcutter.lock": {
    stem: "enemy/seam_lock", variants: 1, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.enemyLock,
    jitter: 0, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.8, 0.05, 0.2)],
    fallback: { sample: "meleeHit", rate: 1.3, highpassHz: 1200 },
    synth: { kind: "tick", freq: 2600, count: 1, spreadMs: 0, isBright: true },
  },
  "seamcutter.cut": {
    stem: "enemy/seam_cut", variants: 2, gain: 0.8, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.6 },
    synth: { kind: "whoosh", durMs: 700, fromHz: 900, toHz: 2400 },
  },
  "caskbellows.crank": {
    stem: "enemy/cask_crank", variants: 2, gain: 0.7, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 0.85 },
    synth: { kind: "knock", freq: 240, count: 3 },
  },
  "caskbellows.stagger": {
    stem: "enemy/cask_stagger", variants: 1, gain: 0.8, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "barrel", rate: 0.7 },
    synth: { kind: "impact", durMs: 600, depthHz: 70 },
  },
  "sinderling.stoke": {
    stem: "enemy/sinder_stoke", variants: 2, gain: 0.68, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "barrel", rate: 1.3 },
    synth: { kind: "swell", durMs: 900, fromHz: 160, toHz: 640, mode: "noise" },
  },
  "sinderling.jet": {
    stem: "enemy/sinder_jet", variants: 2, gain: 0.75, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 1.4 },
    synth: { kind: "whoosh", durMs: 500, fromHz: 700, toHz: 2100 },
  },
  "fragment.harmonize": {
    stem: "enemy/fragment_harmonize", variants: 2, gain: 0.72, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.03, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "tesla", rate: 0.7, highpassHz: 700 },
    synth: { kind: "swell", durMs: 850, fromHz: 260, toHz: 520, mode: "voice" },
  },
  "marshal.order": {
    stem: "mini/marshal_order", variants: 2, gain: 0.8, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 0.6, lowpassHz: 1400 },
    synth: { kind: "swell", durMs: 700, fromHz: 90, toHz: 200, mode: "growl" },
  },
  "marshal.shatter": {
    stem: "mini/marshal_shatter", variants: 1, gain: 0.9, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.5, 0.2, 0.5)],
    fallback: { sample: "barrel", rate: 0.55 },
    synth: { kind: "impact", durMs: 900, depthHz: 55 },
  },
  "toll.ringWarn": {
    stem: "mini/toll_ring_warn", variants: 2, gain: 0.8, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 0.45, lowpassHz: 1200 },
    synth: { kind: "swell", durMs: 900, fromHz: 120, toHz: 320, mode: "voice" },
  },
  "toll.ring": {
    stem: "mini/toll_ring", variants: 2, gain: 0.9, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.55, 0.15, 0.45)],
    fallback: { sample: "floorClear", rate: 0.5 },
    synth: { kind: "notes", freqs: [392, 311, 262], stepMs: 60, noteMs: 700, shape: "triangle" },
  },
  "shielder.block": {
    stem: "enemy/shield_block", variants: 3, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 120, isPerEntityCooldown: true, // manifest rate limit 120ms
    fallback: { sample: "parry", rate: 0.85, lowpassHz: 5000 }, // manifest: parry .75–.95, lowpass 5k, reduced gain
    synth: { kind: "tick", freq: 1200, count: 1, spreadMs: 0, isBright: false },
  },
  "shielder.break": {
    stem: "enemy/shield_break", variants: 1, gain: 0.82, bus: "sfx", priority: WAVE_PRIORITY.hazardActive,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.8, 0.08, 0.3)],
    fallback: { sample: "parry", rate: 0.72, lowpassHz: 4000 }, // manifest DERIVE: parry pitch-down shield break
    synth: { kind: "impact", durMs: 700, depthHz: 90 },
  },

  // ---- §4 Thumper (mortar) / Sunlance (beam) ------------------------------------------
  "shootMortar": {
    stem: "sfx/thumper_fire", variants: 3, gain: 0.82, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true,
    duck: [dM(0.8, 0.06, 0.2)],
    fallback: { sample: "cannon", rate: 1.12, lowpassHz: 1100 }, // launch thump, not an explosion
    synth: { kind: "impact", durMs: 380, depthHz: 110 },
  },
  "mortarDetonate": {
    stem: "sfx/thumper_impact", variants: 3, gain: 0.9, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true,
    duck: [dM(0.75, 0.08, 0.3)],
    fallback: { sample: "barrel", rate: 0.9, lowpassHz: 2800 },
    synth: { kind: "impact", durMs: 780, depthHz: 58 },
  },
  "beamStart": {
    stem: "sfx/sunlance_start", variants: 2, gain: 0.58, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0,
    fallback: { sample: "crit", rate: 0.7 },
    synth: { kind: "shimmer", durMs: 380, freq: 1320, isRising: true },
  },
  "beamLoop": {
    stem: "sfx/sunlance_loop", variants: 1, gain: 0.34, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0, loop: true,
    synth: { kind: "loopPad", mode: "harmonic", filterType: "lowpass", filterHz: 2400, q: 0.8, lfoHz: 0.9, level: 0.55 },
  },
  "beamStop": {
    stem: "sfx/sunlance_stop", variants: 1, gain: 0.34, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0,
    synth: { kind: "shimmer", durMs: 280, freq: 1320, isRising: false },
  },
  "beamHit": {
    stem: "sfx/sunlance_hit", variants: 2, gain: 0.42, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 120, isPerEntityCooldown: true, // manifest: 120ms per target
    fallback: { sample: "enemyHit", rate: 1.45, highpassHz: 900 },
    synth: { kind: "tick", freq: 2900, count: 1, spreadMs: 0, isBright: true },
  },

  // ---- §5 six audio zones (ambient bus loops; never one full-volume global loop) -------
  "ambient.verdant": {
    stem: "amb/verdant_loop", variants: 1, gain: 0.24, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true,
    synth: { kind: "loopPad", mode: "noise", filterType: "lowpass", filterHz: 420, q: 0.7, lfoHz: 0.07, level: 0.5 },
  },
  "ambient.sunless": {
    stem: "amb/sunless_loop", variants: 1, gain: 0.25, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true,
    synth: { kind: "loopPad", mode: "noise", filterType: "lowpass", filterHz: 260, q: 1.4, lfoHz: 0.05, level: 0.5 },
  },
  "ambient.deep": {
    stem: "amb/deep_loop", variants: 1, gain: 0.22, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true,
    synth: { kind: "loopPad", mode: "noise", filterType: "bandpass", filterHz: 180, q: 2.6, lfoHz: 0.04, level: 0.55 },
  },
  "ambient.ember": {
    stem: "amb/ember_loop", variants: 1, gain: 0.28, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true,
    synth: { kind: "loopPad", mode: "noise", filterType: "bandpass", filterHz: 130, q: 1.8, lfoHz: 0.16, level: 0.6 },
  },
  "ambient.fracture": {
    stem: "amb/fracture_loop", variants: 1, gain: 0.2, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true,
    synth: { kind: "loopPad", mode: "noise", filterType: "highpass", filterHz: 5600, q: 0.9, lfoHz: 0.06, level: 0.35 },
  },
  "ambient.null": {
    stem: "amb/null_loop", variants: 1, gain: 0.18, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true,
    synth: { kind: "loopPad", mode: "pulse", filterType: "lowpass", filterHz: 140, q: 1.1, lfoHz: 0.11, level: 0.6 },
  },

  // ---- §6 canonical hazards (depth-progression kinds/cycles) ---------------------------
  "spikes.telegraph": {
    stem: "hazard/spikes_warn", variants: 2, gain: 0.7, bus: "voiceTell", priority: WAVE_PRIORITY.hazardWarn,
    jitter: 0.05, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    duck: [dM(0.65, 0.12, 0.35), dA(0.45, 0.9, 0.3)],
    fallback: { sample: "ricochet", rate: 1.15, highpassHz: 1000 },
    synth: { kind: "tick", freq: 1700, count: 3, spreadMs: 90, isBright: false },
  },
  "spikes.active": {
    stem: "hazard/spikes_fire", variants: 3, gain: 0.76, bus: "sfx", priority: WAVE_PRIORITY.hazardActive,
    jitter: 0.05, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    fallback: { sample: "meleeSwing", rate: 1.5, highpassHz: 700 },
    synth: { kind: "whoosh", durMs: 300, fromHz: 800, toHz: 4200 },
  },
  "toxic_pool.enter": {
    stem: "hazard/toxic_enter", variants: 1, gain: 0.44, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 800,
    fallback: { sample: "enemyDeath", rate: 1.3, lowpassHz: 1800 },
    synth: { kind: "burst", durMs: 350, centerHz: 500 },
  },
  "toxic_pool.loop": {
    stem: "hazard/toxic_loop", variants: 1, gain: 0.18, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true, // proximity-gated by the caller; max one mixed voice by loop key
    synth: { kind: "loopPad", mode: "noise", filterType: "lowpass", filterHz: 600, q: 1.6, lfoHz: 1.9, level: 0.5 },
  },
  "fire_vent.telegraph": {
    stem: "hazard/vent_warn", variants: 2, gain: 0.74, bus: "voiceTell", priority: WAVE_PRIORITY.hazardWarn,
    jitter: 0.05, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    duck: [dM(0.65, 0.12, 0.35), dA(0.45, 1.0, 0.3)],
    fallback: { sample: "enemyAttack", rate: 0.7, lowpassHz: 1200 },
    synth: { kind: "swell", durMs: 1000, fromHz: 90, toHz: 900, mode: "noise" },
  },
  "fire_vent.active": {
    stem: "hazard/vent_blast", variants: 2, gain: 0.84, bus: "sfx", priority: WAVE_PRIORITY.hazardActive,
    jitter: 0.05, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    fallback: { sample: "barrel", rate: 1.3, highpassHz: 300 },
    synth: { kind: "burst", durMs: 1100, centerHz: 1100 },
  },
  "void_rift.telegraph": {
    stem: "hazard/rift_warn", variants: 2, gain: 0.78, bus: "voiceTell", priority: WAVE_PRIORITY.hazardWarn,
    jitter: 0.05, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    duck: [dM(0.65, 0.12, 0.35), dA(0.45, 1.1, 0.3)],
    fallback: { sample: "enemyAttack", rate: 0.4, lowpassHz: 900 },
    synth: { kind: "swell", durMs: 1100, fromHz: 160, toHz: 55, mode: "growl" },
  },
  "void_rift.active": {
    stem: "hazard/rift_open", variants: 2, gain: 0.8, bus: "sfx", priority: WAVE_PRIORITY.hazardActive,
    jitter: 0.05, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.45, lowpassHz: 800 }, // inward air, never an electric zap
    synth: { kind: "whoosh", durMs: 1300, fromHz: 2400, toHz: 120 },
  },

  // ---- §7 pets (species-neutral state cues) --------------------------------------------
  "pet.summon": {
    stem: "pet/summon", variants: 1, gain: 0.38, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05,
    fallback: { sample: "blessing", rate: 1.3 },
    synth: { kind: "notes", freqs: [660, 990], stepMs: 90, noteMs: 260, shape: "sine" },
  },
  "pet.attack": {
    stem: "pet/attack", variants: 3, gain: 0.32, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05, spatial: true, cooldownMs: 150,
    fallback: { sample: "enemyHit", rate: 1.7, highpassHz: 1200 },
    synth: { kind: "tick", freq: 1900, count: 1, spreadMs: 0, isBright: false },
  },
  "pet.abilityReady": {
    stem: "pet/ready", variants: 1, gain: 0.3, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0,
    fallback: { sample: "coin", rate: 1.15 },
    synth: { kind: "notes", freqs: [880, 1174], stepMs: 80, noteMs: 160, shape: "sine" },
  },
  "pet.hurt": {
    stem: "pet/hurt", variants: 2, gain: 0.34, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05, cooldownMs: 1000, // manifest: cooldown 1s
    fallback: { sample: "enemyHit", rate: 1.5, lowpassHz: 2500 },
    synth: { kind: "tick", freq: 1300, count: 1, spreadMs: 0, isBright: false },
  },
  "pet.down": {
    stem: "pet/down", variants: 1, gain: 0.42, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0,
    fallback: { sample: "blessing", rate: 0.65 },
    synth: { kind: "notes", freqs: [784, 622, 466], stepMs: 150, noteMs: 320, shape: "sine" },
  },
  "pet.revive": {
    stem: "pet/revive", variants: 1, gain: 0.38, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0,
    fallback: { sample: "revive", rate: 1.26, highpassHz: 250 }, // manifest DERIVE: revive +4 semitones, HP 250Hz
    synth: { kind: "notes", freqs: [415, 831], stepMs: 100, noteMs: 300, shape: "triangle" },
  },
  "pet.idle": {
    stem: "pet/idle", variants: 3, gain: 0.16, bus: "pet", priority: 25,
    jitter: 0.05, cooldownMs: 8000, isCombatSuppressed: true, // manifest: random ≥8s, suppressed in combat
    fallback: { sample: "dash", rate: 1.9, highpassHz: 2000 },
    synth: { kind: "shimmer", durMs: 350, freq: 2200, isRising: true },
  },

  // ---- §8 co-op states -----------------------------------------------------------------
  "revive.channelStart": {
    stem: "coop/revive_start", variants: 1, gain: 0.65, bus: "sfx", priority: WAVE_PRIORITY.revive,
    jitter: 0, spatial: true, isOffCameraUncapped: true,
    duck: [dM(0.8, 0.1, 0.3)],
    fallback: { sample: "heart", rate: 0.85 },
    synth: { kind: "notes", freqs: [392, 523], stepMs: 140, noteMs: 340, shape: "sine" },
  },
  "revive.channelLoop": {
    stem: "coop/revive_loop", variants: 1, gain: 0.42, bus: "sfx", priority: WAVE_PRIORITY.revive,
    jitter: 0, loop: true,
    synth: { kind: "loopPad", mode: "pulse", filterType: "lowpass", filterHz: 700, q: 0.9, lfoHz: 1.4, level: 0.6 },
  },
  "revive.cancel": {
    stem: "coop/revive_cancel", variants: 1, gain: 0.62, bus: "sfx", priority: WAVE_PRIORITY.revive,
    jitter: 0,
    fallback: { sample: "parry", rate: 0.6, lowpassHz: 2000 },
    synth: { kind: "notes", freqs: [523, 392], stepMs: 90, noteMs: 180, shape: "triangle" },
  },
  // revive.complete REUSES the existing `revive` sample/synth verbatim (played by the
  // existing SimEvent handler); the director only stops the channel loop + applies the
  // manifest's music duck (.5/.18/.55) around it.
  "spectate.enter": {
    stem: "coop/spectate_enter", variants: 1, gain: 0.55, bus: "ui", priority: WAVE_PRIORITY.impact,
    jitter: 0,
    duck: [dM(0.75, 0.1, 0.4)],
    fallback: { sample: "dash", rate: 0.5, lowpassHz: 1400 },
    synth: { kind: "whoosh", durMs: 650, fromHz: 1400, toHz: 300 },
  },
  "spectate.switch": {
    stem: null, variants: 1, gain: 0.35, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0, cooldownMs: 100,
    fallback: { sample: "uiClick", rate: 1.0, lowpassHz: 5000 }, // manifest DERIVE: uiClick lowpass 5k
    synth: { kind: "tick", freq: 750, count: 1, spreadMs: 0, isBright: false },
  },
  "reconnect.lost": {
    stem: "coop/disconnect", variants: 1, gain: 0.65, bus: "ui", priority: WAVE_PRIORITY.hazardActive,
    jitter: 0,
    duck: [dM(0.75, 0.1, 0.5)],
    fallback: { sample: "uiClick", rate: 0.55 },
    synth: { kind: "notes", freqs: [440, 330], stepMs: 160, noteMs: 200, shape: "square" },
  },
  "reconnect.try": {
    stem: null, variants: 1, gain: 0.28, bus: "ui", priority: 40,
    jitter: 0, cooldownMs: 2000, // manifest: max 1 per 2s
    fallback: { sample: "uiClick", rate: 0.89 }, // manifest DERIVE: uiClick pitch -2, no jitter
    synth: { kind: "tick", freq: 640, count: 1, spreadMs: 0, isBright: false },
  },
  "reconnect.restored": {
    stem: "coop/reconnect_ok", variants: 1, gain: 0.65, bus: "ui", priority: WAVE_PRIORITY.hazardActive,
    jitter: 0,
    duck: [dM(0.75, 0.1, 0.45)],
    fallback: { sample: "levelup", rate: 0.9, lowpassHz: 4000 },
    synth: { kind: "notes", freqs: [392, 523, 659], stepMs: 130, noteMs: 300, shape: "sine" },
  },
  "party.readyOn": {
    stem: "coop/ready_on", variants: 1, gain: 0.45, bus: "ui", priority: 55,
    jitter: 0,
    fallback: { sample: "coin", rate: 0.95 },
    synth: { kind: "notes", freqs: [587, 880], stepMs: 90, noteMs: 200, shape: "triangle" },
  },
  "party.readyOff": {
    stem: "coop/ready_off", variants: 1, gain: 0.38, bus: "ui", priority: 55,
    jitter: 0,
    fallback: { sample: "coin", rate: 0.75 },
    synth: { kind: "notes", freqs: [659, 587], stepMs: 90, noteMs: 180, shape: "triangle" },
  },
  "party.allReady": {
    stem: "coop/all_ready", variants: 1, gain: 0.7, bus: "ui", priority: WAVE_PRIORITY.weapon,
    jitter: 0,
    duck: [dM(0.7, 0.1, 0.45)],
    fallback: { sample: "levelup", rate: 1.05 },
    synth: { kind: "notes", freqs: [523, 659, 784], stepMs: 120, noteMs: 320, shape: "triangle" },
  },

  // ---- §9 difficulty / UI / profile / leaderboard ---------------------------------------
  "ui.hover": {
    stem: null, variants: 1, gain: 0.1, bus: "ui", priority: WAVE_PRIORITY.uiHover,
    jitter: 0, cooldownMs: 80, // manifest: UI hover ≥80ms
    synth: { kind: "tick", freq: 900, count: 1, spreadMs: 0, isBright: false },
  },
  "ui.click": {
    stem: null, variants: 1, gain: 0.22, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "uiClick" },
    synth: { kind: "tick", freq: 700, count: 1, spreadMs: 0, isBright: false },
  },
  "ui.confirm": {
    stem: "ui/confirm", variants: 1, gain: 0.38, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "uiClick", rate: 1.25 },
    synth: { kind: "notes", freqs: [660, 990], stepMs: 70, noteMs: 160, shape: "triangle" },
  },
  "ui.back": {
    stem: null, variants: 1, gain: 0.3, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "uiClick", rate: 0.79 }, // manifest DERIVE: confirm pitch -4
    synth: { kind: "tick", freq: 520, count: 1, spreadMs: 0, isBright: false },
  },
  "ui.error": {
    stem: "ui/error", variants: 1, gain: 0.45, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "uiClick", rate: 0.6 },
    synth: { kind: "knock", freq: 220, count: 2 },
  },
  "difficulty.change": {
    stem: null, variants: 1, gain: 0.32, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0, cooldownMs: 90, // caller maps rate: Easy -2 / Normal 0 / Hard +2 / Nightmare +5 semitones
    fallback: { sample: "uiClick" },
    synth: { kind: "tick", freq: 820, count: 1, spreadMs: 0, isBright: false },
  },
  "difficulty.confirm": {
    stem: "ui/difficulty_confirm", variants: 1, gain: 0.5, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "blessing", rate: 0.85 },
    synth: { kind: "notes", freqs: [440, 554, 659], stepMs: 110, noteMs: 260, shape: "triangle" },
  },
  "profile.open": {
    stem: "ui/profile_open", variants: 1, gain: 0.28, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "chest", rate: 1.5, highpassHz: 400 },
    synth: { kind: "tick", freq: 1100, count: 2, spreadMs: 110, isBright: false },
  },
  "profile.statMilestone": {
    stem: null, variants: 1, gain: 0.55, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0, cooldownMs: 1000, // true milestones only, never every stat update
    fallback: { sample: "levelup" }, // manifest REUSE at gain .55
    synth: { kind: "notes", freqs: [392, 494, 587, 784], stepMs: 70, noteMs: 200, shape: "triangle" },
  },
  "profile.save": {
    stem: "ui/profile_save", variants: 1, gain: 0.3, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "uiClick", rate: 0.9 },
    synth: { kind: "knock", freq: 340, count: 1 },
  },
  "leaderboard.open": {
    stem: "ui/leaderboard_open", variants: 1, gain: 0.3, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "chest", rate: 1.7, highpassHz: 600 },
    synth: { kind: "notes", freqs: [740, 880, 1046], stepMs: 60, noteMs: 130, shape: "triangle" },
  },
  "leaderboard.rowMove": {
    stem: null, variants: 1, gain: 0.08, bus: "ui", priority: WAVE_PRIORITY.uiHover,
    jitter: 0, cooldownMs: 100, // manifest: rate limit 100ms, never per network update
    synth: { kind: "tick", freq: 900, count: 1, spreadMs: 0, isBright: false },
  },
  "leaderboard.personalBest": {
    stem: "ui/personal_best", variants: 1, gain: 0.55, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "levelup" },
    synth: { kind: "notes", freqs: [523, 659, 784, 1046], stepMs: 100, noteMs: 300, shape: "triangle" },
  },
  "leaderboard.topRank": {
    stem: "ui/top_rank", variants: 1, gain: 0.65, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    fallback: { sample: "floorClear", rate: 0.9 },
    synth: { kind: "notes", freqs: [523, 659, 784, 1046, 1318], stepMs: 120, noteMs: 380, shape: "triangle" },
  },

  // ---- bestiary audio hook contract (see src/game/bestiaryAudio.ts) -----------------
  // Behavior verb teaches counterplay, body material identifies the species, tier adds
  // an authored layer. Every row ships a SAME-MATERIAL sample fallback (no oscillator
  // identities, no extreme rates) until its generated stem lands.
  "slime.move": {
    stem: "mob/slime_move", variants: 3, gain: 0.3, bus: "sfx", priority: WAVE_PRIORITY.ambient,
    jitter: 0.05, spatial: true, cooldownMs: 260, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 1.6, lowpassHz: 900 },
    synth: { kind: "burst", durMs: 120, centerHz: 240 },
  },
  "slime.commit": {
    stem: "mob/slime_commit", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 1.2 },
    synth: { kind: "swell", durMs: 350, fromHz: 160, toHz: 320, mode: "noise" },
  },
  "skeleton.move": {
    stem: "mob/skeleton_move", variants: 3, gain: 0.3, bus: "sfx", priority: WAVE_PRIORITY.ambient,
    jitter: 0.05, spatial: true, cooldownMs: 280, isPerEntityCooldown: true,
    fallback: { sample: "meleeHit", rate: 1.6, highpassHz: 1200 },
    synth: { kind: "knock", freq: 900, count: 1 },
  },
  "skeleton.commit": {
    stem: "mob/skeleton_commit", variants: 2, gain: 0.7, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 0.9 },
    synth: { kind: "swell", durMs: 450, fromHz: 200, toHz: 420, mode: "growl" },
  },
  // The flock is ONE aggregate bed (a single group-keyed loop, gain scales with count).
  "flock.bed": {
    stem: "mob/flock_bed", variants: 1, gain: 0.4, bus: "sfx", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true, spatial: false,
    synth: { kind: "loopPad", mode: "noise", filterType: "bandpass", filterHz: 620, q: 1.6, lfoHz: 7.5, level: 0.4 },
  },
  "flock.pass": {
    stem: "mob/flock_pass", variants: 3, gain: 0.5, bus: "sfx", priority: WAVE_PRIORITY.ambient,
    jitter: 0.05, spatial: true, cooldownMs: 700, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 1.4 },
    synth: { kind: "whoosh", durMs: 220, fromHz: 2400, toHz: 900 },
  },
  "flock.surge": {
    stem: "mob/flock_surge", variants: 2, gain: 0.65, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 400, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.9 },
    synth: { kind: "whoosh", durMs: 500, fromHz: 800, toHz: 2000 },
  },
  // The commander's pack beats (any chassis: the rally IS the flock's one commit).
  "elite.rally": {
    stem: "mob/elite_rally", variants: 2, gain: 0.75, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 0.7 },
    synth: { kind: "swell", durMs: 700, fromHz: 140, toHz: 340, mode: "growl" },
  },
  "elite.panic": {
    stem: "mob/elite_panic", variants: 2, gain: 0.7, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 300,
    fallback: { sample: "enemyDeath", rate: 1.3 },
    synth: { kind: "shimmer", durMs: 550, freq: 700, isRising: false },
  },
  "charger.rush": {
    stem: "enemy/charger_rush", variants: 2, gain: 0.8, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.55 },
    synth: { kind: "whoosh", durMs: 600, fromHz: 500, toHz: 1400 },
  },
  "charger.dazed": {
    stem: "enemy/charger_dazed", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "enemyDeath", rate: 0.75 },
    synth: { kind: "shimmer", durMs: 800, freq: 480, isRising: false },
  },
  "burrower.recover": {
    stem: "enemy/burrow_recover", variants: 2, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 250, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.8, lowpassHz: 1400 },
    synth: { kind: "burst", durMs: 300, centerHz: 300 },
  },
  // ONE orbit hum for the whole ring, group-keyed like the flock bed.
  "orbit.loop": {
    stem: "mob/orbit_loop", variants: 1, gain: 0.32, bus: "sfx", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true, spatial: false,
    synth: { kind: "loopPad", mode: "harmonic", filterType: "bandpass", filterHz: 900, q: 3, lfoHz: 1.7, level: 0.35 },
  },
  "orbiter.lock": {
    stem: "enemy/orbiter_lock", variants: 1, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.enemyLock,
    jitter: 0, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "uiClick", rate: 1.2 },
    synth: { kind: "tick", freq: 2500, count: 1, spreadMs: 0, isBright: true },
  },
  "orbiter.fire": {
    stem: "enemy/orbiter_fire", variants: 2, gain: 0.65, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 150, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 1.5 },
    synth: { kind: "burst", durMs: 200, centerHz: 1500 },
  },
  "shielder.bash": {
    stem: "enemy/shield_bash", variants: 2, gain: 0.75, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "meleeHit", rate: 0.8 },
    synth: { kind: "impact", durMs: 350, depthHz: 90 },
  },
  "guard.break": {
    stem: "mob/guard_break", variants: 1, gain: 0.85, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "barrel", rate: 0.8 },
    synth: { kind: "impact", durMs: 550, depthHz: 65 },
  },
  "shielder.rearHurt": {
    stem: "enemy/shield_rear_hurt", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 220, isPerEntityCooldown: true,
    fallback: { sample: "meleeHit", rate: 1.15 },
    synth: { kind: "knock", freq: 320, count: 2 },
  },
  "root.raise": {
    stem: "mob/root_raise", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 400, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 0.7 },
    synth: { kind: "swell", durMs: 500, fromHz: 110, toHz: 240, mode: "noise" },
  },
  "root.block": {
    stem: "mob/root_block", variants: 3, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 150,
    fallback: { sample: "barrel", rate: 1.1 },
    synth: { kind: "knock", freq: 210, count: 1 },
  },
  "plate.block": {
    stem: "mob/plate_block", variants: 3, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 150,
    fallback: { sample: "meleeHit", rate: 1.2 },
    synth: { kind: "knock", freq: 480, count: 1 },
  },
  "anchor.place": {
    stem: "enemy/cask_place", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 400, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 0.8 },
    synth: { kind: "knock", freq: 180, count: 2 },
  },
  "caskbellows.lock": {
    stem: "enemy/cask_lock", variants: 1, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.enemyLock,
    jitter: 0, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "coin", rate: 0.7 },
    synth: { kind: "tick", freq: 1900, count: 2, spreadMs: 70, isBright: false },
  },
  "caskbellows.fire": {
    stem: "enemy/cask_fire", variants: 2, gain: 0.7, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 120, isPerEntityCooldown: true,
    fallback: { sample: "cannon", rate: 1.4 },
    synth: { kind: "burst", durMs: 220, centerHz: 700 },
  },
  "seamcutter.stop": {
    stem: "enemy/seam_stop", variants: 2, gain: 0.75, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 250, isPerEntityCooldown: true,
    fallback: { sample: "meleeHit", rate: 0.7 },
    synth: { kind: "impact", durMs: 420, depthHz: 75 },
  },
  "seamcutter.dazed": {
    stem: "enemy/seam_dazed", variants: 2, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "tesla", rate: 0.6 },
    synth: { kind: "shimmer", durMs: 650, freq: 600, isRising: false },
  },
  "sinderling.burst": {
    stem: "enemy/sinder_burst", variants: 2, gain: 0.8, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 200,
    fallback: { sample: "barrel", rate: 1.0 },
    synth: { kind: "impact", durMs: 500, depthHz: 60 },
  },
  "fragment.pulse": {
    stem: "enemy/fragment_pulse", variants: 2, gain: 0.7, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.03, spatial: true, cooldownMs: 250, isPerEntityCooldown: true,
    fallback: { sample: "tesla", rate: 0.7 },
    synth: { kind: "burst", durMs: 450, centerHz: 1100 },
  },
  "knell.fuse": {
    stem: "mob/knell_fuse", variants: 2, gain: 0.6, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "uiClick", rate: 0.8 },
    synth: { kind: "tick", freq: 1300, count: 3, spreadMs: 120, isBright: false },
  },
  // Rate-limited generic hurt/death (the contract's hurt/death semantic events); the
  // per-material death banks are a generation backlog — these carry the limit today.
  "mob.hurt": {
    stem: "mob/hurt", variants: 3, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 90,
    fallback: { sample: "enemyHit" },
    synth: { kind: "burst", durMs: 140, centerHz: 800 },
  },
  "mob.death": {
    stem: "mob/death", variants: 3, gain: 0.7, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 120,
    fallback: { sample: "enemyDeath" },
    synth: { kind: "burst", durMs: 320, centerHz: 500 },
  },
  // Authored tier LAYERS (played alongside the material death — never a pitch-down, so
  // the fallbacks carry NO rate transform).
  "tier.bruteBody": {
    stem: "mob/tier_brute_body", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 150,
    fallback: { sample: "cannon" },
    synth: { kind: "impact", durMs: 420, depthHz: 55 },
  },
  "tier.eliteSheen": {
    stem: "mob/tier_elite_sheen", variants: 2, gain: 0.5, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 150,
    fallback: { sample: "coin" },
    synth: { kind: "shimmer", durMs: 380, freq: 1600, isRising: true },
  },

  // ---- the Slime King joins the wave manifest (windup/lock/impact/recover + bespoke
  // ---- entrance/phase/special/death — it was the last legacy-only boss) --------------
  "king.entrance": {
    stem: "boss/king_entrance", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.4, 0.9)],
    fallback: { sample: "bossSpawn", rate: 0.9 },
    synth: { kind: "swell", durMs: 1100, fromHz: 70, toHz: 200, mode: "growl" },
  },
  "king.hopWarn": {
    stem: "boss/king_hop_warn", variants: 2, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 0.5 },
    synth: { kind: "swell", durMs: 600, fromHz: 90, toHz: 220, mode: "growl" },
  },
  "king.hopLock": {
    stem: "boss/king_hop_lock", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossLock,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.35, 0.15, 0.45)],
    fallback: { sample: "enemyHit", rate: 1.4 },
    synth: { kind: "tick", freq: 2100, count: 2, spreadMs: 60, isBright: false },
  },
  "king.slam": {
    stem: "boss/king_slam", variants: 2, gain: 1.0, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true,
    duck: [dM(0.5, 0.15, 0.5)],
    fallback: { sample: "enemyDeath", rate: 0.6 },
    synth: { kind: "impact", durMs: 750, depthHz: 50 },
  },
  "king.radialWarn": {
    stem: "boss/king_radial_warn", variants: 2, gain: 0.82, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 0.62 },
    synth: { kind: "swell", durMs: 700, fromHz: 120, toHz: 380, mode: "noise" },
  },
  "king.radialFire": {
    stem: "boss/king_radial_fire", variants: 2, gain: 0.9, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyHit", rate: 0.7 },
    synth: { kind: "burst", durMs: 550, centerHz: 600 },
  },
  "king.squeezeWarn": {
    stem: "boss/king_squeeze_warn", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.35, 0.8)],
    fallback: { sample: "enemyAttack", rate: 0.45 },
    synth: { kind: "swell", durMs: 1000, fromHz: 60, toHz: 260, mode: "growl" },
  },
  "king.recover": {
    stem: "boss/king_recover", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "enemyDeath", rate: 0.9 },
    synth: { kind: "shimmer", durMs: 600, freq: 420, isRising: false },
  },
  "king.phase": {
    stem: "boss/king_phase", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.35, 0.8)],
    fallback: { sample: "bossSpawn", rate: 0.8 },
    synth: { kind: "swell", durMs: 1100, fromHz: 60, toHz: 210, mode: "growl" },
  },
  "king.death": {
    stem: "boss/king_death", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.25, 0.8, 1.2)],
    fallback: { sample: "enemyDeath", rate: 0.5 },
    synth: { kind: "impact", durMs: 1600, depthHz: 42 },
  },

  // ---- bespoke entrances + punish-recover beats for the deep bosses ------------------
  "marrow.entrance": {
    stem: "boss/marrow_entrance", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.4, 0.9)],
    fallback: { sample: "bossSpawn", rate: 0.7 },
    synth: { kind: "swell", durMs: 1200, fromHz: 50, toHz: 150, mode: "growl" },
  },
  "marrow.recover": {
    stem: "boss/marrow_recover", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "enemyDeath", rate: 0.8 },
    synth: { kind: "shimmer", durMs: 700, freq: 380, isRising: false },
  },
  "choir.entrance": {
    stem: "boss/choir_entrance", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.4, 0.9)],
    fallback: { sample: "bossSpawn", rate: 1.1, highpassHz: 400 },
    synth: { kind: "swell", durMs: 1300, fromHz: 180, toHz: 520, mode: "voice" },
  },
  "choir.recover": {
    stem: "boss/choir_recover", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 0.8, highpassHz: 500 },
    synth: { kind: "shimmer", durMs: 700, freq: 520, isRising: false },
  },
  "weaver.entrance": {
    stem: "boss/weaver_entrance", variants: 1, gain: 0.92, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.4, 0.9)],
    fallback: { sample: "bossSpawn", rate: 1.3 },
    synth: { kind: "shimmer", durMs: 1100, freq: 1100, isRising: true },
  },
  "weaver.recover": {
    stem: "boss/weaver_recover", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.7 },
    synth: { kind: "shimmer", durMs: 550, freq: 800, isRising: false },
  },
  "gilded.entrance": {
    stem: "boss/gilded_entrance", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.4, 0.9)],
    fallback: { sample: "bossSpawn", rate: 0.7, lowpassHz: 2600 },
    synth: { kind: "swell", durMs: 1300, fromHz: 55, toHz: 170, mode: "growl" },
  },
  // The Warden's EXPOSED window: the plate hangs open — the punish-window identity cue.
  "warden.exposed": {
    stem: "boss/warden_exposed", variants: 2, gain: 0.7, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.05, spatial: true, cooldownMs: 400, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 1.2 },
    synth: { kind: "shimmer", durMs: 800, freq: 1300, isRising: true },
  },

  // ---- miniboss captains: full boss grammar in miniature -----------------------------
  "marshal.lock": {
    stem: "mini/marshal_lock", variants: 1, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.enemyLock,
    jitter: 0, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "barrel", rate: 1.3 },
    synth: { kind: "tick", freq: 1700, count: 2, spreadMs: 70, isBright: false },
  },
  "marshal.recover": {
    stem: "mini/marshal_recover", variants: 2, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 0.55 },
    synth: { kind: "shimmer", durMs: 600, freq: 320, isRising: false },
  },
  "marshal.entrance": {
    stem: "mini/marshal_entrance", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.4, 0.3, 0.7)],
    fallback: { sample: "enemyDeath", rate: 0.5 },
    synth: { kind: "swell", durMs: 1000, fromHz: 70, toHz: 190, mode: "growl" },
  },
  "marshal.death": {
    stem: "mini/marshal_death", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.5, 1.0)],
    fallback: { sample: "enemyDeath", rate: 0.45 },
    synth: { kind: "impact", durMs: 1200, depthHz: 48 },
  },
  "toll.lock": {
    stem: "mini/toll_lock", variants: 1, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.enemyLock,
    jitter: 0, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "coin", rate: 0.5 },
    synth: { kind: "tick", freq: 1500, count: 1, spreadMs: 0, isBright: true },
  },
  "toll.recover": {
    stem: "mini/toll_recover", variants: 2, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 0.6 },
    synth: { kind: "shimmer", durMs: 700, freq: 420, isRising: false },
  },
  "toll.entrance": {
    stem: "mini/toll_entrance", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.4, 0.3, 0.7)],
    fallback: { sample: "floorClear", rate: 0.4 },
    synth: { kind: "swell", durMs: 1200, fromHz: 90, toHz: 260, mode: "voice" },
  },
  "toll.phase": {
    stem: "mini/toll_phase", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.35, 0.35, 0.8)],
    fallback: { sample: "floorClear", rate: 0.45 },
    synth: { kind: "swell", durMs: 1000, fromHz: 120, toHz: 340, mode: "voice" },
  },
  "toll.death": {
    stem: "mini/toll_death", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.5, 1.0)],
    fallback: { sample: "floorClear", rate: 0.45 },
    synth: { kind: "impact", durMs: 1400, depthHz: 45 },
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
  // Any transition INTO "recover" — the punish-window identity (a crash daze, the
  // Warden's exposed plate). Fires alongside release/impact where both are authored.
  readonly recover?: WaveEventId;
}

export const WAVE_TELLS: Readonly<Record<string, Readonly<Record<string, MoveTells>>>> = {
  // The Slime King (kind "boss"): the last legacy-only boss joins the wave manifest.
  boss: {
    hopslam: { windup: "king.hopWarn", lock: "king.hopLock", impact: "king.slam", recover: "king.recover" },
    radial: { windup: "king.radialWarn", release: "king.radialFire" },
    squeeze: { windup: "king.squeezeWarn" },
  },
  marrow: {
    rush: { windup: "marrow.listenStart", lock: "marrow.aimLock", active: "marrow.chargeStart" },
    crash: { impact: "marrow.wallImpact", recover: "marrow.recover" }, // the move flips to "crash" as the stun recover begins
    volley: { windup: "marrow.stompWindup", lock: "marrow.aimLock", release: "marrow.stompImpact" },
    spin: { windup: "marrow.stompWindup", active: "marrow.stompImpact" },
  },
  choir: {
    wail: { windup: "choir.strikeWarn", lock: "choir.strikeLock", release: "choir.strikeImpact" },
    fade: { windup: "choir.swellWarn", impact: "choir.swellFire", recover: "choir.recover" }, // impact = the rematerialize burst
  },
  weaver: {
    pounce: { windup: "weaver.blinkTell", active: "weaver.blinkDepart", impact: "weaver.blinkArriveStrike", recover: "weaver.recover" },
    weave: { windup: "weaver.latticeWarn", release: "weaver.latticeFire" },
  },
  gilded: {
    // The EXPOSED recover after each commitment is the fight's punish identity.
    slam: { windup: "warden.prisonWarn", lock: "warden.turretLock", impact: "warden.prisonClose", recover: "warden.exposed" },
    sweep: { windup: "warden.glyphWarn", active: "warden.turretFire", recover: "warden.exposed" },
  },
  skeleton: {
    lunge: { windup: "skeleton.commit" },
  },
  charger: {
    rush: { windup: "charger.windup", lock: "charger.lock", active: "charger.rush" },
    crash: { impact: "charger.crash", recover: "charger.dazed" },
  },
  burrower: {
    dive: { active: "burrower.submerge" },
    erupt: { windup: "burrower.lock", active: "burrower.erupt", recover: "burrower.recover" },
  },
  orbiter: {
    spit: { windup: "orbiter.diveWarn", lock: "orbiter.lock", release: "orbiter.fire" },
  },
  // The spitter's kite grammar rides the shared chitin caster bank until its own lands.
  spitter: {
    spit: { windup: "orbiter.diveWarn", lock: "seamcutter.lock", release: "orbiter.fire" },
  },
  shielder: {
    lunge: { windup: "shielder.raise", active: "shielder.bash" },
  },
  echojack: {
    decoy: { windup: "echojack.jangle" },
    blink: { impact: "echojack.blink" },
  },
  seamcutter: {
    seam: { windup: "seamcutter.preview", lock: "seamcutter.lock", active: "seamcutter.cut", impact: "seamcutter.stop", recover: "seamcutter.dazed" },
  },
  caskbellows: {
    volley: { windup: "caskbellows.crank", lock: "caskbellows.lock", active: "caskbellows.fire" },
    crash: { impact: "caskbellows.stagger" }, // the rear-crank stagger flips the move to crash
  },
  sinderling: {
    stoke: { windup: "sinderling.stoke" },
    rush: { active: "sinderling.jet" },
  },
  fragment: {
    harmonize: { windup: "fragment.harmonize" },
  },
  marshal: {
    sweep: { windup: "marshal.order", recover: "marshal.recover" },
    volley: { windup: "marshal.order", lock: "marshal.lock", recover: "marshal.recover" },
  },
  toll: {
    knell: { windup: "toll.ringWarn", release: "toll.ring", recover: "toll.recover" },
    volley: { windup: "toll.ringWarn", lock: "toll.lock", recover: "toll.recover" },
  },
};

export const WAVE_BOSS_PHASE: Readonly<Record<string, WaveEventId>> = {
  boss: "king.phase",
  marrow: "marrow.phase", choir: "choir.phase", weaver: "weaver.phase", gilded: "warden.phase",
  marshal: "marshal.shatter", toll: "toll.phase",
};

export const WAVE_BOSS_DEATH: Readonly<Record<string, WaveEventId>> = {
  boss: "king.death",
  marrow: "marrow.death", choir: "choir.death", weaver: "weaver.death", gilded: "warden.death",
  marshal: "marshal.death", toll: "toll.death",
};

// Bespoke entrance per boss-grade body (played at floor load / captain spawn).
export const WAVE_BOSS_ENTRANCE: Readonly<Record<string, WaveEventId>> = {
  boss: "king.entrance",
  marrow: "marrow.entrance", choir: "choir.entrance", weaver: "weaver.entrance", gilded: "gilded.entrance",
  marshal: "marshal.entrance", toll: "toll.entrance",
};

// Every event a boss kind can raise — its preload group (§10: preload the next boss).
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
  const phase = WAVE_BOSS_PHASE[kind];
  if (phase) out.push(phase);
  const death = WAVE_BOSS_DEATH[kind];
  if (death) out.push(death);
  const entrance = WAVE_BOSS_ENTRANCE[kind];
  if (entrance && out.indexOf(entrance) === -1) out.push(entrance);
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
  if (next.phase === "recover" && wasPhase !== "recover") {
    const cue = moves[next.move]?.recover;
    if (cue) out.push(cue);
  }
  return out;
}

// Whether a burrower-style underground tracking loop should be sounding for this state.
export function isTrackLoopHeld(kind: string, state: TellSnapshot): boolean {
  return kind === "burrower" && state.phase === "active" && state.move === "dive";
}
