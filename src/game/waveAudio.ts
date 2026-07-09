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
import type { WaveEngine } from "./audio.js";
import {
  isWaveEventId, waveSpecOf, spatialGainFor, tellCuesFor, isTrackLoopHeld,
  bossWaveEvents, PET_SIDECHAIN, BOSS_LOCK_AMBIENT_MUTE_MS, WAVE_PRIORITY,
  WAVE_BOSS_PHASE, WAVE_BOSS_DEATH, WAVE_WEAPON_FIRE, AMBIENT_ZONE_EVENTS, HAZARD_WAVE_EVENTS,
  BEAM_WEAPON_ID, BEAM_START_IDLE_MS, BEAM_STOP_GAP_MS,
} from "./waveSpec.js";
import type { WaveEventId, WaveSoundSpec, TellSnapshot } from "./waveSpec.js";

export interface WavePlayOpts {
  x?: number;
  y?: number;
  entityId?: number | string;
  gain?: number;
  rate?: number;
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
}

interface BeamState {
  lastShotAtMs: number;
  gain: number;
  holdMs: number; // stop hysteresis — wider for remote beams fed by ~10Hz presence sync
}

class WaveAudioDirector {
  private engine: WaveEngine;
  private listener: WaveListener | null = null;
  private isInCombat = false;
  private lastBossLockAtMs = -Infinity;
  private cooldownAt = new Map<string, number>();
  private lastVariant = new Map<string, number>();
  private tells = new Map<number, TellMemory>();
  private beams = new Map<string, BeamState>();
  private reviveChannels = new Set<string>();
  private ambientZone: number | null = null;
  private seenIdsScratch = new Set<number>();

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

    let gain = spec.gain * (opts?.gain ?? 1);
    if (spec.spatial && opts?.x !== undefined && opts.y !== undefined && this.listener) {
      const l = this.listener;
      const dist = Math.hypot(opts.x - l.x, opts.y - l.y);
      const isOffCamera = opts.x < l.camLeft || opts.x > l.camRight || opts.y < l.camTop || opts.y > l.camBottom;
      gain *= spatialGainFor(dist, isOffCamera, spec.isOffCameraUncapped === true);
    }
    if (gain < 0.02) return false;

    const variantIndex = this.pickVariant(event, spec);
    const rate = (opts?.rate ?? 1) * (1 + (Math.random() * 2 - 1) * spec.jitter);
    const isPlayed = this.engine.playWave({
      event,
      bus: spec.bus,
      priority: spec.priority,
      gain,
      rate,
      stem: this.stemForVariant(spec, variantIndex),
      fallback: spec.fallback,
      synth: spec.synth,
      duck: spec.duck,
    });
    if (!isPlayed) return false;
    if (spec.cooldownMs !== undefined) this.cooldownAt.set(cdKey, nowMs);
    this.lastVariant.set(event, variantIndex);
    if (spec.priority >= WAVE_PRIORITY.bossLock) {
      this.lastBossLockAtMs = nowMs;
      this.engine.duckWaveBus(PET_SIDECHAIN); // §1: pet cues never overlap boss locks
    }
    return true;
  }

  // Routes a sim `cue` event whose name is a manifest id; returns false for legacy names
  // so the caller keeps its existing SfxName path byte-identical.
  cueAt(name: string, x: number, y: number, entityId?: number): boolean {
    if (!isWaveEventId(name)) return false;
    this.play(name, { x, y, entityId });
    return true;
  }

  startLoop(event: WaveEventId, key = "", opts?: { gain?: number; fadeSec?: number }): boolean {
    const spec = waveSpecOf(event);
    if (!spec.loop) return false;
    return this.engine.startWaveLoop(this.loopKey(event, key), {
      event,
      bus: spec.bus,
      gain: spec.gain * (opts?.gain ?? 1),
      stem: spec.stem,
      synth: spec.synth,
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

  setAmbientZone(zoneIndex: number | null): void {
    if (zoneIndex !== null && (zoneIndex < 0 || zoneIndex >= AMBIENT_ZONE_EVENTS.length)) zoneIndex = null;
    if (zoneIndex === this.ambientZone) return;
    if (this.ambientZone !== null) {
      this.stopLoop(AMBIENT_ZONE_EVENTS[this.ambientZone], "zone", AMBIENT_CROSSFADE_SEC);
    }
    this.ambientZone = zoneIndex;
    if (zoneIndex !== null) {
      this.startLoop(AMBIENT_ZONE_EVENTS[zoneIndex], "zone", { fadeSec: AMBIENT_CROSSFADE_SEC });
    }
  }

  // ---- weapons (§4) ----

  isBeamWeapon(weapon: string): boolean {
    return weapon === BEAM_WEAPON_ID;
  }

  // Owns the sound of manifest-bound weapons; returns false so legacy weapons keep their
  // existing SHOOT_SFX path. Beam shots NEVER one-shot: they drive the held-loop lifecycle.
  weaponFired(weapon: string, opts?: WavePlayOpts & { beamKey?: string }): boolean {
    if (weapon === BEAM_WEAPON_ID) {
      this.beamShot(opts?.beamKey ?? "self", opts?.gain ?? 1);
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

  private beamShot(key: string, gain: number): void {
    const nowMs = this.engine.now();
    if (nowMs < 0) return;
    const state = this.beams.get(key);
    if (!state || nowMs - state.lastShotAtMs > BEAM_START_IDLE_MS) {
      this.play("beamStart", { gain });
      this.startLoop("beamLoop", key, { gain });
    }
    // Remote beams arrive through ~10Hz presence sync, slower than the 90ms local stop
    // gap; a wider hold keeps their loop from stuttering between updates.
    const holdMs = key === "self" ? BEAM_STOP_GAP_MS : BEAM_STOP_GAP_MS * 3;
    this.beams.set(key, { lastShotAtMs: nowMs, gain, holdMs });
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
    for (const e of input.enemies) {
      if (e.dead) continue;
      seen.add(e.id);
      const dist = Math.hypot(e.x - input.listener.x, e.y - input.listener.y);
      if (dist < COMBAT_RADIUS) isInCombat = true;
      this.observeEnemy(e, dist);
    }
    this.isInCombat = isInCombat;
    for (const [id, memory] of this.tells) {
      if (seen.has(id)) continue;
      if (memory.kind === "burrower") this.stopLoop("burrower.track", String(id));
      this.tells.delete(id);
    }

    this.observeRevives(input.players);

    for (const [key, beam] of this.beams) {
      if (nowMs - beam.lastShotAtMs <= beam.holdMs) continue;
      this.beams.delete(key);
      this.stopLoop("beamLoop", key);
      this.play("beamStop", { gain: beam.gain });
    }

    // Late unlock / muted-then-unmuted: (re)start the current zone bed once audio runs.
    if (this.ambientZone !== null) {
      this.startLoop(AMBIENT_ZONE_EVENTS[this.ambientZone], "zone", { fadeSec: AMBIENT_CROSSFADE_SEC });
    }
  }

  private observeEnemy(e: WaveFrameEnemy, distToListener: number): void {
    const prev = this.tells.get(e.id) ?? null;
    const cues = tellCuesFor(e.kind, prev, e.attack);
    for (const cue of cues) this.play(cue, { x: e.x, y: e.y, entityId: e.id });

    let hasAcquired = prev?.hasAcquired ?? false;
    if (e.kind === "orbiter" && !hasAcquired
      && Math.abs(distToListener - ORBITER_BAND_RADIUS) <= ORBITER_BAND_SLACK) {
      this.play("orbiter.enterBand", { x: e.x, y: e.y, entityId: e.id });
      hasAcquired = true;
    }

    if (prev && isTrackLoopHeld(e.kind, prev) !== isTrackLoopHeld(e.kind, e.attack)) {
      this.holdLoop("burrower.track", String(e.id), isTrackLoopHeld(e.kind, e.attack));
    } else if (!prev && isTrackLoopHeld(e.kind, e.attack)) {
      this.holdLoop("burrower.track", String(e.id), true);
    }

    if (prev) {
      prev.phase = e.attack.phase;
      prev.move = e.attack.move;
      prev.isAimLocked = e.attack.isAimLocked;
      prev.hasAcquired = hasAcquired;
    } else {
      this.tells.set(e.id, {
        kind: e.kind, phase: e.attack.phase, move: e.attack.move,
        isAimLocked: e.attack.isAimLocked, hasAcquired,
      });
    }
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

  // ---- preload (§10: current biome + the floor's boss; the rest lazy-loads) ----

  preloadForFloor(zoneIndex: number, bossKind: string | null): void {
    const stems: string[] = [];
    const zoneEvent = AMBIENT_ZONE_EVENTS[zoneIndex];
    if (zoneEvent) this.collectStems(zoneEvent, stems);
    for (const event of HAZARD_WAVE_EVENTS) this.collectStems(event, stems);
    if (bossKind) for (const event of bossWaveEvents(bossKind)) this.collectStems(event, stems);
    this.engine.preloadWave(stems);
  }

  // Fresh run / floor teardown: silence every keyed loop and drop per-entity memory.
  // Cooldowns/variants survive (they are anti-spam, not run state).
  reset(): void {
    this.stopAllLoops();
    this.tells.clear();
    this.beams.clear();
    this.reviveChannels.clear();
    this.ambientZone = null;
    this.isInCombat = false;
  }

  onFloorLoad(): void {
    // Entity ids restart per floor: drop tell memory and every entity-keyed loop, keep the
    // ambient zone (setAmbientZone crossfades it) and self-keyed beam state.
    for (const [id, memory] of this.tells) {
      if (memory.kind === "burrower") this.stopLoop("burrower.track", String(id));
    }
    this.tells.clear();
    for (const pid of this.reviveChannels) this.stopLoop("revive.channelLoop", pid);
    this.reviveChannels.clear();
  }

  private pickVariant(event: WaveEventId, spec: WaveSoundSpec): number {
    if (spec.variants <= 1) return 0;
    const last = this.lastVariant.get(event);
    let index = Math.floor(Math.random() * spec.variants);
    if (index === last) index = (index + 1) % spec.variants; // never the same take twice
    return index;
  }

  private stemForVariant(spec: WaveSoundSpec, variantIndex: number): string | null {
    if (spec.stem === null) return null;
    if (spec.variants <= 1) return spec.stem;
    return `${spec.stem}_v${variantIndex + 1}`;
  }

  private collectStems(event: WaveEventId, out: string[]): void {
    const spec = waveSpecOf(event);
    if (spec.stem === null) return;
    if (spec.variants <= 1) {
      out.push(spec.stem);
      return;
    }
    for (let v = 1; v <= spec.variants; v++) out.push(`${spec.stem}_v${v}`);
  }

  private loopKey(event: WaveEventId, key: string): string {
    return key === "" ? event : `${event}#${key}`;
  }
}

export { WaveAudioDirector };

export const waveAudio = new WaveAudioDirector(audio);
