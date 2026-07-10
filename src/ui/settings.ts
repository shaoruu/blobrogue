import { settings } from "../game/settings.js";
import type { FlashLevel } from "../game/settings.js";
import { audio } from "../game/audio.js";

// The shared settings controls, wired straight to the persisted `settings` singleton and
// reused verbatim by BOTH the title Settings screen and the in-game pause overlay (one
// component, so the two can never drift). Presented as TABBED categories (Audio / Gameplay
// / Video / Accessibility): a role=tablist strip over a fixed-height body that shows one
// category at a time, so switching tabs never resizes the panel (zero CLS). Every control
// is one of three row types — a compact switch, a slider with a reserved value, or a small
// cycle stepper — all on the shared 40px .set-row.

export interface SettingsControls {
  root: HTMLElement;
  // Controller LB/RB (and the menu's tab hook) steps the visible category.
  cycleTab: (dir: 1 | -1) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// One control row: a label (+ optional sub) on the left, one control on the right. Fixed
// height/padding so every row across every tab reads as the same component.
function row(label: string, sub: string | null, control: HTMLElement): HTMLElement {
  const r = el("div", "set-row");
  const left = el("div", "set-label");
  left.appendChild(el("span", "lab", label));
  if (sub) left.appendChild(el("span", "sub", sub));
  r.append(left, control);
  return r;
}

// A compact pill switch (never a full-width text button): the state is the KNOB POSITION
// plus the ON/OFF text, not hue alone. role=switch + aria-checked for a11y.
function switchControl(read: () => boolean, toggle: () => void, onSync?: () => void): { el: HTMLButtonElement; sync: () => void } {
  const btn = el("button", "set-switch");
  btn.type = "button";
  btn.setAttribute("role", "switch");
  const track = el("span", "set-switch-track");
  track.appendChild(el("span", "set-switch-knob"));
  const txt = el("span", "set-switch-txt");
  btn.append(track, txt);
  const sync = () => {
    const on = read();
    btn.setAttribute("aria-checked", String(on));
    txt.textContent = on ? "ON" : "OFF";
  };
  sync();
  btn.addEventListener("click", () => { toggle(); sync(); onSync?.(); });
  return { el: btn, sync };
}

// A range slider with its value pinned to a FIXED-width readout (no row shift on drag).
function sliderControl(min: number, max: number, step: number, read: () => number, write: (v: number) => void, opts: { onInput?: () => void } = {}): { el: HTMLElement; range: HTMLInputElement; sync: () => void } {
  const wrap = el("div", "set-slider");
  const range = el("input");
  range.type = "range";
  range.min = String(min); range.max = String(max); range.step = String(step);
  range.value = String(Math.round(read() * 100));
  const val = el("span", "set-val");
  const sync = () => {
    const pct = `${Math.round(read() * 100)}%`;
    val.textContent = pct;
    range.setAttribute("aria-valuetext", pct);
    range.value = String(Math.round(read() * 100));
  };
  sync();
  range.addEventListener("input", () => {
    write(Number(range.value) / 100);
    sync();
    opts.onInput?.();
  });
  wrap.append(range, val);
  return { el: wrap, range, sync };
}

// A small ‹ VALUE › stepper for a short enumerated setting (the flash level).
function cycleControl<T extends string>(options: readonly T[], labels: Record<T, string>, read: () => T, set: (v: T) => void, onChange?: () => void): { el: HTMLElement; sync: () => void } {
  const wrap = el("div", "set-cycle");
  const prev = el("button", "set-step", "\u2039");
  prev.type = "button"; prev.setAttribute("aria-label", "previous");
  const value = el("span", "set-cycle-v");
  const next = el("button", "set-step", "\u203a");
  next.type = "button"; next.setAttribute("aria-label", "next");
  const sync = () => { value.textContent = labels[read()]; };
  sync();
  const step = (dir: number) => {
    const i = options.indexOf(read());
    set(options[(i + dir + options.length) % options.length]);
    sync();
    onChange?.();
  };
  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  wrap.append(prev, value, next);
  return { el: wrap, sync };
}

const FLASH_OPTIONS: readonly FlashLevel[] = ["off", "low", "full"];
const FLASH_LABELS: Record<FlashLevel, string> = { off: "OFF", low: "LOW", full: "FULL" };
const PHOTOSENSITIVITY_NOTE = "full-intensity flashes may affect photosensitive players";

// ---- the four category tabs (each returns its rows fresh on selection) ----

function buildAudioTab(): HTMLElement[] {
  // Mute is a real switch (sound on/off); while muted the three volume rows dim + a
  // reserved note explains it, and the stored mix survives the round-trip untouched.
  const volumeRows: HTMLElement[] = [];
  const mutedNote = el("p", "set-note");
  const syncMuted = () => {
    const isMuted = settings.isMuted;
    for (const r of volumeRows) r.classList.toggle("is-muted", isMuted);
    mutedNote.textContent = isMuted ? "muted \u2014 sliders keep your mix until sound is back on" : "";
  };
  const mute = switchControl(() => !settings.isMuted, () => { settings.toggleMuted(); audio.unlock(); }, syncMuted);
  const master = sliderControl(0, 100, 5, () => settings.masterVol, (v) => {
    audio.unlock();
    if (settings.isMuted && v > 0) { settings.setMuted(false); mute.sync(); syncMuted(); }
    settings.setMasterVol(v);
  });
  const music = sliderControl(0, 100, 5, () => settings.musicVol, (v) => settings.setMusicVol(v));
  const sfx = sliderControl(0, 100, 5, () => settings.sfxVol, (v) => settings.setSfxVol(v));
  master.range.setAttribute("aria-label", "master volume");
  music.range.setAttribute("aria-label", "music");
  sfx.range.setAttribute("aria-label", "sfx");
  const masterRow = row("master volume", null, master.el);
  const musicRow = row("music", null, music.el);
  const sfxRow = row("sfx", null, sfx.el);
  volumeRows.push(masterRow, musicRow, sfxRow);
  syncMuted();
  return [row("sound", "mute all audio", mute.el), masterRow, musicRow, sfxRow, mutedNote];
}

function buildGameplayTab(): HTMLElement[] {
  const autofire = switchControl(() => settings.isAutofire, () => settings.toggleAutofire());
  return [row("autofire", "click toggles continuous fire", autofire.el)];
}

function buildVideoTab(): HTMLElement[] {
  const shake = sliderControl(0, 100, 5, () => settings.shakeIntensity, (v) => settings.setShakeIntensity(v));
  const uiScale = sliderControl(75, 150, 5, () => settings.uiScale, (v) => settings.setUiScale(v));
  shake.range.setAttribute("aria-label", "screen shake");
  uiScale.range.setAttribute("aria-label", "ui scale");
  const highContrast = switchControl(() => settings.isHighContrast, () => settings.setHighContrast(!settings.isHighContrast));
  return [
    row("screen shake", null, shake.el),
    row("ui scale", null, uiScale.el),
    row("high contrast", "lift dark scenes for readability", highContrast.el),
  ];
}

function buildAccessibilityTab(): HTMLElement[] {
  const reducedMotion = switchControl(() => settings.isReducedMotion, () => settings.setReducedMotion(!settings.isReducedMotion));
  const hitstop = switchControl(() => settings.isHitstop, () => settings.setHitstop(!settings.isHitstop));
  const recoil = sliderControl(0, 100, 5, () => settings.recoilIntensity, (v) => settings.setRecoilIntensity(v));
  recoil.range.setAttribute("aria-label", "recoil & kick");
  // The flashes cycle carries the photosensitivity note directly beneath it (reserved
  // height), shown only at the full-intensity level.
  const flashNote = el("p", "set-note");
  const syncNote = () => { flashNote.textContent = settings.flashLevel === "full" ? PHOTOSENSITIVITY_NOTE : ""; };
  const flash = cycleControl(FLASH_OPTIONS, FLASH_LABELS, () => settings.flashLevel, (v) => settings.setFlashLevel(v), syncNote);
  syncNote();
  return [
    row("reduced motion", "dampen camera shake & kick", reducedMotion.el),
    row("flashes", "full-screen flash washes", flash.el),
    flashNote,
    row("hit-stop", "impact freeze frames", hitstop.el),
    row("recoil & kick", null, recoil.el),
  ];
}

interface Tab { id: string; label: string; build: () => HTMLElement[] }
const TABS: Tab[] = [
  { id: "audio", label: "AUDIO", build: buildAudioTab },
  { id: "gameplay", label: "GAMEPLAY", build: buildGameplayTab },
  { id: "video", label: "VIDEO", build: buildVideoTab },
  { id: "accessibility", label: "A11Y", build: buildAccessibilityTab },
];

export function createSettingsControls(opts: { isTwoCol?: boolean } = {}): SettingsControls {
  const root = el("div", "settings");
  const tablist = el("div", "set-tabs");
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", "settings categories");
  const body = el("div", `set-body${opts.isTwoCol ? " two-col" : ""}`);
  body.setAttribute("role", "tabpanel");
  const tabButtons: HTMLButtonElement[] = [];
  let active = 0;

  const select = (i: number) => {
    active = ((i % TABS.length) + TABS.length) % TABS.length;
    tabButtons.forEach((b, j) => b.setAttribute("aria-selected", String(j === active)));
    body.replaceChildren(...TABS[active].build());
    body.setAttribute("aria-label", `${TABS[active].label} settings`);
  };

  TABS.forEach((tab, i) => {
    const b = el("button", "set-tab", tab.label);
    b.type = "button";
    b.id = `set-tab-${tab.id}`;
    b.setAttribute("role", "tab");
    b.addEventListener("click", () => select(i));
    b.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") { e.preventDefault(); select(active + 1); tabButtons[active].focus(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); select(active - 1); tabButtons[active].focus(); }
    });
    tabButtons.push(b);
    tablist.appendChild(b);
  });

  root.append(tablist, body);
  select(0);
  return { root, cycleTab: (dir) => { select(active + dir); } };
}

// Apply the persisted UI scale to the HUD/overlay layers (index.html reads --ui-scale)
// and keep it live as the setting changes. Call once at boot.
export function bindUiScale(): void {
  const apply = () => document.documentElement.style.setProperty("--ui-scale", String(settings.uiScale));
  apply();
  settings.onChange(apply);
}
