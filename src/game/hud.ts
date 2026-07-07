// All the on-screen chrome that lives in the DOM (not the game canvas): the 4-corner
// HUD (hearts / stat chips / minimap frame / weapon / dash meter), the hold-Tab stats
// panel, and the between-floor banner. The 4-corner markup + CSS come from the ui
// designer's spec (docs/ui). Elements are built once and updated via textContent /
// classList / CSS vars so nothing ever reflows the layout mid-run.

import { renderHearts, mountIcons, itemIconEl } from "./hudIcons.js";

export interface HudState {
  hp: number;
  maxHp: number;
  floor: number;
  kills: number;
  coins: number;
  weaponName: string;
  weapons: { name: string; current: boolean }[]; // inventory row
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
  // Collected blessings, duplicates collapsed into a count, shown in the YOUR BUILD panel.
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

// The 4-corner HUD DOM (docs/ui/hud_markup.html). The minimap canvas already lives in
// index.html; its <canvas id="minimap"> is moved into the .tr .minimap frame at build.
const HUD_MARKUP = `
  <div class="hud-corner tl"><div class="statpanel">
    <div class="hearts" data-hearts></div>
    <div class="statrow">
      <span class="chip floor"><span class="k">FL</span><span class="v" data-floor>1</span></span>
      <span class="chip kills"><span class="ic" data-ic="skull"></span><span class="v" data-kills>0</span></span>
      <span class="chip coins"><span class="ic" data-ic="coin"></span><span class="v" data-coins>0</span></span>
    </div>
  </div><div class="coopstrip" data-coop></div><div class="build" data-build><div class="build-title">YOUR BUILD <span class="n" data-build-n>0</span></div><div class="build-grid" data-build-grid></div></div></div>
  <div class="bossbar" data-bossbar>
    <div class="bossbar-label">BOSS</div>
    <div class="bossbar-track"><i data-bossfill></i></div>
  </div>
  <div class="hud-corner tr"><div class="minimap"><span class="mm-title">MAP</span></div></div>
  <div class="hud-corner br"><div class="invrow" data-invrow></div><div class="weapon"><span class="ic" data-ic="gun" style="width:38px;height:24px"></span><span class="wname" data-wname>PISTOL</span><span class="wammo" data-wammo>&#8734;</span></div></div>
  <div class="hud-corner bl"><div class="dash"><span class="k">DASH</span><span class="key">SHIFT</span><span class="bar"><i style="--dash-fill:1"></i></span></div></div>
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
  private wnameEl: HTMLElement;
  private invrowEl!: HTMLElement;
  private prevInvKey = "";
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
  private buildPanel: HTMLElement;
  private buildGrid: HTMLElement;
  private buildN: HTMLElement;
  private prevItemsCount = -1;

  private statsPanel: HTMLElement;
  private statsBody: HTMLElement;
  private banner: HTMLElement;
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
    this.wnameEl = hud.querySelector("[data-wname]")!;
    this.invrowEl = hud.querySelector("[data-invrow]")!;
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
    this.buildPanel = hud.querySelector("[data-build]")!;
    this.buildGrid = hud.querySelector("[data-build-grid]")!;
    this.buildN = hud.querySelector("[data-build-n]")!;

    // Reconcile the standalone minimap canvas into the .tr frame (see index.html note).
    const minimap = document.getElementById("minimap");
    const frame = hud.querySelector(".minimap");
    if (minimap && frame) frame.appendChild(minimap);

    // Rasterize the chip icons (skull/coin/gun) once; hearts render on hp change.
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

    // One-time controls onboarding hint: a subtle, auto-dismissing line near the bottom.
    // Fixed + opacity-only so it never shifts the layout.
    this.controlsHint = el("div",
      `position:fixed;left:0;right:0;bottom:64px;z-index:6;text-align:center;pointer-events:none;` +
      `color:var(--cream);font:9px var(--f-ui),monospace;letter-spacing:1px;` +
      `text-shadow:0 2px 0 var(--dun-0),0 0 10px rgba(0,0,0,0.6);opacity:0;transition:opacity 0.6s ease;`,
      "WASD MOVE \u00b7 MOUSE AIM \u00b7 CLICK SHOOT \u00b7 SHIFT DASH");
    root.appendChild(this.controlsHint);
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
    this.wnameEl.textContent = s.weaponName.toUpperCase();
    // Weapon inventory row: one chip per owned weapon, current highlighted. Only rebuild
    // when the set or selection changes (cheap string key), and hide it with <2 weapons.
    const invKey = s.weapons.map((w) => (w.current ? "*" : "") + w.name).join("|");
    if (invKey !== this.prevInvKey) {
      this.prevInvKey = invKey;
      this.invrowEl.classList.toggle("show", s.weapons.length >= 2);
      this.invrowEl.replaceChildren();
      s.weapons.forEach((w, i) => {
        const chip = el("span", "");
        chip.className = "invchip" + (w.current ? " on" : "");
        chip.textContent = `${i + 1} ${w.name.toUpperCase()}`;
        this.invrowEl.appendChild(chip);
      });
    }
    // Ammo stays the infinity glyph from the markup — weapons have no clip concept.

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

    // Rebuild the YOUR BUILD panel only when a blessing is picked. Gated on total picks
    // (sum of counts) so a repeat pick that just bumps a chip's count still refreshes.
    const totalPicks = s.items.reduce((n, it) => n + it.count, 0);
    if (totalPicks !== this.prevItemsCount) {
      this.prevItemsCount = totalPicks;
      this.buildGrid.replaceChildren();
      for (const it of s.items) {
        const chip = el("div", "");
        chip.className = "ichip" + (it.rarity === "rare" ? " rare" : "");
        chip.style.setProperty("--t", it.tint);
        chip.appendChild(itemIconEl(it.id, it.glyph));
        if (it.count > 1) {
          const c = el("span", "", "x" + it.count);
          c.className = "cnt";
          chip.appendChild(c);
        }
        const tip = el("div", "");
        tip.className = "tip";
        const tn = el("span", "", it.name.toUpperCase());
        tn.className = "tn";
        const td = el("span", "", it.desc);
        td.className = "td";
        tip.append(tn, td);
        chip.appendChild(tip);
        this.buildGrid.appendChild(chip);
      }
      this.buildN.textContent = String(s.items.length);
      this.buildPanel.classList.toggle("show", s.items.length > 0);
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
    this.buildGrid.replaceChildren();
    this.buildPanel.classList.remove("show");
    this.prevItemsCount = -1;
  }
}
