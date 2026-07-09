// All the on-screen chrome that lives in the DOM (not the game canvas): the corner HUD
// (hearts / stat chips / minimap frame / dash meter), the bottom-center hotbar (weapons
// + blessings), the hold-Tab stats panel, and the between-floor banner. The corner
// markup + CSS come from the ui designer's spec (docs/ui). Elements are built once and
// updated via textContent / classList / CSS vars so nothing ever reflows the layout
// mid-run.

import { renderHearts, mountIcons, itemIconEl, weaponIconEl } from "./hudIcons.js";
import { MAX_ITEM_LEVEL } from "../sim/items.js";
import { FocusScope, currentFocus } from "../ui/focus.js";
import type { WeaponId } from "../sim/types.js";

export interface HudState {
  hp: number;
  maxHp: number;
  floor: number;
  kills: number;
  coins: number;
  // Hotbar slots in inventory order (= the 1-9 selection order); `isCurrent` = equipped.
  weapons: { id: WeaponId; name: string; isCurrent: boolean }[];
  isCleared: boolean;
  enemiesLeft: number;
  isBossActive: boolean;
  bossHpFrac: number; // 0..1 boss health; only shown while isBossActive
  coopLabel: string | null;
  // Party blessing gate readout ("WAITING FOR 1/2 PLAYERS… NAME PICKING…"); null hides it.
  waitLabel: string | null;
  dashFill: number; // 0..1 dash-meter fill, 1 = ready
  // Kill-chain combo (per-local-player). combo 0 hides the widget entirely.
  combo: number;      // current chain length
  comboMult: number;  // score/coin multiplier for the current tier (1 / 1.5 / 2 / 3)
  comboColor: string; // tier accent (drives the mult text + drain bar)
  comboFrac: number;  // 0..1 of the combo window still remaining (drives the drain bar)
  // Collected blessings, duplicates collapsed into a level (count = Lv1-3), shown as
  // compact icon-only slots above the hotbar. desc = the CURRENT level's effect;
  // nextDesc = the next level's effect (the upgrade delta), null at max level.
  items: { id: string; name: string; desc: string; nextDesc: string | null; glyph: string; tint: string; rarity: string; count: number }[];
}

export interface HotbarActions {
  // Click / Enter / Space on a slot: equip that inventory index — or, when the slot is
  // already equipped, open its stat drawer (the touch-safe replacement for hover info).
  onSlotActivate(index: number): void;
  // Drag/drop finished: move slot `from` to position `to` (indices into the CURRENT order).
  onSlotReorder(from: number, to: number): void;
}

// The equipped weapon's stat sheet for the tap-to-inspect drawer. onDrop backs the drawer's
// DROP button (the touch path for Q); null when the weapon can't drop (final weapon).
export interface WeaponDrawerData {
  id: WeaponId;
  name: string;
  damage: number;
  rate: number;    // shots per second
  range: number;   // px (melee reach or bullet travel)
  isMelee: boolean;
  onDrop: (() => void) | null;
}

export interface ProfileStats {
  name: string;
  deepestFloor: number;
  totalKills: number;
  totalCoins: number;
  gamesPlayed: number;
}

export interface RosterEntry { name: string; isYou: boolean; color: string; isDown: boolean; isAtExit: boolean; isReconnecting: boolean; }

export interface StatsPanelData {
  floor: number;
  kills: number;
  coins: number;
  runTime: number; // seconds
  weaponName: string;
  profile: ProfileStats | null;
  roster: RosterEntry[] | null;
  items: { name: string; desc: string; glyph: string; tint: string }[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = css;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// One hotbar slot: select key (1-9) in the corner, weapon icon, name underneath. Slots
// past 9 get no key badge — scroll still cycles to them. Fixed width so switching never
// resizes anything. Slots are pointer/keyboard interactive (click/Enter/Space equips, drag
// reorders — see Hud.attachSlotInteractions), so they carry button semantics for a11y.
// Exported for the DOM suite.
export function buildSlot(w: HudState["weapons"][number], index: number): HTMLElement {
  const slot = el("span", "");
  slot.className = "hb-slot" + (w.isCurrent ? " on" : "");
  slot.tabIndex = 0;
  slot.setAttribute("role", "button");
  slot.setAttribute("aria-label", `${w.name}, slot ${index + 1}${w.isCurrent ? ", equipped" : ""}`);
  slot.title = `${w.name} — click to equip, drag to reorder`;
  if (index < 9) {
    const key = el("span", "", String(index + 1));
    key.className = "hb-key";
    slot.appendChild(key);
  }
  const icon = el("span", "");
  icon.className = "hb-icon";
  const iconEl = weaponIconEl(w.id, w.name);
  if (iconEl instanceof HTMLImageElement) iconEl.draggable = false; // never the native image drag — ours
  icon.appendChild(iconEl);
  const name = el("span", "", w.name.toUpperCase());
  name.className = "hb-name";
  slot.append(icon, name);
  return slot;
}

// UI Director gate: the main-HUD blessing row shows at most this many icon slots; the rest
// collapse into one "+N" overflow chip and the FULL build list lives in the hold-Tab panel.
export const MAX_BUFF_SLOTS = 8;

// One blessing slot: a compact 24px icon-only square with the blessing's tint as its border
// and a small LV badge in the corner — no text in the row itself, so many blessings stay one
// tidy strip. The full name, the exact current effect, and the next-level delta live in the
// hover/focus tooltip (and in the aria-label for screen readers). Exported for the DOM suite.
export function buildBuffChip(it: HudState["items"][number]): HTMLElement {
  const chip = el("span", "");
  chip.className = "hb-buff" + (it.rarity === "rare" ? " rare" : "");
  chip.style.setProperty("--t", it.tint);
  chip.tabIndex = 0;
  chip.setAttribute("role", "img");
  chip.setAttribute("aria-label",
    `${it.name}, level ${it.count}: ${it.desc}` + (it.nextDesc ? ` Next level: ${it.nextDesc}` : ""));
  chip.appendChild(itemIconEl(it.id, it.glyph));

  const lv = el("span", "", String(it.count));
  lv.className = "lv" + (it.count >= MAX_ITEM_LEVEL ? " max" : "");
  chip.appendChild(lv);

  const tip = el("span", "");
  tip.className = "tip";
  const tipName = el("span", "", it.name.toUpperCase());
  tipName.className = "tn";
  const tipNow = el("span", "", `LV${it.count} — ${it.desc}`);
  tipNow.className = "tc";
  tip.append(tipName, tipNow);
  if (it.nextDesc) {
    const tipNext = el("span", "", `NEXT LV${it.count + 1} — ${it.nextDesc}`);
    tipNext.className = "tx";
    tip.appendChild(tipNext);
  } else {
    const tipMax = el("span", "", "MAX LEVEL");
    tipMax.className = "tx max";
    tip.appendChild(tipMax);
  }
  chip.appendChild(tip);
  return chip;
}

// The "+N" overflow chip when the build outgrows the row: points at the hold-Tab panel,
// which always lists the complete build. Exported for the DOM suite.
export function buildMoreChip(hiddenCount: number): HTMLElement {
  const chip = el("span", "", `+${hiddenCount}`);
  chip.className = "hb-buff more";
  chip.tabIndex = 0;
  chip.setAttribute("role", "img");
  chip.setAttribute("aria-label", `${hiddenCount} more blessings. Hold Tab for the full build.`);
  const tip = el("span", "");
  tip.className = "tip";
  const tipName = el("span", "", `${hiddenCount} MORE`);
  tipName.className = "tn";
  const tipHint = el("span", "", "HOLD TAB FOR THE FULL BUILD");
  tipHint.className = "tx";
  tip.append(tipName, tipHint);
  chip.appendChild(tip);
  return chip;
}

// The corner HUD DOM (docs/ui/hud_markup.html) + the bottom-center hotbar. The minimap
// canvas already lives in index.html; its <canvas id="minimap"> is moved into the
// .tr .minimap frame at build. The hotbar is a Minecraft-style strip: one slot per owned
// weapon (icon + name + its 1-9 select key, equipped slot lit) with the player's
// blessings as labeled chips on the row above.
const HUD_MARKUP = `
  <div class="hud-corner tl"><div class="statpanel">
    <div class="hearts" data-hearts></div>
    <div class="statrow">
      <span class="chip floor"><span class="k">FL</span><span class="v" data-floor>1</span></span>
      <span class="chip kills"><span class="ic" data-ic="skull"></span><span class="v" data-kills>0</span></span>
      <span class="chip coins"><span class="ic" data-ic="coin"></span><span class="v" data-coins>0</span></span>
    </div>
  </div><div class="coopstrip" data-coop></div></div>
  <div class="bossbar" data-bossbar>
    <div class="bossbar-label">BOSS</div>
    <div class="bossbar-track"><i data-bossfill></i></div>
  </div>
  <div class="hud-corner tr"><div class="minimap"><span class="mm-title">MAP</span></div></div>
  <div class="hud-corner bl"><div class="dash"><span class="k">DASH</span><span class="key">SHIFT</span><span class="bar"><i style="--dash-fill:1"></i></span></div></div>
  <div class="hotbar">
    <div class="hb-buffs" data-hb-buffs></div>
    <button class="hb-build" data-hb-build type="button" aria-haspopup="dialog"></button>
    <div class="hb-slots" data-hb-slots></div>
    <div class="hb-hint" data-hb-hint>CLICK EQUIP &middot; DRAG REORDER &middot; Q DROP</div>
  </div>
  <div class="combo" data-combo>
    <div class="combo-badge">
      <div class="combo-burst" data-combo-burst></div>
      <div class="combo-mult" data-combo-mult>x1</div>
    </div>
    <div class="combo-row"><span class="combo-n" data-combo-n>0</span><span class="combo-k">COMBO</span></div>
    <div class="combo-bar"><i data-combo-fill></i></div>
  </div>
`;

// In-flight hotbar drag. Exists from pointerdown; isActive flips once the pointer travels
// past the click threshold (so a plain click never flickers a ghost). `gap` is the insertion
// index in 0..slotCount — the position the dragged slot would be spliced into.
interface SlotDrag {
  pointerId: number;
  fromIndex: number;
  startX: number;
  startY: number;
  isActive: boolean;
  ghost: HTMLElement | null;
  marker: HTMLElement | null;
  gap: number;
}

const DRAG_START_PX = 6;

export class Hud {
  private hud: HTMLElement;
  private heartsEl: HTMLElement;
  private floorEl: HTMLElement;
  private killsEl: HTMLElement;
  private coinsEl: HTMLElement;
  private slotsEl: HTMLElement;
  private buffsEl: HTMLElement;
  private hotbarHintEl: HTMLElement;
  private buildPillEl: HTMLButtonElement;
  private scrimEl: HTMLElement;
  private drawerEl: HTMLElement;
  private lastItems: HudState["items"] = [];
  private hotbarActions: HotbarActions | null = null;
  private drawerFocus = new FocusScope(); // modal focus capture/restore (same pattern as overlays)
  private drag: SlotDrag | null = null;
  private prevSlotsKey = "";
  private dashEl: HTMLElement;
  private dashFillEl: HTMLElement;
  private coopEl: HTMLElement;
  private comboEl: HTMLElement;
  private comboMultEl: HTMLElement;
  private comboNEl: HTMLElement;
  private comboFillEl: HTMLElement;
  private comboBurstEl: HTMLElement;
  private bossbarEl!: HTMLElement;
  private bossFillEl!: HTMLElement;
  private prevMult = 1;
  private prevCombo = -1;
  private comboPop = 0; // 0..1 scale-punch applied to the mult text when the chain ticks up
  private prevItemsCount = -1;

  private statsPanel: HTMLElement;
  private statsBody: HTMLElement;
  private banner: HTMLElement;
  private waitLine!: HTMLElement;
  private prevWaitLabel: string | null = null;
  private bannerTimer = 0;
  private controlsHint: HTMLElement;
  private hintTimer = 0;

  // Hearts are the one expensive redraw (canvas per heart), so only rebuild on change.
  private prevHp = -1;
  private prevMaxHp = -1;

  constructor(root: HTMLElement) {
    const hud = el("div", "");
    hud.id = "hud";
    hud.innerHTML = HUD_MARKUP;
    hud.style.display = "none"; // hidden until a run starts
    root.appendChild(hud);
    this.hud = hud;

    this.heartsEl = hud.querySelector("[data-hearts]")!;
    this.floorEl = hud.querySelector("[data-floor]")!;
    this.killsEl = hud.querySelector("[data-kills]")!;
    this.coinsEl = hud.querySelector("[data-coins]")!;
    this.slotsEl = hud.querySelector("[data-hb-slots]")!;
    this.buffsEl = hud.querySelector("[data-hb-buffs]")!;
    this.hotbarHintEl = hud.querySelector("[data-hb-hint]")!;
    this.buildPillEl = hud.querySelector("[data-hb-build]")!;
    // The drawers live on the ROOT, not inside #hud: #hud is a z-index:5 stacking context
    // that would pin them under the root-level hint/banner layers (z 6). Root placement
    // puts them above all passive chrome and still under the menus (z 10) — same pattern
    // as the stats panel below.
    this.scrimEl = el("div", "");
    this.scrimEl.className = "hb-scrim";
    this.drawerEl = el("div", "");
    this.drawerEl.className = "hb-drawer";
    this.drawerEl.setAttribute("role", "dialog");
    this.drawerEl.setAttribute("aria-modal", "true");
    root.append(this.scrimEl, this.drawerEl);
    // The BUILD·N pill (compact/touch summary of the blessing row) taps open the full
    // build drawer; the scrim behind any drawer closes it and swallows the tap.
    this.buildPillEl.addEventListener("click", (e) => { e.stopPropagation(); this.openBuildDrawer(); });
    this.scrimEl.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); this.closeDrawer(); });
    this.dashEl = hud.querySelector(".dash")!;
    this.dashFillEl = hud.querySelector(".dash .bar i")!;
    this.coopEl = hud.querySelector("[data-coop]")!;
    this.comboEl = hud.querySelector("[data-combo]")!;
    this.comboMultEl = hud.querySelector("[data-combo-mult]")!;
    this.comboNEl = hud.querySelector("[data-combo-n]")!;
    this.comboFillEl = hud.querySelector("[data-combo-fill]")!;
    this.comboBurstEl = hud.querySelector("[data-combo-burst]")!;
    this.bossbarEl = hud.querySelector("[data-bossbar]")!;
    this.bossFillEl = hud.querySelector("[data-bossfill]")!;

    // Reconcile the standalone minimap canvas into the .tr frame (see index.html note).
    const minimap = document.getElementById("minimap");
    const frame = hud.querySelector(".minimap");
    if (minimap && frame) frame.appendChild(minimap);

    // Rasterize the chip icons (skull/coin) once; hearts render on hp change.
    mountIcons(hud);

    // Hold-Tab stats panel (token-styled to match the pixel dungeon frame).
    this.statsPanel = el("div",
      `position:fixed;inset:0;z-index:8;display:none;align-items:center;justify-content:center;` +
      `background:rgba(5,3,11,0.72);`);
    const card = el("div",
      `min-width:320px;max-width:440px;padding:22px 26px;background:var(--dun-1);` +
      `box-shadow:0 0 0 3px var(--dun-0),0 0 0 6px var(--dun-4),0 0 0 9px var(--dun-0),inset 0 0 0 2px var(--dun-2),0 12px 0 rgba(0,0,0,0.4);` +
      `color:var(--cream);font:16px var(--f-num),ui-monospace,monospace;font-variant-numeric:tabular-nums;`);
    card.appendChild(el("h2", "color:var(--amber);font:14px var(--f-logo),monospace;letter-spacing:2px;margin-bottom:16px;", "RUN STATS"));
    this.statsBody = el("div", "display:flex;flex-direction:column;gap:6px;");
    card.appendChild(this.statsBody);
    card.appendChild(el("p", "margin-top:16px;font:8px var(--f-ui),monospace;letter-spacing:1px;color:var(--dun-4);", "RELEASE TAB TO CLOSE"));
    this.statsPanel.appendChild(card);
    root.appendChild(this.statsPanel);

    // Transient floor banner.
    this.banner = el("div",
      `position:fixed;top:26%;left:0;right:0;z-index:6;text-align:center;pointer-events:none;` +
      `color:var(--amber);font:22px var(--f-logo),monospace;letter-spacing:4px;` +
      `text-shadow:0 4px 0 var(--dun-0),0 0 18px rgba(255,180,59,0.35);opacity:0;transition:opacity 0.35s ease;`);
    root.appendChild(this.banner);

    // Party blessing gate readout: a standing line under the banner slot while teammates
    // still owe their pick (the descend holds for them). Fixed + opacity-only, no reflow.
    this.waitLine = el("div",
      `position:fixed;top:34%;left:0;right:0;z-index:6;text-align:center;pointer-events:none;` +
      `color:var(--cream);font:10px var(--f-ui),monospace;letter-spacing:2px;` +
      `text-shadow:0 2px 0 var(--dun-0),0 0 10px rgba(0,0,0,0.6);opacity:0;transition:opacity 0.3s ease;`);
    root.appendChild(this.waitLine);

    // One-time controls onboarding hint: a subtle, auto-dismissing line above the hotbar
    // (clear of its blessing-chip row). Fixed + opacity-only so it never shifts the layout.
    this.controlsHint = el("div",
      `position:fixed;left:0;right:0;bottom:122px;z-index:6;text-align:center;pointer-events:none;` +
      `color:var(--cream);font:9px var(--f-ui),monospace;letter-spacing:1px;` +
      `text-shadow:0 2px 0 var(--dun-0),0 0 10px rgba(0,0,0,0.6);opacity:0;transition:opacity 0.6s ease;`,
      "WASD MOVE \u00b7 MOUSE AIM \u00b7 CLICK SHOOT \u00b7 SHIFT DASH");
    root.appendChild(this.controlsHint);
  }

  setVisible(v: boolean) {
    this.hud.style.display = v ? "block" : "none";
  }

  setHotbarActions(actions: HotbarActions) {
    this.hotbarActions = actions;
  }

  // ---- hotbar slot interactions (click equip, drag/drop reorder, keyboard activate) ----
  // Every pointer event is stopped at the slot so a hotbar press can never leak into the
  // game canvas as aim/fire; the rest of the HUD stays pointer-transparent.

  private attachSlotInteractions(slot: HTMLElement, index: number) {
    slot.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation(); // a focused slot owns Enter/Space (Space is also the game's key)
      this.hotbarActions?.onSlotActivate(index);
    });
    slot.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || this.drag) return;
      e.preventDefault();
      e.stopPropagation();
      slot.setPointerCapture(e.pointerId);
      this.drag = { pointerId: e.pointerId, fromIndex: index, startX: e.clientX, startY: e.clientY, isActive: false, ghost: null, marker: null, gap: index };
    });
    slot.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      e.stopPropagation();
      if (!d.isActive) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_START_PX) return;
        this.beginDragVisuals(slot, d);
      }
      this.moveGhost(d, e.clientX, e.clientY);
      d.gap = this.insertionGapAt(e.clientX, e.clientY);
      this.placeInsertionMarker(d);
    });
    slot.addEventListener("pointerup", (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.pointerId) return;
      e.stopPropagation();
      const isDragRelease = d.isActive;
      const from = d.fromIndex;
      // Gap -> final index: removing the source first shifts every later gap down by one.
      const to = d.gap > from ? d.gap - 1 : d.gap;
      this.teardownDrag(slot);
      if (!isDragRelease) this.hotbarActions?.onSlotActivate(index);
      else if (to !== from) this.hotbarActions?.onSlotReorder(from, to);
    });
    slot.addEventListener("pointercancel", () => this.teardownDrag(slot));
  }

  private beginDragVisuals(slot: HTMLElement, d: SlotDrag) {
    d.isActive = true;
    const rect = slot.getBoundingClientRect();
    const ghost = slot.cloneNode(true) as HTMLElement;
    ghost.classList.add("hb-ghost");
    ghost.classList.remove("dragging");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    document.body.appendChild(ghost);
    d.ghost = ghost;
    const marker = el("span", "");
    marker.className = "hb-ins";
    this.slotsEl.appendChild(marker);
    d.marker = marker;
    slot.classList.add("dragging");
  }

  private moveGhost(d: SlotDrag, x: number, y: number) {
    if (!d.ghost) return;
    const r = d.ghost.getBoundingClientRect();
    d.ghost.style.transform = `translate(${x - r.width / 2}px, ${y - r.height / 2}px)`;
  }

  private slotEls(): HTMLElement[] {
    return [...this.slotsEl.querySelectorAll<HTMLElement>(".hb-slot")];
  }

  private insertionGapAt(x: number, y: number): number {
    // Insertion gap under the pointer, row-aware (the strip wraps past ~10 slots): pick the
    // row whose vertical center is nearest, then count that row's slots left of the pointer.
    const slots = this.slotEls();
    if (slots.length === 0) return 0;
    const rects = slots.map((s) => s.getBoundingClientRect());
    const rowTops: number[] = [];
    for (const r of rects) if (!rowTops.some((t) => Math.abs(t - r.top) < 4)) rowTops.push(r.top);
    let rowTop = rowTops[0];
    let best = Infinity;
    for (const t of rowTops) {
      const h = rects.find((r) => Math.abs(r.top - t) < 4)!.height;
      const dist = Math.abs(t + h / 2 - y);
      if (dist < best) { best = dist; rowTop = t; }
    }
    let gap = 0;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (r.top < rowTop - 4) { gap = i + 1; continue; }         // full rows above the target
      if (Math.abs(r.top - rowTop) < 4 && r.left + r.width / 2 < x) gap = i + 1;
    }
    return gap;
  }

  private placeInsertionMarker(d: SlotDrag) {
    if (!d.marker) return;
    const slots = this.slotEls();
    if (slots.length === 0) return;
    const parent = this.slotsEl.getBoundingClientRect();
    const before = d.gap < slots.length ? slots[d.gap].getBoundingClientRect() : null;
    const anchor = before ?? slots[slots.length - 1].getBoundingClientRect();
    const xEdge = before ? anchor.left - 4 : anchor.right + 1;
    d.marker.style.left = `${xEdge - parent.left}px`;
    d.marker.style.top = `${anchor.top - parent.top}px`;
    d.marker.style.height = `${anchor.height}px`;
  }

  private teardownDrag(slot: HTMLElement) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.ghost?.remove();
    d.marker?.remove();
    slot.classList.remove("dragging");
    // The DOM order may now be stale against authority (reorder in flight / rebuilds were
    // held during the drag) — force a rebuild on the next update.
    this.prevSlotsKey = "";
  }

  // ---- drawers (touch-first info surfaces — nothing here is hover-only) ----

  isDrawerOpen(): boolean {
    return this.drawerEl.classList.contains("open");
  }

  // Whether the HUD currently owns the pointer/keys: a live hotbar drag or an open drawer.
  // The game gates gameplay actions on this (the input-context seam), so HUD interaction
  // never leaks into firing/dashing/switching.
  isInteractionActive(): boolean {
    return this.drag !== null || this.isDrawerOpen();
  }

  closeDrawer() {
    const wasOpen = this.isDrawerOpen();
    this.drawerEl.classList.remove("open");
    this.scrimEl.classList.remove("show");
    this.drawerEl.replaceChildren();
    if (wasOpen) this.drawerFocus.close(); // return focus to the pill/slot that opened it
  }

  private openDrawer(title: string, fill: (body: HTMLElement) => void) {
    this.drawerEl.replaceChildren();
    const head = el("div", "");
    head.className = "hd-head";
    head.appendChild(el("span", "", title));
    const close = el("button", "", "CLOSE");
    close.className = "hd-close";
    close.type = "button";
    close.addEventListener("click", (e) => { e.stopPropagation(); this.closeDrawer(); });
    head.appendChild(close);
    this.drawerEl.appendChild(head);
    const body = el("div", "");
    body.className = "hd-body";
    fill(body);
    this.drawerEl.appendChild(body);
    this.drawerEl.classList.add("open");
    this.scrimEl.classList.add("show");
    this.drawerFocus.open(close, currentFocus());
  }

  // The full build list as a bottom drawer — what the collapsed BUILD·N pill taps open
  // (same content the hold-Tab panel shows, reachable without a keyboard).
  openBuildDrawer() {
    this.openDrawer(`BUILD \u00b7 ${this.lastItems.length}`, (body) => {
      if (this.lastItems.length === 0) {
        body.appendChild(el("p", "", "NO BLESSINGS YET"));
        return;
      }
      for (const it of this.lastItems) {
        const row = el("div", "");
        row.className = "hd-row";
        row.style.setProperty("--t", it.tint);
        const icon = el("span", "");
        icon.className = "hd-icon";
        icon.appendChild(itemIconEl(it.id, it.glyph));
        const text = el("span", "");
        text.className = "hd-text";
        const name = el("span", "", `${it.name.toUpperCase()} \u00b7 LV${it.count}`);
        name.className = "hd-name";
        const desc = el("span", "", it.desc);
        desc.className = "hd-desc";
        text.append(name, desc);
        if (it.nextDesc) {
          const next = el("span", "", `NEXT LV${it.count + 1} \u2014 ${it.nextDesc}`);
          next.className = "hd-next";
          text.appendChild(next);
        }
        row.append(icon, text);
        body.appendChild(row);
      }
    });
  }

  // The equipped weapon's stat sheet — the tap path for what hover-only title text showed
  // (activate an already-equipped slot to open it). Carries the touch DROP action too.
  openWeaponDrawer(d: WeaponDrawerData) {
    this.openDrawer(d.name.toUpperCase(), (body) => {
      const stats = el("div", "");
      stats.className = "hd-stats";
      const stat = (k: string, v: string) => {
        const box = el("span", "");
        box.className = "hd-stat";
        box.append(el("span", "", k), el("b", "", v));
        stats.appendChild(box);
      };
      stat("DMG", String(d.damage));
      stat("RATE", `${d.rate.toFixed(1)}/S`);
      stat(d.isMelee ? "REACH" : "RANGE", `${Math.round(d.range)} PX`);
      body.appendChild(stats);
      if (d.onDrop) {
        const drop = el("button", "", "DROP (Q)");
        drop.className = "hd-drop";
        drop.type = "button";
        drop.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeDrawer(); // release the input context BEFORE the drop action runs
          d.onDrop?.();
        });
        body.appendChild(drop);
      }
    });
  }

  update(s: HudState) {
    if (s.hp !== this.prevHp || s.maxHp !== this.prevMaxHp) {
      renderHearts(this.heartsEl, s.hp, s.maxHp);
      this.prevHp = s.hp;
      this.prevMaxHp = s.maxHp;
    }
    this.floorEl.textContent = String(s.floor);
    this.killsEl.textContent = String(s.kills);
    this.coinsEl.textContent = String(s.coins);
    // Hotbar: one slot per owned weapon (icon + name + select key), equipped slot lit.
    // Only rebuild when the set/order or selection changes (cheap string key), and NEVER
    // mid-drag — replacing the slots would strand the pointer capture; the drag teardown
    // forces the rebuild instead, realigning the DOM with authority.
    const slotsKey = s.weapons.map((w) => (w.isCurrent ? "*" : "") + w.id).join("|");
    if (slotsKey !== this.prevSlotsKey && !this.drag) {
      this.prevSlotsKey = slotsKey;
      this.slotsEl.replaceChildren();
      s.weapons.forEach((w, i) => {
        const slot = buildSlot(w, i);
        this.attachSlotInteractions(slot, i);
        this.slotsEl.appendChild(slot);
      });
    }
    // The interaction hint matters once there is something to switch/reorder/drop.
    this.hotbarHintEl.classList.toggle("show", s.weapons.length > 1);

    const fill = s.dashFill < 0 ? 0 : s.dashFill > 1 ? 1 : s.dashFill;
    this.dashFillEl.style.setProperty("--dash-fill", String(fill));
    this.dashEl.classList.toggle("ready", fill >= 1);

    // Boss health bar: a big top-center bar visible only while a boss is on the board,
    // draining as it takes damage and flashing red when the boss is nearly dead.
    this.bossbarEl.classList.toggle("show", s.isBossActive);
    if (s.isBossActive) {
      const bf = s.bossHpFrac < 0 ? 0 : s.bossHpFrac > 1 ? 1 : s.bossHpFrac;
      this.bossFillEl.style.transform = `scaleX(${bf})`;
      this.bossbarEl.classList.toggle("low", bf < 0.25);
    }

    this.coopEl.textContent = s.coopLabel ?? "";
    this.coopEl.style.display = s.coopLabel ? "block" : "none";

    if (s.waitLabel !== this.prevWaitLabel) {
      this.prevWaitLabel = s.waitLabel;
      this.waitLine.textContent = s.waitLabel ?? "";
      this.waitLine.style.opacity = s.waitLabel ? "1" : "0";
    }

    this.updateCombo(s);

    // Rebuild the blessing chips only when a blessing is picked. Gated on total picks
    // (sum of levels) so a repeat pick that just levels a chip still refreshes it. The row
    // is capped at MAX_BUFF_SLOTS: past that, the last slot becomes a "+N" overflow chip
    // and the hold-Tab panel carries the full build.
    const totalPicks = s.items.reduce((n, it) => n + it.count, 0);
    this.lastItems = s.items;
    if (totalPicks !== this.prevItemsCount) {
      this.prevItemsCount = totalPicks;
      this.buffsEl.replaceChildren();
      const shownCount = s.items.length > MAX_BUFF_SLOTS ? MAX_BUFF_SLOTS - 1 : s.items.length;
      for (const it of s.items.slice(0, shownCount)) this.buffsEl.appendChild(buildBuffChip(it));
      if (s.items.length > shownCount) this.buffsEl.appendChild(buildMoreChip(s.items.length - shownCount));
      this.buffsEl.classList.toggle("show", s.items.length > 0);
      // Compact/touch contexts collapse the chip row into this summary pill (CSS decides
      // which of the two is visible); tapping it opens the full build drawer.
      this.buildPillEl.textContent = `BUILD \u00b7 ${s.items.length}`;
      this.buildPillEl.setAttribute("aria-label", `${s.items.length} blessings. Open the full build.`);
      this.buildPillEl.classList.toggle("has", s.items.length > 0);
    }
  }

  private updateCombo(s: HudState) {
    // Text refreshes only on a change (and punches the mult when the chain grows); the
    // drain bar tracks the window every frame. Show/hide is opacity+transform only, so
    // the widget never shifts the layout, and combo 0 fades it out.
    if (s.combo !== this.prevCombo) {
      if (s.combo > this.prevCombo && this.prevCombo > 0) this.comboPop = 1; // ticked up mid-chain
      this.comboNEl.textContent = String(s.combo);
      this.comboMultEl.textContent = "x" + (Number.isInteger(s.comboMult) ? s.comboMult : s.comboMult.toFixed(1));
      // One-shot tier-up flare: retrigger the CSS burst animation when the multiplier
      // climbs into a higher tier (not on every kill — only a tier jump earns the flair).
      if (s.comboMult > this.prevMult) {
        this.comboBurstEl.style.animation = "none";
        void this.comboBurstEl.offsetWidth; // reflow so the animation restarts
        this.comboBurstEl.style.animation = "";
        this.comboBurstEl.classList.add("fire");
      } else if (s.comboMult < this.prevMult) {
        this.comboBurstEl.classList.remove("fire");
      }
      this.prevMult = s.comboMult;
      this.prevCombo = s.combo;
    }
    this.comboEl.style.setProperty("--combo-c", s.comboColor);
    const frac = s.comboFrac < 0 ? 0 : s.comboFrac > 1 ? 1 : s.comboFrac;
    this.comboFillEl.style.setProperty("--combo-fill", String(frac));
    const isActive = s.combo > 0;
    this.comboEl.classList.toggle("show", isActive);
    this.comboEl.classList.toggle("low", isActive && frac < 0.34); // flash when about to expire
  }

  showStats(d: StatsPanelData) {
    const line = (label: string, value: string) => {
      const row = el("div", "display:flex;justify-content:space-between;gap:24px;");
      row.appendChild(el("span", "color:#9a8fb5;", label));
      row.appendChild(el("span", "color:#ffe6b0;", value));
      return row;
    };
    this.statsBody.replaceChildren();
    this.statsBody.append(
      line("floor", String(d.floor)),
      line("kills", String(d.kills)),
      line("coins", String(d.coins)),
      line("weapon", d.weaponName),
      line("run time", fmtTime(d.runTime)),
    );
    if (d.items.length) {
      this.statsBody.appendChild(el("div", "height:1px;background:rgba(255,180,59,0.2);margin:8px 0;"));
      this.statsBody.appendChild(el("div", "color:var(--amber);font-size:12px;letter-spacing:1px;", `BLESSINGS \u00b7 ${d.items.length}`));
      for (const it of d.items) {
        const row = el("div", "display:flex;align-items:flex-start;gap:8px;");
        const icon = el("span", "font-size:14px;line-height:1.3;", it.glyph);
        icon.style.color = it.tint;
        const text = el("div", "display:flex;flex-direction:column;gap:1px;");
        text.append(
          el("span", "color:#ffe6b0;", it.name),
          el("span", "color:#9a8fb5;font-size:13px;", it.desc),
        );
        row.append(icon, text);
        this.statsBody.appendChild(row);
      }
    }
    if (d.roster && d.roster.length) {
      this.statsBody.appendChild(el("div", "height:1px;background:rgba(255,180,59,0.2);margin:8px 0;"));
      this.statsBody.appendChild(el("div", "color:#5ad1ff;font-size:12px;letter-spacing:1px;", "PARTY"));
      for (const r of d.roster) {
        const row = el("div", "display:flex;align-items:center;gap:8px;");
        row.appendChild(el("span", `width:10px;height:10px;border-radius:50%;background:${r.color};display:inline-block;`));
        // A reconnecting member is neither dead nor departed — their body is reserved for
        // the reconnect grace (the Sev-0 coherence system); the roster says so explicitly.
        const state = r.isReconnecting ? " \u2014 reconnecting\u2026" : r.isDown ? " \u2014 down" : r.isAtExit ? " \u2014 at the stairs" : "";
        const label = `${r.name}${r.isYou ? " (you)" : ""}${state}`;
        row.appendChild(el("span", `color:${r.isReconnecting ? "#9a8fb5" : r.isDown ? "#ff6a6a" : r.isAtExit ? "#8affc0" : "#ffe6b0"};`, label));
        this.statsBody.appendChild(row);
      }
    }
    if (d.profile) {
      this.statsBody.appendChild(el("div", "height:1px;background:rgba(255,180,59,0.2);margin:8px 0;"));
      this.statsBody.appendChild(el("div", "color:#ffb43b;font-size:12px;letter-spacing:1px;", `${d.profile.name.toUpperCase()} \u2014 ALL TIME`));
      this.statsBody.append(
        line("deepest floor", String(d.profile.deepestFloor)),
        line("total kills", String(d.profile.totalKills)),
        line("total coins", String(d.profile.totalCoins)),
        line("games played", String(d.profile.gamesPlayed)),
      );
    }
    this.statsPanel.style.display = "flex";
  }

  hideStats() {
    this.statsPanel.style.display = "none";
  }

  showBanner(text: string) {
    this.banner.textContent = text;
    this.banner.style.opacity = "1";
    this.bannerTimer = 1.4;
  }

  // Fade the controls hint in for ~5s, then let the CSS transition fade it out. Called
  // once at run start (the caller gates it on the one-time settings flag).
  showControlsHint() {
    this.controlsHint.style.opacity = "1";
    this.hintTimer = 5;
  }

  tick(dt: number) {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.style.opacity = "0";
    }
    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.controlsHint.style.opacity = "0";
    }
    if (this.comboPop > 0) {
      this.comboPop = Math.max(0, this.comboPop - dt * 6); // punch eases out in ~0.16s
      this.comboMultEl.style.transform = `scale(${1 + this.comboPop * 0.35})`;
    }
  }

  clear() {
    this.coopEl.textContent = "";
    this.coopEl.style.display = "none";
    this.waitLine.style.opacity = "0";
    this.prevWaitLabel = null;
    this.comboEl.classList.remove("show", "low");
    this.comboMultEl.style.transform = "scale(1)";
    this.prevCombo = -1;
    this.prevMult = 1;
    this.comboPop = 0;
    this.comboBurstEl.classList.remove("fire");
    this.drag?.ghost?.remove();
    this.drag?.marker?.remove();
    this.drag = null;
    this.closeDrawer();
    this.buildPillEl.classList.remove("has");
    this.lastItems = [];
    this.slotsEl.replaceChildren();
    this.prevSlotsKey = "";
    this.hotbarHintEl.classList.remove("show");
    this.buffsEl.replaceChildren();
    this.buffsEl.classList.remove("show");
    this.prevItemsCount = -1;
  }
}
