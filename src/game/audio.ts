// Procedural WebAudio sound engine — every sound is synthesized in code (ZzFX-flavored
// short blips / noise bursts with frequency sweeps and decay envelopes), so there are
// zero audio asset files to fetch. Each play jitters pitch a touch so repeated shots
// don't get grating.
//
// Browser rule: an AudioContext starts "suspended" and can only be resumed inside a
// user gesture. We create it lazily and resume on the first pointer/key/touch event
// (and again whenever the tab regains focus). Until it is actually "running", sfx()
// no-ops rather than queuing sounds that would all blast out at once on resume.
//
// Nothing here runs in the per-frame hot path: sounds are event-driven and the music
// scheduler wakes on a ~25ms timer (never requestAnimationFrame). The one buffer we
// need (white noise) is generated once and reused across every noise voice.

import { settings } from "./settings.js";

export type SfxName =
  | "shootPistol"
  | "shootShotgun"
  | "shootRapid"
  | "enemyHit"
  | "enemyDeath"
  | "playerHurt"
  | "dash"
  | "coin"
  | "heart"
  | "weapon"
  | "descend"
  | "bossSpawn"
  | "gameOver"
  | "revive"
  | "uiClick";

export type MusicKind = "dungeon" | "boss" | null;

export interface SfxOptions {
  gain?: number; // 0..1 scales this play's loudness (used to attenuate far-off co-op events)
  rate?: number; // pitch/speed multiplier; defaults to a small per-play random jitter
}

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

// Everything below is built from a minor-pentatonic set (offsets 0,3,5,7,10,12...) so
// the loop never lands a sour note; the boss track leans on a couple of +6 tritones for
// menace. Kept sparse + soft on purpose.
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

  private currentKind: MusicKind = null;
  private currentTrack: MusicTrack | null = null;
  private musicStep = 0;
  private nextNoteTime = 0;
  private musicTimer = 0;
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
    if (ctx.state === "suspended") void ctx.resume().then(() => this.applyMusic());
    else this.applyMusic();
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
    const rate = opts?.rate ?? this.rand(0.94, 1.06);
    switch (name) {
      case "shootPistol":
        this.blip(t, "square", 720 * rate, 190 * rate, 0.002, 0.09, 0.5 * gain);
        this.noise(t, "highpass", 1400, 700, 0.04, 0.14 * gain, 0.9, rate);
        break;
      case "shootShotgun":
        this.noise(t, "lowpass", 1900, 300, 0.22, 0.6 * gain, 1, rate);
        this.blip(t, "sawtooth", 190 * rate, 60 * rate, 0.003, 0.18, 0.42 * gain);
        break;
      case "shootRapid": {
        const rapidRate = opts?.rate ?? this.rand(0.90, 1.10);
        this.blip(t, "sawtooth", 900 * rapidRate, 380 * rapidRate, 0.001, 0.06, 0.3 * gain);
        break;
      }
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
        if (this.musicBus) this.duck(this.musicBus, settings.musicVol * 0.5, 0.12, 0.5);
        break;
      case "dash":
        this.noise(t, "bandpass", 500, 2600, 0.22, 0.3 * gain, 0.7);
        break;
      case "coin":
        this.blip(t, "square", 880 * rate, 880 * rate, 0.002, 0.08, 0.28 * gain);
        this.blip(t + 0.06, "square", 1320 * rate, 1320 * rate, 0.002, 0.12, 0.28 * gain);
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
      case "descend": {
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
        if (this.musicBus) this.duck(this.musicBus, settings.musicVol * 0.3, 0.2, 0.8);
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

  setMusic(kind: MusicKind): void {
    if (kind === this.currentKind) return;
    this.currentKind = kind;
    this.applyMusic();
  }

  private applyMusic(): void {
    const kind = this.currentKind;
    if (!kind || settings.isMuted) { this.stopMusicLoop(); return; }
    this.ensureContext();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return; // resume() re-applies once it resolves
    const track = kind === "boss" ? BOSS : DUNGEON;
    if (this.musicTimer && this.currentTrack === track) return; // already looping this one — don't restart
    this.stopMusicLoop();
    this.currentTrack = track;
    this.musicStep = 0;
    this.nextNoteTime = ctx.currentTime + 0.12;
    this.musicTick();
  }

  private stopMusicLoop(): void {
    if (this.musicTimer) {
      clearTimeout(this.musicTimer);
      this.musicTimer = 0;
    }
    this.currentTrack = null;
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
    if (settings.isMuted) this.stopMusicLoop();
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

  private rand(a: number, b: number): number {
    return a + Math.random() * (b - a);
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
      case "enemyHit": return 0.08;
      case "enemyDeath": return 0.2;
      case "playerHurt": return 0.32;
      case "dash": return 0.26;
      case "coin": return 0.2;
      case "heart": return 0.4;
      case "weapon": return 0.2;
      case "descend": return 0.35;
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
