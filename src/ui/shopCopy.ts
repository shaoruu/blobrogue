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
import { itemById, itemDesc, itemLevelsOf, MAX_ITEM_LEVEL } from "../sim/items.js";
import type { PlayerMods } from "../sim/items.js";

// The action-row copy (the BUY button / the pedestal chip word) for every status. The
// exact strings are the studio's accepted state matrix — locked by test/shop.test.ts and
// the DOM suite.
export function shopActionCopy(status: ShopSlotStatus, price: number, coins: number): string {
  switch (status) {
    case "buy": return `BUY \u00b7 ${price} COIN${price === 1 ? "" : "S"}`;
    case "broke": return `NEED ${price - coins} MORE`;
    case "sold": return "SOLD";
    case "owned": return "OWNED";
    case "maxLevel": return "MAX LV";
    case "fullHealth": return "FULL HEALTH";
    case "exhausted": return "NO REROLLS LEFT";
  }
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
}

const KIND_LABEL: Record<ShopSlot["kind"], string> = {
  weapon: "WEAPON",
  blessing: "BLESSING",
  heart: "HEART STATION",
  reroll: "REROLL POST",
};

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

// The full per-viewer panel view for one station. Weapon stats are the buyer's EFFECTIVE
// numbers (base × their live run mods), so the sheet answers "what would this do in MY
// hands right now", exactly like the hotbar drawer.
export function shopPanelView(shop: ShopState, slot: ShopSlot, viewer: ShopViewer, mods: PlayerMods): ShopPanelView {
  const status = shopSlotStatusFor(shop, slot, viewer);
  const lines: string[] = [];
  let icon: ShopPanelIcon = { kind: "reroll" };
  let tag: string | null = null;
  if (slot.kind === "weapon" && slot.weapon !== null) {
    const w = WEAPONS[slot.weapon];
    const dmg = round1(w.damage * mods.damageMult);
    const rate = round1((1 / w.fireCd) * mods.fireRateMult);
    const range = Math.round(w.melee ? w.melee.reach : w.speed * w.life * mods.bulletLifeMult);
    lines.push(`DMG ${dmg} \u00b7 RATE ${rate}/s \u00b7 ${w.melee ? "REACH" : "RANGE"} ${range}`);
    if (w.pellets > 1 || mods.extraPellets > 0) lines.push(`${w.pellets + mods.extraPellets} PROJECTILES PER SHOT`);
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
  };
}
