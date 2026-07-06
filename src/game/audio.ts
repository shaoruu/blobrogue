// Procedural WebAudio sound engine — "8-bit, but it hits". Every sound is synthesized
// in code (square/saw/sine/triangle + white noise, pitch/filter envelopes, a touch of
// bitcrush), so there are zero audio asset files. Built to the audio director's spec in
// docs/AUDIO_SPEC.md: a single parametric synth core plus data-driven presets, a
// music/sfx/ui bus mix into a limiter, and a look-ahead music scheduler.
//
// Browser rule: an AudioContext starts "suspended" and can only be resumed inside a user
// gesture. We create it lazily and resume on the first pointer/key/touch (and when the
// tab regains focus). Until it is actually "running", plays no-op rather than queueing
// sounds that would all fire at once on resume.
//
// Nothing here runs in the per-frame hot path: sounds are event-driven and the music
// scheduler wakes on a 25ms setInterval, scheduling ~100ms ahead on ctx.currentTime.

export type SfxName =
  | "shootPistol" | "shootShotgun" | "shootRapid"
  | "enemyHit" | "enemyDeath" | "playerHurt" | "dash"
  | "coin" | "heart" | "weapon" | "descend" | "bossSpawn" | "gameOver" | "revive" | "uiClick";

export type MusicKind = "dungeon" | "boss" | null;
export type Bus = "music" | "sfx" | "ui";

export interface SfxOptions {
  gain?: number; // 0..1 scales this play's loudness (attenuates far-off co-op events)
  rate?: number; // deterministic pitch multiplier (e.g. lower for a boss death)
}

// The synth core signature (docs/AUDIO_SPEC.md). All optional; sensible defaults below.
export interface VoiceParams {
  shape?: "square" | "saw" | "sine" | "triangle";
  freq?: number;
  freqEnd?: number;
  sweepMs?: number;
  atkMs?: number;
  decMs?: number;
  durMs?: number;
  noise?: number; // 0..1 crossfade toward white noise
  lp?: number;
  lpEnd?: number;
  hp?: number;
  q?: number;
  bit?: number; // 0..1 bitcrush
  vol?: number;
  bus?: Bus;
  varPct?: number; // ±% random on freq (and ~half on durMs)
  trem?: number;   // tremolo LFO frequency (Hz)
  when?: number;   // absolute ctx time to start (defaults to now); used by seq/layers
}

const MASTER_VOL = 0.8;
const BUS_VOL: Record<Bus, number> = { music: 0.5, sfx: 0.9, ui: 0.6 };
const MAX_SFX_VOICES = 16;     // CPU safety cap; the limiter handles loudness of stacks
const RETRIGGER_COOLDOWN = 0.015; // s — dedupe the exact same sound within a frame

const AUDIO_KEY = "blobrogue.audio";

interface AudioPrefs { music: boolean; sfx: boolean; }

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function loadPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(AUDIO_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { music?: boolean; sfx?: boolean };
      return { music: p.music !== false, sfx: p.sfx !== false };
    }
  } catch {
    /* storage disabled — fall through to defaults */
  }
  return { music: true, sfx: true };
}

interface WebkitWindow {
  webkitAudioContext?: typeof AudioContext;
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private buses: Record<Bus, GainNode> | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private crushCurves = new Map<number, Float32Array<ArrayBuffer>>();

  private musicOn: boolean;
  private sfxOn: boolean;

  private currentKind: MusicKind = null;
  private musicInterval = 0;
  private musicStep = 0;
  private nextStepTime = 0;
  private pausedByGame = false;
  private pausedByTab = false;

  private sfxActive = 0;
  private lastPlay = new Map<SfxName, number>();
  private hitCombo = 0;
  private lastHitAt = 0;

  constructor() {
    const prefs = loadPrefs();
    this.musicOn = prefs.music;
    this.sfxOn = prefs.sfx;
    const onGesture = () => this.unlock();
    window.addEventListener("pointerdown", onGesture, { passive: true });
    window.addEventListener("keydown", onGesture, { passive: true });
    window.addEventListener("touchstart", onGesture, { passive: true });
    document.addEventListener("visibilitychange", () => {
      this.pausedByTab = document.hidden;
      this.applyMusic();
    });
  }

  // ---- public control surface ----

  get isMusicOn(): boolean { return this.musicOn; }
  get isSfxOn(): boolean { return this.sfxOn; }

  toggleMusic(): boolean { this.setMusicOn(!this.musicOn); return this.musicOn; }
  toggleSfx(): boolean { this.setSfxOn(!this.sfxOn); return this.sfxOn; }

  setMusicOn(on: boolean): void {
    if (this.musicOn === on) return;
    this.musicOn = on;
    this.persist();
    this.rampBus("music", on ? BUS_VOL.music : 0);
    this.applyMusic();
  }

  setSfxOn(on: boolean): void {
    if (this.sfxOn === on) return;
    this.sfxOn = on;
    this.persist();
    this.rampBus("sfx", on ? BUS_VOL.sfx : 0);
    this.rampBus("ui", on ? BUS_VOL.ui : 0);
  }

  unlock(): void {
    this.ensureContext();
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume().then(() => this.applyMusic());
    else this.applyMusic();
  }

  setMusic(kind: MusicKind): void {
    if (kind === this.currentKind) return;
    this.currentKind = kind;
    this.applyMusic();
  }

  // Pause the music loop for a game pause (kept separate from the tab-hidden pause).
  setMusicPaused(paused: boolean): void {
    if (this.pausedByGame === paused) return;
    this.pausedByGame = paused;
    this.applyMusic();
  }

  // ---- named SFX presets (data straight from the spec) ----

  sfx(name: SfxName, opts?: SfxOptions): void {
    if (!this.sfxOn) return;
    this.ensureContext();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const last = this.lastPlay.get(name) ?? -1;
    if (ctx.currentTime - last < RETRIGGER_COOLDOWN) return;
    this.lastPlay.set(name, ctx.currentTime);

    const g = opts?.gain ?? 1;
    const r = opts?.rate ?? 1;
    switch (name) {
      case "shootPistol":
        this.voice({ shape: "square", freq: 420 * r, freqEnd: 120 * r, sweepMs: 45, atkMs: 1, decMs: 65, durMs: 80, noise: 0.30, lp: 3000, lpEnd: 800, q: 1, vol: 0.50 * g, bus: "sfx", varPct: 6 });
        break;
      case "shootShotgun":
        this.voice({ shape: "saw", freq: 180 * r, freqEnd: 55 * r, sweepMs: 90, atkMs: 1, decMs: 150, durMs: 170, noise: 0.70, lp: 4000, lpEnd: 400, q: 0.7, vol: 0.68 * g, bus: "sfx", varPct: 8 });
        this.voice({ shape: "sine", freq: 80 * r, freqEnd: 40 * r, sweepMs: 70, atkMs: 1, decMs: 65, durMs: 70, vol: 0.6 * g, bus: "sfx", varPct: 8 }); // sub for weight
        break;
      case "shootRapid":
        this.voice({ shape: "square", freq: 540 * r, freqEnd: 320 * r, sweepMs: 22, atkMs: 0.5, decMs: 35, durMs: 45, noise: 0.15, lp: 4200, lpEnd: 1500, q: 1, vol: 0.34 * g, bus: "sfx", varPct: 10 });
        break;
      case "enemyHit": {
        const now = ctx.currentTime;
        this.hitCombo = now - this.lastHitAt < 0.3 ? Math.min(this.hitCombo + 1, 12) : 0;
        this.lastHitAt = now;
        const combo = Math.pow(1.02, this.hitCombo); // +2% pitch per consecutive hit
        this.voice({ shape: "square", freq: 900 * r * combo, freqEnd: 520 * r * combo, sweepMs: 30, atkMs: 1, decMs: 45, durMs: 55, noise: 0.35, lp: 5000, vol: 0.40 * g, bus: "sfx", varPct: 15 });
        break;
      }
      case "enemyDeath":
        this.voice({ shape: "square", freq: 500 * r, freqEnd: 80 * r, sweepMs: 110, atkMs: 1, decMs: 150, durMs: 180, noise: 0.50, lp: 3500, lpEnd: 600, bit: 0.25, vol: 0.50 * g, bus: "sfx", varPct: 12 });
        this.voice({ shape: "sine", freq: 120 * r, freqEnd: 50 * r, sweepMs: 80, atkMs: 1, decMs: 85, durMs: 90, vol: 0.5 * g, bus: "sfx", varPct: 12 });
        break;
      case "playerHurt":
        // Two detuned saws + tremolo + a little crush — must cut through everything.
        this.voice({ shape: "saw", freq: 220, freqEnd: 150, sweepMs: 150, atkMs: 1, decMs: 180, durMs: 200, noise: 0.20, lp: 1800, lpEnd: 700, bit: 0.2, trem: 8, vol: 0.62 * g, bus: "sfx", varPct: 3 });
        this.voice({ shape: "saw", freq: 233, freqEnd: 150, sweepMs: 150, atkMs: 1, decMs: 180, durMs: 200, lp: 1800, lpEnd: 700, bit: 0.2, trem: 8, vol: 0.5 * g, bus: "sfx", varPct: 3 });
        this.duck("music", 0.5, 120, 500);
        break;
      case "dash":
        this.dashSound(g);
        break;
      case "coin":
        this.seq([988, 1319], { shape: "square", atkMs: 1, decMs: 45, durMs: 50, vol: 0.40 * g, bus: "sfx", varPct: 4 }, 55);
        break;
      case "heart":
        this.seq([523, 659, 784], { shape: "triangle", atkMs: 2, decMs: 50, durMs: 55, vol: 0.45 * g, bus: "sfx", varPct: 3 }, 60);
        break;
      case "weapon":
        this.seq([523.25, 783.99, 1046.5, 1318.5], { shape: "square", atkMs: 1, decMs: 85, durMs: 90, bit: 0.2, vol: 0.52 * g, bus: "sfx", varPct: 3 }, 90);
        break;
      case "descend":
        this.descendSound(g);
        break;
      case "bossSpawn":
        this.bossRoar(g);
        break;
      case "gameOver":
        this.gameOverSound(g);
        break;
      case "revive":
        this.seq([440, 587, 880], { shape: "triangle", atkMs: 3, decMs: 110, durMs: 120, vol: 0.4 * g, bus: "sfx", varPct: 2 }, 90);
        break;
      case "uiClick":
        this.voice({ shape: "square", freq: 1200, atkMs: 1, decMs: 22, durMs: 25, vol: 0.28 * g, bus: "ui", varPct: 2 });
        break;
    }
  }

  private dashSound(g: number): void {
    const ctx = this.ctx;
    const bus = this.buses?.sfx;
    if (!ctx || !bus || !this.noiseBuffer) return;
    const t0 = ctx.currentTime;
    // Bandpassed noise whoosh: 400 -> 2000 -> 600.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 3;
    bp.frequency.setValueAtTime(400, t0);
    bp.frequency.linearRampToValueAtTime(2000, t0 + 0.09);
    bp.frequency.linearRampToValueAtTime(600, t0 + 0.18);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.linearRampToValueAtTime(0.40 * g, t0 + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
    src.connect(bp).connect(amp).connect(bus);
    src.start(t0);
    src.stop(t0 + 0.2);
    this.trackSfx(0.2);
    // A sine "zip" riding on top.
    this.voice({ shape: "sine", freq: 300, freqEnd: 900, sweepMs: 120, atkMs: 2, decMs: 110, durMs: 120, vol: 0.3 * g, bus: "sfx", varPct: 10 });
  }

  private descendSound(g: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.voice({ shape: "triangle", freq: 600, freqEnd: 120, sweepMs: 500, atkMs: 5, decMs: 480, durMs: 500, vol: 0.5 * g, bus: "sfx", varPct: 2 });
    this.voice({ shape: "sine", freq: 400, freqEnd: 80, sweepMs: 500, atkMs: 5, decMs: 450, durMs: 500, noise: 0.6, lp: 3000, lpEnd: 400, vol: 0.3 * g, bus: "sfx" });
    this.voice({ shape: "sine", freq: 120, freqEnd: 45, sweepMs: 120, atkMs: 1, decMs: 160, durMs: 180, vol: 0.55 * g, bus: "sfx", when: ctx.currentTime + 0.5 }); // landing thump
  }

  private bossRoar(g: number): void {
    this.voice({ shape: "sine", freq: 60, freqEnd: 45, sweepMs: 1000, atkMs: 20, decMs: 1150, durMs: 1200, vol: 0.85 * g, bus: "sfx" });
    for (const f of [110, 108, 113]) {
      this.voice({ shape: "saw", freq: f, freqEnd: 70, sweepMs: 800, atkMs: 20, decMs: 880, durMs: 900, lp: 1500, lpEnd: 300, bit: 0.4, trem: 6, vol: 0.42 * g, bus: "sfx" });
    }
    this.voice({ shape: "sine", freq: 200, noise: 1, atkMs: 600, decMs: 200, durMs: 700, lp: 400, lpEnd: 3000, vol: 0.5 * g, bus: "sfx" }); // rising noise swell
    this.duck("music", 0.3, 200, 800);
  }

  private gameOverSound(g: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const notes = [440, 392, 330, 262];
    let t = 0;
    for (let i = 0; i < notes.length; i++) {
      this.voice({ shape: i < 2 ? "square" : "sine", freq: notes[i], atkMs: 3, decMs: 200 + i * 40, durMs: 220 + i * 40, lp: 2000, lpEnd: 700, vol: 0.6 * g, bus: "sfx", when: ctx.currentTime + t / 1000 });
      t += 160 + i * 60; // slowing
    }
    // Final bend C4 -> B3.
    this.voice({ shape: "sine", freq: 261.6, freqEnd: 246.9, sweepMs: 400, atkMs: 5, decMs: 600, durMs: 650, lp: 1200, lpEnd: 300, vol: 0.5 * g, bus: "sfx", when: ctx.currentTime + t / 1000 });
  }

  // ---- synth core ----

  voice(p: VoiceParams): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const bus = p.bus ?? "sfx";
    if (bus === "music" ? !this.musicOn : !this.sfxOn) return;
    if (bus !== "music") {
      if (this.sfxActive >= MAX_SFX_VOICES) return; // drop under extreme load; limiter guards the rest
    }
    const busNode = this.buses?.[bus];
    if (!busNode) return;

    const t0 = p.when ?? ctx.currentTime;
    const varPct = p.varPct ?? 0;
    const vf = varPct ? 1 + (Math.random() * 2 - 1) * (varPct / 100) : 1;
    const df = varPct ? 1 + (Math.random() * 2 - 1) * (varPct / 200) : 1; // ~half on duration
    const freq = Math.max(1, (p.freq ?? 440) * vf);
    const freqEnd = Math.max(1, (p.freqEnd ?? p.freq ?? 440) * vf);
    const atk = Math.max(0, (p.atkMs ?? 1) / 1000);
    const dec = Math.max(0.005, (p.decMs ?? 80) / 1000);
    const dur = Math.max((p.durMs ?? (p.atkMs ?? 1) + (p.decMs ?? 80)) / 1000 * df, atk + dec);
    const sweep = Math.max(0.001, (p.sweepMs ?? p.durMs ?? 80) / 1000);
    const vol = Math.max(0.0001, p.vol ?? 0.4);
    const nz = clamp01(p.noise ?? 0);

    // Amp envelope: silence -> peak (atk) -> silence (dec). Sustain is 0.
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.linearRampToValueAtTime(vol, t0 + atk);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + atk + dec);

    // amp -> [bitcrush] -> [lowpass] -> [highpass] -> [tremolo] -> bus
    let node: AudioNode = amp;
    if (p.bit && p.bit > 0) {
      const ws = ctx.createWaveShaper();
      ws.curve = this.crushCurve(p.bit);
      node.connect(ws);
      node = ws;
    }
    if (p.lp) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(Math.max(1, p.lp), t0);
      if (p.lpEnd && p.lpEnd !== p.lp) lp.frequency.exponentialRampToValueAtTime(Math.max(1, p.lpEnd), t0 + dur);
      if (p.q) lp.Q.value = p.q;
      node.connect(lp);
      node = lp;
    }
    if (p.hp) {
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = p.hp;
      node.connect(hp);
      node = hp;
    }
    if (p.trem) {
      const tremGain = ctx.createGain();
      tremGain.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = p.trem;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.5;
      lfo.connect(lfoDepth).connect(tremGain.gain);
      lfo.start(t0);
      lfo.stop(t0 + dur + 0.02);
      node.connect(tremGain);
      node = tremGain;
    }
    node.connect(busNode);

    // Tonal + noise voices crossfaded by `noise`.
    if (nz < 1) {
      const osc = ctx.createOscillator();
      osc.type = p.shape === "saw" ? "sawtooth" : (p.shape ?? "square");
      osc.frequency.setValueAtTime(freq, t0);
      if (freqEnd !== freq) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + sweep);
      const tg = ctx.createGain();
      tg.gain.value = 1 - nz;
      osc.connect(tg).connect(amp);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }
    if (nz > 0 && this.noiseBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const ng = ctx.createGain();
      ng.gain.value = nz;
      src.connect(ng).connect(amp);
      src.start(t0);
      src.stop(t0 + dur + 0.02);
    }
    if (bus !== "music") this.trackSfx(dur);
  }

  // Plays a note sequence (ascending pickups etc.) spaced by spacingMs.
  private seq(notes: number[], base: VoiceParams, spacingMs: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    for (let i = 0; i < notes.length; i++) {
      this.voice({ ...base, freq: notes[i], when: t0 + (i * spacingMs) / 1000 });
    }
  }

  // Smoothly ducks a bus toward `toGain × its base`, holds, then recovers.
  private duck(bus: Bus, toGain: number, holdMs: number, recoverMs: number): void {
    const ctx = this.ctx;
    const node = this.buses?.[bus];
    if (!ctx || !node) return;
    const base = (bus === "music" ? this.musicOn : this.sfxOn) ? BUS_VOL[bus] : 0;
    if (base <= 0) return;
    const now = ctx.currentTime;
    node.gain.cancelScheduledValues(now);
    node.gain.setTargetAtTime(base * toGain, now, 0.02);
    node.gain.setTargetAtTime(base, now + holdMs / 1000, recoverMs / 1000 / 3);
  }

  private trackSfx(durSeconds: number): void {
    this.sfxActive++;
    window.setTimeout(() => { this.sfxActive = Math.max(0, this.sfxActive - 1); }, (durSeconds + 0.05) * 1000);
  }

  // ---- music (look-ahead scheduler; setInterval 25ms, ~100ms ahead) ----

  private applyMusic(): void {
    this.stopScheduler();
    if (!this.currentKind || !this.musicOn || this.pausedByGame || this.pausedByTab) return;
    this.ensureContext();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return; // resume() re-applies via unlock()
    this.musicStep = 0;
    this.nextStepTime = ctx.currentTime + 0.06;
    this.musicInterval = window.setInterval(this.scheduleAhead, 25);
  }

  private stopScheduler(): void {
    if (this.musicInterval) {
      clearInterval(this.musicInterval);
      this.musicInterval = 0;
    }
  }

  private scheduleAhead = (): void => {
    const ctx = this.ctx;
    const kind = this.currentKind;
    if (!ctx || !kind) return;
    const bpm = kind === "boss" ? 144 : 112;
    const stepDur = 60 / bpm / 4; // 16th notes
    while (this.nextStepTime < ctx.currentTime + 0.1) {
      if (kind === "boss") this.bossStep(this.musicStep, this.nextStepTime, stepDur);
      else this.dungeonStep(this.musicStep, this.nextStepTime, stepDur);
      this.nextStepTime += stepDur;
      this.musicStep++;
    }
  };

  // D Dorian, 112 BPM, 16 steps/bar. bass(tri+lp) · pad(detuned saws drone) · arp(square
  // Dm7 gated) · kick 0&8 · hats offbeat. Kept soft; the music bus sits under sfx.
  private dungeonStep(step: number, t: number, stepDur: number): void {
    const s = step % 16;
    const D2 = 73.42, D3 = 146.83, D4 = 293.66;
    const semi = (base: number, n: number) => base * Math.pow(2, n / 12);
    const bass = [0, null, null, null, null, null, null, null, 7, null, null, null, 10, null, null, null][s];
    if (bass !== null) this.voice({ shape: "triangle", freq: semi(D2, bass), atkMs: 6, decMs: stepDur * 2600, durMs: stepDur * 2800, lp: 400, vol: 0.5, bus: "music", when: t });
    const arpOn = [1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1][s];
    if (arpOn) {
      const dm7 = [0, 3, 7, 10]; // D F A C
      this.voice({ shape: "square", freq: semi(D4, dm7[s % 4]), atkMs: 2, decMs: 110, durMs: 120, lp: 2600, vol: 0.15, bus: "music", when: t });
    }
    if (s === 0) {
      // Pad drone: two lightly detuned saws for a bar.
      const barMs = stepDur * 16000;
      this.voice({ shape: "saw", freq: D3, atkMs: 160, decMs: barMs, durMs: barMs, lp: 800, vol: 0.12, bus: "music", when: t });
      this.voice({ shape: "saw", freq: D3 * 1.006, atkMs: 160, decMs: barMs, durMs: barMs, lp: 800, vol: 0.12, bus: "music", when: t });
    }
    if (s === 0 || s === 8) this.voice({ shape: "sine", freq: 150, freqEnd: 45, sweepMs: 60, atkMs: 1, decMs: 120, durMs: 140, noise: 0.2, lp: 1200, vol: 0.55, bus: "music", when: t }); // kick
    if (s === 2 || s === 6 || s === 10 || s === 14) this.voice({ shape: "square", freq: 8000, noise: 1, atkMs: 0.5, decMs: 35, durMs: 40, hp: 6000, vol: 0.12, bus: "music", when: t }); // hat
  }

  // A Phrygian, 144 BPM: driving 16th bass, kick every beat, root+♭2 stab, tenser.
  private bossStep(step: number, t: number, stepDur: number): void {
    const s = step % 16;
    const A1 = 55, A2 = 110, A3 = 220;
    const semi = (base: number, n: number) => base * Math.pow(2, n / 12);
    this.voice({ shape: "saw", freq: A1, atkMs: 1, decMs: stepDur * 700, durMs: stepDur * 900, lp: 500, vol: s % 2 === 0 ? 0.4 : 0.26, bus: "music", when: t }); // driving 16th bass
    if (s % 4 === 0) this.voice({ shape: "sine", freq: 160, freqEnd: 44, sweepMs: 60, atkMs: 1, decMs: 130, durMs: 150, noise: 0.25, lp: 1400, vol: 0.6, bus: "music", when: t }); // kick every beat
    if (s === 0 || s === 8) {
      this.voice({ shape: "square", freq: A3, atkMs: 2, decMs: 160, durMs: 180, lp: 2200, vol: 0.16, bus: "music", when: t }); // root
      this.voice({ shape: "square", freq: semi(A2, 1), atkMs: 2, decMs: 160, durMs: 180, lp: 2200, vol: 0.12, bus: "music", when: t }); // ♭2 stab
    }
    if (s % 2 === 1) this.voice({ shape: "square", freq: 9000, noise: 1, atkMs: 0.5, decMs: 28, durMs: 32, hp: 7000, vol: 0.1, bus: "music", when: t }); // hats
  }

  // ---- context + persistence ----

  private ensureContext(): void {
    if (this.ctx) return;
    const w = window as Window & WebkitWindow;
    const Ctor = window.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = MASTER_VOL;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    master.connect(limiter).connect(ctx.destination);

    const mk = (v: number) => { const g = ctx.createGain(); g.gain.value = v; g.connect(master); return g; };
    this.buses = {
      music: mk(this.musicOn ? BUS_VOL.music : 0),
      sfx: mk(this.sfxOn ? BUS_VOL.sfx : 0),
      ui: mk(this.sfxOn ? BUS_VOL.ui : 0),
    };
    this.noiseBuffer = this.makeNoise(ctx);
  }

  private rampBus(bus: Bus, to: number): void {
    const ctx = this.ctx;
    const node = this.buses?.[bus];
    if (ctx && node) node.gain.setTargetAtTime(to, ctx.currentTime, 0.02);
  }

  private makeNoise(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * 2); // 2s covers the boss roar's noise swell
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Amplitude-quantization curve for bitcrush; cached per level count.
  private crushCurve(bit: number): Float32Array<ArrayBuffer> {
    const levels = Math.max(3, Math.round(32 - clamp01(bit) * 29)); // bit 0 ≈ clean, bit 1 ≈ 3 levels
    const cached = this.crushCurves.get(levels);
    if (cached) return cached;
    const n = 1024;
    const curve = new Float32Array(n);
    const half = levels / 2;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.round(x * half) / half;
    }
    this.crushCurves.set(levels, curve);
    return curve;
  }

  private persist(): void {
    try {
      localStorage.setItem(AUDIO_KEY, JSON.stringify({ music: this.musicOn, sfx: this.sfxOn }));
    } catch {
      /* storage disabled — keep the in-memory values */
    }
  }
}

export const audio = new AudioEngine();

// Overloaded free function: `sfx("shootPistol")` for named presets, or `sfx({ ...params })`
// to drive the synth core directly (per docs/AUDIO_SPEC.md).
export function sfx(name: SfxName, opts?: SfxOptions): void;
export function sfx(params: VoiceParams): void;
export function sfx(a: SfxName | VoiceParams, b?: SfxOptions): void {
  if (typeof a === "string") audio.sfx(a, b);
  else audio.voice(a);
}
