// The weapon stat tooltip as a self-contained controller — the presentation seam the
// interactive-hotbar work (PR #36) mounts on ITS hotbar DOM without merging through Hud:
// give it the current slot elements + weapon ids (setSlots) and a card provider, and it
// owns hover hit-testing, the selected-slot flash, rendering, and positioning. The DATA
// seam is src/sim/weaponStats.ts (weaponCard / weaponCardKey) — pure, DOM-free, reusable
// by any surface (drawers, controller focus, mobile long-press) via show(index, source).
//
// Gameplay-safety invariants (UI contract):
//  - The tooltip element and the slots stay pointer-transparent; hover is hit-tested
//    manually from window mousemove, so clicks/aim always pass through to the game.
//  - Fixed-position + out-of-flow: showing/hiding can never shift the layout.

import type { WeaponId } from "../sim/types.js";
import type { WeaponCard } from "../sim/weaponStats.js";
import { weaponCardKey } from "../sim/weaponStats.js";

export type WeaponTipSource = "hover" | "select" | "focus";

const SELECT_FLASH_SECS = 2.2;

export class WeaponTipController {
  private tip: HTMLElement;
  private slotEls: HTMLElement[] = [];
  private slotIds: WeaponId[] = [];
  private hoverSlot = -1;
  private flashSlot = -1;
  private flashTimer = 0;
  private prevCurrentId: WeaponId | "" = "";
  private tipKey = "";
  private provider: ((id: WeaponId) => WeaponCard | null) | null = null;
  // The tooltip only hit-tests while its host surface is live (a hidden HUD has no slots
  // on screen, but rects would still resolve — the host flips this with visibility).
  private isActive = false;

  constructor(root: HTMLElement) {
    this.tip = document.createElement("div");
    this.tip.className = "hb-tip";
    root.appendChild(this.tip);
    window.addEventListener("mousemove", (e) => this.onMouseMove(e));
  }

  // Live weapon cards (the game closes over the local player, so values include current
  // blessings and low-HP scalers). Null provider hides the tip entirely.
  setProvider(fn: ((id: WeaponId) => WeaponCard | null) | null): void {
    this.provider = fn;
  }

  setActive(isActive: boolean): void {
    if (this.isActive === isActive) return;
    this.isActive = isActive;
    if (!isActive) { this.hoverSlot = -1; this.sync(); }
  }

  // The host hotbar hands over its CURRENT slot elements on every rebuild. Any hotbar
  // shape works — the controller only needs elements to hit-test and anchor against.
  setSlots(slotEls: HTMLElement[], slotIds: WeaponId[]): void {
    this.slotEls = slotEls;
    this.slotIds = slotIds;
  }

  // Selection tracking: switching weapons flashes the selected slot's card (the keyboard
  // path); suppressed on the first observation so a run's opening loadout doesn't pop.
  noteSelection(currentId: WeaponId | ""): void {
    if (currentId !== "" && this.prevCurrentId !== "" && currentId !== this.prevCurrentId) {
      this.show(this.slotIds.indexOf(currentId), "select");
    }
    this.prevCurrentId = currentId;
  }

  // The single trigger seam. "select" flashes and auto-fades; "hover" pins while the
  // cursor stays; "focus" mirrors hover for controller/mobile focus drivers.
  show(index: number, source: WeaponTipSource): void {
    if (source === "select") {
      this.flashSlot = index;
      this.flashTimer = index >= 0 ? SELECT_FLASH_SECS : 0;
    } else {
      this.hoverSlot = index;
    }
    this.sync();
  }

  // Refresh content + anchor. Cheap when nothing changed (keyed on the card's values), so
  // the host calls it once per frame while mods/HP can move the numbers mid-hover.
  sync(): void {
    const idx = this.activeSlot();
    const card = idx >= 0 && this.provider ? this.provider(this.slotIds[idx]) : null;
    if (!card) {
      if (this.tipKey !== "") {
        this.tipKey = "";
        this.tip.classList.remove("show");
      }
      return;
    }
    const key = idx + ":" + weaponCardKey(card);
    if (key !== this.tipKey) {
      this.tipKey = key;
      this.render(card);
      this.tip.classList.add("show");
    }
    this.position(this.slotEls[idx]);
  }

  tick(dt: number): void {
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) { this.flashTimer = 0; this.flashSlot = -1; this.sync(); }
    }
  }

  reset(): void {
    this.slotEls = [];
    this.slotIds = [];
    this.hoverSlot = -1;
    this.flashSlot = -1;
    this.flashTimer = 0;
    this.prevCurrentId = "";
    this.tipKey = "";
    this.tip.classList.remove("show");
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.isActive || this.slotEls.length === 0) {
      if (this.hoverSlot !== -1) { this.hoverSlot = -1; this.sync(); }
      return;
    }
    let hit = -1;
    for (let i = 0; i < this.slotEls.length; i++) {
      const r = this.slotEls[i].getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) { hit = i; break; }
    }
    if (hit !== this.hoverSlot) {
      this.hoverSlot = hit;
      this.sync();
    }
  }

  private activeSlot(): number {
    if (this.hoverSlot >= 0 && this.hoverSlot < this.slotIds.length) return this.hoverSlot;
    if (this.flashTimer > 0 && this.flashSlot >= 0 && this.flashSlot < this.slotIds.length) return this.flashSlot;
    return -1;
  }

  private render(card: WeaponCard): void {
    this.tip.replaceChildren();
    const name = document.createElement("div");
    name.className = "wt-name";
    name.textContent = card.name.toUpperCase();
    const kind = document.createElement("div");
    kind.className = "wt-kind";
    kind.textContent = card.kind === "melee" ? "MELEE" : "RANGED";
    const verb = document.createElement("div");
    verb.className = "wt-verb";
    verb.textContent = card.verb;
    this.tip.append(name, kind, verb);
    for (const l of card.lines) {
      const row = document.createElement("div");
      row.className = "wt-row" + (l.delta > 0 ? " up" : l.delta < 0 ? " down" : "");
      const label = document.createElement("span");
      label.className = "k";
      label.textContent = l.label;
      row.appendChild(label);
      const val = document.createElement("span");
      val.className = "v";
      if (l.delta !== 0) {
        const base = document.createElement("span");
        base.className = "vb";
        base.textContent = l.base;
        const arrow = document.createElement("span");
        arrow.className = "arrow";
        arrow.textContent = "\u2192";
        val.append(base, arrow, document.createTextNode(l.current));
      } else {
        val.textContent = l.current;
      }
      row.appendChild(val);
      this.tip.appendChild(row);
    }
    const hint = document.createElement("div");
    hint.className = "wt-hint";
    hint.textContent = "BASE \u2192 WITH BLESSINGS";
    this.tip.appendChild(hint);
  }

  private position(slot: HTMLElement | undefined): void {
    if (!slot) return;
    const r = slot.getBoundingClientRect();
    const w = this.tip.offsetWidth || 212;
    const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    this.tip.style.left = `${Math.round(x)}px`;
    this.tip.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`;
    this.tip.style.top = "auto";
  }
}
