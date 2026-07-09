// Player-facing "feel" + accessibility settings — audio mute, screen-shake intensity,
// autofire, reduced motion, flash level, hit-stop, recoil intensity, UI scale, and the
// preferred solo difficulty — persisted to localStorage. Deliberately DOM-free so both
// the audio engine and the game loop can read it without pulling in any UI. A tiny
// subscriber list lets the audio engine react to a mute toggle the instant it flips.

import { DEFAULT_DIFFICULTY, isDifficulty } from "../sim/balance.js";
import type { Difficulty } from "../sim/balance.js";

const MUTE_KEY = "blobrogue.muted";
const SHAKE_KEY = "blobrogue.shake";
const AUTOFIRE_KEY = "blobrogue.autofire";
const MASTER_KEY = "blobrogue.vol.master";
const MUSIC_KEY = "blobrogue.vol.music";
const SFX_KEY = "blobrogue.vol.sfx";
const HINT_KEY = "blobrogue.controlsHintSeen"; // one-time controls onboarding hint
const DIFFICULTY_KEY = "blobrogue.difficulty"; // preferred SOLO difficulty (rooms are host state)
const MOTION_KEY = "blobrogue.reducedMotion";
const FLASH_KEY = "blobrogue.flashLevel";
const HITSTOP_KEY = "blobrogue.hitstop";
const RECOIL_KEY = "blobrogue.recoil";
const UI_SCALE_KEY = "blobrogue.uiScale";

// Full-screen flash washes (boss phases, explosions, celebrations): off kills them, low
// keeps a faint glow, full is the authored intensity. Anything at "full" is gated behind
// the photosensitivity note in the settings UI.
export type FlashLevel = "off" | "low" | "full";
const FLASH_FACTOR: Record<FlashLevel, number> = { off: 0, low: 0.4, full: 1 };

const UI_SCALE_MIN = 0.75;
const UI_SCALE_MAX = 1.5;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function clampUiScale(n: number): number {
  return n < UI_SCALE_MIN ? UI_SCALE_MIN : n > UI_SCALE_MAX ? UI_SCALE_MAX : n;
}

// QA/automation override: ?autofire=1 (or ?qa=1) force-enables autofire for this
// session regardless of the stored preference. Reading the query string is BOM-only,
// so it keeps this module UI-free.
function readForceAutofire(): boolean {
  try {
    const p = new URLSearchParams(window.location.search);
    return p.get("autofire") === "1" || p.get("qa") === "1";
  } catch {
    return false;
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

// Reduced motion defaults to the OS preference until the player picks explicitly.
function readReducedMotion(): boolean {
  try {
    const stored = localStorage.getItem(MOTION_KEY);
    if (stored !== null) return stored === "1";
  } catch {
    /* storage disabled — fall through to the media query */
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function readFlashLevel(): FlashLevel {
  try {
    const v = localStorage.getItem(FLASH_KEY);
    return v === "off" || v === "low" || v === "full" ? v : "full";
  } catch {
    return "full";
  }
}

function readNumber(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function readDifficulty(key: string): Difficulty {
  try {
    const v = localStorage.getItem(key);
    return isDifficulty(v) ? v : DEFAULT_DIFFICULTY;
  } catch {
    return DEFAULT_DIFFICULTY;
  }
}

type Listener = () => void;

class Settings {
  private muted: boolean;
  private shake: number; // 0..1, scales screen-shake magnitude
  private autofire: boolean; // click toggles continuous fire instead of hold-to-fire
  private master: number; // 0..1 master volume (limiter catches peaks)
  private music: number;  // 0..1 music bus
  private sfx: number;    // 0..1 sfx bus
  private controlsHintSeen: boolean; // has the one-time controls onboarding hint shown?
  private difficulty: Difficulty;    // preferred solo difficulty (validated; default standard)
  private reducedMotion: boolean;    // dampen camera motion (shake/kick/recoil) wholesale
  private flash: FlashLevel;         // full-screen flash washes: off / low / full
  private hitstop: boolean;          // impact hit-stop frames on/off
  private recoil: number;            // 0..1, scales camera kick + weapon recoil punch
  private hudScale: number;          // HUD/overlay zoom, UI_SCALE_MIN..UI_SCALE_MAX
  private listeners = new Set<Listener>();

  constructor() {
    this.muted = readBool(MUTE_KEY, false);
    this.shake = clamp01(readNumber(SHAKE_KEY, 1));
    this.autofire = readBool(AUTOFIRE_KEY, false) || readForceAutofire();
    this.master = clamp01(readNumber(MASTER_KEY, 0.7));
    this.music = clamp01(readNumber(MUSIC_KEY, 0.5));
    this.sfx = clamp01(readNumber(SFX_KEY, 0.9));
    this.controlsHintSeen = readBool(HINT_KEY, false);
    this.difficulty = readDifficulty(DIFFICULTY_KEY);
    this.reducedMotion = readReducedMotion();
    this.flash = readFlashLevel();
    this.hitstop = readBool(HITSTOP_KEY, true);
    this.recoil = clamp01(readNumber(RECOIL_KEY, 1));
    this.hudScale = clampUiScale(readNumber(UI_SCALE_KEY, 1));
  }

  get isMuted(): boolean {
    return this.muted;
  }

  get shakeIntensity(): number {
    return this.shake;
  }

  get isAutofire(): boolean {
    return this.autofire;
  }

  setMuted(value: boolean): void {
    if (this.muted === value) return;
    this.muted = value;
    try {
      localStorage.setItem(MUTE_KEY, value ? "1" : "0");
    } catch {
      /* storage disabled — keep the in-memory value */
    }
    this.emit();
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setShakeIntensity(value: number): void {
    const v = clamp01(value);
    if (this.shake === v) return;
    this.shake = v;
    try {
      localStorage.setItem(SHAKE_KEY, String(v));
    } catch {
      /* storage disabled — keep the in-memory value */
    }
    this.emit();
  }

  setAutofire(value: boolean): void {
    if (this.autofire === value) return;
    this.autofire = value;
    try {
      localStorage.setItem(AUTOFIRE_KEY, value ? "1" : "0");
    } catch {
      /* storage disabled — keep the in-memory value */
    }
    this.emit();
  }

  toggleAutofire(): boolean {
    this.setAutofire(!this.autofire);
    return this.autofire;
  }
  get isControlsHintSeen(): boolean { return this.controlsHintSeen; }

  markControlsHintSeen(): void {
    if (this.controlsHintSeen) return;
    this.controlsHintSeen = true;
    try { localStorage.setItem(HINT_KEY, "1"); } catch {}
  }

  get preferredDifficulty(): Difficulty { return this.difficulty; }

  setPreferredDifficulty(value: Difficulty): void {
    if (this.difficulty === value) return;
    this.difficulty = value;
    try { localStorage.setItem(DIFFICULTY_KEY, value); } catch { /* storage disabled */ }
    this.emit();
  }

  get isReducedMotion(): boolean { return this.reducedMotion; }
  get flashLevel(): FlashLevel { return this.flash; }
  get isHitstop(): boolean { return this.hitstop; }
  get recoilIntensity(): number { return this.recoil; }
  get uiScale(): number { return this.hudScale; }

  // What the render/FX paths actually consume: reduced motion zeroes camera motion
  // (shake + kick + recoil punch) regardless of the individual sliders.
  get effectiveShake(): number { return this.reducedMotion ? 0 : this.shake; }
  get effectiveRecoil(): number { return this.reducedMotion ? 0 : this.recoil; }
  // Multiplier applied to full-screen flash strengths at their call sites.
  get flashFactor(): number { return FLASH_FACTOR[this.flash]; }

  setReducedMotion(value: boolean): void {
    if (this.reducedMotion === value) return;
    this.reducedMotion = value;
    try { localStorage.setItem(MOTION_KEY, value ? "1" : "0"); } catch {}
    this.emit();
  }

  setFlashLevel(value: FlashLevel): void {
    if (this.flash === value) return;
    this.flash = value;
    try { localStorage.setItem(FLASH_KEY, value); } catch {}
    this.emit();
  }

  setHitstop(value: boolean): void {
    if (this.hitstop === value) return;
    this.hitstop = value;
    try { localStorage.setItem(HITSTOP_KEY, value ? "1" : "0"); } catch {}
    this.emit();
  }

  setRecoilIntensity(v: number): void {
    v = clamp01(v);
    if (this.recoil === v) return;
    this.recoil = v;
    try { localStorage.setItem(RECOIL_KEY, String(v)); } catch {}
    this.emit();
  }

  setUiScale(v: number): void {
    v = clampUiScale(v);
    if (this.hudScale === v) return;
    this.hudScale = v;
    try { localStorage.setItem(UI_SCALE_KEY, String(v)); } catch {}
    this.emit();
  }

  get masterVol(): number { return this.master; }
  get musicVol(): number { return this.music; }
  get sfxVol(): number { return this.sfx; }

  setMasterVol(v: number): void { v = clamp01(v); if (this.master === v) return; this.master = v; try { localStorage.setItem(MASTER_KEY, String(v)); } catch {} this.emit(); }
  setMusicVol(v: number): void { v = clamp01(v); if (this.music === v) return; this.music = v; try { localStorage.setItem(MUSIC_KEY, String(v)); } catch {} this.emit(); }
  setSfxVol(v: number): void { v = clamp01(v); if (this.sfx === v) return; this.sfx = v; try { localStorage.setItem(SFX_KEY, String(v)); } catch {} this.emit(); }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }
}

export const settings = new Settings();
