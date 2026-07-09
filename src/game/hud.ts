// All the on-screen chrome that lives in the DOM (not the game canvas): the corner HUD
// (hearts / stat chips / minimap frame / dash meter), the bottom-center hotbar (weapons
// + blessings), the hold-Tab stats panel, and the between-floor banner. The corner
// markup + CSS come from the ui designer's spec (docs/ui). Elements are built once and
// updated via textContent / classList / CSS vars so nothing ever reflows the layout
// mid-run.

import { renderHearts, mountIcons, itemIconEl, weaponIconEl } from "./hudIcons.js";
import type { WeaponId } from "../sim/types.js";
import type { WeaponCard } from "../sim/weaponStats.js";
import { weaponCardKey } from "../sim/weaponStats.js";

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
  dashFill: number; // 0..1 dash-meter fill, 1 = ready
  // Kill-chain combo (per-local-player). combo 0 hides the widget entirely.
  combo: number;      // current chain length
  comboMult: number;  // score/coin multiplier for the current tier (1 / 1.5 / 2 / 3)
  comboColor: string; // tier accent (drives the mult text + drain bar)
  comboFrac: number;  // 0..1 of the combo window still remaining (drives the drain bar)
  // Collected blessings, duplicates collapsed into a level (count = Lv1-3), shown as
  // labeled chips above the hotbar.
  items: { id: string; name: string; desc: string; glyph: string; tint: string; rarity: string; count: number }[];
}

export interface ProfileStats {
  name: string;
  deepestFloor: number;
  totalKills: number;
  totalCoins: number;
  gamesPlayed: number;
}

export interface RosterEntry { name: string; isYou: boolean; color: string; isDown: boolean; }

export interface StatsPanelData {
  floor: number;
  kills: number;
  coins: number;
  runTime: number; // seconds
  weaponName: string;
  // Live per-run accumulation (sim RunStats) — the same numbers the run submission reports.
  damageDealt: number;
  damageTaken: number;
  bestCombo: number;
  bossKills: number;
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
// past 9 get no key badge — Q/scroll still cycles to them. Fixed width so switching
// never resizes anything.
function buildSlot(w: HudState["weapons"][number], index: number): HTMLElement {
  const slot = el("span", "");
  slot.className = "hb-slot" + (w.isCurrent ? " on" : "");
  if (index < 9) {
    const key = el("span", "", String(index + 1));
    key.className = "hb-key";
    slot.appendChild(key);
  }
  const icon = el("span", "");
  icon.className = "hb-icon";
  icon.appendChild(weaponIconEl(w.id, w.name));
  const name = el("span", "", w.name.toUpperCase());
  name.className = "hb-name";
  slot.append(icon, name);
  return slot;
}

// One blessing chip: tinted icon + name + Lv1-3, with the current level's effect text
// as a hover tooltip (the chips row is the only pointer-enabled part of the hotbar).
function buildBuffChip(it: HudState["items"][number]): HTMLElement {
  const chip = el("span", "");
  chip.className = "hb-buff" + (it.rarity === "rare" ? " rare" : "");
  chip.style.setProperty("--t", it.tint);
  chip.appendChild(itemIconEl(it.id, it.glyph));
  const name = el("span", "", it.name.toUpperCase());
  name.className = "bn";
  const lv = el("span", "", "LV" + it.count);
  lv.className = "bl";
  const tip = el("span", "", it.desc);
  tip.className = "tip";
  chip.append(name, lv, tip);
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
    <div class="hb-slots" data-hb-slots></div>
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

export class Hud {
  private hud: HTMLElement;
  private heartsEl: HTMLElement;
  private floorEl: HTMLElement;
  private killsEl: HTMLElement;
  private coinsEl: HTMLElement;
  private slotsEl: HTMLElement;
  private buffsEl: HTMLElement;
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
  private bannerTimer = 0;
  private controlsHint: HTMLElement;
  private hintTimer = 0;

  // ---- weapon stat tooltip (hover / keyboard-selected slot) ----
  // The slots stay pointer-events:none (clicks/aim always pass through to the game), so
  // hover is hit-tested manually against slot rects from a window mousemove. Keyboard
  // selection (1-9 / Q / scroll) flashes the tooltip for the newly selected slot. Every
  // trigger funnels through showWeaponTip(index, source) — the single seam a controller
  // or mobile long-press path can call later.
  private weaponTip: HTMLElement;
  private slotEls: HTMLElement[] = [];
  private slotIds: WeaponId[] = [];
  private hoverSlot = -1;
  private flashSlot = -1;
  private flashTimer = 0;
  private prevCurrentId: WeaponId | "" = "";
  private tipKey = "";
  private cardProvider: ((id: WeaponId) => WeaponCard | null) | null = null;

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
    card.appendChild(el("p", "margin-top:16px;font:8px var(--f-ui),monospace;letter-spacing:1px;color:var(--dun-4);", "HOLD TAB TO VIEW \u00b7 RELEASE TO RESUME"));
    this.statsPanel.appendChild(card);
    root.appendChild(this.statsPanel);

    // Transient floor banner.
    this.banner = el("div",
      `position:fixed;top:26%;left:0;right:0;z-index:6;text-align:center;pointer-events:none;` +
      `color:var(--amber);font:22px var(--f-logo),monospace;letter-spacing:4px;` +
      `text-shadow:0 4px 0 var(--dun-0),0 0 18px rgba(255,180,59,0.35);opacity:0;transition:opacity 0.35s ease;`);
    root.appendChild(this.banner);

    // One-time controls onboarding hint: a subtle, auto-dismissing line above the hotbar
    // (clear of its blessing-chip row). Fixed + opacity-only so it never shifts the layout.
    this.controlsHint = el("div",
      `position:fixed;left:0;right:0;bottom:122px;z-index:6;text-align:center;pointer-events:none;` +
      `color:var(--cream);font:9px var(--f-ui),monospace;letter-spacing:1px;` +
      `text-shadow:0 2px 0 var(--dun-0),0 0 10px rgba(0,0,0,0.6);opacity:0;transition:opacity 0.6s ease;`,
      "WASD MOVE \u00b7 MOUSE AIM \u00b7 CLICK SHOOT \u00b7 SHIFT DASH");
    root.appendChild(this.controlsHint);

    // Weapon stat tooltip (see the field-block comment). Lives outside #hud so it can't
    // inherit its stacking; fixed + pointer-events:none, so it never blocks gameplay.
    this.weaponTip = el("div", "");
    this.weaponTip.className = "hb-tip";
    root.appendChild(this.weaponTip);
    window.addEventListener("mousemove", (e) => this.onTipMouseMove(e));
  }

  // Feed the tooltip live weapon cards (game.ts closes over the local player, so the values
  // include the player's current blessings and low-HP scalers). Null provider hides the tip.
  setWeaponCardProvider(fn: ((id: WeaponId) => WeaponCard | null) | null) {
    this.cardProvider = fn;
  }

  private onTipMouseMove(e: MouseEvent) {
    if (this.hud.style.display === "none" || this.slotEls.length === 0) {
      if (this.hoverSlot !== -1) { this.hoverSlot = -1; this.syncWeaponTip(); }
      return;
    }
    let hit = -1;
    for (let i = 0; i < this.slotEls.length; i++) {
      const r = this.slotEls[i].getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) { hit = i; break; }
    }
    if (hit !== this.hoverSlot) {
      this.hoverSlot = hit;
      this.syncWeaponTip();
    }
  }

  // The single tooltip trigger seam. source "select" = keyboard/scroll selection flash
  // (auto-fades); "hover" pins while the cursor stays; "focus" mirrors hover for future
  // controller/mobile focus drivers.
  showWeaponTip(index: number, source: "hover" | "select" | "focus") {
    if (source === "select") {
      this.flashSlot = index;
      this.flashTimer = index >= 0 ? 2.2 : 0;
    } else {
      this.hoverSlot = index;
    }
    this.syncWeaponTip();
  }

  private activeTipSlot(): number {
    if (this.hoverSlot >= 0 && this.hoverSlot < this.slotIds.length) return this.hoverSlot;
    if (this.flashTimer > 0 && this.flashSlot >= 0 && this.flashSlot < this.slotIds.length) return this.flashSlot;
    return -1;
  }

  private syncWeaponTip() {
    const idx = this.activeTipSlot();
    const card = idx >= 0 && this.cardProvider ? this.cardProvider(this.slotIds[idx]) : null;
    if (!card) {
      if (this.tipKey !== "") {
        this.tipKey = "";
        this.weaponTip.classList.remove("show");
      }
      return;
    }
    const key = idx + ":" + weaponCardKey(card);
    if (key !== this.tipKey) {
      this.tipKey = key;
      this.renderWeaponTip(card);
      this.weaponTip.classList.add("show");
    }
    this.positionWeaponTip(this.slotEls[idx]);
  }

  private renderWeaponTip(card: WeaponCard) {
    this.weaponTip.replaceChildren();
    const name = el("div", "", card.name.toUpperCase());
    name.className = "wt-name";
    const kind = el("div", "", card.kind === "melee" ? "MELEE" : "RANGED");
    kind.className = "wt-kind";
    const verb = el("div", "", card.verb);
    verb.className = "wt-verb";
    this.weaponTip.append(name, kind, verb);
    for (const l of card.lines) {
      const row = el("div", "");
      row.className = "wt-row" + (l.delta > 0 ? " up" : l.delta < 0 ? " down" : "");
      row.appendChild(el("span", "", l.label)).className = "k";
      const val = el("span", "");
      val.className = "v";
      if (l.delta !== 0) {
        const baseSpan = el("span", "", l.base);
        baseSpan.className = "vb";
        const arrow = el("span", "", "\u2192");
        arrow.className = "arrow";
        val.append(baseSpan, arrow, document.createTextNode(l.current));
      } else {
        val.textContent = l.current;
      }
      row.appendChild(val);
      this.weaponTip.appendChild(row);
    }
    const hint = el("div", "", "BASE \u2192 WITH BLESSINGS");
    hint.className = "wt-hint";
    this.weaponTip.appendChild(hint);
  }

  private positionWeaponTip(slot: HTMLElement | undefined) {
    if (!slot) return;
    const r = slot.getBoundingClientRect();
    const w = this.weaponTip.offsetWidth || 212;
    const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    this.weaponTip.style.left = `${Math.round(x)}px`;
    this.weaponTip.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`;
    this.weaponTip.style.top = "auto";
  }

  setVisible(v: boolean) {
    this.hud.style.display = v ? "block" : "none";
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
    // Only rebuild when the set or selection changes (cheap string key).
    const slotsKey = s.weapons.map((w) => (w.isCurrent ? "*" : "") + w.id).join("|");
    if (slotsKey !== this.prevSlotsKey) {
      this.prevSlotsKey = slotsKey;
      this.slotsEl.replaceChildren();
      this.slotEls = s.weapons.map((w, i) => buildSlot(w, i));
      this.slotIds = s.weapons.map((w) => w.id);
      for (const slot of this.slotEls) this.slotsEl.appendChild(slot);
      // Switching weapons flashes the selected slot's stat card (the keyboard-focus path);
      // suppressed on the first build of a run so the opening pistol doesn't pop a tooltip.
      const currentId = s.weapons.find((w) => w.isCurrent)?.id ?? "";
      if (currentId !== "" && this.prevCurrentId !== "" && currentId !== this.prevCurrentId) {
        this.showWeaponTip(s.weapons.findIndex((w) => w.isCurrent), "select");
      }
      this.prevCurrentId = currentId;
    }
    this.syncWeaponTip();

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

    this.updateCombo(s);

    // Rebuild the blessing chips only when a blessing is picked. Gated on total picks
    // (sum of levels) so a repeat pick that just levels a chip still refreshes it.
    const totalPicks = s.items.reduce((n, it) => n + it.count, 0);
    if (totalPicks !== this.prevItemsCount) {
      this.prevItemsCount = totalPicks;
      this.buffsEl.replaceChildren();
      for (const it of s.items) this.buffsEl.appendChild(buildBuffChip(it));
      this.buffsEl.classList.toggle("show", s.items.length > 0);
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
      line("damage dealt / taken", `${Math.round(d.damageDealt)} / ${Math.round(d.damageTaken)}`),
      line("best combo", d.bestCombo > 0 ? `x${d.bestCombo}` : "\u2014"),
      line("bosses slain", String(d.bossKills)),
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
        const label = `${r.name}${r.isYou ? " (you)" : ""}${r.isDown ? " \u2014 down" : ""}`;
        row.appendChild(el("span", `color:${r.isDown ? "#ff6a6a" : "#ffe6b0"};`, label));
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
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) { this.flashTimer = 0; this.flashSlot = -1; this.syncWeaponTip(); }
    }
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
    this.comboEl.classList.remove("show", "low");
    this.comboMultEl.style.transform = "scale(1)";
    this.prevCombo = -1;
    this.prevMult = 1;
    this.comboPop = 0;
    this.comboBurstEl.classList.remove("fire");
    this.slotsEl.replaceChildren();
    this.prevSlotsKey = "";
    this.buffsEl.replaceChildren();
    this.buffsEl.classList.remove("show");
    this.prevItemsCount = -1;
    this.slotEls = [];
    this.slotIds = [];
    this.hoverSlot = -1;
    this.flashSlot = -1;
    this.flashTimer = 0;
    this.prevCurrentId = "";
    this.tipKey = "";
    this.weaponTip.classList.remove("show");
  }
}
