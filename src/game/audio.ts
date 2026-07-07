// Sample-based WebAudio sound engine. The game ships real, pre-generated audio files
// under public/audio/ (per-weapon shots, enemy/player feedback, pickups, boss, plus two
// looping instrumental tracks). We fetch + decode those into AudioBuffers on demand and
// play one-shots through a gain bus; if a file ever fails to load/decode we fall back to
// the original procedural synth for that one sound (kept below) so a missing asset can
// never break — or throw in — the game.
//
// Anti-repetition (the whole reason samples don't sound like a stuck machine gun): combat
// sounds ship three variants (_v1/_v2/_v3); every play picks one at random and every
// one-shot gets a ±5% playbackRate jitter.
//
// Browser rule: an AudioContext starts "suspended" and can only be resumed inside a user
// gesture. We create it lazily and resume on the first pointer/key/touch event (and again
// whenever the tab regains focus). Music playback and buffer decoding only happen once the
// context is actually "running", so there is no autoplay violation and no silent backlog.
//
// Nothing here runs in the per-frame hot path: sounds are event-driven, decoded buffers are
// cached (never re-fetched per play), and only cheap node allocation happens per one-shot.

import { settings } from "./settings.js";

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

// Maps each logical event to a committed sample: `id` is the file stem under
// public/audio/sfx/, `variants` is how many _vN takes exist (1 = single-take, no suffix).
// Events with no entry (revive, uiClick) have no shipped sample and use the synth path.
interface SampleSpec {
  id: string;
  variants: number;
  mix?: number; // per-sound loudness trim (0..1, default 1) — the hand-tuned mix balance
}

const SAMPLES: Partial<Record<SfxName, SampleSpec>> = {
  shootPistol: { id: "pistol", variants: 3, mix: 0.7 },
  shootShotgun: { id: "shotgun", variants: 3, mix: 0.85 },
  shootRapid: { id: "rapid", variants: 3, mix: 0.5 },
  smg: { id: "smg", variants: 3, mix: 0.5 },
  cannon: { id: "cannon", variants: 3, mix: 1.0 },
  burst: { id: "burst", variants: 3, mix: 0.65 },
  ricochet: { id: "ricochet", variants: 3, mix: 0.7 },
  homing: { id: "homing", variants: 3, mix: 0.6 },
  tesla: { id: "tesla", variants: 3, mix: 0.7 },
  enemyAttack: { id: "enemyAttack", variants: 3, mix: 0.6 },
  enemyHit: { id: "enemyHit", variants: 3, mix: 0.55 },
  enemyDeath: { id: "enemyDeath", variants: 3, mix: 0.7 },
  playerHurt: { id: "playerHurt", variants: 1, mix: 0.9 },
  dash: { id: "dash", variants: 1, mix: 0.35 },
  coin: { id: "coin", variants: 1, mix: 0.5 },
  chest: { id: "chest", variants: 1, mix: 0.8 },
  barrel: { id: "barrel", variants: 1, mix: 0.9 },
  heart: { id: "heart", variants: 1, mix: 0.7 },
  weapon: { id: "weaponPickup", variants: 1, mix: 0.75 },
  descend: { id: "descend", variants: 1, mix: 0.7 },
  floorClear: { id: "floorClear", variants: 1, mix: 0.75 },
  bossSpawn: { id: "bossRoar", variants: 1, mix: 1.0 },
  gameOver: { id: "gameOver", variants: 1, mix: 0.85 },
};

// Loaded up-front on the first user gesture so the frequent gameplay sounds are ready
// before the first shot; everything else lazy-loads on first use.
const PRELOAD: SfxName[] = [
  "shootPistol", "shootShotgun", "shootRapid", "smg", "cannon", "burst", "ricochet",
  "homing", "tesla", "enemyAttack", "enemyHit", "enemyDeath", "playerHurt", "dash",
  "coin", "heart",
];

const MUSIC_FADE = 0.3;    // seconds of crossfade when swapping / starting / stopping tracks
const PITCH_JITTER = 0.1;  // ±5% playbackRate spread applied to every one-shot

// ---- procedural synth fallback (below) ----------------------------------------------
interface MusicTrack {
  bpm: number;
  root: number; // bass root frequency (Hz)
  bass: (number | null)[]; // semitone offsets from root (or rest) per eighth-note step
  lead: (number | null)[];
  bassType: OscillatorType;
  leadType: OscillatorType;
  bassGain: number;
  leadGain: number;
}

const DUNGEON: MusicTrack = {
  bpm: 92,
  root: 110, // A2
  bass: [0, null, null, null, 0, null, null, null, 5, null, null, null, 7, null, null, null],
  lead: [24, null, null, 27, null, null, 31, null, null, 29, null, null, 27, null, null, null],
  bassType: "triangle",
  leadType: "sine",
  bassGain: 0.32,
  leadGain: 0.16,
};

const BOSS: MusicTrack = {
  bpm: 138,
  root: 110,
  bass: [0, 0, 0, 6, 0, 0, 0, 6, 5, 5, 5, 6, 3, 3, 6, 6],
  lead: [12, 15, 19, 15, 12, 18, 19, 18, 12, 17, 19, 17, 12, 18, 22, 18],
  bassType: "sawtooth",
  leadType: "square",
  bassGain: 0.3,
  leadGain: 0.13,
};

interface WebkitWindow {
  webkitAudioContext?: typeof AudioContext;
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  // Sample cache: buffers keyed by file stem ("pistol_v2", "coin"); loading/failed keyed
  // by SampleSpec.id so a sound is loaded once and, on failure, routes to the synth.
  private buffers = new Map<string, AudioBuffer>();
  private loadingIds = new Set<string>();
  private failedIds = new Set<string>();
  private ext: "ogg" | "mp3" | null = null;

  // Streamed music: a looping BufferSource per track, crossfaded through its own gain.
  private musicBuffers = new Map<Exclude<MusicKind, null>, AudioBuffer>();
  private musicLoading = new Set<Exclude<MusicKind, null>>();
  private failedMusic = new Set<Exclude<MusicKind, null>>();
  private musicSource: AudioBufferSourceNode | null = null;
  private musicSourceGain: GainNode | null = null;
  private playingKind: MusicKind = null;

  private currentKind: MusicKind = null;

  // Synth fallback music scheduler state.
  private currentTrack: MusicTrack | null = null;
  private musicStep = 0;
  private nextNoteTime = 0;
  private musicTimer = 0;
  private synthMusicKind: MusicKind = null;

  private sfxActive = new Map<SfxName, number>();
  private sfxLastAt = new Map<SfxName, number>();

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

    // Loud impacts briefly duck the music so they punch through — kept from the synth era
    // and applied regardless of which path (sample/synth) makes the sound.
    if (this.musicBus) {
      if (name === "playerHurt") this.duck(this.musicBus, settings.musicVol * 0.5, 0.12, 0.5);
      else if (name === "bossSpawn") this.duck(this.musicBus, settings.musicVol * 0.3, 0.2, 0.8);
    }

    const spec = SAMPLES[name];
    if (spec && !this.failedIds.has(spec.id)) {
      this.playSample(spec, rate, gain);
      return;
    }
    this.synth(name, t, rate, gain);
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

  private sfxUrl(fileStem: string): string {
    return `${import.meta.env.BASE_URL}audio/sfx/${fileStem}.${this.extension()}`;
  }

  private musicUrl(kind: Exclude<MusicKind, null>): string {
    return `${import.meta.env.BASE_URL}audio/music/${kind}.${this.extension()}`;
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

  private playSample(spec: SampleSpec, rate: number, gain: number): void {
    this.ensureLoaded(spec);
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus) return;
    const stem = spec.variants <= 1
      ? spec.id
      : `${spec.id}_v${1 + Math.floor(Math.random() * spec.variants)}`;
    const buf = this.buffers.get(stem);
    if (!buf) return; // still loading — skip this one play rather than blocking or stacking
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.max(0.01, rate);
    const g = ctx.createGain();
    g.gain.value = gain * (spec.mix ?? 1);
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

    // Sample track failed to load once — use the procedural score for it instead.
    if (this.failedMusic.has(kind)) { this.applySynthMusic(kind); return; }

    const buf = this.musicBuffers.get(kind);
    if (!buf) { this.loadMusic(kind); return; }

    this.stopSynthMusic();
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
    this.stopSynthMusic();
    this.playingKind = null;
  }

  // ---- synth fallback -----------------------------------------------------------------

  private applySynthMusic(kind: Exclude<MusicKind, null>): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    this.fadeOutMusicSource();
    if (this.musicTimer && this.synthMusicKind === kind) return; // already looping this one
    this.stopSynthMusic();
    this.synthMusicKind = kind;
    this.currentTrack = kind === "boss" ? BOSS : DUNGEON;
    this.musicStep = 0;
    this.nextNoteTime = ctx.currentTime + 0.12;
    this.musicTick();
  }

  private stopSynthMusic(): void {
    if (this.musicTimer) {
      clearTimeout(this.musicTimer);
      this.musicTimer = 0;
    }
    this.currentTrack = null;
    this.synthMusicKind = null;
  }

  private musicTick = (): void => {
    const ctx = this.ctx;
    const track = this.currentTrack;
    if (!ctx || !track) return;
    const secPerStep = 60 / track.bpm / 2; // eighth notes
    while (this.nextNoteTime < ctx.currentTime + 0.12) {
      const step = this.musicStep % track.bass.length;
      const b = track.bass[step];
      if (b !== null) this.musicVoice(track.root * this.semis(b), this.nextNoteTime, secPerStep * 1.9, track.bassType, track.bassGain);
      const l = track.lead[step % track.lead.length];
      if (l !== null) this.musicVoice(track.root * this.semis(l), this.nextNoteTime, secPerStep * 1.4, track.leadType, track.leadGain);
      this.nextNoteTime += secPerStep;
      this.musicStep++;
    }
    this.musicTimer = window.setTimeout(this.musicTick, 25);
  };

  private semis(n: number): number {
    return Math.pow(2, n / 12);
  }

  private applyVolumes(): void {
    const ctx = this.ctx;
    const now = ctx?.currentTime ?? 0;
    if (ctx && this.master) {
      this.master.gain.setTargetAtTime(settings.isMuted ? 0 : settings.masterVol, now, 0.02);
    }
    if (ctx && this.sfxBus) {
      this.sfxBus.gain.setTargetAtTime(settings.sfxVol, now, 0.02);
    }
    if (ctx && this.musicBus) {
      this.musicBus.gain.setTargetAtTime(settings.musicVol, now, 0.02);
    }
    if (settings.isMuted) this.stopMusic();
    else this.applyMusic();
  }

  private duck(bus: GainNode, toGain: number, holdSec: number, recoverSec: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const baseGain = bus === this.musicBus ? settings.musicVol : settings.sfxVol;
    bus.gain.cancelScheduledValues(now);
    bus.gain.setTargetAtTime(toGain, now, 0.02);
    bus.gain.setTargetAtTime(baseGain, now + holdSec, recoverSec / 3);
  }

  private ensureContext(): void {
    if (this.ctx) return;
    const w = window as Window & WebkitWindow;
    const Ctor = window.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = settings.isMuted ? 0 : settings.masterVol;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.ratio.value = 12;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.knee.value = 6;
    master.connect(comp);
    comp.connect(ctx.destination);
    this.master = master;
    const sfxBus = ctx.createGain();
    sfxBus.gain.value = settings.sfxVol;
    sfxBus.connect(master);
    this.sfxBus = sfxBus;
    const musicBus = ctx.createGain();
    musicBus.gain.value = settings.musicVol;
    musicBus.connect(master);
    this.musicBus = musicBus;
    this.noiseBuffer = this.makeNoise(ctx);
  }

  private makeNoise(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Procedural voices, retained as the per-sound fallback and for events with no shipped
  // sample (revive, uiClick). `rate` already carries the per-play jitter from sfx().
  private synth(name: SfxName, t: number, rate: number, gain: number): void {
    switch (name) {
      case "shootPistol":
        this.blip(t, "square", 720 * rate, 190 * rate, 0.002, 0.09, 0.5 * gain);
        this.noise(t, "highpass", 1400, 700, 0.04, 0.14 * gain, 0.9, rate);
        break;
      case "shootShotgun":
      case "cannon":
        this.noise(t, "lowpass", 1900, 300, 0.22, 0.6 * gain, 1, rate);
        this.blip(t, "sawtooth", 190 * rate, 60 * rate, 0.003, 0.18, 0.42 * gain);
        break;
      case "shootRapid":
      case "smg":
      case "burst":
      case "ricochet":
      case "homing":
      case "tesla": {
        this.blip(t, "sawtooth", 900 * rate, 380 * rate, 0.001, 0.06, 0.3 * gain);
        break;
      }
      case "enemyAttack":
        this.noise(t, "bandpass", 500, 2600, 0.22, 0.3 * gain, 0.7);
        break;
      case "enemyHit":
        this.noise(t, "bandpass", 2200, 1400, 0.05, 0.24 * gain, 1.6, rate);
        break;
      case "enemyDeath":
        this.noise(t, "lowpass", 2600, 200, 0.16, 0.5 * gain, 1);
        this.blip(t, "triangle", 430 * rate, 90 * rate, 0.002, 0.15, 0.34 * gain);
        break;
      case "playerHurt":
        this.blip(t, "sawtooth", 300 * rate, 70 * rate, 0.002, 0.28, 0.5 * gain);
        this.blip(t, "sawtooth", 318 * rate, 70 * rate, 0.002, 0.28, 0.5 * gain);
        this.noise(t, "lowpass", 1800, 400, 0.12, 0.3 * gain);
        break;
      case "dash":
        this.noise(t, "bandpass", 500, 2600, 0.22, 0.3 * gain, 0.7);
        break;
      case "coin":
        this.blip(t, "square", 880 * rate, 880 * rate, 0.002, 0.08, 0.28 * gain);
        this.blip(t + 0.06, "square", 1320 * rate, 1320 * rate, 0.002, 0.12, 0.28 * gain);
        break;
      case "chest":
      case "barrel":
        this.blip(t, "square", 160 * rate, 120 * rate, 0.004, 0.16, 0.4 * gain);
        this.noise(t, "lowpass", 1400, 400, 0.1, 0.3 * gain);
        break;
      case "heart": {
        const base = 523.25 * rate; // C5, then a bright major triad
        this.blip(t, "triangle", base, base, 0.006, 0.18, 0.26 * gain);
        this.blip(t + 0.08, "triangle", base * 1.26, base * 1.26, 0.006, 0.18, 0.24 * gain);
        this.blip(t + 0.16, "triangle", base * 1.5, base * 1.5, 0.006, 0.22, 0.24 * gain);
        break;
      }
      case "weapon":
        this.blip(t, "square", 160 * rate, 120 * rate, 0.004, 0.16, 0.4 * gain);
        this.noise(t, "lowpass", 1400, 400, 0.1, 0.3 * gain);
        this.blip(t + 0.05, "square", 300 * rate, 240 * rate, 0.003, 0.12, 0.3 * gain);
        break;
      case "descend":
      case "floorClear": {
        const notes = [660, 550, 440, 330];
        for (let i = 0; i < notes.length; i++) {
          this.blip(t + i * 0.07, "triangle", notes[i] * rate, notes[i] * rate, 0.004, 0.16, 0.3 * gain);
        }
        break;
      }
      case "bossSpawn":
        this.blip(t, "sawtooth", 90 * rate, 58 * rate, 0.02, 0.9, 0.4 * gain);
        this.blip(t, "square", 95 * rate, 62 * rate, 0.02, 0.9, 0.2 * gain); // slight detune -> ominous beating
        this.noise(t, "lowpass", 600, 120, 0.7, 0.24 * gain);
        break;
      case "gameOver": {
        const notes = [440, 392, 330, 262];
        for (let i = 0; i < notes.length; i++) {
          this.blip(t + i * 0.16, "triangle", notes[i] * rate, notes[i] * rate, 0.01, 0.4, 0.32 * gain);
        }
        break;
      }
      case "revive":
        this.blip(t, "triangle", 330 * rate, 660 * rate, 0.01, 0.3, 0.3 * gain);
        this.blip(t + 0.1, "triangle", 660 * rate, 990 * rate, 0.01, 0.3, 0.24 * gain);
        break;
      case "uiClick":
        this.blip(t, "square", 600, 900, 0.002, 0.05, 0.2 * gain);
        break;
    }
  }

  // A short enveloped oscillator with an optional exponential frequency sweep.
  private blip(t0: number, type: OscillatorType, f0: number, f1: number, attack: number, decay: number, vol: number): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, f0), t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + attack + decay);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    osc.connect(g).connect(bus);
    osc.start(t0);
    osc.stop(t0 + attack + decay + 0.02);
  }

  // A filtered white-noise burst with a filter-frequency sweep — our "crunch" primitive.
  private noise(t0: number, filterType: BiquadFilterType, f0: number, f1: number, decay: number, vol: number, q = 0.9, rate = 1): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus || !this.noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(Math.max(1, f0 * rate), t0);
    if (f1 !== f0) filter.frequency.exponentialRampToValueAtTime(Math.max(1, f1 * rate), t0 + decay);
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, vol), t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    src.connect(filter).connect(g).connect(bus);
    src.start(t0);
    src.stop(t0 + decay + 0.02);
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

  private musicVoice(freq: number, t0: number, dur: number, type: OscillatorType, vol: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(bus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
}

export const audio = new AudioEngine();

// Convenience free function so callers can `import { sfx } from "./audio.js"`.
export function sfx(name: SfxName, opts?: SfxOptions): void {
  audio.sfx(name, opts);
}
