// Sample-based WebAudio sound engine. The game ships real, authored audio files under
// public/audio/ (per-weapon shots, enemy/player feedback, pickups, boss, plus two looping
// instrumental tracks). We fetch + decode those into AudioBuffers on demand and play
// one-shots through a gain bus.
//
// AUTHORED-ONLY CONTRACT (playtest audit): this engine never synthesizes sound at runtime.
// There are no OscillatorNodes, no procedurally generated noise buffers, and no scheduled
// synth music anywhere in user-facing play. Every voice is a decoded authored file. When a
// file is missing it either falls back to another AUTHORED sample declared safe to reuse
// (rate within the SAFE_DERIVE band) or fails quietly — silence, never a beep. Missing
// assets are explicit hooks: the file path is committed here/in waveSpec.ts and the
// generation pipeline ships the binary later (see docs/audio/AUDIO_ASSET_INVENTORY.md).
//
// Anti-repetition: combat sounds ship variant takes (_v1.._vN); every play picks one at
// random and every one-shot gets a ±5% playbackRate jitter.
//
// Browser rule: an AudioContext starts "suspended" and can only be resumed inside a user
// gesture. We create it lazily and resume on the first pointer/key/touch event (and again
// whenever the tab regains focus). Music playback and buffer decoding only happen once the
// context is actually "running", so there is no autoplay violation and no silent backlog.
//
// Nothing here runs in the per-frame hot path: sounds are event-driven, decoded buffers are
// cached (never re-fetched per play), and only cheap node allocation happens per one-shot.

import { settings } from "./settings.js";
import {
  MAX_GLOBAL_VOICES, MAX_VOICES_PER_EVENT, BOSS_LOCK_RESERVED_VOICES, WAVE_PRIORITY, WAVE_BUS_GAIN,
} from "./waveSpec.js";
import type { WaveBusId, DuckBusId, WaveDuck, WaveSampleFallback } from "./waveSpec.js";

export type SfxName =
  | "shootPistol"
  | "shootShotgun"
  | "shootRapid"
  | "smg"
  | "cannon"
  | "burst"
  | "ricochet"
  | "homing"
  | "tesla"
  | "meleeSwing"
  | "meleeHit"
  | "heavySwing"
  | "parry"
  | "crit"
  | "levelup"
  | "blessing"
  | "enemyAttack"
  | "enemyHit"
  | "enemyDeath"
  | "playerHurt"
  | "dash"
  | "coin"
  | "chest"
  | "barrel"
  | "heart"
  | "weapon"
  | "descend"
  | "floorClear"
  | "bossSpawn"
  | "gameOver"
  | "revive"
  | "uiClick";

export type MusicKind = "dungeon" | "boss" | null;

export interface SfxOptions {
  gain?: number; // 0..1 scales this play's loudness (used to attenuate far-off co-op events)
  rate?: number; // pitch/speed multiplier; a small per-play jitter is always applied on top
}

// A fully resolved wave-manifest one-shot: the director (waveAudio.ts) picks the variant,
// applies jitter/attenuation/cooldowns, and hands the engine pure playback mechanics.
export interface WavePlayRequest {
  event: string;
  bus: WaveBusId;
  priority: number;
  gain: number;
  rate: number;
  stem: string | null; // wave file path under public/audio/ (null = fallback-only row)
  fallback?: WaveSampleFallback;
  duck?: readonly WaveDuck[];
}

// A wave-manifest loop start; loops are keyed (entity/zone/channel) and stopped explicitly.
// Loops only ever start from a DECODED authored buffer — a missing loop asset kicks its
// load and stays silent until a later start finds the buffer ready (never a synth pad,
// never a mid-loop swap).
export interface WaveLoopRequest {
  event: string;
  bus: WaveBusId;
  gain: number;
  stem: string | null;
  fadeSec: number;
}

// The capability surface the wave director drives — the engine's mechanics contract,
// narrow enough that tests exercise director policy against a scripted stand-in.
export interface WaveEngine {
  now(): number;
  playWave(req: WavePlayRequest): boolean;
  startWaveLoop(key: string, req: WaveLoopRequest): boolean;
  stopWaveLoop(key: string, fadeSec?: number): void;
  hasWaveLoop(key: string): boolean;
  stopAllWaveLoops(fadeSec?: number): void;
  duckWaveBus(duck: WaveDuck): void;
  preloadWave(stems: string[]): void;
  preloadSamples(samples: readonly SfxName[]): void;
}

// Maps each logical event to a committed sample: `id` is the file stem under
// public/audio/sfx/, `variants` is how many _vN takes exist (1 = single-take, no suffix).
// `reuse` is the AUTHORED stand-in played while the primary file is missing/failed —
// safe reuse only (rate within [0.85, 1.15]); an entry without one fails quietly.
export interface SampleSpec {
  id: string;
  variants: number;
  mix?: number; // per-sound loudness trim (0..1, default 1) — the hand-tuned mix balance
  reuse?: { sample: SfxName; rate?: number };
}

export const SAMPLES: Partial<Record<SfxName, SampleSpec>> = {
  shootPistol: { id: "pistol", variants: 3, mix: 0.7 },
  shootShotgun: { id: "shotgun", variants: 3, mix: 0.85 },
  shootRapid: { id: "rapid", variants: 3, mix: 0.5 },
  smg: { id: "smg", variants: 3, mix: 0.5 },
  cannon: { id: "cannon", variants: 3, mix: 1.0 },
  burst: { id: "burst", variants: 3, mix: 0.65 },
  ricochet: { id: "ricochet", variants: 3, mix: 0.7 },
  homing: { id: "homing", variants: 3, mix: 0.6 },
  tesla: { id: "tesla", variants: 3, mix: 0.7 },
  meleeSwing: { id: "meleeSwing", variants: 3, mix: 0.6 },
  meleeHit: { id: "meleeHit", variants: 3, mix: 0.8 },
  heavySwing: { id: "heavySwing", variants: 1, mix: 0.85 },
  parry: { id: "parry", variants: 1, mix: 0.8 },
  crit: { id: "crit", variants: 1, mix: 0.55 },
  levelup: { id: "levelup", variants: 1, mix: 0.85 },
  blessing: { id: "blessing", variants: 1, mix: 0.8 },
  enemyAttack: { id: "enemyAttack", variants: 3, mix: 0.6 },
  enemyHit: { id: "enemyHit", variants: 3, mix: 0.55 },
  enemyDeath: { id: "enemyDeath", variants: 3, mix: 0.7 },
  playerHurt: { id: "playerHurt", variants: 1, mix: 0.9 },
  dash: { id: "dash", variants: 1, mix: 0.35 },
  coin: { id: "coin", variants: 1, mix: 0.5 },
  chest: { id: "chest", variants: 1, mix: 1.0 },
  barrel: { id: "barrel", variants: 1, mix: 0.9 },
  heart: { id: "heart", variants: 1, mix: 0.7 },
  weapon: { id: "weaponPickup", variants: 1, mix: 0.75 },
  descend: { id: "descend", variants: 1, mix: 0.7 },
  floorClear: { id: "floorClear", variants: 1, mix: 0.75 },
  bossSpawn: { id: "bossRoar", variants: 1, mix: 1.0 },
  gameOver: { id: "gameOver", variants: 1, mix: 0.85 },
  // ASSET HOOK (P0): public/audio/sfx/revive.{ogg,mp3} is not shipped yet. Until it lands
  // the revive sting reuses the authored heart chime at natural pitch — warm, ascending,
  // the same "life restored" family — never a synthesized stand-in.
  revive: { id: "revive", variants: 1, mix: 0.8, reuse: { sample: "heart" } },
  // ASSET HOOK (P0): public/audio/sfx/uiClick.{ogg,mp3} is not shipped yet. Safe reuse:
  // the authored coin chime, slightly brightened, trimmed well down for UI duty.
  uiClick: { id: "uiClick", variants: 1, mix: 0.3, reuse: { sample: "coin", rate: 1.1 } },
};

// Loaded up-front on the first user gesture so the frequent gameplay sounds are ready
// before the first shot; everything else lazy-loads on first use.
const PRELOAD: SfxName[] = [
  "shootPistol", "shootShotgun", "shootRapid", "smg", "cannon", "burst", "ricochet",
  "homing", "tesla", "meleeSwing", "meleeHit", "heavySwing", "parry", "crit",
  "enemyAttack", "enemyHit", "enemyDeath", "playerHurt", "dash",
  "coin", "heart", "revive", "uiClick",
];

const MUSIC_FADE = 0.3;    // seconds of crossfade when swapping / starting / stopping tracks
const PITCH_JITTER = 0.1;  // ±5% playbackRate spread applied to every one-shot

interface WebkitWindow {
  webkitAudioContext?: typeof AudioContext;
}

// A live wave voice — tracked for the manifest's voice budget + priority stealing.
interface WaveVoice {
  event: string;
  priority: number;
  gain: GainNode;
  sources: AudioScheduledSourceNode[];
  pending: number; // sources still sounding; the voice frees when this reaches 0
}

interface WaveLoopVoice {
  key: string;
  gain: GainNode;
  sources: AudioScheduledSourceNode[];
}

// Active duck per duckable bus: a deeper concurrent duck wins until it expires.
interface DuckState {
  target: number;
  until: number;
}

class AudioEngine implements WaveEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  // Each duckable category is TWO series gain nodes: the user node (slider, curved gain)
  // feeding a duck node (automation, rests at 1.0, dips during ducks). Sliders write the
  // user node and ducks write the duck node, so they multiply instead of clobbering each
  // other's scheduled ramps — a slider move mid-duck lands on the NEW volume.
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private musicDuck: GainNode | null = null;

  // Sample cache: buffers keyed by file stem ("pistol_v2", "coin"); loading/failed keyed
  // by SampleSpec.id so a sound is loaded once and, on failure, routes to its safe reuse
  // (or silence).
  private buffers = new Map<string, AudioBuffer>();
  private loadingIds = new Set<string>();
  private failedIds = new Set<string>();
  private ext: "ogg" | "mp3" | null = null;

  // Streamed music: a looping BufferSource per track, crossfaded through its own gain.
  // A track that fails to load stays SILENT — there is no procedural score.
  private musicBuffers = new Map<Exclude<MusicKind, null>, AudioBuffer>();
  private musicLoading = new Set<Exclude<MusicKind, null>>();
  private failedMusic = new Set<Exclude<MusicKind, null>>();
  private musicSource: AudioBufferSourceNode | null = null;
  private musicSourceGain: GainNode | null = null;
  private playingKind: MusicKind = null;

  private currentKind: MusicKind = null;

  private sfxActive = new Map<SfxName, number>();
  private sfxLastAt = new Map<SfxName, number>();

  // ---- wave layer state (manifest voices, loops, buses, ducking) ----
  private voiceTellBus: GainNode | null = null;
  private ambientBus: GainNode | null = null;
  private ambientDuck: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private petBus: GainNode | null = null;
  private petDuck: GainNode | null = null;
  private waveVoices: WaveVoice[] = [];
  private waveLoops = new Map<string, WaveLoopVoice>();
  private waveBuffers = new Map<string, AudioBuffer>();
  private waveLoading = new Set<string>();
  private failedWave = new Set<string>();
  private waveFallbackLogged = new Set<string>();
  private duckStates = new Map<DuckBusId, DuckState>();

  constructor() {
    const onGesture = () => this.unlock();
    // Not `once`: if the tab is backgrounded the context can re-suspend, so let any
    // later gesture wake it again. unlock() is cheap and idempotent.
    window.addEventListener("pointerdown", onGesture, { passive: true });
    window.addEventListener("keydown", onGesture, { passive: true });
    window.addEventListener("touchstart", onGesture, { passive: true });
    settings.onChange(() => this.applyVolumes());
  }

  // Create + resume the context. Safe to call repeatedly (it is wired to every gesture
  // incl. movement keys); must originate from a user gesture the first time or the
  // browser keeps it suspended. resume() is async, so we (re)apply music once it lands.
  unlock(): void {
    this.ensureContext();
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      void ctx.resume().then(() => this.onRunning());
    } else {
      this.onRunning();
    }
  }

  private onRunning(): void {
    this.preload();
    this.applyMusic();
  }

  sfx(name: SfxName, opts?: SfxOptions): void {
    if (settings.isMuted) return;
    this.ensureContext();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const gain = opts?.gain ?? 1;
    if (gain <= 0.001) return;
    const lastAt = this.sfxLastAt.get(name) ?? 0;
    if (t - lastAt < 0.015) return;
    const active = this.sfxActive.get(name) ?? 0;
    if (active >= 6) return;
    this.sfxLastAt.set(name, t);
    this.sfxActive.set(name, active + 1);
    window.setTimeout(() => {
      const c = this.sfxActive.get(name) ?? 1;
      this.sfxActive.set(name, Math.max(0, c - 1));
    }, this.sfxMaxDur(name) * 1000 + 20);

    // A caller may pin the pitch (e.g. a deep boss thud); a subtle jitter rides on top
    // of that so even repeated identical events never phase into a single grating tone.
    const rate = (opts?.rate ?? 1) * (1 + (Math.random() - 0.5) * PITCH_JITTER);

    // Loud impacts briefly duck the music so they punch through — applied regardless of
    // whether the primary or its safe reuse ends up sounding.
    if (name === "playerHurt") this.duckMusic(0.5, 0.12, 0.5);
    else if (name === "bossSpawn") this.duckMusic(0.3, 0.2, 0.8);

    const spec = SAMPLES[name];
    if (spec) this.playSample(spec, rate, gain);
    // No entry = no authored asset mapped: the event stays silent (never a synth voice).
  }

  // ---- sample loading + playback ------------------------------------------------------

  // Prefer Ogg/Vorbis (Chrome/Firefox); fall back to MP3 where Ogg isn't decodable (Safari).
  private extension(): "ogg" | "mp3" {
    if (this.ext) return this.ext;
    let chosen: "ogg" | "mp3" = "mp3";
    try {
      const el = document.createElement("audio");
      if (typeof el.canPlayType === "function" && el.canPlayType('audio/ogg; codecs="vorbis"') !== "") {
        chosen = "ogg";
      }
    } catch {
      chosen = "mp3";
    }
    this.ext = chosen;
    return chosen;
  }

  // BASE_URL is a Vite build constant; headless test runners (tsx) have no import.meta.env,
  // so read it defensively — the served game always gets the real base.
  private baseUrl(): string {
    const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
    return env?.BASE_URL ?? "/";
  }

  private sfxUrl(fileStem: string): string {
    return `${this.baseUrl()}audio/sfx/${fileStem}.${this.extension()}`;
  }

  private musicUrl(kind: Exclude<MusicKind, null>): string {
    return `${this.baseUrl()}audio/music/${kind}.${this.extension()}`;
  }

  private fileStems(spec: SampleSpec): string[] {
    if (spec.variants <= 1) return [spec.id];
    const stems: string[] = [];
    for (let v = 1; v <= spec.variants; v++) stems.push(`${spec.id}_v${v}`);
    return stems;
  }

  private async fetchDecode(url: string): Promise<AudioBuffer> {
    const ctx = this.ctx;
    if (!ctx) throw new Error("no audio context");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    const bytes = await res.arrayBuffer();
    return await ctx.decodeAudioData(bytes);
  }

  private preload(): void {
    for (const name of PRELOAD) {
      const spec = SAMPLES[name];
      if (spec) this.ensureLoaded(spec);
    }
  }

  private ensureLoaded(spec: SampleSpec): void {
    if (this.loadingIds.has(spec.id) || this.failedIds.has(spec.id)) return;
    const stems = this.fileStems(spec);
    if (stems.every((s) => this.buffers.has(s))) return;
    this.loadingIds.add(spec.id);
    Promise.all(stems.map((s) => this.fetchDecode(this.sfxUrl(s)).then((buf) => this.buffers.set(s, buf))))
      .then(() => { this.loadingIds.delete(spec.id); })
      .catch(() => { this.loadingIds.delete(spec.id); this.failedIds.add(spec.id); });
  }

  // The decoded buffer for one play of `spec`, or null while loading/failed. Kicks the
  // load so a later play finds it ready.
  private sampleBuffer(spec: SampleSpec): AudioBuffer | null {
    this.ensureLoaded(spec);
    const stem = spec.variants <= 1
      ? spec.id
      : `${spec.id}_v${1 + Math.floor(Math.random() * spec.variants)}`;
    return this.buffers.get(stem) ?? null;
  }

  private playSample(spec: SampleSpec, rate: number, gain: number): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus) return;
    let buf = this.sampleBuffer(spec);
    let effectiveRate = rate;
    const mix = spec.mix ?? 1;
    if (!buf && spec.reuse) {
      // Primary missing/failed: the declared authored stand-in, safe-reuse rate only.
      const reuseSpec = SAMPLES[spec.reuse.sample];
      if (reuseSpec) {
        buf = this.sampleBuffer(reuseSpec);
        effectiveRate = rate * (spec.reuse.rate ?? 1);
      }
    }
    if (!buf) return; // still loading or missing with no safe reuse — fail quietly
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.max(0.01, effectiveRate);
    const g = ctx.createGain();
    g.gain.value = gain * mix;
    src.connect(g).connect(bus);
    src.start();
  }

  // ---- music --------------------------------------------------------------------------

  setMusic(kind: MusicKind): void {
    if (kind === this.currentKind) return;
    this.currentKind = kind;
    this.applyMusic();
  }

  private applyMusic(): void {
    const kind = this.currentKind;
    if (!kind || settings.isMuted) { this.stopMusic(); return; }
    this.ensureContext();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return; // resume() re-applies once it resolves

    // A failed track stays silent: there is no procedural score to fall back to.
    if (this.failedMusic.has(kind)) { this.fadeOutMusicSource(); return; }

    const buf = this.musicBuffers.get(kind);
    if (!buf) { this.loadMusic(kind); return; }

    if (this.playingKind === kind && this.musicSource) return; // already looping this one
    this.startMusicSource(buf, kind);
  }

  private loadMusic(kind: Exclude<MusicKind, null>): void {
    if (this.musicLoading.has(kind) || this.musicBuffers.has(kind)) return;
    this.musicLoading.add(kind);
    this.fetchDecode(this.musicUrl(kind))
      .then((buf) => { this.musicBuffers.set(kind, buf); this.musicLoading.delete(kind); this.applyMusic(); })
      .catch(() => { this.musicLoading.delete(kind); this.failedMusic.add(kind); this.applyMusic(); });
  }

  private startMusicSource(buf: AudioBuffer, kind: Exclude<MusicKind, null>): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    const now = ctx.currentTime;
    this.fadeOutMusicSource();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(1, now + MUSIC_FADE);
    src.connect(g).connect(bus);
    src.start(now);
    this.musicSource = src;
    this.musicSourceGain = g;
    this.playingKind = kind;
  }

  private fadeOutMusicSource(): void {
    const ctx = this.ctx;
    const src = this.musicSource;
    const g = this.musicSourceGain;
    if (!ctx || !src || !g) return;
    const now = ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(0.0001, now + MUSIC_FADE);
    try { src.stop(now + MUSIC_FADE + 0.02); } catch { /* already stopped */ }
    this.musicSource = null;
    this.musicSourceGain = null;
  }

  private stopMusic(): void {
    this.fadeOutMusicSource();
    this.playingKind = null;
  }

  // ---- wave layer (manifest-driven voices, loops, buses, ducking) -----------------------
  // Mechanism only: the director (waveAudio.ts) owns manifest policy (variants, jitter,
  // cooldowns, attenuation, lifecycle) and hands this engine fully resolved requests.

  // Engine clock in ms, or -1 while no running context exists (callers treat -1 as
  // "audio off": state machines idle, nothing plays, nothing accrues cooldowns).
  now(): number {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return -1;
    return ctx.currentTime * 1000;
  }

  busNode(bus: WaveBusId | "music"): GainNode | null {
    switch (bus) {
      case "sfx": return this.sfxBus;
      case "voiceTell": return this.voiceTellBus;
      case "ambient": return this.ambientBus;
      case "ui": return this.uiBus;
      case "pet": return this.petBus;
      case "music": return this.musicBus;
    }
  }

  // The automation node of a duckable category (in series after its user node).
  duckNode(bus: DuckBusId): GainNode | null {
    switch (bus) {
      case "music": return this.musicDuck;
      case "ambient": return this.ambientDuck;
      case "pet": return this.petDuck;
    }
  }

  waveVoiceCount(): number {
    return this.waveVoices.length;
  }

  waveVoiceCountFor(event: string): number {
    let n = 0;
    for (const v of this.waveVoices) if (v.event === event) n++;
    return n;
  }

  isWavePlaying(event: string): boolean {
    return this.waveVoiceCountFor(event) > 0;
  }

  playWave(req: WavePlayRequest): boolean {
    if (settings.isMuted) return false;
    const ctx = this.ctx;
    const bus = this.busNode(req.bus);
    if (!ctx || ctx.state !== "running" || !bus) return false;
    if (req.gain <= 0.001) return false;
    if (!this.admitWaveVoice(req.event, req.priority)) return false;

    const voiceGain = ctx.createGain();
    voiceGain.gain.value = req.gain;
    voiceGain.connect(bus);
    const sources = this.buildWaveSources(req, voiceGain);
    if (sources.length === 0) {
      voiceGain.disconnect();
      return false;
    }

    const voice: WaveVoice = { event: req.event, priority: req.priority, gain: voiceGain, sources, pending: sources.length };
    for (const src of sources) {
      src.onended = () => {
        voice.pending--;
        if (voice.pending <= 0) {
          const at = this.waveVoices.indexOf(voice);
          if (at !== -1) this.waveVoices.splice(at, 1);
        }
      };
    }
    this.waveVoices.push(voice);
    if (req.duck) for (const d of req.duck) this.duckWaveBus(d);
    return true;
  }

  startWaveLoop(key: string, req: WaveLoopRequest): boolean {
    if (this.waveLoops.has(key)) return true; // already sounding — NEVER a duplicate voice
    if (settings.isMuted) return false;
    const ctx = this.ctx;
    const bus = this.busNode(req.bus);
    if (!ctx || ctx.state !== "running" || !bus) return false;
    if (req.stem === null) return false; // loops have no fallback lane: authored file or silence

    const buf = this.waveBuffers.get(req.stem);
    if (!buf) {
      // Not decoded yet (or 404): kick the load and stay silent. Level-triggered callers
      // (the director's holds) retry, so the authored loop starts cleanly once ready —
      // never a synth pad, never a mid-loop source swap.
      this.ensureWaveLoaded([req.stem]);
      return false;
    }
    const voiceGain = ctx.createGain();
    voiceGain.connect(bus);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(voiceGain);
    src.start();
    const now = ctx.currentTime;
    if (req.fadeSec > 0.01) {
      this.rampEqualPower(voiceGain.gain, 0, req.gain, now, req.fadeSec, true);
    } else {
      voiceGain.gain.setValueAtTime(req.gain, now);
    }
    this.waveLoops.set(key, { key, gain: voiceGain, sources: [src] });
    return true;
  }

  stopWaveLoop(key: string, fadeSec = 0.12): void {
    const loop = this.waveLoops.get(key);
    if (!loop) return;
    this.waveLoops.delete(key);
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.rampEqualPower(loop.gain.gain, loop.gain.gain.value, 0, now, Math.max(0.01, fadeSec), false);
    for (const src of loop.sources) {
      try { src.stop(now + fadeSec + 0.02); } catch { /* already stopped */ }
    }
  }

  hasWaveLoop(key: string): boolean {
    return this.waveLoops.has(key);
  }

  waveLoopKeys(): string[] {
    return [...this.waveLoops.keys()];
  }

  stopAllWaveLoops(fadeSec = 0.2): void {
    for (const key of [...this.waveLoops.keys()]) this.stopWaveLoop(key, fadeSec);
  }

  // Manifest §1 duck notation: bus to base×to, hold, then recover. A deeper duck in
  // flight wins over a shallower one until it expires — locks never lose their headroom.
  // Ducks only ever write the category's DUCK node (a multiplier resting at 1.0), so the
  // user's slider node is untouched and a mid-duck slider move still lands.
  duckWaveBus(duck: WaveDuck): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const node = this.duckNode(duck.bus);
    if (!node) return;
    const now = ctx.currentTime;
    const active = this.duckStates.get(duck.bus);
    if (active && now < active.until && active.target <= duck.to) return;
    node.gain.cancelScheduledValues(now);
    node.gain.setTargetAtTime(duck.to, now, 0.02);
    node.gain.setTargetAtTime(1, now + duck.hold, Math.max(0.01, duck.recover) / 3);
    this.duckStates.set(duck.bus, { target: duck.to, until: now + duck.hold + duck.recover });
  }

  preloadWave(stems: string[]): void {
    this.ensureWaveLoaded(stems);
  }

  // Decode the shipped-library samples a floor's fallbacks may reach, so even a
  // first-trigger fallback plays a ready authored buffer (item: no first-use synth,
  // no silent first hit where a safe reuse exists).
  preloadSamples(samples: readonly SfxName[]): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    for (const name of samples) {
      const spec = SAMPLES[name];
      if (!spec) continue;
      this.ensureLoaded(spec);
      if (spec.reuse) {
        const reuseSpec = SAMPLES[spec.reuse.sample];
        if (reuseSpec) this.ensureLoaded(reuseSpec);
      }
    }
  }

  isWaveBufferReady(stem: string): boolean {
    return this.waveBuffers.has(stem);
  }

  waveFetchFailures(): number {
    return this.failedWave.size;
  }

  // Voice budget (§10): 24 global, 4 per event, 3 reserved so a bossLock can ALWAYS get a
  // voice; a full pool steals the lowest-priority strictly-quieter voice.
  private admitWaveVoice(event: string, priority: number): boolean {
    if (this.waveVoiceCountFor(event) >= MAX_VOICES_PER_EVENT) return false;
    const cap = priority >= WAVE_PRIORITY.bossLock ? MAX_GLOBAL_VOICES : MAX_GLOBAL_VOICES - BOSS_LOCK_RESERVED_VOICES;
    if (this.waveVoices.length < cap) return true;
    let victim: WaveVoice | null = null;
    for (const v of this.waveVoices) {
      if (v.priority >= priority) continue;
      if (!victim || v.priority < victim.priority) victim = v;
    }
    if (!victim) return false;
    this.stopWaveVoice(victim);
    return this.waveVoices.length < MAX_GLOBAL_VOICES;
  }

  private stopWaveVoice(voice: WaveVoice): void {
    const at = this.waveVoices.indexOf(voice);
    if (at !== -1) this.waveVoices.splice(at, 1);
    voice.pending = 0;
    const ctx = this.ctx;
    const now = ctx ? ctx.currentTime : 0;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setTargetAtTime(0.0001, now, 0.004); // micro-fade, never a click
    for (const src of voice.sources) {
      src.onended = null;
      try { src.stop(now + 0.03); } catch { /* already stopped */ }
    }
  }

  // Source resolution, authored buffers only: the generated wave file when its buffer is
  // ready; else the declared safe-reuse fallback (an existing shipped sample through
  // pitch/filters inside the safe band) when ITS buffer is ready; else nothing — the play
  // fails quietly. Missing primaries kick a load so the real file takes over on later
  // plays (and the preload plan decodes reachable cues before their first trigger).
  private buildWaveSources(req: WavePlayRequest, out: GainNode): AudioScheduledSourceNode[] {
    const ctx = this.ctx;
    if (!ctx) return [];
    if (req.stem !== null) {
      const buf = this.waveBuffers.get(req.stem);
      if (buf) {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = Math.max(0.01, req.rate);
        src.connect(out);
        src.start();
        return [src];
      }
      this.ensureWaveLoaded([req.stem]);
      if (this.failedWave.has(req.stem) && !this.waveFallbackLogged.has(req.stem)) {
        this.waveFallbackLogged.add(req.stem);
        console.info(`[audio] wave file missing, using authored fallback/silence: ${req.stem}`);
      }
    }
    const fb = req.fallback;
    if (!fb) return [];
    const spec = SAMPLES[fb.sample];
    if (!spec) return [];
    const buf = this.sampleBuffer(spec);
    if (!buf) return [];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.max(0.01, req.rate * (fb.rate ?? 1));
    const tail = this.connectFilters(src, fb.lowpassHz, fb.highpassHz);
    tail.connect(out);
    src.start();
    return [src];
  }

  private connectFilters(src: AudioNode, lowpassHz?: number, highpassHz?: number): AudioNode {
    const ctx = this.ctx;
    if (!ctx) return src;
    let tail: AudioNode = src;
    if (lowpassHz !== undefined) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = lowpassHz;
      tail.connect(lp);
      tail = lp;
    }
    if (highpassHz !== undefined) {
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = highpassHz;
      tail.connect(hp);
      tail = hp;
    }
    return tail;
  }

  private waveUrl(stem: string): string {
    return `${this.baseUrl()}audio/${stem}.${this.extension()}`;
  }

  private ensureWaveLoaded(stems: string[]): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return; // gesture policy: no fetches before unlock
    for (const stem of stems) {
      if (this.waveBuffers.has(stem) || this.waveLoading.has(stem) || this.failedWave.has(stem)) continue;
      this.waveLoading.add(stem);
      this.fetchDecode(this.waveUrl(stem))
        .then((buf) => { this.waveBuffers.set(stem, buf); this.waveLoading.delete(stem); })
        .catch(() => { this.waveLoading.delete(stem); this.failedWave.add(stem); });
    }
  }

  // Equal-power fade (manifest loop contract): sin/cos curve so a zone crossfade holds
  // constant perceived level instead of dipping in the middle.
  private rampEqualPower(param: AudioParam, from: number, to: number, at: number, dur: number, isIn: boolean): void {
    const steps = 24;
    const curve = new Float32Array(steps + 1);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const shaped = isIn ? Math.sin(t * Math.PI / 2) : Math.cos(t * Math.PI / 2);
      curve[i] = Math.max(0.0001, from + (to - from) * (isIn ? shaped : 1 - shaped));
    }
    param.cancelScheduledValues(at);
    try {
      param.setValueCurveAtTime(curve, at, dur);
    } catch {
      param.setValueAtTime(from, at);
      param.linearRampToValueAtTime(to, at + dur);
    }
  }

  // Slider writes go ONLY to the user nodes (curved gains). Duck automation lives on its
  // own series nodes, so a mid-duck slider move needs no reset: the duck recovers to 1.0
  // and the product lands on the new user gain.
  private applyVolumes(): void {
    const ctx = this.ctx;
    const now = ctx?.currentTime ?? 0;
    if (ctx && this.master) {
      this.master.gain.setTargetAtTime(settings.isMuted ? 0 : settings.masterGain, now, 0.02);
    }
    if (ctx && this.sfxBus) {
      this.sfxBus.gain.setTargetAtTime(settings.sfxGain, now, 0.02);
    }
    if (ctx && this.musicBus) {
      this.musicBus.gain.setTargetAtTime(settings.musicGain, now, 0.02);
    }
    if (ctx) {
      const waveBuses: [GainNode | null, number][] = [
        [this.voiceTellBus, WAVE_BUS_GAIN.voiceTell],
        [this.ambientBus, WAVE_BUS_GAIN.ambient],
        [this.uiBus, WAVE_BUS_GAIN.ui],
        [this.petBus, WAVE_BUS_GAIN.pet],
      ];
      for (const [bus, base] of waveBuses) {
        if (bus) bus.gain.setTargetAtTime(base * settings.sfxGain, now, 0.02);
      }
    }
    if (settings.isMuted) this.stopMusic();
    else this.applyMusic();
  }

  // Legacy hardcoded music duck (playerHurt/bossSpawn): a relative dip on the music duck
  // node — never the slider node — recovering to unity.
  private duckMusic(toRatio: number, holdSec: number, recoverSec: number): void {
    const ctx = this.ctx;
    const node = this.musicDuck;
    if (!ctx || !node) return;
    const now = ctx.currentTime;
    node.gain.cancelScheduledValues(now);
    node.gain.setTargetAtTime(toRatio, now, 0.02);
    node.gain.setTargetAtTime(1, now + holdSec, recoverSec / 3);
  }

  private ensureContext(): void {
    if (this.ctx) return;
    const w = window as Window & WebkitWindow;
    const Ctor = window.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = settings.isMuted ? 0 : settings.masterGain;
    // The compressor sits post-master with no makeup gain, so a low master never pumps
    // the mix back up.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.knee.value = 6;
    master.connect(comp);
    comp.connect(ctx.destination);
    this.master = master;
    // Duckable categories route user node -> duck node -> master; the duck node rests
    // at 1.0 and only duck automation ever writes it.
    const makeDuck = (): GainNode => {
      const duck = ctx.createGain();
      duck.connect(master);
      return duck;
    };
    const makeBus = (gain: number, parent: GainNode): GainNode => {
      const bus = ctx.createGain();
      bus.gain.value = gain;
      bus.connect(parent);
      return bus;
    };
    this.sfxBus = makeBus(settings.sfxGain, master);
    this.musicDuck = makeDuck();
    this.musicBus = makeBus(settings.musicGain, this.musicDuck);
    // Wave-manifest buses (§1). All scale with the SFX slider — one "sound effects"
    // control governs everything that is not music, preserving the two-slider model.
    this.voiceTellBus = makeBus(WAVE_BUS_GAIN.voiceTell * settings.sfxGain, master);
    this.ambientDuck = makeDuck();
    this.ambientBus = makeBus(WAVE_BUS_GAIN.ambient * settings.sfxGain, this.ambientDuck);
    this.uiBus = makeBus(WAVE_BUS_GAIN.ui * settings.sfxGain, master);
    this.petDuck = makeDuck();
    this.petBus = makeBus(WAVE_BUS_GAIN.pet * settings.sfxGain, this.petDuck);
  }

  private sfxMaxDur(name: SfxName): number {
    switch (name) {
      case "shootPistol": return 0.12;
      case "shootShotgun": return 0.25;
      case "shootRapid": return 0.08;
      case "smg": return 0.08;
      case "cannon": return 0.3;
      case "burst": return 0.12;
      case "ricochet": return 0.12;
      case "homing": return 0.12;
      case "tesla": return 0.14;
      case "meleeSwing": return 0.18;
      case "meleeHit": return 0.16;
      case "heavySwing": return 0.32;
      case "parry": return 0.3;
      case "crit": return 0.12;
      case "levelup": return 0.6;
      case "blessing": return 0.5;
      case "enemyAttack": return 0.3;
      case "enemyHit": return 0.12;
      case "enemyDeath": return 0.25;
      case "playerHurt": return 0.32;
      case "dash": return 0.26;
      case "coin": return 0.2;
      case "chest": return 0.3;
      case "barrel": return 0.3;
      case "heart": return 0.4;
      case "weapon": return 0.2;
      case "descend": return 0.35;
      case "floorClear": return 0.5;
      case "bossSpawn": return 0.95;
      case "gameOver": return 0.75;
      case "revive": return 0.45;
      case "uiClick": return 0.07;
    }
  }
}

export { AudioEngine };

export const audio = new AudioEngine();

// Convenience free function so callers can `import { sfx } from "./audio.js"`.
export function sfx(name: SfxName, opts?: SfxOptions): void {
  audio.sfx(name, opts);
}
