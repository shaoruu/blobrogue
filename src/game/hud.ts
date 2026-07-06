// All the on-screen chrome that lives in the DOM (not the game canvas): the stat
// bar, the hold-Tab stats panel, and the between-floor banner. Elements are built
// once and updated via textContent / classList so nothing ever reflows the layout.

export interface HudState {
  hp: number;
  maxHp: number;
  floor: number;
  kills: number;
  coins: number;
  weaponName: string;
  isCleared: boolean;
  enemiesLeft: number;
  isBossActive: boolean;
  coopLabel: string | null;
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

const PANEL_BG = "rgba(23,18,39,0.86)";
const BORDER = "1px solid rgba(255,180,59,0.35)";

export class Hud {
  private hearts: HTMLElement;
  private heartCells: HTMLSpanElement[] = [];
  private floorChip: HTMLElement;
  private killsChip: HTMLElement;
  private coinsChip: HTMLElement;
  private weaponChip: HTMLElement;
  private status: HTMLElement;
  private coopChip: HTMLElement;

  private statsPanel: HTMLElement;
  private statsBody: HTMLElement;
  private banner: HTMLElement;
  private bannerTimer = 0;

  constructor(root: HTMLElement) {
    const bar = el("div",
      `position:fixed;top:12px;left:12px;z-index:5;display:flex;flex-direction:column;gap:8px;` +
      `padding:10px 12px;background:${PANEL_BG};border:${BORDER};border-radius:10px;` +
      `color:#ffe6b0;font:13px ui-monospace,Menlo,monospace;pointer-events:none;` +
      `text-shadow:0 1px 0 #000;font-variant-numeric:tabular-nums;`);

    this.hearts = el("div", "display:flex;gap:3px;font-size:18px;line-height:1;");
    bar.appendChild(this.hearts);

    const chips = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
    const chipCss = "padding:3px 8px;background:rgba(255,180,59,0.10);border-radius:6px;white-space:nowrap;";
    this.floorChip = el("span", chipCss, "floor 1");
    this.killsChip = el("span", chipCss, "kills 0");
    this.coinsChip = el("span", `${chipCss}color:#ffd27a;`, "coins 0");
    this.weaponChip = el("span", `${chipCss}color:#ffb43b;`, "Pistol");
    chips.append(this.floorChip, this.killsChip, this.coinsChip, this.weaponChip);
    bar.appendChild(chips);

    this.status = el("div", "font-size:12px;color:#9a8fb5;min-height:15px;");
    bar.appendChild(this.status);

    this.coopChip = el("div", "font-size:11px;color:#5ad1ff;min-height:14px;letter-spacing:0.5px;");
    bar.appendChild(this.coopChip);

    root.appendChild(bar);

    // Hold-Tab stats panel.
    this.statsPanel = el("div",
      `position:fixed;inset:0;z-index:8;display:none;align-items:center;justify-content:center;` +
      `background:rgba(8,6,16,0.72);backdrop-filter:blur(2px);`);
    const card = el("div",
      `min-width:320px;max-width:440px;padding:22px 26px;background:${PANEL_BG};border:${BORDER};` +
      `border-radius:14px;color:#ffe6b0;font:14px ui-monospace,Menlo,monospace;` +
      `box-shadow:0 18px 50px rgba(0,0,0,0.5);font-variant-numeric:tabular-nums;`);
    card.appendChild(el("h2", "color:#ffb43b;font-size:20px;letter-spacing:2px;margin-bottom:14px;", "RUN STATS"));
    this.statsBody = el("div", "display:flex;flex-direction:column;gap:6px;");
    card.appendChild(this.statsBody);
    card.appendChild(el("p", "margin-top:16px;font-size:11px;color:#6f6689;", "hold TAB to view · release to resume"));
    this.statsPanel.appendChild(card);
    root.appendChild(this.statsPanel);

    // Transient floor banner.
    this.banner = el("div",
      `position:fixed;top:26%;left:0;right:0;z-index:6;text-align:center;pointer-events:none;` +
      `color:#ffb43b;font:700 30px ui-monospace,Menlo,monospace;letter-spacing:4px;` +
      `text-shadow:0 3px 0 #000;opacity:0;transition:opacity 0.35s ease;`);
    root.appendChild(this.banner);

    this.syncHeartCells(6);
  }

  private syncHeartCells(maxHp: number) {
    while (this.heartCells.length < maxHp) {
      const cell = el("span", "");
      this.heartCells.push(cell);
      this.hearts.appendChild(cell);
    }
    while (this.heartCells.length > maxHp) {
      const cell = this.heartCells.pop();
      if (cell) this.hearts.removeChild(cell);
    }
  }

  update(s: HudState) {
    this.syncHeartCells(s.maxHp);
    for (let i = 0; i < this.heartCells.length; i++) {
      const filled = i < s.hp;
      this.heartCells[i].textContent = filled ? "\u2665" : "\u2661";
      this.heartCells[i].style.color = filled ? "#ff6a6a" : "#4a3a5a";
    }
    this.floorChip.textContent = `floor ${s.floor}`;
    this.killsChip.textContent = `kills ${s.kills}`;
    this.coinsChip.textContent = `coins ${s.coins}`;
    this.weaponChip.textContent = s.weaponName;

    if (s.isBossActive) {
      this.status.textContent = "the slime king blocks the way";
      this.status.style.color = "#ff8a5a";
    } else if (s.isCleared) {
      this.status.textContent = "floor cleared \u2014 find the exit \u25be";
      this.status.style.color = "#8affc0";
    } else {
      this.status.textContent = `enemies: ${s.enemiesLeft}`;
      this.status.style.color = "#9a8fb5";
    }

    this.coopChip.textContent = s.coopLabel ?? "";
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

  tick(dt: number) {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.style.opacity = "0";
    }
  }

  clear() {
    this.status.textContent = "";
    this.coopChip.textContent = "";
  }
}
