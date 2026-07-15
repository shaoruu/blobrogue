// Patch's shop — the pure presentation layer: per-viewer panel/world copy derived from
// authoritative ShopState. DOM-free so the whole state-copy matrix runs headlessly in
// tests, and shared by BOTH surfaces (the world-space pedestal chip and the interact
// panel), so they can never disagree with each other or with the sim: the status they
// render comes from the same shopSlotStatusFor the buy command validates with.
//
// The feel contract for the premium economy: an unaffordable premium item is always
// VISIBLE-BUT-LOCKED — its name, its pedestal, and its price render greyed rather than
// hidden, so the "save for it" goal forms floors before the wallet catches up. The
// climactic buys (legendary/artifact/mythic) carry the event treatment (see
// PREMIUM_EVENT_KINDS + the client's big-purchase flourish).

import type { ShopSlot, ShopSlotStatus, ShopState, ShopViewer } from "../sim/shop.js";
import { shopSlotStatusFor, shopSlotPriceFor, shopSlotForViewer, isMythicKind, upgradeTargetTier, weaponCapOf, PREMIUM_EVENT_KINDS } from "../sim/shop.js";
import { SHOP, PREMIUM, CAPS, premiumMysteryLegendaryWeight } from "../sim/balance.js";
import { WEAPONS, WEAPON_RARITY_COLOR } from "../sim/weapons.js";
import type { WeaponId } from "../sim/types.js";
import { weaponDisplayStats, lowHpFrac } from "../sim/weaponStats.js";
import { itemById, itemDesc, itemLevelsOf, itemMaxLevel } from "../sim/items.js";
import type { PlayerMods } from "../sim/items.js";

// The action-row copy (the BUY button / the pedestal chip word) for every status. The
// exact strings are the studio's accepted state matrix — locked by test/shop.test.ts and
// the DOM suite. The artifact's "price" is hearts, so its buy row is authored separately
// (see shopPanelView).
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
    case "locked": return "ONE PREMIUM BUY PER SHOP";
    case "capped": return "AT THE CAP";
    case "inFight": return "ENEMIES TOO CLOSE";
    case "needHearts": return "NOT ENOUGH MAX HEARTS";
  }
}

// The two non-buyable visual groups (live playtest fix: "can't afford yet" was read as
// "already done/gone"). "broke" is still LIVE — the station is for sale, the viewer just
// needs coins (the visible-but-locked save-for-it read) — so it wears the amber outline
// + coin glyph. Everything else non-buy is RESOLVED for this viewer (bought/claimed/
// maxed/full/spent) and wears the muted check treatment. The groups must never share a
// look, in color or grayscale.
export function isResolvedShopStatus(status: ShopSlotStatus): boolean {
  return status !== "buy" && status !== "broke";
}

// The state-dependent panel footer — the explicit multi-buy framing: every station is
// independently purchasable, and a purchase never closes the stall.
export function shopFooterCopy(shop: ShopState, viewer: ShopViewer, isJustBought: boolean): string {
  if (isJustBought) return "BOUGHT \u2713 \u00b7 other stations still open";
  const isAnyAffordable = shop.slots.some((slot) =>
    shopSlotStatusFor(shop, shopSlotForViewer(shop, slot, viewer.pid), viewer) === "buy"
  );
  return isAnyAffordable
    ? "Spend at any station you can afford"
    : "Earn more coins and come back before you descend";
}

// Explicit ownership copy — the anti-ambiguity contract: a player always knows whether a
// buy would race teammates (shared physical object) or is safely theirs (instanced).
export function shopOwnershipCopy(slot: ShopSlot): string {
  if (slot.kind === "reroll" || slot.kind === "reroll_all") return "SHARED \u2014 RESTOCKS FOR EVERYONE";
  if (isMythicKind(slot.kind)) return "ONE PER PARTY \u2014 FIRST CLAIM";
  return slot.isShared ? "SHARED \u2014 FIRST BUY CLAIMS" : "FOR YOU";
}

export function shopSlotName(slot: ShopSlot): string {
  switch (slot.kind) {
    // A mystery pedestal is "???" everywhere until a buy reveals it (online clients never
    // even receive the identity; sold mystery slots arrive already identified).
    case "weapon": {
      if (slot.isMystery || slot.weapon === null) return slot.isMystery ? "???" : "Weapon";
      return WEAPONS[slot.weapon].name;
    }
    case "blessing": return itemById(slot.itemId ?? "")?.name ?? "Blessing";
    case "heart": return "Heart";
    case "reroll": return "Restock";
    case "mystery": return "Mystery Weapon";
    case "legendary": return slot.weapon !== null ? WEAPONS[slot.weapon].name : "Legendary Weapon";
    case "rare_blessing": return itemById(slot.itemId ?? "")?.name ?? "Rare Blessing";
    case "max_hp": return "Heart Container";
    case "full_heal": return "Panacea";
    case "core_infusion": return itemById(slot.itemId ?? "")?.name ?? "Core Infusion";
    case "weapon_upgrade": return "Weapon Upgrade";
    case "revive_token": return "Revive Token";
    case "extra_slot": return "Bandolier Slot";
    case "reroll_all": return "Reroll Everything";
    case "amber_cache": return "Amber Cache";
    case "prospector": return "Prospector's Draught";
    case "artifact": return slot.weapon !== null ? WEAPONS[slot.weapon].name : "Artifact";
    case "mythic_weapon": return slot.weapon !== null ? WEAPONS[slot.weapon].name : "Mythic Arsenal";
    case "mythic_trio": return "Rare Trio";
    case "mythic_amber": return "Amber Windfall";
  }
}

// The compact chip a pedestal wears in the world: state word when blocked, plain price
// when buyable — glanceable shelf labels, never the rejected floating full-copy tags.
// The artifact's chip prices in hearts (its whole identity is the currency).
export function shopChipCopy(status: ShopSlotStatus, price: number, kind?: ShopSlot["kind"]): string {
  if (kind === "artifact" && (status === "buy" || status === "needHearts")) {
    return `${PREMIUM.artifactHeartCost}\u2665`;
  }
  return status === "buy" || status === "broke" ? `${price}c` : shopActionCopy(status, price, 0);
}

// What the panel's icon should draw (the panel reuses real art: the weapon's pickup
// side profile, the blessing's glyph chip, the heart sprite; the premium stations wear
// tinted text glyphs until authored art lands).
export type ShopPanelIcon =
  | { kind: "weapon"; weapon: WeaponId }
  | { kind: "glyph"; itemId: string; glyph: string; tint: string }
  | { kind: "heart" }
  | { kind: "reroll" }
  | { kind: "mystery" }
  | { kind: "text"; text: string; tint: string };

export interface ShopPanelView {
  slotId: number;
  name: string;
  kindLabel: string;    // WEAPON / BLESSING / HEART STATION / REROLL POST / PREMIUM …
  ownership: string;
  tag: string | null;   // blessing: NEW / UPGRADE LV2-3; weapons: the rarity badge
  lines: string[];      // exact current/effective stats or effect
  icon: ShopPanelIcon;
  status: ShopSlotStatus;
  action: string;
  isBuyable: boolean;
  // The event treatment (legendary/artifact/mythic): distinct glow + the big-purchase
  // confirm flourish on the client.
  isEvent: boolean;
  coins: number;        // the viewer's live balance (anchors NEED N MORE COINS)
  footer: string;       // state-dependent multi-buy framing (shopFooterCopy)
  isJustBought: boolean; // the viewer's own buy just landed (~1.2s client latch)
}

const KIND_LABEL: Record<ShopSlot["kind"], string> = {
  weapon: "WEAPON",
  blessing: "BLESSING",
  heart: "HEART STATION",
  reroll: "REROLL POST",
  mystery: "PREMIUM \u00b7 MYSTERY WEAPON",
  legendary: "PREMIUM \u00b7 LEGENDARY WEAPON",
  rare_blessing: "PREMIUM \u00b7 RARE BLESSING",
  max_hp: "PREMIUM \u00b7 HEART CONTAINER",
  full_heal: "PREMIUM \u00b7 FULL HEAL",
  core_infusion: "PREMIUM \u00b7 CORE INFUSION",
  weapon_upgrade: "PREMIUM \u00b7 UPGRADE STATION",
  revive_token: "PREMIUM \u00b7 REVIVE TOKEN",
  extra_slot: "PREMIUM \u00b7 BANDOLIER",
  reroll_all: "PREMIUM \u00b7 GRAND REROLL",
  amber_cache: "PREMIUM \u00b7 AMBER CACHE",
  prospector: "PREMIUM \u00b7 CONSUMABLE",
  artifact: "ARTIFACT \u00b7 DEVIL DEAL",
  mythic_weapon: "MYTHIC \u00b7 ARSENAL",
  mythic_trio: "MYTHIC \u00b7 RARE TRIO",
  mythic_amber: "MYTHIC \u00b7 WINDFALL",
};

// Stat numbers read at one decimal, trailing .0 dropped — the tooltip convention.
function fmt(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

// The full per-viewer panel view for one station. Weapon lines derive from
// weaponDisplayStats — the ONE live effective-stats model the hotbar tooltip and drawer
// read — so what the shop promises can never drift from what the buy delivers. Prices
// everywhere are the viewer's EFFECTIVE price (successive-buy escalation included).
export function shopPanelView(shop: ShopState, slot: ShopSlot, viewer: ShopViewer, mods: PlayerMods, floor: number, isJustBought = false): ShopPanelView {
  const status = shopSlotStatusFor(shop, slot, viewer);
  const price = shopSlotPriceFor(shop, slot, viewer);
  const lines: string[] = [];
  let icon: ShopPanelIcon = { kind: "reroll" };
  let tag: string | null = null;
  const weaponLines = (weapon: WeaponId): void => {
    const s = weaponDisplayStats(weapon, mods, lowHpFrac(viewer.hp, viewer.maxHp));
    // Rarer stock announces its tier (commons stay untagged — the tag is a signal).
    if (WEAPONS[weapon].rarity !== "common") tag = WEAPONS[weapon].rarity.toUpperCase();
    lines.push(s.role);
    lines.push(`POWER ${fmt(s.power.perHit)}${s.power.count > 1 ? ` \u00d7${s.power.count}` : ""} \u00b7 ${s.cadence.band} \u00b7 ${s.reach.band} \u00b7 ${s.coverage.kind}`);
    for (const m of s.mechanics.slice(0, 2)) lines.push(m.text);
    icon = { kind: "weapon", weapon };
  };
  const blessingLines = (): void => {
    const def = itemById(slot.itemId ?? "");
    if (!def) return;
    const level = Math.min(itemMaxLevel(def), (itemLevelsOf(viewer.ownedItemIds).get(def.id) ?? 0) + 1);
    tag = level > 1 ? `UPGRADE LV${level}` : "NEW";
    lines.push(itemDesc(def, level).toUpperCase());
    icon = { kind: "glyph", itemId: def.id, glyph: def.glyph, tint: def.tint };
  };
  if (slot.kind === "weapon" && slot.isMystery) {
    // The gamble, stated honestly: no stats (nobody knows them), just the contract.
    tag = "MYSTERY";
    lines.push("UNIDENTIFIED \u2014 REVEALS WHEN BOUGHT");
    lines.push("COULD BE ANYTHING \u2014 EVEN A LEGENDARY");
    icon = { kind: "mystery" };
  } else if (slot.kind === "weapon" && slot.weapon !== null) {
    weaponLines(slot.weapon);
  } else if (slot.kind === "blessing" || slot.kind === "rare_blessing" || slot.kind === "core_infusion") {
    blessingLines();
    if (slot.kind === "core_infusion") lines.push(`EACH CORE LEVEL COSTS \u00d7${PREMIUM.hpPriceGrowth}`);
  } else if (slot.kind === "heart") {
    lines.push(`+${SHOP.heartHeal} HP \u00b7 NEVER A FULL HEAL`);
    lines.push(`YOU: ${viewer.hp}/${viewer.maxHp} HP`);
    icon = { kind: "heart" };
  } else if (slot.kind === "reroll") {
    lines.push("RESTOCKS EVERY UNBOUGHT PEDESTAL");
    lines.push(`${Math.max(0, SHOP.rerollLimit - shop.rerollsUsed)} OF ${SHOP.rerollLimit} REROLLS LEFT`);
  } else if (slot.kind === "mystery") {
    tag = "PREMIUM GAMBLE";
    lines.push("UNIDENTIFIED \u2014 REVEALED WHEN BOUGHT");
    lines.push(`DEEP ODDS: LEGENDARY WEIGHT \u00d7${premiumMysteryLegendaryWeight(floor)}`);
    icon = { kind: "mystery" };
  } else if (slot.kind === "legendary" && slot.weapon !== null) {
    weaponLines(slot.weapon);
  } else if (slot.kind === "max_hp") {
    lines.push(`+1 MAX HEART \u00b7 THIS RUN ONLY \u00b7 +${CAPS.maxHpBonus} TOTAL CAP`);
    lines.push(`NEXT ONE COSTS \u00d7${PREMIUM.hpPriceGrowth}`);
    icon = { kind: "heart" };
  } else if (slot.kind === "full_heal") {
    lines.push("HEAL TO FULL \u00b7 NO PROTECTION FRAMES");
    lines.push(`YOU: ${viewer.hp}/${viewer.maxHp} HP`);
    icon = { kind: "heart" };
  } else if (slot.kind === "weapon_upgrade") {
    const target = upgradeTargetTier(viewer.equipped);
    lines.push("REFORGES YOUR EQUIPPED GUN ONE TIER UP");
    lines.push(target !== null
      ? `${WEAPONS[viewer.equipped].name.toUpperCase()} \u2192 A ${target.toUpperCase()}`
      : `${WEAPONS[viewer.equipped].name.toUpperCase()} IS ALREADY LEGENDARY`);
    icon = { kind: "text", text: "\u2692", tint: WEAPON_RARITY_COLOR[target ?? "legendary"] };
  } else if (slot.kind === "revive_token") {
    lines.push("A LETHAL HIT STANDS YOU BACK UP INSTEAD");
    lines.push("ONE BANKED AT A TIME \u00b7 NEVER STOPS A WIPE");
    icon = { kind: "text", text: "\u271a", tint: "var(--red)" };
  } else if (slot.kind === "extra_slot") {
    lines.push("+1 HOTBAR SLOT \u00b7 THIS RUN ONLY \u00b7 CAP 1");
    lines.push(`YOU: ${viewer.ownedWeapons.length}/${weaponCapOf(viewer)} SLOTS`);
    icon = { kind: "text", text: "\u25a3", tint: "var(--bone)" };
  } else if (slot.kind === "reroll_all") {
    lines.push("RESTOCKS EVERY UNBOUGHT STATION");
    lines.push("YOUR NEXT BLESSING OFFER REROLLS TOO");
    lines.push(`EACH USE COSTS +${Math.round((PREMIUM.rerollPriceGrowth - 1) * 100)}%`);
  } else if (slot.kind === "amber_cache") {
    lines.push("RUN END: UNSPENT COINS \u2192 AMBER");
    lines.push(`+${PREMIUM.amberPerHundredCoins} AMBER PER 100 \u00b7 MAX +${PREMIUM.amberRunCap}`);
    icon = { kind: "text", text: "\u25c6", tint: "var(--amber)" };
  } else if (slot.kind === "prospector") {
    lines.push(`COINS \u00d7${PREMIUM.prospectorMult} FOR THE REST OF THIS FLOOR`);
    lines.push("DRINK EARLY \u2014 IT DIES AT THE STAIRS");
    icon = { kind: "text", text: "\u2697", tint: "var(--amber-hi)" };
  } else if (slot.kind === "artifact" && slot.weapon !== null) {
    tag = "ARTIFACT";
    weaponLines(slot.weapon);
    lines.push(`PAID IN MAX HEARTS: \u2212${PREMIUM.artifactHeartCost} FOREVER (THIS RUN)`);
  } else if (slot.kind === "mythic_weapon" && slot.weapon !== null) {
    tag = "MYTHIC";
    weaponLines(slot.weapon);
  } else if (slot.kind === "mythic_trio") {
    tag = "MYTHIC";
    lines.push("PICK 1 OF 3 RARE BLESSINGS");
    icon = { kind: "text", text: "\u2756", tint: WEAPON_RARITY_COLOR.legendary };
  } else if (slot.kind === "mythic_amber") {
    tag = "MYTHIC";
    lines.push(`+${PREMIUM.mythicAmber} AMBER \u2014 BANKED FOREVER`);
    icon = { kind: "text", text: "\u25c6", tint: WEAPON_RARITY_COLOR.legendary };
  }
  // The artifact's buy row prices in hearts, not coins.
  const action = slot.kind === "artifact" && status === "buy"
    ? `TRADE \u00b7 ${PREMIUM.artifactHeartCost} MAX HEARTS`
    : shopActionCopy(status, price, viewer.coins);
  return {
    slotId: slot.id,
    name: shopSlotName(slot),
    kindLabel: KIND_LABEL[slot.kind],
    ownership: shopOwnershipCopy(slot),
    tag,
    lines,
    icon,
    status,
    action,
    isBuyable: status === "buy",
    isEvent: PREMIUM_EVENT_KINDS.has(slot.kind),
    coins: viewer.coins,
    footer: shopFooterCopy(shop, viewer, isJustBought),
    isJustBought,
  };
}
