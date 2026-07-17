// The wave-audio DIRECTOR: manifest policy between gameplay and the engine. The engine
// (audio.ts) is pure mechanism — buses, voices, loops, ducks; this module owns every rule
// the manifest states in prose: per-event cooldowns and rate limits, variant non-repeat,
// pitch-jitter lanes, distance attenuation, the bossLock windows (pet sidechain + ambient
// one-shot mute), loop lifecycles keyed by entity/channel (started once, stopped
// explicitly, swept on despawn), the Sunlance held-beam hysteresis, the revive-channel
// state machine, ambient zone crossfades, and preload plans.
//
// Trigger sources, in precedence order (cooldowns make the paths mutually safe):
//   1. SimEvents that already exist (boss phase/death, revive) — exact moments.
//   2. `cue` SimEvents whose name is a manifest event id — the sim-side semantic channel.
//   3. The tell watcher: per-tick edges over AUTHORITATIVE enemy attack state (never
//      animation frames), so PR #31's bosses/mobs sound right with zero sim changes.

import { audio } from "./audio.js";
import type { SfxName, WaveEngine } from "./audio.js";
import {
  isWaveEventId, waveSpecOf, spatialGainFor, tellCuesFor, isBurrowUnderground,
  bossWaveEvents, PET_SIDECHAIN, BOSS_LOCK_AMBIENT_MUTE_MS, WAVE_PRIORITY,
  WAVE_BOSS_PHASE, WAVE_BOSS_DEATH, WAVE_BOSS_ENTRANCE, WAVE_WEAPON_FIRE,
  AMBIENT_ZONE_EVENTS, HAZARD_WAVE_EVENTS, PVP_WAVE_EVENTS,
  ALWAYS_REACHABLE_EVENTS, BEAM_WEAPON_ID, BEAM_START_IDLE_MS, BEAM_STOP_GAP_MS, BEAM_FIRE_CUE_GAP_MS,
  BURROW_EMITTER, BURROW_THUD_EVENT, DEEP_EMITTER, takeStemsOf, emitterRand,
} from "./waveSpec.js";
import {
  MAX_CONCURRENT_MOB_LOCKS, MOB_LOCK_WINDOW_MS, GROUP_LOOP_KEY,
  FLOCK_BED_RADIUS, ORBIT_LOOP_RADIUS, FLOCK_PASS_OUTER, FLOCK_PASS_INNER,
  bestiaryPreloadEvents,
} from "./bestiaryAudio.js";
import type { EnemyKind } from "../sim/types.js";
import type { WaveEventId, WaveSoundSpec, TellSnapshot } from "./waveSpec.js";

export interface WavePlayOpts {
  x?: number;
  y?: number;
  entityId?: number | string;
  gain?: number;
  rate?: number;
  // Deterministic variant selection (the seeded emitters); absent = Math.random.
  variantRoll?: number;
  // Exact take index (weighted emitter draws own the pick AND the anti-repeat rule).
  variantIndex?: number;
}

// Camera-space listener (the local player + view rect); drives attenuation + combat gating.
export interface WaveListener {
  x: number;
  y: number;
  camLeft: number;
  camTop: number;
  camRight: number;
  camBottom: number;
}

// Structural views over sim state (satisfied by src/sim Enemy / PlayerSim directly — the
// director never imports sim modules, so it survives any sim-side rebase untouched).
export interface WaveFrameEnemy {
  readonly id: number;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly dead: boolean;
  readonly attack: TellSnapshot;
}

export interface WaveFramePlayer {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly isDown: boolean;
  readonly reviveProgress: number;
}

export interface WaveFrameInput {
  readonly listener: WaveListener;
  readonly enemies: Iterable<WaveFrameEnemy>;
  readonly players: Iterable<WaveFramePlayer>;
  // Whether a world position is a valid wall/material cell for diegetic ambience
  // placement (the Deep emitter). Absent = every ring position is acceptable.
  readonly isMaterialCellAt?: (x: number, y: number) => boolean;
}

// Mirrors the content-wave orbiter ring (ORBITER_RING/SLACK) for the once-per-entity
// enterBand cue; a constant here, not an import, so main compiles before PR #31 lands.
const ORBITER_BAND_RADIUS = 170;
const ORBITER_BAND_SLACK = 30;
// "In combat" for suppression rules (§10 pet idle): any live enemy this close.
const COMBAT_RADIUS = 480;
const AMBIENT_CROSSFADE_SEC = 1.5; // §10: crossfade ambient zone changes 1.5s

interface TellMemory {
  kind: string;
  phase: string;
  move: string;
  isAimLocked: boolean;
  hasAcquired: boolean;
  lastDist: number; // listener distance last frame (the flock close-pass edge)
}

interface BeamState {
  lastShotAtMs: number;
  gain: number;
  holdMs: number; // stop hysteresis — wider for remote beams fed by ~10Hz presence sync
  lastFireCueMs: number; // interim per-shot sizzle throttle (only while the loop is silent)
}

// Per-burrower deterministic underground emitter: each authored component channel keeps
// its own next-fire clock; the whole pattern is a pure function of the entity id.
interface BurrowEmitterState {
  rngState: number;
  nextAtMs: number[];
}

// The Deep's sparse ambience scheduler (one per director; active only in the Deep zone).
// One GLOBAL opportunity clock; per-channel re-arm clocks and last-take memory; recent
// starts are shared (the max-one-active cap).
interface DeepEmitterState {
  seed: number;     // the arming seed (floor identity), immutable
  rngState: number; // the live LCG cursor
  nextOpportunityAtMs: number;
  rearmAtMs: number[];
  lastTake: number[];
  recentAtMs: number[]; // recent event starts, pruned to the overlap window
}


// Sim cue-channel names from world.ts (dotted) → WAVE_SOUNDS camelCase events.
// Keeps stem uniqueness in WAVE_SOUNDS while still routing THE LAST PROCESSION beats.
const WAKE_CUE_ALIASES: Readonly<Record<string, WaveEventId>> = {
  "wake.activate": "wake.processionEntrance",
  "wake.procession.plant": "wake.processionBierPulse",
  "wake.procession.tell": "wake.processionTell",
  "wake.procession.front": "wake.processionFront",
  "wake.procession.success": "wake.processionPunish",
  "wake.procession.miss": "wake.processionFail",
  "wake.procession.survival": "wake.processionRecover",
  "wake.procession.threshold": "wake.processionThreshold",
  "wake.procession.shelter": "wake.processionShelter",
  "wake.procession.shadow": "wake.processionShadowWarn",
  "wake.procession.blocker": "wake.processionBlockerHighlight",
  "wake.procession.break": "wake.processionBlockerBreak",
};

class WaveAudioDirector {
  private engine: WaveEngine;
  private listener: WaveListener | null = null;
  private isInCombat = false;
  private lastBossLockAtMs = -Infinity;
  private lastCombatLockAtMs = -Infinity;
  private cooldownAt = new Map<string, number>();
  // MOB lock concurrency (bestiary audio contract): at most MAX_CONCURRENT_MOB_LOCKS
  // enemy-lock cues inside one audible window. Boss locks are exempt (their own band).
  private mobLockAtMs: number[] = [];
  private lastVariant = new Map<string, number>();
  private tells = new Map<number, TellMemory>();
  private beams = new Map<string, BeamState>();
  private reviveChannels = new Set<string>();
  private ambientZone: number | null = null;
  private seenIdsScratch = new Set<number>();
  private burrowEmitters = new Map<number, BurrowEmitterState>();
  private deepEmitter: DeepEmitterState | null = null;

  constructor(engine: WaveEngine) {
    this.engine = engine;
  }

  play(event: WaveEventId, opts?: WavePlayOpts): boolean {
    const spec = waveSpecOf(event);
    const nowMs = this.engine.now();
    if (nowMs < 0) return false;
    if (spec.isCombatSuppressed && this.isInCombat) return false;
    if (spec.bus === "ambient" && !spec.loop && nowMs - this.lastBossLockAtMs < BOSS_LOCK_AMBIENT_MUTE_MS) return false;

    const cdKey = spec.isPerEntityCooldown && opts?.entityId !== undefined ? `${event}#${opts.entityId}` : event;
    if (spec.cooldownMs !== undefined) {
      const lastAt = this.cooldownAt.get(cdKey);
      if (lastAt !== undefined && nowMs - lastAt < spec.cooldownMs) return false;
    }
    if (spec.priority === WAVE_PRIORITY.enemyLock) {
      this.mobLockAtMs = this.mobLockAtMs.filter((t) => nowMs - t < MOB_LOCK_WINDOW_MS);
      if (this.mobLockAtMs.length >= MAX_CONCURRENT_MOB_LOCKS) return false;
    }

    let gain = spec.gain * (opts?.gain ?? 1);
    if (spec.spatial && opts?.x !== undefined && opts.y !== undefined && this.listener) {
      const l = this.listener;
      const dist = Math.hypot(opts.x - l.x, opts.y - l.y);
      const isOffCamera = opts.x < l.camLeft || opts.x > l.camRight || opts.y < l.camTop || opts.y > l.camBottom;
      gain *= spatialGainFor(dist, isOffCamera, spec.isOffCameraUncapped === true);
    }
    if (gain < 0.02) return false;

    const variantIndex = this.pickVariant(event, spec, opts?.variantRoll, opts?.variantIndex);
    const rate = (opts?.rate ?? 1) * (1 + (Math.random() * 2 - 1) * spec.jitter);
    const isPlayed = this.engine.playWave({
      event,
      bus: spec.bus,
      priority: spec.priority,
      gain,
      rate,
      stem: this.stemForVariant(spec, variantIndex),
      fallback: spec.fallback,
      duck: spec.duck,
    });
    if (!isPlayed) return false;
    if (spec.cooldownMs !== undefined) this.cooldownAt.set(cdKey, nowMs);
    if (spec.priority === WAVE_PRIORITY.enemyLock) this.mobLockAtMs.push(nowMs);
    this.lastVariant.set(event, variantIndex);
    if (spec.priority >= WAVE_PRIORITY.bossLock) {
      this.lastBossLockAtMs = nowMs;
      this.engine.duckWaveBus(PET_SIDECHAIN); // §1: pet cues never overlap boss locks
    }
    // Combat locks (enemy/boss lock tells, hazard warnings) open the Deep emitter's
    // ±250ms ambience mute window.
    if (spec.priority >= WAVE_PRIORITY.enemyLock) this.lastCombatLockAtMs = nowMs;
    return true;
  }

  // Routes a sim `cue` event whose name is a manifest id; returns false for legacy names
  // so the caller keeps its existing SfxName path byte-identical.
  cueAt(name: string, x: number, y: number, entityId?: number): boolean {
    const resolved = WAKE_CUE_ALIASES[name] ?? name;
    if (!isWaveEventId(resolved)) return false;
    this.play(resolved, { x, y, entityId });
    return true;
  }

  startLoop(event: WaveEventId, key = "", opts?: { gain?: number; fadeSec?: number }): boolean {
    const spec = waveSpecOf(event);
    if (!spec.loop || spec.stem === null) return false; // authored silence never starts a voice
    return this.engine.startWaveLoop(this.loopKey(event, key), {
      event,
      bus: spec.bus,
      gain: spec.gain * (opts?.gain ?? 1),
      stem: spec.stem,
      fadeSec: opts?.fadeSec ?? 0.06,
    });
  }

  stopLoop(event: WaveEventId, key = "", fadeSec = 0.12): void {
    this.engine.stopWaveLoop(this.loopKey(event, key), fadeSec);
  }

  // Level-triggered loop control: callers state "should be sounding" each tick and the
  // director does edge work — the manifest's proximity-gated loops (toxic pool) in one line.
  holdLoop(event: WaveEventId, key: string, isHeld: boolean, opts?: { gain?: number }): void {
    if (isHeld) this.startLoop(event, key, opts);
    else this.stopLoop(event, key);
  }

  stopAllLoops(): void {
    this.engine.stopAllWaveLoops();
  }

  // ---- ambient zones (§5) ----

  // `ambientSeed` is the deterministic biome-ambient RNG seed (the caller derives it
  // from the run seed + floor): the same floor always schedules the same Deep pattern,
  // different floors get different ones. Absent = a fixed default.
  setAmbientZone(zoneIndex: number | null, ambientSeed?: number): void {
    if (zoneIndex !== null && (zoneIndex < 0 || zoneIndex >= AMBIENT_ZONE_EVENTS.length)) zoneIndex = null;
    const seed = (ambientSeed ?? 0x0DEE9) | 0;
    if (zoneIndex === this.ambientZone) {
      // Same zone, new floor: the bed crossfades nothing, but the Deep scheduler
      // re-seeds so its deterministic pattern follows the floor.
      if (this.deepEmitter !== null && this.deepEmitter.seed !== seed) this.deepEmitter = this.armDeepEmitter(seed);
      return;
    }
    if (this.ambientZone !== null) {
      this.stopLoop(AMBIENT_ZONE_EVENTS[this.ambientZone], "zone", AMBIENT_CROSSFADE_SEC);
    }
    this.ambientZone = zoneIndex;
    if (zoneIndex !== null) {
      this.startLoop(AMBIENT_ZONE_EVENTS[zoneIndex], "zone", { fadeSec: AMBIENT_CROSSFADE_SEC });
    }
    // The Deep has no bed (authored silence): entering it arms the sparse positional
    // scheduler from the deterministic ambient seed.
    this.deepEmitter = zoneIndex !== null && AMBIENT_ZONE_EVENTS[zoneIndex] === "ambient.deep"
      ? this.armDeepEmitter(seed)
      : null;
  }

  private armDeepEmitter(seed: number): DeepEmitterState {
    return {
      seed,
      rngState: seed,
      nextOpportunityAtMs: -1,
      rearmAtMs: DEEP_EMITTER.channels.map(() => 0),
      lastTake: DEEP_EMITTER.channels.map(() => -1),
      recentAtMs: [],
    };
  }

  // ---- weapons (§4) ----

  isBeamWeapon(weapon: string): boolean {
    return weapon === BEAM_WEAPON_ID;
  }

  // Owns the sound of manifest-bound weapons; returns false so legacy weapons keep their
  // existing SHOOT_SFX path. Beam shots NEVER one-shot: they drive the held-loop lifecycle.
  weaponFired(weapon: string, opts?: WavePlayOpts & { beamKey?: string }): boolean {
    if (weapon === BEAM_WEAPON_ID) {
      this.beamShot(opts?.beamKey ?? "self", opts?.gain ?? 1, opts?.x, opts?.y);
      return true;
    }
    const event = WAVE_WEAPON_FIRE[weapon];
    if (!event) return false;
    this.play(event, opts);
    return true;
  }

  // Rate-limited Sunlance hit tick (§4: 120ms per target rides beamHit's cooldown).
  beamHitAt(targetId: number, x: number, y: number): void {
    this.play("beamHit", { entityId: targetId, x, y });
  }

  private beamShot(key: string, gain: number, x?: number, y?: number): void {
    const nowMs = this.engine.now();
    if (nowMs < 0) return;
    const state = this.beams.get(key);
    if (!state || nowMs - state.lastShotAtMs > BEAM_START_IDLE_MS) {
      this.play("beamStart", { gain, x, y });
      this.startLoop("beamLoop", key, { gain });
    }
    // The authored held loop is the real voice. Until its stem ships the loop is silent
    // (loops are authored-file-or-silence), so an audible per-shot sizzle carries the lance
    // — throttled so 22Hz fire reads as one continuous beam, positional so a teammate's
    // lance is heard where it fires. It yields the instant the real loop actually sounds,
    // so shipping the loop asset needs no code change (no doubled voice).
    let lastFireCueMs = state?.lastFireCueMs ?? -Infinity;
    if (!this.engine.hasWaveLoop(this.loopKey("beamLoop", key)) && nowMs - lastFireCueMs >= BEAM_FIRE_CUE_GAP_MS) {
      this.play("beamFire", { gain, x, y });
      lastFireCueMs = nowMs;
    }
    // Remote beams arrive through ~10Hz presence sync, slower than the 90ms local stop
    // gap; a wider hold keeps their loop from stuttering between updates.
    const holdMs = key === "self" ? BEAM_STOP_GAP_MS : BEAM_STOP_GAP_MS * 3;
    this.beams.set(key, { lastShotAtMs: nowMs, gain, holdMs, lastFireCueMs });
  }

  // ---- boss beats routed from SimEvents (exact moments, kind-aware) ----

  bossPhase(kind: string, x: number, y: number, entityId?: number): boolean {
    const event = WAVE_BOSS_PHASE[kind];
    if (!event) return false;
    this.play(event, { x, y, entityId });
    return true;
  }

  bossDeath(kind: string, x: number, y: number): boolean {
    const event = WAVE_BOSS_DEATH[kind];
    if (!event) return false;
    this.play(event, { x, y });
    return true;
  }

  // ---- co-op revive channel (§8) ----

  reviveComplete(pid: string): void {
    this.stopLoop("revive.channelLoop", pid);
    this.reviveChannels.delete(pid);
    // revive.complete REUSES the existing `revive` one-shot (played by the caller); the
    // manifest's duck for it lands here.
    this.engine.duckWaveBus({ bus: "music", to: 0.5, hold: 0.18, recover: 0.55 });
  }

  // ---- per-tick observation (tell watcher, channels, beam hysteresis, loop GC) ----

  frame(input: WaveFrameInput): void {
    this.listener = input.listener;
    const nowMs = this.engine.now();
    if (nowMs < 0) return;

    const seen = this.seenIdsScratch;
    seen.clear();
    let isInCombat = false;
    let flockNear = 0;
    let orbitNear = 0;
    for (const e of input.enemies) {
      if (e.dead) continue;
      seen.add(e.id);
      const dist = Math.hypot(e.x - input.listener.x, e.y - input.listener.y);
      if (dist < COMBAT_RADIUS) isInCombat = true;
      if (e.kind === "bat" && dist < FLOCK_BED_RADIUS) flockNear++;
      if (e.kind === "orbiter" && dist < ORBIT_LOOP_RADIUS) orbitNear++;
      this.observeEnemy(e, dist, nowMs);
    }
    this.isInCombat = isInCombat;
    // The flock is ONE aggregate bed and the orbit ring ONE hum: a single group-keyed
    // loop each, held while any member is near — never a voice per body.
    this.holdLoop("flock.bed", GROUP_LOOP_KEY, flockNear > 0, { gain: Math.min(1, 0.5 + 0.12 * flockNear) });
    this.holdLoop("orbit.loop", GROUP_LOOP_KEY, orbitNear > 0);
    for (const [id] of this.tells) {
      if (seen.has(id)) continue;
      this.burrowEmitters.delete(id); // despawn stops the underground emitter
      this.tells.delete(id);
    }

    this.observeRevives(input.players);

    for (const [key, beam] of this.beams) {
      if (nowMs - beam.lastShotAtMs <= beam.holdMs) {
        // Held: keep asking for the loop. A no-op while it sounds; the graceful late
        // start when its authored buffer decoded after the trigger (loops never synth).
        this.startLoop("beamLoop", key, { gain: beam.gain });
        continue;
      }
      this.beams.delete(key);
      this.stopLoop("beamLoop", key);
      this.play("beamStop", { gain: beam.gain });
    }

    // Late unlock / muted-then-unmuted: (re)start the current zone bed once audio runs.
    if (this.ambientZone !== null) {
      this.startLoop(AMBIENT_ZONE_EVENTS[this.ambientZone], "zone", { fadeSec: AMBIENT_CROSSFADE_SEC });
    }

    this.stepDeepEmitter(nowMs, input.listener, input.isMaterialCellAt);
  }

  private observeEnemy(e: WaveFrameEnemy, distToListener: number, nowMs: number): void {
    const prev = this.tells.get(e.id) ?? null;
    const cues = tellCuesFor(e.kind, prev, e.attack);
    for (const cue of cues) this.play(cue, { x: e.x, y: e.y, entityId: e.id });

    let hasAcquired = prev?.hasAcquired ?? false;
    if (e.kind === "orbiter" && !hasAcquired
      && Math.abs(distToListener - ORBITER_BAND_RADIUS) <= ORBITER_BAND_SLACK) {
      this.play("orbiter.enterBand", { x: e.x, y: e.y, entityId: e.id });
      hasAcquired = true;
    }

    // The flock's close pass: a body crossing from OUTER to INNER of the listener.
    if (e.kind === "bat" && prev && prev.lastDist > FLOCK_PASS_OUTER && distToListener < FLOCK_PASS_INNER) {
      this.play("flock.pass", { x: e.x, y: e.y, entityId: e.id });
    }

    if (e.kind === "burrower") {
      // The underground thud fires exactly once per commitment, on the direction-lock
      // edge (the same authoritative edge as the burrower.lock tell).
      if (cues.indexOf("burrower.lock") !== -1) {
        this.play(BURROW_THUD_EVENT, { x: e.x, y: e.y, entityId: e.id });
      }
      this.stepBurrowEmitter(e, nowMs);
    }

    if (prev) {
      prev.phase = e.attack.phase;
      prev.move = e.attack.move;
      prev.isAimLocked = e.attack.isAimLocked;
      prev.hasAcquired = hasAcquired;
      prev.lastDist = distToListener;
    } else {
      this.tells.set(e.id, {
        kind: e.kind, phase: e.attack.phase, move: e.attack.move,
        isAimLocked: e.attack.isAimLocked, hasAcquired, lastDist: distToListener,
      });
    }
  }

  // ---- deterministic positional emitters (audio director FINAL: no synthesis, only
  // scheduled authored one-shots) ----

  // Burrow underground presence: three authored component channels on independent seeded
  // cadences (dirt grind 1.0–1.4s, pebble 0.35–0.75s, shell scrape 1.3–2.0s), positional
  // at the tunnelling body. Stops the instant the burrower locks its eruption (leaves the
  // dive) or despawns — the state simply drops; there is no loop voice to kill.
  private stepBurrowEmitter(e: WaveFrameEnemy, nowMs: number): void {
    if (!isBurrowUnderground(e.kind, e.attack)) {
      this.burrowEmitters.delete(e.id);
      return;
    }
    let st = this.burrowEmitters.get(e.id);
    if (!st) {
      st = { rngState: (0xB0770 ^ Math.imul(e.id + 1, 2654435761)) | 0, nextAtMs: [] };
      for (const ch of BURROW_EMITTER) st.nextAtMs.push(nowMs + this.drawGapMs(st, ch.minGapSec, ch.maxGapSec));
      this.burrowEmitters.set(e.id, st);
    }
    for (let i = 0; i < BURROW_EMITTER.length; i++) {
      if (nowMs < st.nextAtMs[i]) continue;
      const ch = BURROW_EMITTER[i];
      const roll = emitterRand(st.rngState);
      st.rngState = roll.state;
      this.play(ch.event, { x: e.x, y: e.y, entityId: e.id, variantRoll: roll.value });
      st.nextAtMs[i] = nowMs + this.drawGapMs(st, ch.minGapSec, ch.maxGapSec);
    }
  }

  // The Deep's near-silent sparse ambience (FINAL P0 contract): ONE global opportunity
  // every 1.5–3.2s draws one category by weight (mineral 35 / drip 25 / stress 20 /
  // architecture 20). The drawn category sounds only if its own re-arm window elapsed —
  // otherwise the opportunity is authored silence, never rerolled (categories never
  // fill in for each other). Every play lands on a deterministic 160–520px ring
  // position around the camera, accepted only on valid wall/material cells (diegetic —
  // never centered on the listener); at most ONE Deep event sounds at a time, and a
  // due opportunity holds (not rescheduled) through the ±250ms lock/critical-cue mute.
  private stepDeepEmitter(nowMs: number, l: WaveListener, isMaterialCellAt?: (x: number, y: number) => boolean): void {
    const st = this.deepEmitter;
    if (!st) return;
    if (st.nextOpportunityAtMs < 0) {
      st.nextOpportunityAtMs = nowMs + this.drawGapMs(st, DEEP_EMITTER.globalMinGapSec, DEEP_EMITTER.globalMaxGapSec);
    }
    if (nowMs < st.nextOpportunityAtMs) return;
    if (nowMs - this.lastCombatLockAtMs < DEEP_EMITTER.lockMuteMs) return; // hold
    st.recentAtMs = st.recentAtMs.filter((t) => nowMs - t < DEEP_EMITTER.overlapWindowSec * 1000);
    if (st.recentAtMs.length >= DEEP_EMITTER.maxOverlap) return; // hold

    // Weighted category draw (one per opportunity).
    const catRoll = this.drawRand(st);
    const totalWeight = DEEP_EMITTER.channels.reduce((s, c) => s + c.weight, 0);
    let r = catRoll * totalWeight;
    let index = DEEP_EMITTER.channels.length - 1;
    for (let i = 0; i < DEEP_EMITTER.channels.length; i++) {
      r -= DEEP_EMITTER.channels[i].weight;
      if (r <= 0) { index = i; break; }
    }
    const ch = DEEP_EMITTER.channels[index];
    const spec = waveSpecOf(ch.event);
    const takes = takeStemsOf(spec);
    if (takes.length > 0 && nowMs >= st.rearmAtMs[index]) {
      // Weighted take pick with the anti-repeat rule owned here (per-channel memory).
      const takeIndex = this.pickWeightedTake(st, index, takes.length, ch.takeWeights);
      const target = (ch.gainMin + this.drawRand(st) * (ch.gainMax - ch.gainMin)) * (ch.takeGainMult?.[takeIndex] ?? 1);
      // Diegetic placement: deterministic ring draws, accepted only on material cells.
      let pos: { x: number; y: number } | null = null;
      for (let attempt = 0; attempt < DEEP_EMITTER.placementTries && pos === null; attempt++) {
        const angle = this.drawRand(st) * Math.PI * 2;
        const distance = DEEP_EMITTER.minDistPx + this.drawRand(st) * (DEEP_EMITTER.maxDistPx - DEEP_EMITTER.minDistPx);
        const x = l.x + Math.cos(angle) * distance;
        const y = l.y + Math.sin(angle) * distance;
        if (isMaterialCellAt === undefined || isMaterialCellAt(x, y)) pos = { x, y };
      }
      if (pos !== null) {
        const isPlayed = this.play(ch.event, {
          x: pos.x, y: pos.y,
          // The row's gain is the channel max; scale this play into its authored range
          // (deterministic), before the ordinary distance attenuation.
          gain: target / spec.gain,
          variantIndex: takeIndex,
        });
        if (isPlayed) {
          st.recentAtMs.push(nowMs);
          st.lastTake[index] = takeIndex;
          st.rearmAtMs[index] = nowMs + this.drawGapMs(st, ch.minGapSec, ch.maxGapSec);
        }
      }
    }
    st.nextOpportunityAtMs = nowMs + this.drawGapMs(st, DEEP_EMITTER.globalMinGapSec, DEEP_EMITTER.globalMaxGapSec);
  }

  private pickWeightedTake(st: DeepEmitterState, channelIndex: number, count: number, weights?: readonly number[]): number {
    if (count <= 1) return 0;
    const last = st.lastTake[channelIndex];
    const weightOf = (i: number): number => (i === last ? 0 : weights?.[i] ?? 1);
    let total = 0;
    for (let i = 0; i < count; i++) total += weightOf(i);
    let r = this.drawRand(st) * total;
    for (let i = 0; i < count; i++) {
      r -= weightOf(i);
      if (weightOf(i) > 0 && r <= 0) return i;
    }
    return (last + 1) % count;
  }

  private drawRand(st: { rngState: number }): number {
    const r = emitterRand(st.rngState);
    st.rngState = r.state;
    return r.value;
  }

  private drawGapMs(st: { rngState: number }, minSec: number, maxSec: number): number {
    return (minSec + this.drawRand(st) * (maxSec - minSec)) * 1000;
  }

  private observeRevives(players: Iterable<WaveFramePlayer>): void {
    const live = new Set<string>();
    for (const p of players) {
      live.add(p.id);
      const isChanneling = p.isDown && p.reviveProgress > 0;
      const wasChanneling = this.reviveChannels.has(p.id);
      if (isChanneling && !wasChanneling) {
        this.reviveChannels.add(p.id);
        this.play("revive.channelStart", { x: p.x, y: p.y, entityId: p.id });
        this.startLoop("revive.channelLoop", p.id);
      } else if (isChanneling) {
        this.startLoop("revive.channelLoop", p.id); // idempotent hold + late decode start
      } else if (!isChanneling && wasChanneling) {
        this.reviveChannels.delete(p.id);
        this.stopLoop("revive.channelLoop", p.id);
        if (p.isDown) this.play("revive.cancel", { x: p.x, y: p.y }); // still down = broken, not completed
      }
    }
    for (const pid of this.reviveChannels) {
      if (live.has(pid)) continue;
      this.reviveChannels.delete(pid);
      this.stopLoop("revive.channelLoop", pid);
    }
  }

  // ---- preload (§10 + first-trigger contract) ----
  // Decode every cue this floor can REACH before it can trigger: the biome bed, the
  // hazard kit, the boss actually here, every spawned archetype's tells, and the
  // always-reachable player-driven set (weapons, revive channel). Each event's authored
  // fallback sample is decoded too, so even a pending-asset row's first trigger plays a
  // ready authored buffer instead of racing its load.

  preloadForFloor(
    zoneIndex: number,
    bossKind: string | null,
    enemyKinds?: Iterable<string>,
    presentationEvents?: Iterable<WaveEventId>,
  ): void {
    const stems: string[] = [];
    const samples: SfxName[] = [];
    const collect = (event: WaveEventId): void => {
      this.collectStems(event, stems);
      const fb = waveSpecOf(event).fallback;
      if (fb && samples.indexOf(fb.sample) === -1) samples.push(fb.sample);
    };
    const zoneEvent = AMBIENT_ZONE_EVENTS[zoneIndex];
    if (zoneEvent) collect(zoneEvent);
    // The Deep's bed is authored silence — its sparse emitter channels load instead
    // (channels awaiting selection contribute no stems).
    if (zoneEvent === "ambient.deep") for (const ch of DEEP_EMITTER.channels) collect(ch.event);
    for (const event of HAZARD_WAVE_EVENTS) collect(event);
    for (const event of ALWAYS_REACHABLE_EVENTS) collect(event);
    if (presentationEvents) for (const event of presentationEvents) collect(event);
    if (bossKind) for (const event of bossWaveEvents(bossKind)) collect(event);
    // The floor's actual encounter kinds preload alongside the boss (contract): the
    // first rootward on a floor never announces itself through a fallback. Both cue
    // surfaces load — the tell-watcher rows (bossWaveEvents) and the bestiary hook
    // manifest (bestiaryPreloadEvents).
    if (enemyKinds) {
      const seen = new Set<string>();
      for (const kind of enemyKinds) {
        if (seen.has(kind) || kind === bossKind) continue;
        seen.add(kind);
        for (const event of bossWaveEvents(kind)) collect(event);
        for (const event of bestiaryPreloadEvents(kind as EnemyKind)) collect(event);
      }
    }
    this.engine.preloadWave(stems);
    this.engine.preloadSamples(samples);
  }

  // Decode the PvP kill/death/match-flow cues on match entry so the FIRST frag/death/GO never
  // races its load (a frag is never culled — it must also never be silent on the first kill).
  preloadPvp(): void {
    const stems: string[] = [];
    for (const event of PVP_WAVE_EVENTS) this.collectStems(event, stems);
    this.engine.preloadWave(stems);
  }

  // The bespoke entrance for a boss-grade body (bosses at floor load, captains on spawn).
  bossEntrance(kind: string, x?: number, y?: number, entityId?: number): boolean {
    const event = WAVE_BOSS_ENTRANCE[kind];
    if (!event) return false;
    this.play(event, { x, y, entityId });
    return true;
  }

  // Fresh run / floor teardown: silence every keyed loop and drop per-entity memory.
  // Cooldowns/variants survive (they are anti-spam, not run state).
  reset(): void {
    this.stopAllLoops();
    this.tells.clear();
    this.beams.clear();
    this.reviveChannels.clear();
    this.burrowEmitters.clear();
    this.deepEmitter = null;
    this.ambientZone = null;
    this.isInCombat = false;
  }

  onFloorLoad(): void {
    // Entity ids restart per floor: drop tell memory, every entity-keyed loop, and every
    // entity-keyed emitter; keep the ambient zone (setAmbientZone crossfades it) and
    // self-keyed beam state. Group beds (flock/orbit) are stopped explicitly.
    this.stopLoop("flock.bed", GROUP_LOOP_KEY);
    this.stopLoop("orbit.loop", GROUP_LOOP_KEY);
    this.tells.clear();
    this.burrowEmitters.clear();
    for (const pid of this.reviveChannels) this.stopLoop("revive.channelLoop", pid);
    this.reviveChannels.clear();
  }

  // Variant selection over the event's SELECTED take set: an exact index wins (weighted
  // emitter draws own their pick AND anti-repeat rule); seeded emitters may pass a
  // deterministic roll; everything else rides Math.random. The uniform paths never play
  // the same take back-to-back (single-take selections necessarily repeat).
  private pickVariant(event: WaveEventId, spec: WaveSoundSpec, roll?: number, exactIndex?: number): number {
    const count = takeStemsOf(spec).length;
    if (count <= 1) return 0;
    if (exactIndex !== undefined) return Math.min(count - 1, Math.max(0, exactIndex));
    const last = this.lastVariant.get(event);
    let index = Math.floor((roll ?? Math.random()) * count) % count;
    if (index === last) index = (index + 1) % count; // never the same take twice
    return index;
  }

  private stemForVariant(spec: WaveSoundSpec, variantIndex: number): string | null {
    const takes = takeStemsOf(spec);
    return takes[variantIndex] ?? null;
  }

  private collectStems(event: WaveEventId, out: string[]): void {
    out.push(...takeStemsOf(waveSpecOf(event)));
  }

  private loopKey(event: WaveEventId, key: string): string {
    return key === "" ? event : `${event}#${key}`;
  }
}

export { WaveAudioDirector };

export const waveAudio = new WaveAudioDirector(audio);
