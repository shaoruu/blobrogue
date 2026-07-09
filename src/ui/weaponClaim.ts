import type { WeaponId } from "../sim/types.js";
import { WEAPONS } from "../sim/weapons.js";
import { weaponIconEl } from "../game/hudIcons.js";
import { FocusScope, currentFocus } from "./focus.js";

// The boss weapon claim overlay (studio balance gate §4): the party's shared choice set,
// claimed PERSONALLY — picking here removes nothing for teammates, an owned duplicate
// can't be claimed (the reroll is the out), and passing releases this player's hold on the
// party's descend gate. Modeled on BlessingOverlay (same layer, focus scope, and card CSS)
// so reward moments read as one visual language.
export interface WeaponClaimActions {
  onClaim: (id: WeaponId) => void;
  onReroll: () => void;
  onPass: () => void;
}

export class WeaponClaimOverlay {
  private root: HTMLElement;
  private cardsEl: HTMLElement;
  private footerEl: HTMLElement;
  private cards: HTMLElement[] = [];
  private choices: WeaponId[] = [];
  private owned: ReadonlySet<WeaponId> = new Set();
  private rerollsLeft = 0;
  private selected = 0;
  private actions: WeaponClaimActions | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private focusScope = new FocusScope();

  constructor() {
    const root = document.createElement("div");
    root.className = "blessing-overlay hidden";

    const card = document.createElement("div");
    card.className = "menu blessing";

    const title = document.createElement("h1");
    title.textContent = "CLAIM A WEAPON";
    card.appendChild(title);

    const sub = document.createElement("p");
    sub.className = "muted";
    sub.textContent = "the boss's arsenal \u2014 one personal claim; teammates see the same choices";
    card.appendChild(sub);

    this.cardsEl = document.createElement("div");
    this.cardsEl.className = "blessing-cards";
    card.appendChild(this.cardsEl);

    this.footerEl = document.createElement("p");
    this.footerEl.className = "hint";
    card.appendChild(this.footerEl);

    root.appendChild(card);
    document.body.appendChild(root);
    this.root = root;
  }

  show(choices: WeaponId[], owned: ReadonlySet<WeaponId>, rerollsLeft: number, actions: WeaponClaimActions): void {
    this.choices = choices;
    this.owned = owned;
    this.rerollsLeft = rerollsLeft;
    this.actions = actions;
    this.selected = Math.max(0, choices.findIndex((id) => !owned.has(id)));
    const previous = currentFocus();
    this.render();
    this.root.classList.remove("hidden");
    this.focusScope.open(this.cards[this.selected] ?? null, previous);
    this.keyHandler = (e) => this.onKey(e);
    window.addEventListener("keydown", this.keyHandler, true);
  }

  hide(): void {
    const wasOpen = this.keyHandler !== null;
    this.root.classList.add("hidden");
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler, true);
      this.keyHandler = null;
    }
    this.actions = null;
    if (wasOpen) this.focusScope.close();
  }

  isOpen(): boolean {
    return this.keyHandler !== null;
  }

  private render(): void {
    this.cardsEl.replaceChildren();
    this.cards = [];
    this.choices.forEach((id, i) => {
      const def = WEAPONS[id];
      const isOwned = this.owned.has(id);
      const el = document.createElement("button");
      el.className = "blessing-card";
      el.type = "button";
      el.disabled = isOwned;
      if (isOwned) el.style.opacity = "0.45";

      const key = document.createElement("span");
      key.className = "bc-key";
      key.textContent = String(i + 1);
      el.appendChild(key);

      const icon = document.createElement("span");
      icon.className = "bc-icon";
      icon.appendChild(weaponIconEl(id, def.name));
      el.appendChild(icon);

      const name = document.createElement("span");
      name.className = "bc-name";
      name.textContent = def.name;
      el.appendChild(name);

      const tag = document.createElement("span");
      tag.className = "bc-tag" + (isOwned ? " up" : " new");
      tag.textContent = isOwned ? "OWNED" : def.melee ? "MELEE" : "RANGED";
      el.appendChild(tag);

      el.addEventListener("click", () => this.claim(i));
      el.addEventListener("mouseenter", () => { if (!isOwned) this.setSelected(i); });
      this.cardsEl.appendChild(el);
      this.cards.push(el);
    });
    this.footerEl.textContent = `1-${this.choices.length} or click \u00b7 \u2190 \u2192 then ENTER`
      + (this.rerollsLeft > 0 ? " \u00b7 R \u2014 REROLL (once)" : "")
      + " \u00b7 ESC \u2014 PASS";
    this.setSelected(this.selected);
  }

  private setSelected(i: number): void {
    this.selected = i;
    this.cards.forEach((c, idx) => c.classList.toggle("selected", idx === i));
    this.cards[i]?.focus();
  }

  private onKey(e: KeyboardEvent): void {
    const k = e.key.toLowerCase();
    if (k >= "1" && k <= String(this.choices.length)) {
      e.preventDefault(); e.stopPropagation();
      this.claim(Number(k) - 1);
    } else if (k === "arrowright" || k === "d") {
      e.preventDefault(); e.stopPropagation();
      this.setSelected((this.selected + 1) % this.choices.length);
    } else if (k === "arrowleft" || k === "a") {
      e.preventDefault(); e.stopPropagation();
      this.setSelected((this.selected + this.choices.length - 1) % this.choices.length);
    } else if (k === "enter" || k === " ") {
      e.preventDefault(); e.stopPropagation();
      this.claim(this.selected);
    } else if (k === "r" && this.rerollsLeft > 0) {
      e.preventDefault(); e.stopPropagation();
      const a = this.actions;
      this.hide();
      a?.onReroll();
    } else if (k === "escape") {
      e.preventDefault(); e.stopPropagation();
      const a = this.actions;
      this.hide();
      a?.onPass();
    }
  }

  private claim(i: number): void {
    const id = this.choices[i];
    const a = this.actions;
    if (id === undefined || !a || this.owned.has(id)) return;
    this.hide();
    a.onClaim(id);
  }
}
