// Patch's shop — the pure presentation layer: per-viewer panel/world copy derived from
// authoritative ShopState. DOM-free so the whole state-copy matrix runs headlessly in
// tests, and shared by BOTH surfaces (the world-space pedestal chip and the interact
// panel), so they can never disagree with each other or with the sim: the status they
// render comes from the same shopSlotStatusFor the buy command validates with.

import type { ShopSlot, ShopSlotStatus, ShopState, ShopViewer } from "../sim/shop.js";
import { shopSlotStatusFor } from "../sim/shop.js";
import { SHOP } from "../sim/balance.js";
import { WEAPONS } from "../sim/weapons.js";
import type { WeaponId } from "../sim/types.js";
import { weaponDisplayStats, lowHpFrac } from "../sim/weaponStats.js";
import { itemById, itemDesc, itemLevelsOf, MAX_ITEM_LEVEL } from "../sim/items.js";
import type { PlayerMods } from "../sim/items.js";

// The action-row copy (the BUY button / the pedestal chip word) for every status. The
// exact strings are the studio's accepted state matrix — locked by test/shop.test.ts and
// the DOM suite.
export function shopActionCopy(status: ShopSlotStatus, price: number, coins: number): string {
  switch (status) {
    case "buy": return `BUY \u00b7 ${price} COIN${price === 1 ? "" : "S"}`;
    case "broke": return `NEED ${price - coins} MORE COINS`;
    case "sold": return "SOLD";
    case "owned": return "OWNED";
    case "full": return "HOTBAR FULL";
    case "maxLevel": return "MAX LV";
    case "fullHealth": return "FULL HEALTH";
    case "exhausted": return "NO REROLLS LEFT";
  }
}

// The two non-buyable visual groups (live playtest fix: "can't afford yet" was read as
// "already done/gone"). "broke" is still LIVE — the station is for sale, the viewer just
// needs coins — so it wears the amber outline + coin glyph. Everything else non-buy is
// RESOLVED for this viewer (bought/claimed/maxed/full/spent) and wears the muted
// check treatment. The groups must never share a look, in color or grayscale.
export function isResolvedShopStatus(status: ShopSlotStatus): boolean {
  return status !== "buy" && status !== "broke";
}

// The state-dependent panel footer — the explicit multi-buy framing: every station is
// independently purchasable, and a purchase never closes the stall.
export function shopFooterCopy(shop: ShopState, viewer: ShopViewer, isJustBought: boolean): string {
  if (isJustBought) return "BOUGHT \u2713 \u00b7 other stations still open";
  const isAnyAffordable = shop.slots.some((s) => shopSlotStatusFor(shop, s, viewer) === "buy");
  return isAnyAffordable
    ? "Spend at any station you can afford"
    : "Earn more coins and come back before you descend";
}

// Explicit ownership copy — the anti-ambiguity contract: a player always knows whether a
// buy would race teammates (shared physical object) or is safely theirs (instanced).
export function shopOwnershipCopy(slot: ShopSlot): string {
  if (slot.kind === "reroll") return "SHARED \u2014 RESTOCKS FOR EVERYONE";
  return slot.isShared ? "SHARED \u2014 FIRST BUY CLAIMS" : "FOR YOU";
}

export function shopSlotName(slot: ShopSlot): string {
  if (slot.kind === "weapon") return slot.weapon !== null ? WEAPONS[slot.weapon].name : "Weapon";
  if (slot.kind === "blessing") return itemById(slot.itemId ?? "")?.name ?? "Blessing";
  if (slot.kind === "heart") return "Heart";
  return "Restock";
}

// The compact chip a pedestal wears in the world: state word when blocked, plain price
// when buyable — glanceable shelf labels, never the rejected floating full-copy tags.
export function shopChipCopy(status: ShopSlotStatus, price: number): string {
  return status === "buy" || status === "broke" ? `${price}c` : shopActionCopy(status, price, 0);
}

// What the panel's icon should draw (the panel reuses real art: the weapon's pickup
// side profile, the blessing's glyph chip, the heart sprite).
export type ShopPanelIcon =
  | { kind: "weapon"; weapon: WeaponId }
  | { kind: "glyph"; itemId: string; glyph: string; tint: string }
  | { kind: "heart" }
  | { kind: "reroll" };

export interface ShopPanelView {
  slotId: number;
  name: string;
  kindLabel: string;    // WEAPON / BLESSING / HEART STATION / REROLL POST
  ownership: string;
  tag: string | null;   // blessing: NEW / UPGRADE LV2-3 (the level this buy would reach)
  lines: string[];      // exact current/effective stats or effect
  icon: ShopPanelIcon;
  status: ShopSlotStatus;
  action: string;
  isBuyable: boolean;
  coins: number;        // the viewer's live balance (anchors NEED N MORE COINS)
  footer: string;       // state-dependent multi-buy framing (shopFooterCopy)
  isJustBought: boolean; // the viewer's own buy just landed (~1.2s client latch)
}

const KIND_LABEL: Record<ShopSlot["kind"], string> = {
  weapon: "WEAPON",
  blessing: "BLESSING",
  heart: "HEART STATION",
  reroll: "REROLL POST",
};

// Stat numbers read at one decimal, trailing .0 dropped — the tooltip convention.
function fmt(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

// The full per-viewer panel view for one station. Weapon lines derive from
// weaponDisplayStats — the ONE live effective-stats model the hotbar tooltip and drawer
// read — so what the shop promises can never drift from what the buy delivers.
export function shopPanelView(shop: ShopState, slot: ShopSlot, viewer: ShopViewer, mods: PlayerMods, isJustBought = false): ShopPanelView {
  const status = shopSlotStatusFor(shop, slot, viewer);
  const lines: string[] = [];
  let icon: ShopPanelIcon = { kind: "reroll" };
  let tag: string | null = null;
  if (slot.kind === "weapon" && slot.weapon !== null) {
    const s = weaponDisplayStats(slot.weapon, mods, lowHpFrac(viewer.hp, viewer.maxHp));
    lines.push(s.role);
    lines.push(`POWER ${fmt(s.power.perHit)}${s.power.count > 1 ? ` \u00d7${s.power.count}` : ""} \u00b7 ${s.cadence.band} \u00b7 ${s.reach.band} \u00b7 ${s.coverage.kind}`);
    for (const m of s.mechanics.slice(0, 2)) lines.push(m.text);
    icon = { kind: "weapon", weapon: slot.weapon };
  } else if (slot.kind === "blessing" && slot.itemId !== null) {
    const def = itemById(slot.itemId);
    if (def) {
      const level = Math.min(MAX_ITEM_LEVEL, (itemLevelsOf(viewer.ownedItemIds).get(def.id) ?? 0) + 1);
      tag = level > 1 ? `UPGRADE LV${level}` : "NEW";
      lines.push(itemDesc(def, level).toUpperCase());
      icon = { kind: "glyph", itemId: def.id, glyph: def.glyph, tint: def.tint };
    }
  } else if (slot.kind === "heart") {
    lines.push(`+${SHOP.heartHeal} HP \u00b7 NEVER A FULL HEAL`);
    lines.push(`YOU: ${viewer.hp}/${viewer.maxHp} HP`);
    icon = { kind: "heart" };
  } else if (slot.kind === "reroll") {
    lines.push("RESTOCKS EVERY UNBOUGHT PEDESTAL");
    lines.push(`${Math.max(0, SHOP.rerollLimit - shop.rerollsUsed)} OF ${SHOP.rerollLimit} REROLLS LEFT`);
  }
  return {
    slotId: slot.id,
    name: shopSlotName(slot),
    kindLabel: KIND_LABEL[slot.kind],
    ownership: shopOwnershipCopy(slot),
    tag,
    lines,
    icon,
    status,
    action: shopActionCopy(status, slot.price, viewer.coins),
    isBuyable: status === "buy",
    coins: viewer.coins,
    footer: shopFooterCopy(shop, viewer, isJustBought),
    isJustBought,
  };
}
