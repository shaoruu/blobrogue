// Screen-shake intensity, persisted to localStorage. Deliberately DOM-free so the game
// loop can read it without pulling in any UI. Audio mute/volume lives in the audio engine
// (persisted separately under blobrogue.audio), so this stays tiny.

const SHAKE_KEY = "blobrogue.shake";

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
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

class Settings {
  private shake: number; // 0..1, scales screen-shake magnitude

  constructor() {
    this.shake = clamp01(readNumber(SHAKE_KEY, 1));
  }

  get shakeIntensity(): number {
    return this.shake;
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
  }
}

export const settings = new Settings();
