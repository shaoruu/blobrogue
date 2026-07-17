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
  // Selection-driven take list (audio-gen selection manifest): the EXPLICIT file stems
  // this event may play, overriding the stem/variants naming derivation. Only selected
  // takes are ever referenced or preloaded — never "every generated file". An EMPTY
  // array is a registered hook awaiting selection: the event stays silent and its
  // emitter channel never schedules.
  readonly takes?: readonly string[];
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

// ---- audio-gen take selection (mirrors audio-gen-p0-components/selected_components.json) --
// The audio director's per-component selection: only these takes ship / are referenced.
// REJECTED takes (burrow dirt_grind_v1, pebble_v3, underground_thud_v1) and the
// superseded burrow_track/deep_loop files must never appear anywhere.
export const SELECTED_BURROW_TAKES = {
  dirtGrind: ["enemy/burrow_dirt_grind_v2"],
  pebble: ["enemy/burrow_pebble_v1", "enemy/burrow_pebble_v2"],
  shellScrape: ["enemy/burrow_shell_v1", "enemy/burrow_shell_v2"],
  thud: ["enemy/burrow_underground_thud_v2"],
} as const;

// Deep FINAL P0 selection (audio-gen-p0-deep-final/selected_deep_manifest.json — this
// closes P0 material selection, Burrow 6 + Deep 8; binaries ship after Ian's human
// spot-check). The r4 replacement takes are authoritative: the old
// `deep_architecture_shift_v1` take is retired and must never be referenced. The
// resin "creak" category is renamed resinStress — it is a sticky stress/release,
// not a beam creak. The continuous bed stays authored silence.
export const SELECTED_DEEP_TAKES = {
  resinStress: ["amb/deep_resin_creak_r4_v3"],
  mineralTick: ["amb/deep_mineral_tick_v1", "amb/deep_mineral_tick_v2"],
  architectureShift: ["amb/deep_architecture_shift_r4_v1", "amb/deep_architecture_shift_r4_v2"],
  resinDrip: ["amb/deep_resin_drip_r4_v1", "amb/deep_resin_drip_r4_v2", "amb/deep_resin_drip_r4_v3"],
} as const;

function pendingGiantSound(stem: string, priority: number = WAVE_PRIORITY.bossTell): WaveSoundSpec {
  return {
    stem,
    variants: 1,
    gain: 0.85,
    bus: "voiceTell",
    priority,
    jitter: 0,
    spatial: true,
    isOffCameraUncapped: true,
    cooldownMs: 120,
    isPerEntityCooldown: true,
  };
}

export const WAVE_SOUNDS = {
  "gorge.entrance": pendingGiantSound("boss/gorge_entrance"),
  "gorge.phase": pendingGiantSound("boss/gorge_phase"),
  "gorge.death": pendingGiantSound("boss/gorge_death"),
  "gorge.ringWarn": pendingGiantSound("boss/gorge_ring_warn"),
  "gorge.ring2Warn": pendingGiantSound("boss/gorge_ring2_warn", WAVE_PRIORITY.bossLock),
  "gorge.ringImpact": pendingGiantSound("boss/gorge_ring_impact"),
  "gorge.zoneWarn": pendingGiantSound("boss/gorge_zone_warn"),
  "gorge.zoneActive": pendingGiantSound("boss/gorge_zone_active"),
  "gorge.spokeWarn": pendingGiantSound("boss/gorge_spoke_warn"),
  "gorge.spokeActive": pendingGiantSound("boss/gorge_spoke_active"),
  "gorge.exposed": pendingGiantSound("boss/gorge_exposed"),
  "gorge.peel": pendingGiantSound("boss/gorge_peel"),
  "gorge.coreReveal": pendingGiantSound("boss/gorge_core_reveal"),
  "gorge.seamWarn": pendingGiantSound("boss/gorge_seam_warn"),
  "gorge.seamBreak": pendingGiantSound("boss/gorge_seam_break"),

  "pale.entrance": pendingGiantSound("boss/pale_entrance"),
  "pale.phase": pendingGiantSound("boss/pale_phase"),
  "pale.death": pendingGiantSound("boss/pale_death"),
  "pale.ringWarn": pendingGiantSound("boss/pale_ring_warn"),
  "pale.ring2Warn": pendingGiantSound("boss/pale_ring2_warn", WAVE_PRIORITY.bossLock),
  "pale.ringImpact": pendingGiantSound("boss/pale_ring_impact"),
  "pale.zoneWarn": pendingGiantSound("boss/pale_zone_warn"),
  "pale.zoneActive": pendingGiantSound("boss/pale_zone_active"),
  "pale.spokeWarn": pendingGiantSound("boss/pale_spoke_warn"),
  "pale.spokeActive": pendingGiantSound("boss/pale_spoke_active"),
  "pale.exposed": pendingGiantSound("boss/pale_exposed"),
  "pale.peel": pendingGiantSound("boss/pale_peel"),
  "pale.coreReveal": pendingGiantSound("boss/pale_core_reveal"),
  "pale.seamWarn": pendingGiantSound("boss/pale_seam_warn"),
  "pale.seamBreak": pendingGiantSound("boss/pale_seam_break"),
  "pale.warmthWarn": pendingGiantSound("boss/pale_warmth_warn"),
  "pale.warmthChill": pendingGiantSound("boss/pale_warmth_chill"),
  "pale.warmthClear": pendingGiantSound("boss/pale_warmth_clear"),

  // ---- CLAIMANT F70 — ALL THINGS OWED (batch claimant-owed-v1) -----------------------
  // Gilded debt / angular crown-lane / claim-token relay. CROWNFALL retired forever.
  "claimant.owedEntrance": {
    stem: "boss/claimant_owed_entrance", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.4, 0.9)],
    fallback: { sample: "bossSpawn", rate: 1.05 },
  },
  "claimant.owedPhase": {
    stem: "boss/claimant_owed_phase", variants: 1, gain: 0.92, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.35, 0.85)],
    fallback: { sample: "enemyAttack", rate: 0.9 },
  },
  "claimant.owedDeath": {
    stem: "boss/claimant_owed_death", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.2, 0.9, 1.3)],
    fallback: { sample: "enemyDeath", rate: 0.85 },
  },
  "claimant.owedTell": {
    stem: "boss/claimant_owed_tell", variants: 2, gain: 0.88, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.45, 0.25, 0.55)],
    fallback: { sample: "tesla", rate: 0.95, highpassHz: 800 },
  },
  "claimant.owedLock": {
    stem: "boss/claimant_owed_lock", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossLock,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.35, 0.12, 0.4)],
    fallback: { sample: "tesla", rate: 1.1, highpassHz: 1500 },
  },
  "claimant.owedDescent": {
    stem: "boss/claimant_owed_descent", variants: 2, gain: 0.95, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.4, 0.15, 0.5)],
    fallback: { sample: "cannon", rate: 1.05 },
  },
  "claimant.owedPunish": {
    stem: "boss/claimant_owed_punish", variants: 1, gain: 0.95, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 400, isPerEntityCooldown: true,
    duck: [dM(0.25, 0.35, 0.9)],
    fallback: { sample: "floorClear", rate: 0.95 },
  },
  "claimant.owedRecover": {
    stem: "boss/claimant_owed_recover", variants: 1, gain: 0.78, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    duck: [dM(0.55, 0.15, 0.4)],
    fallback: { sample: "enemyAttack", rate: 0.85 },
  },
  "claimant.owedFail": {
    stem: "boss/claimant_owed_fail", variants: 2, gain: 0.86, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true,
    duck: [dM(0.55, 0.12, 0.35)],
    fallback: { sample: "enemyAttack", rate: 1.05 },
  },
  "claimant.owedTokenPickup": {
    stem: "boss/claimant_owed_token_pickup", variants: 2, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.03, spatial: true, cooldownMs: 80, isPerEntityCooldown: true,
    fallback: { sample: "uiClick", rate: 1.05 },
  },
  "claimant.owedTokenPass": {
    stem: "boss/claimant_owed_token_pass", variants: 2, gain: 0.58, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.03, spatial: true, cooldownMs: 80, isPerEntityCooldown: true,
    fallback: { sample: "uiClick", rate: 0.95 },
  },
  "claimant.owedTokenDrop": {
    stem: "boss/claimant_owed_token_drop", variants: 1, gain: 0.48, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.03, spatial: true, cooldownMs: 80, isPerEntityCooldown: true,
    fallback: { sample: "meleeHit", rate: 0.95 },
  },
  "claimant.owedSocketLight": {
    stem: "boss/claimant_owed_socket_light", variants: 2, gain: 0.72, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 150, isPerEntityCooldown: true,
    duck: [dM(0.7, 0.1, 0.3)],
    fallback: { sample: "tesla", rate: 1.1, highpassHz: 1200 },
  },
  "claimant.owedDeposit": {
    stem: "boss/claimant_owed_deposit", variants: 2, gain: 0.8, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, cooldownMs: 120, isPerEntityCooldown: true,
    duck: [dM(0.55, 0.12, 0.4)],
    fallback: { sample: "parry", rate: 0.95 },
  },
  "claimant.owedGuardChip": {
    stem: "boss/claimant_owed_guard_chip", variants: 3, gain: 0.42, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.03, spatial: true, cooldownMs: 60, isPerEntityCooldown: true,
    fallback: { sample: "meleeHit", rate: 1.1 },
  },
  "claimant.owedOvercommit": {
    stem: "boss/claimant_owed_overcommit", variants: 1, gain: 0.84, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 400, isPerEntityCooldown: true,
    duck: [dM(0.5, 0.15, 0.45)],
    fallback: { sample: "shootShotgun", rate: 0.95 },
  },

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
    // Same-material (chitin) shipped fallback until the generated stem lands: the feint
    // reads as a dry, whispery split.
    fallback: { sample: "dash", rate: 1.15, highpassHz: 1200 },
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
  // per commitment, on the direction-lock edge. Takes are SELECTION-DRIVEN (see
  // SELECTED_BURROW_TAKES): ±3% jitter max, deterministic variants, no immediate repeat.
  "burrow.dirtGrind": {
    stem: null, takes: SELECTED_BURROW_TAKES.dirtGrind, variants: 1, gain: 0.22, bus: "sfx", priority: WAVE_PRIORITY.pet,
    jitter: 0.03, spatial: true,
  },
  "burrow.pebble": {
    stem: null, takes: SELECTED_BURROW_TAKES.pebble, variants: 2, gain: 0.14, bus: "sfx", priority: WAVE_PRIORITY.pet,
    jitter: 0.03, spatial: true,
  },
  "burrow.shellScrape": {
    stem: null, takes: SELECTED_BURROW_TAKES.shellScrape, variants: 2, gain: 0.18, bus: "sfx", priority: WAVE_PRIORITY.pet,
    jitter: 0.03, spatial: true,
  },
  "burrow.thud": {
    stem: null, takes: SELECTED_BURROW_TAKES.thud, variants: 1, gain: 0.28, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.03, spatial: true,
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

  // ---- the bestiary wave (generation stems queued; safe-band authored fallbacks carry each identity
  // ---- until the audio pipeline ships the files) --------------------------------------
  "echojack.jangle": {
    stem: "enemy/echojack_jangle", variants: 2, gain: 0.7, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "coin", rate: 0.85, highpassHz: 900 },
  },
  "echojack.blink": {
    stem: "enemy/echojack_blink", variants: 2, gain: 0.65, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 1.15 },
  },
  "seamcutter.preview": {
    stem: "enemy/seam_preview", variants: 2, gain: 0.75, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "tesla", rate: 0.85, lowpassHz: 2400 },
  },
  "seamcutter.lock": {
    stem: "enemy/seam_lock", variants: 1, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.enemyLock,
    jitter: 0, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.8, 0.05, 0.2)],
    fallback: { sample: "meleeHit", rate: 1.15, highpassHz: 1200 },
  },
  "seamcutter.cut": {
    stem: "enemy/seam_cut", variants: 2, gain: 0.8, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.85 },
  },
  "caskbellows.crank": {
    stem: "enemy/cask_crank", variants: 2, gain: 0.7, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 0.85 },
  },
  "caskbellows.stagger": {
    stem: "enemy/cask_stagger", variants: 1, gain: 0.8, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "barrel", rate: 0.85 },
  },
  "sinderling.stoke": {
    stem: "enemy/sinder_stoke", variants: 2, gain: 0.68, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "barrel", rate: 1.15 },
  },
  "sinderling.jet": {
    stem: "enemy/sinder_jet", variants: 2, gain: 0.75, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 1.15 },
  },
  "fragment.harmonize": {
    stem: "enemy/fragment_harmonize", variants: 2, gain: 0.72, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.03, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "tesla", rate: 0.85, highpassHz: 700 },
  },
  "marshal.order": {
    stem: "mini/marshal_order", variants: 2, gain: 0.8, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 0.85, lowpassHz: 1400 },
  },
  "marshal.shatter": {
    stem: "mini/marshal_shatter", variants: 1, gain: 0.9, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.5, 0.2, 0.5)],
    fallback: { sample: "barrel", rate: 0.85 },
  },
  "toll.ringWarn": {
    stem: "mini/toll_ring_warn", variants: 2, gain: 0.8, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 0.85, lowpassHz: 1200 },
  },
  "toll.ring": {
    stem: "mini/toll_ring", variants: 2, gain: 0.9, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.55, 0.15, 0.45)],
    fallback: { sample: "floorClear", rate: 0.85 },
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
  // Content-wave weapons (PR #97): each gets a bespoke fire cue with a safe base-sample
  // fallback (so a missing/streaming stem still sounds, per the authored-or-fallback contract).
  "shootCleaver": {
    stem: "sfx/cleaver_fire_v1", variants: 1, gain: 0.7, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true, fallback: { sample: "shootShotgun", rate: 0.85 },
  },
  "shootScrapper": {
    stem: "sfx/scrapper_fire_v1", variants: 1, gain: 0.5, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true, fallback: { sample: "smg", rate: 1.05 },
  },
  "shootSkipper": {
    stem: "sfx/skipper_fire_v1", variants: 1, gain: 0.72, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true, fallback: { sample: "shootShotgun", rate: 0.95 },
  },
  "shootArcbolt": {
    stem: "sfx/arcbolt_fire_v1", variants: 1, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true, fallback: { sample: "tesla", rate: 1.1 },
  },
  "shootCryobolt": {
    stem: "sfx/cryobolt_fire_v1", variants: 1, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true, fallback: { sample: "homing", rate: 1.15 },
  },
  "shootFirebomb": {
    stem: "sfx/firebomb_fire_v1", variants: 1, gain: 0.72, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true, duck: [dM(0.8, 0.06, 0.2)], fallback: { sample: "cannon", rate: 1.05, lowpassHz: 1200 },
  },
  "shootTracker": {
    stem: "sfx/tracker_fire_v1", variants: 1, gain: 0.62, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true, fallback: { sample: "homing", rate: 1.0 },
  },
  "shootSingularity": {
    stem: "sfx/singularity_fire_v1", variants: 1, gain: 0.78, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.04, spatial: true, duck: [dM(0.75, 0.08, 0.25)], fallback: { sample: "cannon", rate: 0.85, lowpassHz: 900 },
  },
  "shootMooringNail": {
    stem: "sfx/mooring_nail_fire", variants: 1, takes: [], gain: 0.7, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "shootSluicegate": {
    stem: "sfx/sluicegate_fire", variants: 1, takes: [], gain: 0.7, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "shootOddsmaker": {
    stem: "sfx/oddsmaker_fire", variants: 1, takes: [], gain: 0.7, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "shootPathmaker": {
    stem: "sfx/pathmaker_fire", variants: 1, takes: [], gain: 0.55, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "shootResonantFork": {
    stem: "sfx/resonant_fork_fire", variants: 1, takes: [], gain: 0.65, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "shootRedPen": {
    stem: "sfx/red_pen_fire", variants: 1, takes: [], gain: 0.6, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "shootMarginCall": {
    stem: "sfx/margin_call_fire", variants: 1, takes: [], gain: 0.7, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "shootSidewinder": {
    stem: "sfx/sidewinder_fire", variants: 1, takes: [], gain: 0.6, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "shootHushiron": {
    stem: "sfx/hushiron_fire", variants: 1, takes: [], gain: 0.62, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "shootBacktalk": {
    stem: "sfx/backtalk_fire", variants: 1, takes: [], gain: 0.6, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "shootLamplighter": {
    stem: "sfx/lamplighter_fire", variants: 1, takes: [], gain: 0.58, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "shootFaultlink": {
    stem: "sfx/faultlink_fire", variants: 1, takes: [], gain: 0.66, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "backtalk.parry": {
    stem: "sfx/backtalk_parry", variants: 1, takes: [], gain: 0.72, bus: "sfx",
    priority: WAVE_PRIORITY.impact, jitter: 0, spatial: true,
  },
  "backtalk.return": {
    stem: "sfx/backtalk_return", variants: 1, takes: [], gain: 0.7, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "lamplighter.patch": {
    stem: "sfx/lamplighter_patch", variants: 1, takes: [], gain: 0.5, bus: "sfx",
    priority: WAVE_PRIORITY.impact, jitter: 0, spatial: true,
  },
  "faultlink.link": {
    stem: "sfx/faultlink_link", variants: 1, takes: [], gain: 0.55, bus: "sfx",
    priority: WAVE_PRIORITY.impact, jitter: 0, spatial: true,
  },
  "red_pen.snap": {
    stem: "sfx/red_pen_snap", variants: 1, takes: [], gain: 0.75, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "resonant_fork.link": {
    stem: "sfx/resonant_fork_link", variants: 1, takes: [], gain: 0.5, bus: "sfx",
    priority: WAVE_PRIORITY.impact, jitter: 0, spatial: true,
  },
  "blessing.crosscurrent": {
    stem: "sfx/blessing_crosscurrent", variants: 1, takes: [], gain: 0.4, bus: "sfx",
    priority: WAVE_PRIORITY.impact, jitter: 0, spatial: true,
  },
  "blessing.warmRound": {
    stem: "sfx/blessing_warm_round", variants: 1, takes: [], gain: 0.4, bus: "sfx",
    priority: WAVE_PRIORITY.impact, jitter: 0, spatial: true,
  },
  "blessing.knownByTouch": {
    stem: "sfx/blessing_known_by_touch", variants: 1, takes: [], gain: 0.35, bus: "sfx",
    priority: WAVE_PRIORITY.impact, jitter: 0, spatial: true,
  },
  "blessing.rememberMe": {
    stem: "sfx/blessing_remember_me", variants: 1, takes: [], gain: 0.5, bus: "sfx",
    priority: WAVE_PRIORITY.impact, jitter: 0, spatial: true,
  },
  "blessing.carryTheLight": {
    stem: "sfx/blessing_carry_the_light", variants: 1, takes: [], gain: 0.4, bus: "sfx",
    priority: WAVE_PRIORITY.impact, jitter: 0, spatial: true,
  },
  "oddsmaker.ricochet": {
    stem: "sfx/oddsmaker_ricochet", variants: 1, takes: [], gain: 0.7, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "oddsmaker.seeker": {
    stem: "sfx/oddsmaker_seeker", variants: 1, takes: [], gain: 0.7, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "oddsmaker.blast": {
    stem: "sfx/oddsmaker_blast", variants: 1, takes: [], gain: 0.75, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "oddsmaker.pierce": {
    stem: "sfx/oddsmaker_pierce", variants: 1, takes: [], gain: 0.7, bus: "sfx",
    priority: WAVE_PRIORITY.weapon, jitter: 0, spatial: true,
  },
  "blessing.holdFast": {
    stem: "sfx/blessing_hold_fast", variants: 1, takes: [], gain: 0.35, bus: "sfx",
    priority: WAVE_PRIORITY.impact, jitter: 0, spatial: true,
  },
  "blessing.nothingWasted": {
    stem: "sfx/blessing_nothing_wasted", variants: 1, takes: [], gain: 0.4, bus: "sfx",
    priority: WAVE_PRIORITY.impact, jitter: 0, spatial: true,
  },
  "blessing.muddy": {
    stem: "sfx/blessing_muddy", variants: 1, takes: [], gain: 0.35, bus: "sfx",
    priority: WAVE_PRIORITY.impact, jitter: 0, spatial: true,
  },
  "blessing.onBeat": {
    stem: "sfx/blessing_on_beat", variants: 1, takes: [], gain: 0.35, bus: "sfx",
    priority: WAVE_PRIORITY.impact, jitter: 0, spatial: true,
  },
  "blessing.sharedRope": {
    stem: "sfx/blessing_shared_rope", variants: 1, takes: [], gain: 0.4, bus: "sfx",
    priority: WAVE_PRIORITY.impact, jitter: 0, spatial: true,
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
    fallback: { sample: "enemyHit", rate: 1.15, highpassHz: 900 }, // contract band: <= 1.4
  },
  // The held-loop stem is the authored voice for the lance; until it ships the loop is
  // silent (loops are authored-file-or-silence), which left the Sunlance mute. beamFire is
  // the audible interim: a per-shot sizzle DERIVED from the shipped tesla bank, throttled by
  // the director (see beamShot) so 22Hz fire reads as one lance, and suppressed the instant
  // the real loop sounds. Positional, so a teammate's lance is heard where it fires.
  "beamFire": {
    stem: "sfx/sunlance_fire", variants: 1, gain: 0.3, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true,
    fallback: { sample: "tesla", rate: 1.1 },
  },

  // ---- §4b the effect wave: SEMANTIC WEAPON AUDIO HOOKS -------------------------------
  // The weapon audio integration contract. Resolution is authored stem -> shipped-sample
  // DERIVE fallback -> SILENCE — the synth lane is GONE engine-wide (#45 de-synthesis), so
  // "no oscillator, ever" holds by construction for every row here. Jitter <= 0.05 so the
  // authored take never repitches past +-5%; DERIVE rates stay inside [0.7, 1.4].
  // Multi-stage mechanics carry >= 3 semantic cues; every continuous mechanic is start +
  // ONE keyed loop + stop (never a per-tick retrigger); tier releases are DISTINCT STEMS,
  // never pitch tiers. WEAPON_AUDIO below binds semantic states to these rows — the client
  // triggers states, never file names.

  // Shared universal cue: the effect wave's equip foley (per-weapon stems can replace
  // this by remapping WEAPON_AUDIO once authored takes land).
  "weapon.equip": {
    stem: "sfx/weapon_equip", variants: 2, gain: 0.45, bus: "sfx", priority: WAVE_PRIORITY.ui,
    jitter: 0.05, cooldownMs: 150,
    fallback: { sample: "weapon", rate: 1.1 },
  },

  // Lastlight (risk: danger / payoff / recovery + the release).
  "shootLastlight": {
    stem: "sfx/lastlight_fire", variants: 3, gain: 0.85, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true,
    duck: [dM(0.8, 0.06, 0.2)],
    fallback: { sample: "cannon", rate: 1.15, highpassHz: 300 }, // sharp desperate crack
  },
  "lastlight.empowered": {
    stem: "sfx/lastlight_empowered", variants: 2, gain: 0.95, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.04, spatial: true,
    duck: [dM(0.7, 0.08, 0.25)],
    fallback: { sample: "cannon", rate: 0.9, highpassHz: 200 }, // a DISTINCT heavier take, not a pitch tier
  },
  "lastlight.surge": {
    stem: "sfx/lastlight_surge", variants: 1, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.03, cooldownMs: 800,
    fallback: { sample: "crit", rate: 0.85 }, // the danger band opens
  },
  "lastlight.settle": {
    stem: "sfx/lastlight_settle", variants: 1, gain: 0.45, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.03, cooldownMs: 800,
    fallback: { sample: "heart", rate: 0.95 }, // recovery: the band closes
  },

  // Breach (charge: prime / hold loop / threshold / full lock / TWO release stems /
  // travel / impact / vent-cancel — 9 semantic cues).
  "breach.chargeStart": {
    stem: "sfx/breach_charge_start", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.04, cooldownMs: 120,
    fallback: { sample: "chest", rate: 1.15, highpassHz: 500 }, // breech opens, spring compresses
  },
  "breach.chargeLoop": {
    stem: "sfx/breach_charge_loop", variants: 1, gain: 0.4, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0, loop: true,
  },
  "breach.threshold": {
    stem: "sfx/breach_threshold", variants: 1, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.03, cooldownMs: 200,
    fallback: { sample: "coin", rate: 0.85, lowpassHz: 3000 }, // the half-charge detent clicks past
  },
  "breach.fullLock": {
    stem: "sfx/breach_lock", variants: 1, gain: 0.7, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.03, cooldownMs: 200,
    fallback: { sample: "parry", rate: 1.15, highpassHz: 900 }, // the full-charge sear locks
  },
  "shootBreach": {
    stem: "sfx/breach_fire", variants: 3, gain: 0.85, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true,
    duck: [dM(0.8, 0.06, 0.2)],
    fallback: { sample: "cannon", rate: 0.95, lowpassHz: 1300 }, // the short-lob release
  },
  "breach.releaseFull": {
    stem: "sfx/breach_release_full", variants: 2, gain: 0.95, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.04, spatial: true,
    duck: [dM(0.75, 0.08, 0.25)],
    fallback: { sample: "shootShotgun", rate: 0.85, lowpassHz: 1600 }, // a DISTINCT full-charge take
  },
  "breach.travel": {
    stem: "sfx/breach_travel", variants: 2, gain: 0.4, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 150,
    fallback: { sample: "dash", rate: 0.85, lowpassHz: 2500 }, // the shell's falling whistle
  },
  "breach.impact": {
    stem: "sfx/breach_impact", variants: 3, gain: 0.9, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true,
    duck: [dM(0.75, 0.08, 0.3)],
    fallback: { sample: "barrel", rate: 0.85 },
  },
  "breach.vent": {
    stem: "sfx/breach_vent", variants: 1, gain: 0.5, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.04, cooldownMs: 150,
    fallback: { sample: "dash", rate: 0.85, highpassHz: 1200 }, // the canceled charge hisses out
  },

  // Snapwire (trap: place / arm / trigger / expire + the refused-plant fail).
  "wirePlant": {
    stem: "sfx/snapwire_plant", variants: 2, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true,
    fallback: { sample: "parry", rate: 1.15, highpassHz: 1500 }, // taut string pluck
  },
  "wire.armed": {
    stem: "sfx/snapwire_armed", variants: 1, gain: 0.5, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.03, spatial: true, cooldownMs: 120,
    fallback: { sample: "coin", rate: 1.15, highpassHz: 1800 }, // the wire goes live
  },
  "wireSnap": {
    stem: "sfx/snapwire_snap", variants: 3, gain: 0.85, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 120,
    duck: [dM(0.75, 0.08, 0.3)],
    fallback: { sample: "parry", rate: 0.85 }, // heavy cable release
  },
  "wire.expire": {
    stem: "sfx/snapwire_expire", variants: 1, gain: 0.35, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.04, spatial: true, cooldownMs: 200,
    fallback: { sample: "parry", rate: 0.9, lowpassHz: 2200 }, // tension slackens, unspent
  },
  "wire.refuse": {
    stem: "sfx/snapwire_refuse", variants: 1, gain: 0.4, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.03, cooldownMs: 200,
    fallback: { sample: "uiClick", rate: 0.85 }, // no anchor here (fail state)
  },

  // Frostline release (its status voice is the SHARED status library below).
  "shootFrostline": {
    stem: "sfx/frostline_fire", variants: 3, gain: 0.5, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true,
    fallback: { sample: "shootRapid", rate: 1.15, highpassHz: 1200 }, // glassy chip
  },

  // Razor Halo (orbital: ONE mixed owner loop — never per blade — + pass / hit / catch
  // and the flare active).
  "halo.loop": {
    stem: "sfx/halo_loop", variants: 1, gain: 0.3, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0, loop: true,
  },
  "halo.pass": {
    stem: "sfx/halo_pass", variants: 2, gain: 0.25, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, cooldownMs: 250,
    fallback: { sample: "meleeSwing", rate: 1.15, highpassHz: 1800 }, // one blade sweeping by
  },
  "halo.hit": {
    stem: "sfx/halo_hit", variants: 3, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 120, isPerEntityCooldown: true,
    fallback: { sample: "meleeHit", rate: 1.15, highpassHz: 700 },
  },
  "haloFlare": {
    stem: "sfx/halo_flare", variants: 2, gain: 0.7, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true, cooldownMs: 150,
    fallback: { sample: "meleeSwing", rate: 1.15, highpassHz: 800 }, // ring of steel widening
  },
  "halo.catch": {
    stem: "sfx/halo_catch", variants: 2, gain: 0.7, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 150,
    fallback: { sample: "meleeHit", rate: 0.85 }, // the flared ring connects
  },

  // Prism Sentry (deployable: place / unfold / acquire / fire / damaged / destroyed /
  // timeout — 7 semantic cues).
  "sentryPlace": {
    stem: "sfx/sentry_place", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true,
    fallback: { sample: "chest", rate: 1.15, highpassHz: 400 }, // crystalline mount click
  },
  "sentry.unfold": {
    stem: "sfx/sentry_unfold", variants: 1, gain: 0.5, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.04, spatial: true, cooldownMs: 150,
    fallback: { sample: "blessing", rate: 1.15, highpassHz: 600 }, // the prism opens
  },
  "sentry.acquire": {
    stem: "sfx/sentry_acquire", variants: 1, gain: 0.45, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.03, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "coin", rate: 1.15, highpassHz: 1400 }, // target lock chirp
  },
  "sentryShot": {
    stem: "sfx/sentry_fire", variants: 3, gain: 0.45, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true, cooldownMs: 120, isPerEntityCooldown: true,
    fallback: { sample: "homing", rate: 1.15, highpassHz: 600 },
  },
  "sentry.damaged": {
    stem: "sfx/sentry_damaged", variants: 2, gain: 0.5, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 150,
    fallback: { sample: "enemyHit", rate: 1.15, highpassHz: 900 }, // glass chips off the core
  },
  "sentryDown": {
    stem: "sfx/sentry_down", variants: 1, gain: 0.75, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 200,
    fallback: { sample: "parry", rate: 0.85, lowpassHz: 3000 }, // shattering prism
  },
  "sentry.timeout": {
    stem: "sfx/sentry_timeout", variants: 1, gain: 0.45, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.04, spatial: true, cooldownMs: 200,
    fallback: { sample: "blessing", rate: 0.85 }, // powers down, unbroken
  },

  // Crooked Chain (tether: lash-latch / pull loop / hold / sweep + the inverted-drag
  // danger and the whiffed-lash fail).
  "tetherLatch": {
    stem: "sfx/chain_latch", variants: 3, gain: 0.7, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, spatial: true, cooldownMs: 150,
    fallback: { sample: "ricochet", rate: 0.85, lowpassHz: 4000 }, // hook bite + link rattle
  },
  "crook.pullLoop": {
    stem: "sfx/chain_pull_loop", variants: 1, gain: 0.35, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0, loop: true,
  },
  "crook.hold": {
    stem: "sfx/chain_hold", variants: 1, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.04, spatial: true, cooldownMs: 150,
    fallback: { sample: "chest", rate: 0.9, lowpassHz: 2500 }, // the chain snaps taut
  },
  "tetherSweep": {
    stem: "sfx/chain_sweep", variants: 2, gain: 0.85, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 150,
    duck: [dM(0.8, 0.08, 0.25)],
    fallback: { sample: "heavySwing", rate: 1.1 },
  },
  "crook.dragged": {
    stem: "sfx/chain_dragged", variants: 1, gain: 0.8, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.04, spatial: true, cooldownMs: 300,
    duck: [dM(0.7, 0.1, 0.3)],
    fallback: { sample: "enemyAttack", rate: 0.85, lowpassHz: 1800 }, // YOU are the one reeled in
  },
  "crook.whiff": {
    stem: "sfx/chain_whiff", variants: 2, gain: 0.4, bus: "sfx", priority: WAVE_PRIORITY.weapon,
    jitter: 0.05, cooldownMs: 150,
    fallback: { sample: "meleeSwing", rate: 0.85, lowpassHz: 3500 }, // the lash bites nothing
  },

  // ---- §4c the SHARED status library (apply/break; DoT ticks stay silent) -------------
  "status.chillApply": {
    stem: "status/chill_apply", variants: 2, gain: 0.4, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 250, isPerEntityCooldown: true,
    fallback: { sample: "coin", rate: 0.85, highpassHz: 1600 }, // frost takes hold
  },
  "status.freeze": {
    stem: "status/freeze_solid", variants: 2, gain: 0.65, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.04, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "parry", rate: 1.15, highpassHz: 1200 }, // solid ice locks
  },
  "status.freezeBreak": {
    stem: "status/freeze_break", variants: 2, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyDeath", rate: 1.15, highpassHz: 1500 }, // the shell shatters
  },
  "status.burnApply": {
    stem: "status/burn_apply", variants: 2, gain: 0.4, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 400, isPerEntityCooldown: true,
    fallback: { sample: "barrel", rate: 1.15, highpassHz: 900 }, // ignition catch (ticks stay silent)
  },
  "status.shockApply": {
    stem: "status/shock_apply", variants: 2, gain: 0.4, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 400, isPerEntityCooldown: true,
    fallback: { sample: "tesla", rate: 1.15, highpassHz: 1200 }, // static takes hold
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
  // The Deep's sparse positional ambience (audio director FINAL + P0 selection): per-
  // channel scheduled authored one-shots, near-silent by design — cadence, weights and
  // gain ranges live in DEEP_EMITTER below. Row gain = the channel's max gain (the
  // emitter scales each play down into its authored range deterministically).
  "deep.resinStress": {
    stem: null, takes: SELECTED_DEEP_TAKES.resinStress, variants: 1, gain: 0.12, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0.02, spatial: true, // the stress/release take carries the ±2% lane
  },
  "deep.mineralTick": {
    stem: null, takes: SELECTED_DEEP_TAKES.mineralTick, variants: 2, gain: 0.11, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, spatial: true,
  },
  "deep.architectureShift": {
    stem: null, takes: SELECTED_DEEP_TAKES.architectureShift, variants: 2, gain: 0.13, bus: "ambient", priority: WAVE_PRIORITY.ambient,
    jitter: 0, spatial: true,
  },
  "deep.resinDrip": {
    stem: null, takes: SELECTED_DEEP_TAKES.resinDrip, variants: 3, gain: 0.1, bus: "ambient", priority: WAVE_PRIORITY.ambient,
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
  // Companion-dog voice (the RESCUED doggie/pack — distinct from the combat pet.* rows).
  // Warm, low-gain, heavily-varied + cooldown'd so it never grates (audio-director contract).
  "dog.bark": {
    stem: "pet/dog_bark", variants: 4, gain: 0.4, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05, spatial: true, cooldownMs: 2500,
  },
  "dog.pant": {
    stem: "pet/dog_pant", variants: 3, gain: 0.22, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05, spatial: true, cooldownMs: 6000,
  },
  "dog.trot": {
    stem: "pet/dog_trot", variants: 2, gain: 0.14, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.04, spatial: true, loop: true,
  },
  "dog.settle": {
    stem: "pet/dog_settle", variants: 2, gain: 0.3, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05, spatial: true, cooldownMs: 8000,
  },
  "dog.happy": {
    stem: "pet/dog_happy", variants: 3, gain: 0.4, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05, spatial: true, cooldownMs: 1500,
  },
  // The cat / baby dragon / baby slime each get a small species voice on the pet bus, same
  // move-cue + settle-cue shape as the doggie (cooldowns own the anti-annoyance cadence).
  "cat.move": {
    stem: "pet/cat_meow", variants: 2, gain: 0.3, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05, spatial: true, cooldownMs: 6500,
  },
  "cat.settle": {
    stem: "pet/cat_purr", variants: 1, gain: 0.26, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05, spatial: true, cooldownMs: 8000,
  },
  "dragon.move": {
    stem: "pet/dragon_chirp", variants: 2, gain: 0.3, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05, spatial: true, cooldownMs: 6500,
  },
  "dragon.settle": {
    stem: "pet/dragon_rumble", variants: 1, gain: 0.28, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05, spatial: true, cooldownMs: 8000,
  },
  "slimepet.move": {
    stem: "pet/slime_squish", variants: 2, gain: 0.26, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05, spatial: true, cooldownMs: 5500,
  },
  "slimepet.settle": {
    stem: "pet/slime_plop", variants: 1, gain: 0.26, bus: "pet", priority: WAVE_PRIORITY.pet,
    jitter: 0.05, spatial: true, cooldownMs: 8000,
  },
  // Amber Camp UI cues (menu-triggered, non-positional, ui bus). Warm amber materials, not
  // combat sounds. A camp purchase/denied/panel-open gets a voice so the meta loop reads.
  "camp.purchase": {
    stem: "meta/camp_purchase", variants: 2, gain: 0.6, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0.03, fallback: { sample: "coin", rate: 0.9 },
  },
  "camp.denied": {
    stem: "meta/camp_denied", variants: 1, gain: 0.4, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0, fallback: { sample: "uiClick", rate: 0.9 },
  },
  "camp.shopOpen": {
    stem: "meta/camp_shop_open", variants: 2, gain: 0.45, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0.03, fallback: { sample: "uiClick", rate: 1.0 },
  },
  "camp.shopClose": {
    stem: "meta/camp_shop_close", variants: 1, gain: 0.35, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0, fallback: { sample: "uiClick", rate: 0.85 },
  },
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
  "expedition.bandEntry": {
    stem: "ui/expedition_band_entry", variants: 1, gain: 0.72, bus: "ui", priority: WAVE_PRIORITY.ui,
    jitter: 0,
    duck: [dM(0.65, 0.25, 0.7), dA(0.55, 0.4, 0.5)],
    fallback: { sample: "floorClear", rate: 0.9 },
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

  // ---- bestiary audio hook contract (see src/game/bestiaryAudio.ts) -----------------
  // Behavior verb teaches counterplay, body material identifies the species, tier adds
  // an authored layer. Every row ships a SAME-MATERIAL sample fallback (no oscillator
  // identities, no extreme rates) until its generated stem lands.
  "slime.move": {
    stem: "mob/slime_move", variants: 3, gain: 0.3, bus: "sfx", priority: WAVE_PRIORITY.ambient,
    jitter: 0.05, spatial: true, cooldownMs: 260, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 1.15, lowpassHz: 900 },
  },
  "slime.commit": {
    stem: "mob/slime_commit", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 1.15 },
  },
  "skeleton.move": {
    stem: "mob/skeleton_move", variants: 3, gain: 0.3, bus: "sfx", priority: WAVE_PRIORITY.ambient,
    jitter: 0.05, spatial: true, cooldownMs: 280, isPerEntityCooldown: true,
    fallback: { sample: "meleeHit", rate: 1.15, highpassHz: 1200 },
  },
  "skeleton.commit": {
    stem: "mob/skeleton_commit", variants: 2, gain: 0.7, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 0.9 },
  },
  // The flock is ONE aggregate bed (a single group-keyed loop, gain scales with count).
  "flock.bed": {
    stem: "mob/flock_bed", variants: 1, gain: 0.4, bus: "sfx", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true, spatial: false,
  },
  "flock.pass": {
    stem: "mob/flock_pass", variants: 3, gain: 0.5, bus: "sfx", priority: WAVE_PRIORITY.ambient,
    jitter: 0.05, spatial: true, cooldownMs: 700, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 1.15 },
  },
  "flock.surge": {
    stem: "mob/flock_surge", variants: 2, gain: 0.65, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 400, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.9 },
  },
  // The commander's pack beats (any chassis: the rally IS the flock's one commit).
  "elite.rally": {
    stem: "mob/elite_rally", variants: 2, gain: 0.75, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 0.85 },
  },
  "elite.panic": {
    stem: "mob/elite_panic", variants: 2, gain: 0.7, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 300,
    fallback: { sample: "enemyDeath", rate: 1.15 },
  },
  "charger.rush": {
    stem: "enemy/charger_rush", variants: 2, gain: 0.8, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.85 },
  },
  "charger.dazed": {
    stem: "enemy/charger_dazed", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "enemyDeath", rate: 0.85 },
  },
  "burrower.recover": {
    stem: "enemy/burrow_recover", variants: 2, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 250, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.85, lowpassHz: 1400 },
  },
  // ONE orbit hum for the whole ring, group-keyed like the flock bed.
  "orbit.loop": {
    stem: "mob/orbit_loop", variants: 1, gain: 0.32, bus: "sfx", priority: WAVE_PRIORITY.ambient,
    jitter: 0, loop: true, spatial: false,
  },
  "orbiter.lock": {
    stem: "enemy/orbiter_lock", variants: 1, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.enemyLock,
    jitter: 0, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "uiClick", rate: 1.15 },
  },
  "orbiter.fire": {
    stem: "enemy/orbiter_fire", variants: 2, gain: 0.65, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 150, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 1.15 },
  },
  "shielder.bash": {
    stem: "enemy/shield_bash", variants: 2, gain: 0.75, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "meleeHit", rate: 0.85 },
  },
  "guard.break": {
    stem: "mob/guard_break", variants: 1, gain: 0.85, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "barrel", rate: 0.85 },
  },
  "shielder.rearHurt": {
    stem: "enemy/shield_rear_hurt", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 220, isPerEntityCooldown: true,
    fallback: { sample: "meleeHit", rate: 1.15 },
  },
  "root.raise": {
    stem: "mob/root_raise", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 400, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 0.85 },
  },
  "root.block": {
    stem: "mob/root_block", variants: 3, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 150,
    fallback: { sample: "barrel", rate: 1.1 },
  },
  "root.divider": {
    stem: "mob/root_divider", variants: 2, gain: 0.75, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 400, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 0.85 },
  },
  "keel.berm": {
    stem: "mob/keel_berm", variants: 2, gain: 0.65, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 400, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.85, lowpassHz: 1100 },
  },
  "mason.survey": {
    stem: "mob/mason_survey", variants: 2, gain: 0.6, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "meleeHit", rate: 0.85 },
  },
  "mason.raise": {
    stem: "mob/mason_raise", variants: 2, gain: 0.75, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 400, isPerEntityCooldown: true,
    fallback: { sample: "cannon", rate: 1.1 },
  },
  "plate.block": {
    stem: "mob/plate_block", variants: 3, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 150,
    fallback: { sample: "meleeHit", rate: 1.15 },
  },
  "anchor.place": {
    stem: "enemy/cask_place", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 400, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 0.85 },
  },
  "caskbellows.lock": {
    stem: "enemy/cask_lock", variants: 1, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.enemyLock,
    jitter: 0, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "coin", rate: 0.85 },
  },
  "caskbellows.fire": {
    stem: "enemy/cask_fire", variants: 2, gain: 0.7, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 120, isPerEntityCooldown: true,
    fallback: { sample: "cannon", rate: 1.15 },
  },
  "seamcutter.stop": {
    stem: "enemy/seam_stop", variants: 2, gain: 0.75, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 250, isPerEntityCooldown: true,
    fallback: { sample: "meleeHit", rate: 0.85 },
  },
  "seamcutter.dazed": {
    stem: "enemy/seam_dazed", variants: 2, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "tesla", rate: 0.85 },
  },
  "sinderling.burst": {
    stem: "enemy/sinder_burst", variants: 2, gain: 0.8, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 200,
    fallback: { sample: "barrel", rate: 1.0 },
  },
  "fragment.pulse": {
    stem: "enemy/fragment_pulse", variants: 2, gain: 0.7, bus: "sfx", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.03, spatial: true, cooldownMs: 250, isPerEntityCooldown: true,
    fallback: { sample: "tesla", rate: 0.85 },
  },
  "knell.fuse": {
    stem: "mob/knell_fuse", variants: 2, gain: 0.6, bus: "voiceTell", priority: WAVE_PRIORITY.enemyTell,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "uiClick", rate: 0.85 },
  },
  // Rate-limited generic hurt/death (the contract's hurt/death semantic events); the
  // per-material death banks are a generation backlog — these carry the limit today.
  "mob.hurt": {
    stem: "mob/hurt", variants: 3, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 90,
    fallback: { sample: "enemyHit" },
  },
  "mob.death": {
    stem: "mob/death", variants: 3, gain: 0.7, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 120,
    fallback: { sample: "enemyDeath" },
  },
  // Authored tier LAYERS (played alongside the material death — never a pitch-down, so
  // the fallbacks carry NO rate transform).
  "tier.bruteBody": {
    stem: "mob/tier_brute_body", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 150,
    fallback: { sample: "cannon" },
  },
  "tier.eliteSheen": {
    stem: "mob/tier_elite_sheen", variants: 2, gain: 0.5, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 150,
    fallback: { sample: "coin" },
  },

  // ---- the Slime King joins the wave manifest (windup/lock/impact/recover + bespoke
  // ---- entrance/phase/special/death — it was the last legacy-only boss) --------------
  "king.entrance": {
    stem: "boss/king_entrance", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.4, 0.9)],
    fallback: { sample: "bossSpawn", rate: 0.9 },
  },
  "king.hopWarn": {
    stem: "boss/king_hop_warn", variants: 2, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 0.85 },
  },
  "king.hopLock": {
    stem: "boss/king_hop_lock", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossLock,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    duck: [dM(0.35, 0.15, 0.45)],
    fallback: { sample: "enemyHit", rate: 1.15 },
  },
  "king.slam": {
    stem: "boss/king_slam", variants: 2, gain: 1.0, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true,
    duck: [dM(0.5, 0.15, 0.5)],
    fallback: { sample: "enemyDeath", rate: 0.85 },
  },
  "king.radialWarn": {
    stem: "boss/king_radial_warn", variants: 2, gain: 0.82, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 0.85 },
  },
  "king.radialFire": {
    stem: "boss/king_radial_fire", variants: 2, gain: 0.9, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "enemyHit", rate: 0.85 },
  },
  "king.squeezeWarn": {
    stem: "boss/king_squeeze_warn", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.35, 0.8)],
    fallback: { sample: "enemyAttack", rate: 0.85 },
  },
  "king.recover": {
    stem: "boss/king_recover", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "enemyDeath", rate: 0.9 },
  },
  "king.phase": {
    stem: "boss/king_phase", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.35, 0.8)],
    fallback: { sample: "bossSpawn", rate: 0.85 },
  },
  "king.death": {
    stem: "boss/king_death", variants: 1, gain: 1.0, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.25, 0.8, 1.2)],
    fallback: { sample: "enemyDeath", rate: 0.85 },
  },

  // ---- bespoke entrances + punish-recover beats for the deep bosses ------------------
  "marrow.entrance": {
    stem: "boss/marrow_entrance", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.4, 0.9)],
    fallback: { sample: "bossSpawn", rate: 0.85 },
  },
  "marrow.recover": {
    stem: "boss/marrow_recover", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "enemyDeath", rate: 0.85 },
  },
  "choir.entrance": {
    stem: "boss/choir_entrance", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.4, 0.9)],
    fallback: { sample: "bossSpawn", rate: 1.1, highpassHz: 400 },
  },
  "choir.recover": {
    stem: "boss/choir_recover", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "enemyAttack", rate: 0.85, highpassHz: 500 },
  },
  "weaver.entrance": {
    stem: "boss/weaver_entrance", variants: 1, gain: 0.92, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.4, 0.9)],
    fallback: { sample: "bossSpawn", rate: 1.15 },
  },
  "weaver.recover": {
    stem: "boss/weaver_recover", variants: 2, gain: 0.6, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "dash", rate: 0.85 },
  },
  "gilded.entrance": {
    stem: "boss/gilded_entrance", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.4, 0.9)],
    fallback: { sample: "bossSpawn", rate: 0.85, lowpassHz: 2600 },
  },
  // The Warden's EXPOSED window: the plate hangs open — the punish-window identity cue.
  "warden.exposed": {
    stem: "boss/warden_exposed", variants: 2, gain: 0.7, bus: "sfx", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.05, spatial: true, cooldownMs: 400, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 1.15 },
  },

  // ---- miniboss captains: full boss grammar in miniature -----------------------------
  "marshal.lock": {
    stem: "mini/marshal_lock", variants: 1, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.enemyLock,
    jitter: 0, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "barrel", rate: 1.15 },
  },
  "marshal.recover": {
    stem: "mini/marshal_recover", variants: 2, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 0.85 },
  },
  "marshal.entrance": {
    stem: "mini/marshal_entrance", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.4, 0.3, 0.7)],
    fallback: { sample: "enemyDeath", rate: 0.85 },
  },
  "marshal.death": {
    stem: "mini/marshal_death", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.5, 1.0)],
    fallback: { sample: "enemyDeath", rate: 0.85 },
  },
  "toll.lock": {
    stem: "mini/toll_lock", variants: 1, gain: 0.85, bus: "voiceTell", priority: WAVE_PRIORITY.enemyLock,
    jitter: 0, spatial: true, cooldownMs: 200, isPerEntityCooldown: true,
    fallback: { sample: "coin", rate: 0.85 },
  },
  "toll.recover": {
    stem: "mini/toll_recover", variants: 2, gain: 0.55, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300, isPerEntityCooldown: true,
    fallback: { sample: "chest", rate: 0.85 },
  },
  "toll.entrance": {
    stem: "mini/toll_entrance", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.4, 0.3, 0.7)],
    fallback: { sample: "floorClear", rate: 0.85 },
  },
  "toll.phase": {
    stem: "mini/toll_phase", variants: 1, gain: 0.9, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0.03, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.35, 0.35, 0.8)],
    fallback: { sample: "floorClear", rate: 0.85 },
  },
  "toll.death": {
    stem: "mini/toll_death", variants: 1, gain: 0.95, bus: "voiceTell", priority: WAVE_PRIORITY.bossTell,
    jitter: 0, spatial: true, isOffCameraUncapped: true, cooldownMs: 1000, isPerEntityCooldown: true,
    duck: [dM(0.3, 0.5, 1.0)],
    fallback: { sample: "floorClear", rate: 0.85 },
  },

  // ---- PVP (FFA arena deathmatch): the KILL / DEATH / MATCH-FLOW layer (client-only audio) ----
  // A SNAPPIER, brighter arcade kit — its own voice, distinct from the moody PvE cues. Bound to
  // the shipped sim events (pvpKill / pvpMatchOver / match.ph / SelfWire.rsp). Shots + impacts
  // during a match REUSE the arsenal — only this kill/death/match-flow layer is new.
  //
  // THE #1 RULE: `pvpKill{by,victim}` broadcasts to EVERY client, so the wiring branches on the
  // LOCAL player id (pvpKillCue below): by===self -> FRAG (the money cue, non-spatial, full gain);
  // victim===self -> DEATH (non-spatial); neither -> a quiet SPATIAL distant thud, hard-rate-limited
  // (cooldownMs 300, global) so a 6-player lobby never spams. Priorities: frag 92 (above weapon/
  // impact — a frag is NEVER culled), death 95 (own death always reads), fight/win/lose 96.
  "pvp.frag": { stem: "pvp/frag", variants: 3, gain: 0.85, bus: "ui", priority: 92, jitter: 0.03, cooldownMs: 40 },
  // Future dedicated escalation takes. Wave 1 keeps the chain cue on a safe repitch of the
  // shipped base frag; these hooks remain unfired until their authored files land.
  "pvp.fragStreak2": { stem: "pvp/frag_streak2", variants: 1, gain: 0.88, bus: "ui", priority: 92, jitter: 0 },
  "pvp.fragStreak3": { stem: "pvp/frag_streak3", variants: 1, gain: 0.9, bus: "ui", priority: 92, jitter: 0 },
  "pvp.death": { stem: "pvp/death", variants: 2, gain: 0.8, bus: "ui", priority: 95, jitter: 0.02 },
  "pvp.killDistant": {
    stem: "pvp/kill_distant", variants: 2, gain: 0.35, bus: "sfx", priority: WAVE_PRIORITY.impact,
    jitter: 0.05, spatial: true, cooldownMs: 300,
  },
  "pvp.countTick": { stem: "pvp/count_tick", variants: 1, gain: 0.6, bus: "ui", priority: 90, jitter: 0 },
  "pvp.fight": { stem: "pvp/fight_go", variants: 1, gain: 0.9, bus: "ui", priority: 96, jitter: 0 },
  "pvp.win": { stem: "pvp/match_win", variants: 1, gain: 0.9, bus: "ui", priority: 96, jitter: 0 },
  "pvp.lose": { stem: "pvp/match_lose", variants: 1, gain: 0.8, bus: "ui", priority: 96, jitter: 0 },
  // respawnTick (optional, subtle) is registered as a hook but NOT fired in v1; respawnIn is the
  // "weapons hot" blip the instant the local rsp countdown hits 0 and control returns.
  "pvp.respawnTick": {
    stem: "pvp/respawn_tick", variants: 1, gain: 0.3, bus: "ui", priority: WAVE_PRIORITY.ui, jitter: 0, cooldownMs: 400,
  },
  "pvp.respawnIn": { stem: "pvp/respawn_in", variants: 1, gain: 0.6, bus: "ui", priority: 90, jitter: 0 },
  // TODO(pvp-audio): optional TENSION tier (pvp.takeLead / pvp.lostLead / pvp.matchPoint /
  // pvp.finalFrag) — deferred; needs client-side lead-change + fraglimit tracking off the match
  // scoreboard block. Ship after the core beats (1-6) gate.
} as const satisfies Record<string, WaveSoundSpec>;

export type WaveEventId = keyof typeof WAVE_SOUNDS;
export const EXPEDITION_BAND_ENTRY_EVENT: WaveEventId = "expedition.bandEntry";

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
    // Earned windows + fair surprise: the blink-strike rides the thread it committed;
    // the climb (dive grammar) departs on the blink rows and its silk volleys charge on
    // the lattice rows; the P3 lane dash (rush grammar) flares then fires; every
    // snag / forced-down / overshoot flips the move to "crash" — the shared
    // punishable-stun grammar, voiced on the Weaver's own rows.
    blink: { windup: "weaver.blinkTell", active: "weaver.blinkDepart", impact: "weaver.blinkArriveStrike", recover: "weaver.recover" },
    dive: { windup: "weaver.feint", active: "weaver.blinkDepart" },
    rush: { windup: "weaver.latticeWarn", active: "weaver.blinkDepart", impact: "weaver.blinkArriveStrike", recover: "weaver.recover" },
    crash: { impact: "weaver.blinkArriveStrike", recover: "weaver.recover" },
  },
  gilded: {
    // The EXPOSED recover after each commitment is the fight's punish identity.
    slam: { windup: "warden.prisonWarn", lock: "warden.turretLock", impact: "warden.prisonClose", recover: "warden.exposed" },
    sweep: { windup: "warden.glyphWarn", active: "warden.turretFire", recover: "warden.exposed" },
  },
  gorge: {
    slam: { windup: "gorge.ringWarn", impact: "gorge.ringImpact" },
    spew: { windup: "gorge.zoneWarn", active: "gorge.zoneActive" },
    sweep: { windup: "gorge.spokeWarn", active: "gorge.spokeActive" },
  },
  pale: {
    slam: { windup: "pale.ringWarn", impact: "pale.ringImpact" },
    spew: { windup: "pale.zoneWarn", active: "pale.zoneActive" },
    sweep: { windup: "pale.spokeWarn", active: "pale.spokeActive" },
  },
  // CLAIMANT F70 — ALL THINGS OWED signature cast (PASS-THE-CLAIM / protocol 42).
  claimant: {
    all_things_owed: {
      windup: "claimant.owedTell", lock: "claimant.owedLock", active: "claimant.owedDescent",
      impact: "claimant.owedFail", recover: "claimant.owedRecover",
    },
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
  // The workers: a long stationary tell, then the construction lands on the release.
  rootward: {
    build: { windup: "root.raise", release: "root.divider" },
  },
  mason: {
    build: { windup: "mason.survey", release: "mason.raise" },
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
  // Wave 1 deep bosses (placeholder cue banks — the audio director's per-boss stems are a
  // separate task). Only the shared-grammar moves that the tell contract enumerates need
  // rows here (rush / sweep / volley); the bosses' bespoke moves (mirror/beam/spew/hurl/spin/
  // build/radial/merge/roar) ride their own boss cue maps.
  jet: {
    rush: { windup: "king.radialWarn", active: "king.radialFire" }, // the recoil-line dash
  },
  quorum: {
    sweep: { windup: "marrow.listenStart", active: "marrow.chargeStart" }, // the tether-snap wall
    volley: { windup: "marrow.listenStart", lock: "marrow.aimLock", release: "marrow.chargeStart" }, // the role volley
  },
};

export const WAVE_BOSS_PHASE: Readonly<Record<string, WaveEventId>> = {
  boss: "king.phase",
  marrow: "marrow.phase", choir: "choir.phase", weaver: "weaver.phase", gilded: "warden.phase",
  marshal: "marshal.shatter", toll: "toll.phase",
  gorge: "gorge.phase", pale: "pale.phase", claimant: "claimant.owedPhase",
};

export const WAVE_BOSS_DEATH: Readonly<Record<string, WaveEventId>> = {
  boss: "king.death",
  marrow: "marrow.death", choir: "choir.death", weaver: "weaver.death", gilded: "warden.death",
  marshal: "marshal.death", toll: "toll.death",
  gorge: "gorge.death", pale: "pale.death", claimant: "claimant.owedDeath",
};

// Bespoke entrance per boss-grade body (played at floor load / captain spawn).
export const WAVE_BOSS_ENTRANCE: Readonly<Record<string, WaveEventId>> = {
  boss: "king.entrance",
  marrow: "marrow.entrance", choir: "choir.entrance", weaver: "weaver.entrance", gilded: "gilded.entrance",
  marshal: "marshal.entrance", toll: "toll.entrance",
  gorge: "gorge.entrance", pale: "pale.entrance", claimant: "claimant.owedEntrance",
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

// Weapon + co-op cues reachable on ANY floor (player-driven) — part of every floor's
// preload plan so a first trigger never races its decode.
export const ALWAYS_REACHABLE_EVENTS: readonly WaveEventId[] = [
  "shootMortar", "mortarDetonate", "beamStart", "beamLoop", "beamStop", "beamHit", "beamFire",
  "revive.channelStart", "revive.channelLoop", "revive.cancel",
];

// PR #31 WeaponIds -> wave fire events; beam is EXCLUDED on purpose (its lifecycle is
// start/loop/stop through the director — with a director-throttled beamFire sizzle only
// while the authored loop stem is missing, never a raw per-shot one-shot at 22Hz). The effect
// wave binds only its SHOOTING verbs here (lastlight/frostline raise `shot` events);
// breach routes through the charge-tier release logic in game.ts (WEAPON_AUDIO), and
// the non-shooting verbs carry their sound on dedicated effect events.
export const WAVE_WEAPON_FIRE: Readonly<Record<string, WaveEventId>> = {
  mortar: "shootMortar",
  lastlight: "shootLastlight",
  frostline: "shootFrostline",
  cleaver: "shootCleaver",
  scrapper: "shootScrapper",
  skipper: "shootSkipper",
  arcbolt: "shootArcbolt",
  cryobolt: "shootCryobolt",
  firebomb: "shootFirebomb",
  tracker: "shootTracker",
  singularity: "shootSingularity",
  mooring_nail: "shootMooringNail",
  sluicegate: "shootSluicegate",
  oddsmaker: "shootOddsmaker",
  pathmaker: "shootPathmaker",
  resonant_fork: "shootResonantFork",
  red_pen: "shootRedPen",
  margin_call: "shootMarginCall",
  sidewinder: "shootSidewinder",
  hushiron: "shootHushiron",
  backtalk: "shootBacktalk",
  lamplighter: "shootLamplighter",
  faultlink: "shootFaultlink",
};

// ---- the WEAPON AUDIO CONTRACT: semantic states -> manifest rows -----------------------
// The client (and tests) speak STATES; only this table knows row ids. Universal state
// vocabulary: equip, prime (start), loop (the ONE keyed hold loop), threshold, ready
// (lock), release (+releaseAlt for a DISTINCT-STEM tier), travel, impact, vent
// (cancel/cooldown), fail — plus the family verbs (trap place/arm/trigger/expire,
// orbital pass/hit/catch, deployable place/unfold/acquire/fire/damaged/destroyed/
// timeout, tether hold/sweep/dragged, risk danger/payoff/recovery) and the shared
// statusApply/statusBreak library hooks.
export type WeaponAudioState =
  | "equip" | "prime" | "loop" | "threshold" | "ready" | "release" | "releaseAlt"
  | "travel" | "impact" | "vent" | "fail"
  | "place" | "arm" | "trigger" | "expire"
  | "pass" | "hit" | "catch"
  | "unfold" | "acquire" | "fire" | "damaged" | "destroyed" | "timeout"
  | "hold" | "sweep" | "dragged"
  | "danger" | "payoff" | "recovery"
  | "statusApply" | "statusBreak";

export const WEAPON_AUDIO: Readonly<Record<string, Partial<Record<WeaponAudioState, WaveEventId>>>> = {
  lastlight: {
    equip: "weapon.equip",
    release: "shootLastlight",
    danger: "lastlight.surge",       // the low-HP band opens (the cost is live)
    payoff: "lastlight.empowered",   // a DISTINCT empowered take, never a pitch tier
    recovery: "lastlight.settle",
  },
  breach: {
    equip: "weapon.equip",
    prime: "breach.chargeStart",
    loop: "breach.chargeLoop",       // ONE keyed hold loop; start/stop, never per tick
    threshold: "breach.threshold",
    ready: "breach.fullLock",
    release: "shootBreach",          // partial-charge tier
    releaseAlt: "breach.releaseFull",// full-charge tier — a distinct stem
    travel: "breach.travel",
    impact: "breach.impact",
    vent: "breach.vent",             // the safe cancel hisses out
  },
  snapwire: {
    equip: "weapon.equip",
    place: "wirePlant",
    arm: "wire.armed",
    trigger: "wireSnap",
    expire: "wire.expire",
    fail: "wire.refuse",
  },
  frostline: {
    equip: "weapon.equip",
    release: "shootFrostline",
    statusApply: "status.chillApply", // the shared status library carries its voice
    statusBreak: "status.freezeBreak",
  },
  halo: {
    equip: "weapon.equip",
    loop: "halo.loop",               // ONE mixed owner loop — never a voice per blade
    pass: "halo.pass",
    hit: "halo.hit",
    release: "haloFlare",
    catch: "halo.catch",
  },
  sentry: {
    equip: "weapon.equip",
    place: "sentryPlace",
    unfold: "sentry.unfold",
    acquire: "sentry.acquire",
    fire: "sentryShot",
    damaged: "sentry.damaged",
    destroyed: "sentryDown",
    timeout: "sentry.timeout",
  },
  crook: {
    equip: "weapon.equip",
    prime: "tetherLatch",
    loop: "crook.pullLoop",
    hold: "crook.hold",
    sweep: "tetherSweep",
    dragged: "crook.dragged",        // the risk half: YOU are the one reeled in
    fail: "crook.whiff",
  },
  // Back-filled bindings for the previous wave's manifest weapons.
  mortar: { release: "shootMortar", impact: "mortarDetonate" },
  beam: { prime: "beamStart", loop: "beamLoop", vent: "beamStop", hit: "beamHit" },
  mooring_nail: { equip: "weapon.equip", release: "shootMooringNail" },
  sluicegate: { equip: "weapon.equip", release: "shootSluicegate" },
  oddsmaker: { equip: "weapon.equip", release: "shootOddsmaker" },
  pathmaker: { equip: "weapon.equip", release: "shootPathmaker" },
  resonant_fork: { equip: "weapon.equip", release: "shootResonantFork" },
  red_pen: { equip: "weapon.equip", release: "shootRedPen" },
  margin_call: { equip: "weapon.equip", release: "shootMarginCall" },
  sidewinder: { equip: "weapon.equip", release: "shootSidewinder" },
  hushiron: { equip: "weapon.equip", release: "shootHushiron" },
  backtalk: { equip: "weapon.equip", release: "shootBacktalk" },
  lamplighter: { equip: "weapon.equip", release: "shootLamplighter" },
  faultlink: { equip: "weapon.equip", release: "shootFaultlink" },
};

// The shared status library (apply on FIRST application, break on state exit; DoT ticks
// are SILENT by contract — their cadence carries no decision).
export const STATUS_AUDIO: Readonly<Record<string, WaveEventId>> = {
  burn: "status.burnApply",
  chill: "status.chillApply",
  shock: "status.shockApply",
  freeze: "status.freeze",
  freezeBreak: "status.freezeBreak",
};

export const ODDSMAKER_OUTCOME_AUDIO = {
  ricochet: "oddsmaker.ricochet",
  seeker: "oddsmaker.seeker",
  blast: "oddsmaker.blast",
  pierce: "oddsmaker.pierce",
} as const satisfies Readonly<Record<string, WaveEventId>>;

export const BLESSING_PROC_AUDIO: Readonly<Record<string, WaveEventId>> = {
  hold_fast: "blessing.holdFast",
  nothing_wasted: "blessing.nothingWasted",
  second_breath_muddy: "blessing.muddy",
  on_the_beat: "blessing.onBeat",
  shared_rope: "blessing.sharedRope",
  crosscurrent: "blessing.crosscurrent",
  last_warm_round: "blessing.warmRound",
  known_by_touch: "blessing.knownByTouch",
  remember_me: "blessing.rememberMe",
  carry_the_light: "blessing.carryTheLight",
};

export const BEAM_WEAPON_ID = "beam";
// Manifest §4 hysteresis: start after >120ms idle; stop when >90ms since the last shot.
export const BEAM_START_IDLE_MS = 120;
export const BEAM_STOP_GAP_MS = 90;
// Interim per-shot sizzle throttle (only while the authored loop stem is missing): ~2 of
// the Sunlance's 45ms shots per cue, so the lance reads continuous, never a machine gun.
export const BEAM_FIRE_CUE_GAP_MS = 80;

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

// ---- PVP (client-only) trigger helpers -------------------------------------------------
// pvpKill fires to EVERY client; the LOCAL player id decides which cue and whether it is
// spatial. This branch is the whole point of the PvP audio pass — the killer hears the
// money FRAG, the victim hears DEATH (both in-your-head, non-spatial), and everyone else a
// quiet SPATIAL distant thud (hard rate-limited by the row's cooldown). Factored pure so the
// role logic is asserted headlessly, exactly like the tell/attenuation helpers above.
export type PvpKillRole = "frag" | "death" | "distant";

export interface PvpKillCue {
  readonly event: WaveEventId;
  readonly isSpatial: boolean; // frag/death play at full gain in your head; distant is positional
}

export const PVP_KILL_CUES: Readonly<Record<PvpKillRole, PvpKillCue>> = {
  frag: { event: "pvp.frag", isSpatial: false },
  death: { event: "pvp.death", isSpatial: false },
  distant: { event: "pvp.killDistant", isSpatial: true },
};

export function pvpKillRole(isLocalKiller: boolean, isLocalVictim: boolean): PvpKillRole {
  if (isLocalKiller) return "frag";
  if (isLocalVictim) return "death";
  return "distant";
}

export function pvpKillCue(isLocalKiller: boolean, isLocalVictim: boolean): PvpKillCue {
  return PVP_KILL_CUES[pvpKillRole(isLocalKiller, isLocalVictim)];
}

// Match-over branches on winner===self: a triumphant win sting vs a light defeat cue. Never
// the co-op gameOver (too heavy/final — a PvP loss is a fast requeue).
export function pvpMatchOverCue(isLocalWinner: boolean): WaveEventId {
  return isLocalWinner ? "pvp.win" : "pvp.lose";
}

// FRAG STREAK escalation: rapid local frags step the base frag pitch up a semitone each,
// clamped into a SAFE repitch band (~2 steps) so the base variants never pitch out of range.
// A gap longer than the window resets the ladder. Beyond the cap wants the dedicated
// pvp.fragStreak2/3 stems (registered as hooks) rather than pitching further.
export const PVP_FRAG_STREAK_WINDOW_MS = 4000;
export const PVP_FRAG_STREAK_MAX_STEPS = 2;   // safe-band steps on the base frag variants
export const PVP_FRAG_STREAK_SEMITONES = 1;   // per rapid frag

// The streak index for a frag landing `gapMs` after the previous one (0 = fresh / window lapsed).
export function pvpFragStreakStep(prevStep: number, gapMs: number): number {
  if (gapMs > PVP_FRAG_STREAK_WINDOW_MS) return 0;
  return prevStep + 1;
}

// Playback rate for a streak step, clamped into the safe repitch band on the base variants.
export function pvpFragStreakRate(step: number): number {
  const clamped = Math.max(0, Math.min(step, PVP_FRAG_STREAK_MAX_STEPS));
  const rate = Math.pow(2, (clamped * PVP_FRAG_STREAK_SEMITONES) / 12);
  return Math.min(SAFE_DERIVE_RATE_MAX, rate);
}

// Rising countdown-tick pitch: the final second(s) rise so the 3..2..1 ramps into the GO.
// countTick has zero jitter, so this rate plays exactly. `secondsLeft` is the whole-second
// readout (3, 2, 1); earlier/longer countdowns clamp to the base rate.
export function pvpCountTickRate(secondsLeft: number): number {
  const step = Math.max(0, Math.min(2, 3 - secondsLeft));
  return 1 + 0.06 * step;
}

// The events the PvP kill/death/match-flow layer actually FIRES (excludes the pending
// streak/tension hooks). Preloaded on match entry so a first frag never races its decode.
export const PVP_WAVE_EVENTS: readonly WaveEventId[] = [
  "pvp.frag", "pvp.death", "pvp.killDistant", "pvp.countTick", "pvp.fight", "pvp.win",
  "pvp.lose", "pvp.respawnIn",
];

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

// The Deep's sparse positional ambience scheduler — near-silent by design (audio
// director FINAL P0 contract). TWO-LEVEL cadence: one global opportunity every
// 1.5–3.2s draws ONE category by weight; the drawn category sounds only if its own
// re-arm window has elapsed — otherwise that opportunity is authored silence, never
// rerolled onto another category (categories never fill in for each other). Each play
// gets a deterministic gain inside the category's range and a deterministic position
// on the 160–520px ring around the camera, accepted only on valid wall/material cells
// (diegetic sources in the Deep's fabric — never centered on the listener).
export interface DeepEmitterChannel {
  readonly event: WaveEventId;
  readonly weight: number;       // share of global opportunities this category wins
  readonly minGapSec: number;    // re-arm window between two sounds of THIS category
  readonly maxGapSec: number;
  readonly gainMin: number;
  readonly gainMax: number;
  // Per-take draw weights / gain trims, aligned with the row's `takes` array.
  readonly takeWeights?: readonly number[];
  readonly takeGainMult?: readonly number[];
}

export const DEEP_EMITTER = {
  globalMinGapSec: 1.5,
  globalMaxGapSec: 3.2,
  channels: [
    { event: "deep.mineralTick", weight: 0.35, minGapSec: 2, maxGapSec: 4.5, gainMin: 0.07, gainMax: 0.11 },
    { event: "deep.resinDrip", weight: 0.25, minGapSec: 2.5, maxGapSec: 5, gainMin: 0.06, gainMax: 0.10, takeWeights: [0.5, 1, 1] },
    { event: "deep.resinStress", weight: 0.20, minGapSec: 3.5, maxGapSec: 6.5, gainMin: 0.08, gainMax: 0.12 },
    { event: "deep.architectureShift", weight: 0.20, minGapSec: 5, maxGapSec: 9, gainMin: 0.09, gainMax: 0.13, takeGainMult: [0.8, 1] },
  ] as readonly DeepEmitterChannel[],
  // Never more than ONE Deep event sounding at a time: a due opportunity holds through
  // the overlap window until the previous event has faded.
  maxOverlap: 1,
  overlapWindowSec: 1.2,
  // Suppress ±250ms around lock/critical cues (enemy/boss lock tells and hazard
  // warnings, priority ≥ enemyLock); the trailing side is enforceable, the leading
  // side is unknowable without clairvoyance.
  lockMuteMs: 250,
  // Deterministic diegetic placement ring around the camera center.
  minDistPx: 160,
  maxDistPx: 520,
  placementTries: 6, // deterministic ring draws before an opportunity gives up (silence)
} as const;

// The explicit take stems an event may play (selection-driven when `takes` is present).
export function takeStemsOf(spec: WaveSoundSpec): readonly string[] {
  if (spec.takes !== undefined) return spec.takes;
  if (spec.stem === null) return [];
  if (spec.variants <= 1) return [spec.stem];
  const out: string[] = [];
  for (let v = 1; v <= spec.variants; v++) out.push(`${spec.stem}_v${v}`);
  return out;
}
