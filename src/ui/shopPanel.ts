// The compact shop panel: what an explicit interact (E / the semantic interact action)
// opens on a focused station in Patch's room. Icon, name, exact effect/stat lines, the
// explicit ownership contract, price and ONE clearly-stated action (BUY, or the reason
// there is nothing to buy). Purchases leave ONLY through the BUY control — stepping on a
// pedestal never buys, and the panel itself re-renders from authoritative state every
// frame, so a teammate's concurrent claim flips it to an honest SOLD mid-look.
//
// Modeled on BlessingOverlay's mechanics (own fixed layer, capture-phase keys, focus
// scope), but non-modal in spirit: the world keeps ticking (online can't freeze), the
// game samples gameplay input as idle under the "shop" context, and Esc/E close it.
// Accessibility: real dialog semantics, the action row is a live region (state flips are
// announced), keyboard-first (Enter/Space buys via the focused button), nothing hover-only.

import type { ShopPanelView } from "./shopCopy.js";
import { isResolvedShopStatus } from "./shopCopy.js";
import { itemIconEl, pxIcon, ICONS } from "../game/hudIcons.js";
import { weaponIconSrc } from "../game/assets.js";
import { FocusScope, currentFocus } from "./focus.js";

export class ShopPanel {
  private root: HTMLElement;
  private iconEl: HTMLElement;
  private nameEl: HTMLElement;
  private kindEl: HTMLElement;
  private tagEl: HTMLElement;
  private ownershipEl: HTMLElement;
  private linesEl: HTMLElement;
  private buyEl: HTMLButtonElement;
  private coinsEl: HTMLElement;
  private footEl: HTMLElement;
  private onBuy: ((slotId: number) => void) | null = null;
  private onClose: (() => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private focusScope = new FocusScope();
  private view: ShopPanelView | null = null;
  private lastRendered = "";

  constructor() {
    const root = document.createElement("div");
    root.className = "shop-panel hidden";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Patch's shop");

    const card = document.createElement("div");
    card.className = "shop-card";

    // The viewer's live balance leads the card so NEED N MORE COINS is always anchored
    // to a visible number. aria-live announces only actual balance changes (render
    // guards the write), never steady-state re-renders.
    this.coinsEl = document.createElement("p");
    this.coinsEl.className = "shop-coins";
    this.coinsEl.setAttribute("aria-live", "polite");
    card.appendChild(this.coinsEl);

    const head = document.createElement("div");
    head.className = "shop-head";
    this.iconEl = document.createElement("span");
    this.iconEl.className = "shop-icon";
    head.appendChild(this.iconEl);
    const title = document.createElement("div");
    title.className = "shop-title";
    this.nameEl = document.createElement("h1");
    this.nameEl.id = "shop-item-name";
    title.appendChild(this.nameEl);
    const meta = document.createElement("p");
    meta.className = "shop-meta";
    this.kindEl = document.createElement("span");
    meta.appendChild(this.kindEl);
    this.tagEl = document.createElement("span");
    this.tagEl.className = "shop-tag";
    meta.appendChild(this.tagEl);
    title.appendChild(meta);
    head.appendChild(title);
    card.appendChild(head);
    root.setAttribute("aria-labelledby", "shop-item-name");

    this.ownershipEl = document.createElement("p");
    this.ownershipEl.className = "shop-ownership";
    card.appendChild(this.ownershipEl);

    this.linesEl = document.createElement("div");
    this.linesEl.className = "shop-lines";
    card.appendChild(this.linesEl);

    // The one action row. aria-live announces authoritative state flips (a teammate's
    // claim turning the row into SOLD) without re-focusing anything.
    this.buyEl = document.createElement("button");
    this.buyEl.type = "button";
    this.buyEl.className = "shop-buy";
    this.buyEl.setAttribute("aria-live", "polite");
    this.buyEl.addEventListener("click", () => this.buy());
    card.appendChild(this.buyEl);

    // The multi-buy framing footer: always populated (no layout shift), state-dependent
    // copy — BOUGHT ✓ after your own buy, otherwise spend/earn guidance.
    this.footEl = document.createElement("p");
    this.footEl.className = "shop-foot";
    card.appendChild(this.footEl);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "ENTER buy \u00b7 ESC close";
    card.appendChild(hint);

    root.appendChild(card);
    document.body.appendChild(root);
    this.root = root;
  }

  get isOpen(): boolean {
    return this.keyHandler !== null;
  }

  get slotId(): number | null {
    return this.view?.slotId ?? null;
  }

  open(view: ShopPanelView, onBuy: (slotId: number) => void, onClose: () => void): void {
    this.onBuy = onBuy;
    this.onClose = onClose;
    const previous = currentFocus();
    this.render(view);
    this.root.classList.remove("hidden");
    this.focusScope.open(this.buyEl, previous);
    this.keyHandler = (e) => this.onKey(e);
    window.addEventListener("keydown", this.keyHandler, true);
  }

  // Per-frame refresh from authoritative state. Rebuilds the DOM only when the view
  // actually changed (a coin tick or a teammate's claim), so steady state never reflows.
  update(view: ShopPanelView): void {
    if (!this.isOpen) return;
    this.render(view);
  }

  close(): void {
    if (!this.isOpen) return;
    window.removeEventListener("keydown", this.keyHandler!, true);
    this.keyHandler = null;
    this.root.classList.add("hidden");
    this.view = null;
    this.lastRendered = "";
    const cb = this.onClose;
    this.onBuy = null;
    this.onClose = null;
    this.focusScope.close();
    cb?.();
  }

  private render(view: ShopPanelView): void {
    const key = JSON.stringify(view);
    if (key === this.lastRendered) return;
    this.lastRendered = key;
    this.view = view;
    this.nameEl.textContent = view.name.toUpperCase();
    this.kindEl.textContent = view.kindLabel;
    this.tagEl.textContent = view.tag ?? "";
    this.tagEl.classList.toggle("hidden", view.tag === null);
    this.ownershipEl.textContent = view.ownership;
    this.ownershipEl.classList.toggle("shared", view.ownership.startsWith("SHARED"));
    this.linesEl.replaceChildren(...view.lines.map((text) => {
      const line = document.createElement("p");
      line.textContent = text;
      return line;
    }));
    this.renderIcon(view);
    this.renderAction(view);
    const coinsText = `YOUR COINS: ${view.coins}`;
    if (this.coinsEl.textContent !== coinsText) this.coinsEl.textContent = coinsText;
    this.footEl.textContent = view.footer;
    this.footEl.classList.toggle("bought", view.isJustBought);
  }

  // The one action row, rendered as its visual group: BUY (live, filled amber), BROKE
  // (live but unaffordable — amber outline + coin glyph, never the resolved grey), or
  // RESOLVED (muted + check: bought/claimed/maxed/full/spent). Glyphs are aria-hidden;
  // the copy itself carries the meaning for the live region.
  private renderAction(view: ShopPanelView): void {
    const isResolved = isResolvedShopStatus(view.status);
    const label = document.createElement("span");
    label.className = "shop-buy-label";
    label.textContent = view.action;
    if (view.status === "broke") {
      const coin = document.createElement("span");
      coin.className = "shop-buy-glyph";
      coin.setAttribute("aria-hidden", "true");
      coin.appendChild(pxIcon(ICONS.coin.map, ICONS.coin.pal, 1.5));
      this.buyEl.replaceChildren(coin, label);
    } else if (isResolved) {
      const check = document.createElement("span");
      check.className = "shop-buy-glyph";
      check.setAttribute("aria-hidden", "true");
      check.textContent = "\u2713";
      this.buyEl.replaceChildren(check, label);
    } else {
      this.buyEl.replaceChildren(label);
    }
    this.buyEl.disabled = !view.isBuyable;
    this.buyEl.className = `shop-buy ${view.status}${isResolved ? " resolved" : ""}`;
  }

  private renderIcon(view: ShopPanelView): void {
    this.iconEl.replaceChildren();
    this.iconEl.style.removeProperty("--t");
    if (view.icon.kind === "weapon") {
      const src = weaponIconSrc(view.icon.weapon);
      if (src) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = "";
        this.iconEl.appendChild(img);
        return;
      }
      this.iconEl.textContent = "\u2694";
      return;
    }
    if (view.icon.kind === "glyph") {
      this.iconEl.style.setProperty("--t", view.icon.tint);
      this.iconEl.appendChild(itemIconEl(view.icon.itemId, view.icon.glyph));
      return;
    }
    this.iconEl.textContent = view.icon.kind === "heart" ? "\u2665" : "\u21bb";
  }

  private onKey(e: KeyboardEvent): void {
    const k = e.key.toLowerCase();
    if (k === "escape" || k === "e") {
      e.preventDefault(); e.stopPropagation();
      this.close();
    } else if (k === "enter" || k === " ") {
      e.preventDefault(); e.stopPropagation();
      this.buy();
    }
  }

  private buy(): void {
    if (!this.view || !this.view.isBuyable) return;
    this.onBuy?.(this.view.slotId);
  }
}
