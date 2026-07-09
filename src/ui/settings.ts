import { settings } from "../game/settings.js";
import type { FlashLevel } from "../game/settings.js";
import { audio } from "../game/audio.js";

// The shared settings controls, wired straight to the persisted `settings` singleton.
// Reused on the title screen and in the in-game pause overlay so both stay in sync
// automatically (they read/write the same source of truth).

function toggleButton(label: string, read: () => boolean, toggle: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "secondary";
  btn.setAttribute("aria-pressed", String(read()));
  const sync = () => {
    btn.textContent = `${label}: ${read() ? "on" : "off"}`;
    btn.setAttribute("aria-pressed", String(read()));
  };
  sync();
  btn.addEventListener("click", () => { toggle(); sync(); });
  return btn;
}

function sliderRow(label: string, min: number, max: number, step: number, read: () => number, write: (v: number) => void): HTMLElement {
  const row = document.createElement("label");
  row.className = "settings-shake";
  const text = document.createElement("span");
  text.className = "settings-label";
  const val = document.createElement("span");
  val.className = "settings-val";
  const syncVal = () => { val.textContent = `${Math.round(read() * 100)}%`; };
  text.append(document.createTextNode(`${label} `), val);
  const range = document.createElement("input");
  range.type = "range";
  range.min = String(min); range.max = String(max); range.step = String(step);
  range.value = String(Math.round(read() * 100));
  range.setAttribute("aria-label", `${label} intensity`);
  syncVal();
  range.addEventListener("input", () => {
    write(Number(range.value) / 100);
    syncVal();
  });
  row.append(text, range);
  return row;
}

const FLASH_ORDER: FlashLevel[] = ["full", "low", "off"];
const PHOTOSENSITIVITY_NOTE = "full-intensity flashes may affect photosensitive players";

export function createSettingsControls(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings";

  const mute = document.createElement("button");
  mute.className = "secondary settings-mute";
  const syncMute = () => {
    mute.textContent = settings.isMuted ? "sound: off" : "sound: on";
    mute.setAttribute("aria-pressed", String(!settings.isMuted));
  };
  syncMute();
  mute.addEventListener("click", () => {
    settings.toggleMuted();
    audio.unlock(); // this click is a gesture — resume the context so unmuting is instant
    syncMute();
  });

  const autofire = toggleButton("autofire", () => settings.isAutofire, () => settings.toggleAutofire());
  autofire.classList.add("settings-autofire");

  const shake = sliderRow("screen shake", 0, 100, 5, () => settings.shakeIntensity, (v) => settings.setShakeIntensity(v));

  // ---- accessibility ----
  const reducedMotion = toggleButton("reduced motion", () => settings.isReducedMotion, () => settings.setReducedMotion(!settings.isReducedMotion));
  const hitstop = toggleButton("hit-stop", () => settings.isHitstop, () => settings.setHitstop(!settings.isHitstop));

  // Flash level cycles full -> low -> off; the photosensitivity note shows only at full.
  const flash = document.createElement("button");
  flash.className = "secondary settings-flash";
  const flashNote = document.createElement("p");
  flashNote.className = "settings-note";
  const syncFlash = () => {
    flash.textContent = `flashes: ${settings.flashLevel}`;
    flashNote.textContent = settings.flashLevel === "full" ? PHOTOSENSITIVITY_NOTE : "";
    flashNote.style.display = settings.flashLevel === "full" ? "" : "none";
  };
  syncFlash();
  flash.addEventListener("click", () => {
    const next = FLASH_ORDER[(FLASH_ORDER.indexOf(settings.flashLevel) + 1) % FLASH_ORDER.length];
    settings.setFlashLevel(next);
    syncFlash();
  });

  const recoil = sliderRow("recoil & kick", 0, 100, 5, () => settings.recoilIntensity, (v) => settings.setRecoilIntensity(v));
  const uiScale = sliderRow("ui scale", 75, 150, 5, () => settings.uiScale, (v) => settings.setUiScale(v));

  wrap.append(mute, autofire, shake, reducedMotion, hitstop, flash, flashNote, recoil, uiScale);
  return wrap;
}

// Apply the persisted UI scale to the HUD/overlay layers (index.html reads --ui-scale)
// and keep it live as the setting changes. Call once at boot.
export function bindUiScale(): void {
  const apply = () => document.documentElement.style.setProperty("--ui-scale", String(settings.uiScale));
  apply();
  settings.onChange(apply);
}
