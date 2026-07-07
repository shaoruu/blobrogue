// Player-facing "feel" settings — audio mute, screen-shake intensity, and autofire —
// persisted to localStorage. Deliberately DOM-free so both the audio engine and the
// game loop can read it without pulling in any UI. A tiny subscriber list lets the
// audio engine react to a mute toggle the instant it flips.

const MUTE_KEY = "blobrogue.muted";
const SHAKE_KEY = "blobrogue.shake";
const AUTOFIRE_KEY = "blobrogue.autofire";
const MASTER_KEY = "blobrogue.vol.master";
const MUSIC_KEY = "blobrogue.vol.music";
const SFX_KEY = "blobrogue.vol.sfx";

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
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

type Listener = () => void;

class Settings {
  private muted: boolean;
  private shake: number; // 0..1, scales screen-shake magnitude
  private autofire: boolean; // click toggles continuous fire instead of hold-to-fire
  private master: number; // 0..1 master volume (limiter catches peaks)
  private music: number;  // 0..1 music bus
  private sfx: number;    // 0..1 sfx bus
  private listeners = new Set<Listener>();

  constructor() {
    this.muted = readBool(MUTE_KEY, false);
    this.shake = clamp01(readNumber(SHAKE_KEY, 1));
    this.autofire = readBool(AUTOFIRE_KEY, false) || readForceAutofire();
    this.master = clamp01(readNumber(MASTER_KEY, 0.7));
    this.music = clamp01(readNumber(MUSIC_KEY, 0.5));
    this.sfx = clamp01(readNumber(SFX_KEY, 0.9));
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
