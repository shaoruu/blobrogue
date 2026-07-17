// In-run blessing system, leveled (spec §6). Every blessing has Lv1–3; a duplicate pick IS
// the Lv2/Lv3 upgrade. A player's build is their pick history (ownedItemIds — one entry per
// pick, so an id's count is its level) and mods are always RECOMPUTED from those levels,
// then clamped to the raw caps — no irreversible incremental applies, no cap escapes. The
// authoritative sim (solo LocalTransport and the server) runs the identical recompute.

import { CAPS } from "./balance.js";
import { applyKitStatLean } from "./kits.js";
import type { KitId } from "./kits.js";
import { PVP } from "./pvp.js";
import { blessingHistoryWeight, blessingSeenCount } from "./offerHistory.js";
import type { BlessingOfferHistory } from "./offerHistory.js";
import {
  CURRENT_CONTENT_CATALOG_VERSION,
  contentCatalogFor,
} from "./contentCatalog.js";
import type { ContentCatalogVersion } from "./contentCatalog.js";

// The neutral run-stat modifiers. Every field starts at its identity value (1 for a
// multiplier, 0 for an additive) so an un-blessed run behaves exactly as before.
// Only fields that at least one item touches live here — no dead knobs.
export interface PlayerMods {
  damageMult: number;      // ×bullet damage (raw cap 2.25)
  fireRateMult: number;    // shots/sec multiplier (raw cap 1.80)
  moveSpeedMult: number;   // ×walk speed (raw cap 1.35)
  maxHpBonus: number;      // ± hearts added to the base max HP (raw cap +4)
  extraPellets: number;    // + projectiles per shot
  spreadAdd: number;       // + cone width (rad) once a shot fires >1 pellet
  pierce: number;          // enemies a bullet punches through (blessing cap +3)
  bulletSizeMult: number;  // ×bullet radius (bigger = easier hits)
  bulletSpeedMult: number; // ×bullet speed
  bulletLifeMult: number;  // ×bullet lifetime (range)
  lifestealChance: number; // chance to regain a heart on kill (shared 1.25s proc cooldown)
  critChance: number;      // chance a pellet crits
  critMult: number;        // ×damage on a crit
  dashCdMult: number;      // ×dash cooldown (level LOOKUP — never multiplied copy-over-copy)
  extraDashCharge: number; // banked extra dash uses (the premium dash core; hard cap 1)
  coinMult: number;        // ×coins per pickup
  coinMagnet: number;      // px radius that vacuums loose coins toward you
  coinMagnetPull: number;  // px/s pull speed of the vacuum
  thorns: number;          // damage reflected onto whatever touches you
  adrenaline: number;      // + fire-rate multiplier scaled by how low your HP is
  berserk: number;         // + damage multiplier scaled by how low your HP is
  burnChance: number;      // 0..1 chance a hit also ignites (each elemental cap 0.5)
  chillChance: number;     // 0..1 chance a hit also chills (slow → freeze)
  shockChance: number;     // 0..1 chance a hit also shocks (+dmg amp + arc)
  selfKnockbackMult: number;
  reclaimedBounceDamage: number;
  muddyDashRefund: number;
  comboWindowBonus: number;
  beatFireRatePerTier: number;
  reviveRadiusBonus: number;
  reviveSpeedMult: number;
}

export function createMods(): PlayerMods {
  return {
    damageMult: 1,
    fireRateMult: 1,
    moveSpeedMult: 1,
    maxHpBonus: 0,
    extraPellets: 0,
    spreadAdd: 0,
    pierce: 0,
    bulletSizeMult: 1,
    bulletSpeedMult: 1,
    bulletLifeMult: 1,
    lifestealChance: 0,
    critChance: 0,
    critMult: 2,
    dashCdMult: 1,
    extraDashCharge: 0,
    coinMult: 1,
    coinMagnet: 0,
    coinMagnetPull: 0,
    thorns: 0,
    adrenaline: 0,
    berserk: 0,
    burnChance: 0,
    chillChance: 0,
    shockChance: 0,
    selfKnockbackMult: 1,
    reclaimedBounceDamage: 0,
    muddyDashRefund: 0,
    comboWindowBonus: 0,
    beatFireRatePerTier: 0,
    reviveRadiusBonus: 0,
    reviveSpeedMult: 1,
  };
}

// Raw caps (spec §6), enforced after a FULL build recompute. The 4–6× strong-run fantasy is
// expressive capability (pellets/pierce/status/crit/positioning), never raw flat stats.
export function clampModCaps(m: PlayerMods): void {
  if (m.damageMult > CAPS.damageMult) m.damageMult = CAPS.damageMult;
  if (m.fireRateMult > CAPS.fireRateMult) m.fireRateMult = CAPS.fireRateMult;
  if (m.moveSpeedMult > CAPS.moveSpeedMult) m.moveSpeedMult = CAPS.moveSpeedMult;
  if (m.maxHpBonus > CAPS.maxHpBonus) m.maxHpBonus = CAPS.maxHpBonus;
  if (m.pierce > CAPS.pierce) m.pierce = CAPS.pierce;
  if (m.burnChance > CAPS.elementalChance) m.burnChance = CAPS.elementalChance;
  if (m.chillChance > CAPS.elementalChance) m.chillChance = CAPS.elementalChance;
  if (m.shockChance > CAPS.elementalChance) m.shockChance = CAPS.elementalChance;
  if (m.extraDashCharge > 1) m.extraDashCharge = 1; // the premium dash core's hard cap
}

export type ItemRarity = "common" | "uncommon" | "rare";

// Rarer items are stronger / more build-defining and show up less often. The number
// is the raw weight used by the weighted draw.
const RARITY_WEIGHT: Record<ItemRarity, number> = {
  common: 10,
  uncommon: 6,
  rare: 3,
};

// A NEW eligible blessing weighs 3× an upgrade of an owned one (spec §6 duplicates rule).
const NEW_ITEM_WEIGHT = 3;

export const MAX_ITEM_LEVEL = 3;

export interface ItemDef {
  id: string;
  name: string;
  descs: readonly [string, string, string]; // per-level card text (cumulative effect)
  glyph: string;       // single-char icon shown on the card + HUD strip (tint gives identity)
  tint: string;        // accent color for the drawn icon chip
  rarity: ItemRarity;
  // Premium-only stock (the shop's core infusions): NEVER enters a blessing offer roll —
  // the offer pool and its seeded streams are byte-identical with or without these defs.
  isPremiumOnly?: boolean;
  // Per-item level cap (defaults to MAX_ITEM_LEVEL; the dash core caps at 1).
  maxLevel?: number;
  // Writes the blessing's TOTAL contribution at the given cumulative level (1–3) onto a
  // fresh mods struct. Levels are lookups, never repeated multiplication.
  apply: (m: PlayerMods, level: number) => void;
}

export function itemMaxLevel(def: ItemDef): number {
  return def.maxLevel ?? MAX_ITEM_LEVEL;
}

// Convenience for the common "one number per level" shape.
function lv(values: readonly [number, number, number], level: number): number {
  return values[Math.max(1, Math.min(MAX_ITEM_LEVEL, level)) - 1];
}

// The curated pool. Lv1 establishes the mechanic; Lv2 adds ~35–55% of Lv1's raw delta plus
// consistency; Lv3 adds ~20–40% plus a payoff (spec §6 growth budget). Canonical examples
// (Hair Trigger, Full Metal, statuses, Coin Magnet, Fang, Vitality, Second Wind) are exact.
export const ITEMS: readonly ItemDef[] = [
  {
    id: "glass_cannon", name: "Glass Cannon",
    descs: ["+60% damage, but -2 max hearts.", "+85% damage, but -2 max hearts.", "+100% damage, but -2 max hearts."],
    glyph: "!", tint: "#ff5a5a", rarity: "rare",
    apply: (m, l) => { m.damageMult += lv([0.60, 0.85, 1.00], l); m.maxHpBonus -= 2; },
  },
  {
    id: "hair_trigger", name: "Hair Trigger",
    descs: ["+35% fire rate.", "+55% fire rate.", "+70% fire rate."],
    glyph: "T", tint: "#ffd166", rarity: "common",
    apply: (m, l) => { m.fireRateMult += lv([0.35, 0.55, 0.70], l); },
  },
  {
    id: "split_shot", name: "Split Shot",
    descs: ["+1 projectile per shot.", "+2 projectiles per shot.", "+3 projectiles per shot."],
    glyph: "Y", tint: "#5ab6ff", rarity: "uncommon",
    apply: (m, l) => { m.extraPellets += lv([1, 2, 3], l); m.spreadAdd += lv([0.10, 0.16, 0.22], l); },
  },
  {
    id: "scattergun", name: "Scattergun",
    descs: ["+2 projectiles, wider spread, -10% damage.", "+3 projectiles, wider spread, -10% damage.", "+4 projectiles, wider spread, -10% damage."],
    glyph: "W", tint: "#ffb43b", rarity: "uncommon",
    apply: (m, l) => { m.extraPellets += lv([2, 3, 4], l); m.spreadAdd += lv([0.22, 0.26, 0.30], l); m.damageMult -= 0.10; },
  },
  {
    id: "full_metal", name: "Full Metal",
    descs: ["Bullets punch through +1 enemy.", "Bullets punch through +2 enemies.", "Bullets punch through +3 enemies."],
    glyph: "P", tint: "#e8e0c8", rarity: "uncommon",
    apply: (m, l) => { m.pierce += lv([1, 2, 3], l); },
  },
  {
    id: "swift_boots", name: "Swift Boots",
    descs: ["+20% move speed.", "+28% move speed.", "+35% move speed."],
    glyph: "S", tint: "#7fdd5a", rarity: "common",
    apply: (m, l) => { m.moveSpeedMult += lv([0.20, 0.28, 0.35], l); },
  },
  {
    id: "big_iron", name: "Big Iron",
    descs: ["Bigger, slower bullets hit +50% harder.", "Bigger, slower bullets hit +70% harder.", "Bigger, slower bullets hit +85% harder."],
    glyph: "O", tint: "#b06bff", rarity: "uncommon",
    apply: (m, l) => { m.bulletSizeMult += 0.8; m.damageMult += lv([0.50, 0.70, 0.85], l); m.bulletSpeedMult -= 0.22; m.fireRateMult -= 0.12; },
  },
  {
    id: "vampire_fang", name: "Vampire Fang",
    descs: ["8% chance to heal a heart on kill.", "13% chance to heal a heart on kill.", "17% chance to heal a heart on kill."],
    glyph: "V", tint: "#ff6a9d", rarity: "uncommon",
    apply: (m, l) => { m.lifestealChance = lv([0.08, 0.13, 0.17], l); },
  },
  {
    id: "adrenaline", name: "Adrenaline",
    descs: ["Fire faster the lower your HP.", "Fire much faster the lower your HP.", "Fire far faster the lower your HP."],
    glyph: "A", tint: "#7fdd5a", rarity: "uncommon",
    apply: (m, l) => { m.adrenaline = lv([0.60, 0.85, 1.00], l); },
  },
  {
    id: "berserk", name: "Berserk",
    descs: ["Hit harder the lower your HP.", "Hit much harder the lower your HP.", "Hit far harder the lower your HP."],
    glyph: "R", tint: "#ff5a5a", rarity: "rare",
    apply: (m, l) => { m.berserk = lv([0.60, 0.85, 1.00], l); },
  },
  {
    id: "second_wind", name: "Second Wind",
    descs: ["-35% dash cooldown.", "-45% dash cooldown.", "-50% dash cooldown."],
    glyph: "D", tint: "#5ab6ff", rarity: "common",
    // dashCdMult takes the LOWER of any contributors (a level lookup, never multiplied
    // copy-over-copy) so dash blessings compose order-independently. Identity-preserving:
    // with only Second Wind touching it, min(1, x) = x — the old assignment exactly.
    apply: (m, l) => { m.dashCdMult = Math.min(m.dashCdMult, lv([0.65, 0.55, 0.50], l)); },
  },
  {
    id: "thorns", name: "Thorns",
    descs: ["Attackers take 2 damage on contact.", "Attackers take 3 damage on contact.", "Attackers take 4 damage on contact."],
    glyph: "X", tint: "#7fdd5a", rarity: "uncommon",
    apply: (m, l) => { m.thorns = lv([2, 3, 4], l); },
  },
  {
    id: "coin_magnet", name: "Coin Magnet",
    descs: ["Vacuum up nearby coins.", "Vacuum coins from across the room.", "Vacuum coins from nearly anywhere."],
    glyph: "M", tint: "#ffd166", rarity: "common",
    apply: (m, l) => { m.coinMagnet = lv([90, 240, 900], l); m.coinMagnetPull = lv([240, 480, 900], l); },
  },
  {
    id: "greed", name: "Greed",
    descs: ["Coins are worth double.", "Coins are worth 2.5x.", "Coins are worth triple."],
    glyph: "$", tint: "#ffd166", rarity: "uncommon",
    apply: (m, l) => { m.coinMult = lv([2, 2.5, 3], l); },
  },
  {
    id: "deadeye", name: "Deadeye",
    descs: ["+25% crit chance for big hits.", "+40% crit chance for bigger hits.", "+50% crit chance for huge hits."],
    glyph: "+", tint: "#ff5a5a", rarity: "rare",
    // critChance is ADDITIVE and critMult takes the HIGHER of any contributors, so crit
    // blessings compose order-independently (Deadeye + Marksman + Executioner stack cleanly).
    // Identity-preserving: with only Deadeye touching crit, this is byte-for-byte the old
    // assignment (base critChance 0 + x; max(2, x) = x).
    apply: (m, l) => { m.critChance += lv([0.25, 0.40, 0.50], l); m.critMult = Math.max(m.critMult, lv([2.5, 2.75, 3.0], l)); },
  },
  {
    id: "vitality", name: "Vitality",
    descs: ["+2 max hearts.", "+3 max hearts.", "+4 max hearts."],
    glyph: "H", tint: "#ff6a6a", rarity: "common",
    apply: (m, l) => { m.maxHpBonus += lv([2, 3, 4], l); },
  },
  // Elemental blessings — turn any weapon into a status-dealer. Chances stack with
  // Elementalist and clamp at the 50% per-element cap.
  {
    id: "incendiary_rounds", name: "Incendiary Rounds",
    descs: ["25% chance to ignite enemies.", "40% chance to ignite enemies.", "50% chance to ignite enemies."],
    glyph: "F", tint: "#ff8a3b", rarity: "uncommon",
    apply: (m, l) => { m.burnChance += lv([0.25, 0.40, 0.50], l); },
  },
  {
    id: "cryo_coating", name: "Cryo Coating",
    descs: ["25% chance to chill (slow, then freeze) enemies.", "40% chance to chill enemies.", "50% chance to chill enemies."],
    glyph: "C", tint: "#7fd3ff", rarity: "uncommon",
    apply: (m, l) => { m.chillChance += lv([0.25, 0.40, 0.50], l); },
  },
  {
    id: "static_charge", name: "Static Charge",
    descs: ["25% chance to shock enemies (+dmg, arcs).", "40% chance to shock enemies.", "50% chance to shock enemies."],
    glyph: "Z", tint: "#7fe9ff", rarity: "uncommon",
    apply: (m, l) => { m.shockChance += lv([0.25, 0.40, 0.50], l); },
  },
  {
    id: "elementalist", name: "Elementalist",
    descs: ["+15% chance to burn, chill, AND shock.", "+25% chance to burn, chill, AND shock.", "+32% chance to burn, chill, AND shock."],
    glyph: "E", tint: "#c98bff", rarity: "rare",
    apply: (m, l) => {
      const c = lv([0.15, 0.25, 0.32], l);
      m.burnChance += c; m.chillChance += c; m.shockChance += c;
    },
  },
  // ---- the content wave: build-defining blessings (existing PlayerMods fields only, so
  // no wire/protocol change). Each is a distinct BUILD identity with a real tradeoff, never
  // a flat +X% of an existing stat, and every contribution rides the same raw-cap clamp. ----
  {
    // Precision: reach + velocity + crit for the patient shooter, paid in fire rate.
    id: "marksman", name: "Marksman",
    descs: ["+35% range, +12% bullet speed, +15% crit — but -12% fire rate.", "+50% range, +18% bullet speed, +23% crit — but -12% fire rate.", "+65% range, +24% bullet speed, +30% crit — but -12% fire rate."],
    glyph: "L", tint: "#ffd166", rarity: "rare",
    // Bullet-speed contribution is deliberately modest: the Snapwire's arm-time floor
    // (test/arsenal envelope) is priced against the best legal bulletSpeedMult, so a big
    // speed blessing would demand re-pricing an existing weapon. The range (bulletLife)
    // component carries the reach identity instead.
    apply: (m, l) => {
      m.bulletLifeMult += lv([0.35, 0.50, 0.65], l);
      m.bulletSpeedMult += lv([0.12, 0.18, 0.24], l);
      m.critChance += lv([0.15, 0.23, 0.30], l);
      m.fireRateMult -= 0.12;
    },
  },
  {
    // The walking wall: hearts + retaliation, paid in mobility.
    id: "juggernaut", name: "Juggernaut",
    descs: ["+2 hearts and 2 thorns damage — but -15% move speed.", "+2 hearts and 3 thorns damage — but -15% move speed.", "+3 hearts and 4 thorns damage — but -15% move speed."],
    glyph: "J", tint: "#b06bff", rarity: "rare",
    apply: (m, l) => { m.maxHpBonus += lv([2, 2, 3], l); m.thorns += lv([2, 3, 4], l); m.moveSpeedMult -= 0.15; },
  },
  {
    // Penetration: bigger, deeper-punching rounds that fly slower.
    id: "heavy_rounds", name: "Heavy Rounds",
    descs: ["Bigger rounds punch through +1 enemy, but fly slower.", "Bigger rounds punch through +2 enemies, but fly slower.", "Bigger rounds punch through +3 enemies, but fly slower."],
    glyph: "=", tint: "#e8e0c8", rarity: "uncommon",
    apply: (m, l) => { m.bulletSizeMult += 0.6; m.pierce += lv([1, 2, 3], l); m.bulletSpeedMult -= 0.2; },
  },
  {
    // Hit-and-run: tempo + footwork, paid in raw punch.
    id: "skirmisher", name: "Skirmisher",
    descs: ["+25% fire rate & +12% move speed — but -15% damage.", "+38% fire rate & +18% move speed — but -15% damage.", "+50% fire rate & +24% move speed — but -15% damage."],
    glyph: "~", tint: "#7fdd5a", rarity: "uncommon",
    apply: (m, l) => { m.fireRateMult += lv([0.25, 0.38, 0.50], l); m.moveSpeedMult += lv([0.12, 0.18, 0.24], l); m.damageMult -= 0.15; },
  },
  {
    // Feast or famine: rare, devastating crits (huge multiplier, thin chance).
    id: "executioner", name: "Executioner",
    descs: ["+10% crit chance, and crits hit for ×3.2.", "+15% crit chance, and crits hit for ×3.6.", "+20% crit chance, and crits hit for ×4.0."],
    glyph: "x", tint: "#ff5a5a", rarity: "rare",
    apply: (m, l) => { m.critChance += lv([0.10, 0.15, 0.20], l); m.critMult = Math.max(m.critMult, lv([3.2, 3.6, 4.0], l)); },
  },
  {
    // All offense: damage + fire rate, paid in hearts (a step past Glass Cannon).
    id: "overload", name: "Overload",
    descs: ["+40% damage & +20% fire rate — but -2 hearts.", "+55% damage & +30% fire rate — but -2 hearts.", "+70% damage & +40% fire rate — but -2 hearts."],
    glyph: "!", tint: "#ff8a3b", rarity: "rare",
    apply: (m, l) => { m.damageMult += lv([0.40, 0.55, 0.70], l); m.fireRateMult += lv([0.20, 0.30, 0.40], l); m.maxHpBonus -= 2; },
  },
  {
    // Dodge glass: raw mobility + dash uptime, paid in hearts.
    id: "featherweight", name: "Featherweight",
    descs: ["+16% move speed & -20% dash cooldown — but -2 hearts.", "+24% move speed & -28% dash cooldown — but -2 hearts.", "+30% move speed & -35% dash cooldown — but -2 hearts."],
    glyph: "^", tint: "#7fdd5a", rarity: "uncommon",
    apply: (m, l) => { m.moveSpeedMult += lv([0.16, 0.24, 0.30], l); m.dashCdMult = Math.min(m.dashCdMult, lv([0.80, 0.72, 0.65], l)); m.maxHpBonus -= 2; },
  },
  {
    // Cold shoulder: big, chilling rounds that lock a body down as they land.
    id: "frostbite", name: "Frostbite",
    descs: ["Bigger rounds, +20% chance to chill on hit.", "Bigger rounds, +30% chance to chill on hit.", "Bigger rounds, +40% chance to chill on hit."],
    glyph: "*", tint: "#7fd3ff", rarity: "uncommon",
    apply: (m, l) => { m.bulletSizeMult += 0.4; m.chillChance += lv([0.20, 0.30, 0.40], l); },
  },
  {
    // Fast hands: a light tempo + crit hybrid for the aggressive opener.
    id: "quickdraw", name: "Quickdraw",
    descs: ["+20% fire rate & +10% crit chance.", "+30% fire rate & +15% crit chance.", "+38% fire rate & +20% crit chance."],
    glyph: "Q", tint: "#ffd166", rarity: "common",
    apply: (m, l) => { m.fireRateMult += lv([0.20, 0.30, 0.38], l); m.critChance += lv([0.10, 0.15, 0.20], l); },
  },
  {
    // The frontliner: a sturdier, faster body to hold the line.
    id: "vanguard", name: "Vanguard",
    descs: ["+1 heart & +12% move speed.", "+2 hearts & +16% move speed.", "+2 hearts & +20% move speed."],
    glyph: "U", tint: "#ff6a6a", rarity: "common",
    apply: (m, l) => { m.maxHpBonus += lv([1, 2, 2], l); m.moveSpeedMult += lv([0.12, 0.16, 0.20], l); },
  },
  {
    id: "hold_fast", name: "HOLD FAST",
    descs: ["Weapon kick is reduced 30%.", "Weapon kick is reduced 45%.", "Weapon kick is reduced 60%."],
    glyph: "|", tint: "#d6c7a1", rarity: "common",
    apply: (m, l) => { m.selfKnockbackMult = Math.min(m.selfKnockbackMult, lv([0.70, 0.55, 0.40], l)); },
  },
  {
    id: "nothing_wasted", name: "NOTHING WASTED",
    descs: ["Plain rounds that miss reclaim one wall bounce at 35% damage.", "Plain rounds that miss reclaim one wall bounce at 50% damage.", "Plain rounds that miss reclaim one wall bounce at 65% damage."],
    glyph: "\\", tint: "#e8e0c8", rarity: "uncommon",
    apply: (m, l) => { m.reclaimedBounceDamage = Math.max(m.reclaimedBounceDamage, lv([0.35, 0.50, 0.65], l)); },
  },
  {
    id: "second_breath_muddy", name: "SECOND BREATH MUDDY",
    descs: ["Dashing through silk refunds 20% of that dash cooldown.", "Dashing through silk refunds 35% of that dash cooldown.", "Dashing through silk refunds 50% of that dash cooldown."],
    glyph: "%", tint: "#9b7a55", rarity: "uncommon",
    apply: (m, l) => { m.muddyDashRefund = Math.max(m.muddyDashRefund, lv([0.20, 0.35, 0.50], l)); },
  },
  {
    id: "on_the_beat", name: "ON THE BEAT",
    descs: ["Kills add 0.5s to the combo beat; each active tier grants +4% fire rate.", "Kills add 0.8s to the combo beat; each active tier grants +6% fire rate.", "Kills add 1.1s to the combo beat; each active tier grants +8% fire rate."],
    glyph: "#", tint: "#efb85f", rarity: "rare",
    apply: (m, l) => {
      m.comboWindowBonus = Math.max(m.comboWindowBonus, lv([0.5, 0.8, 1.1], l));
      m.beatFireRatePerTier = Math.max(m.beatFireRatePerTier, lv([0.04, 0.06, 0.08], l));
    },
  },
  {
    id: "shared_rope", name: "SHARED ROPE",
    descs: ["Revive from 12px farther away and channel 15% faster.", "Revive from 20px farther away and channel 25% faster.", "Revive from 28px farther away and channel 35% faster."],
    glyph: "&", tint: "#a8d7a0", rarity: "common",
    apply: (m, l) => {
      m.reviveRadiusBonus = Math.max(m.reviveRadiusBonus, lv([12, 20, 28], l));
      m.reviveSpeedMult = Math.max(m.reviveSpeedMult, lv([1.15, 1.25, 1.35], l));
    },
  },
  // ---- the premium CORE INFUSIONS (shop stock only — never in a blessing offer) ----
  // Single-stat bumps toward the existing raw caps: a FASTER route to the cap, never a
  // higher cap (clampModCaps still rules). Leveled like blessings so the build strip,
  // the recompute, and the level caps all ride the one item system; each successive core
  // costs ×1.6 at the stall (see shopSlotPriceFor).
  {
    id: "core_damage", name: "Cinder Core",
    descs: ["+25% damage.", "+45% damage.", "+60% damage."],
    glyph: "\u25b2", tint: "#ff8a5a", rarity: "rare", isPremiumOnly: true,
    apply: (m, l) => { m.damageMult += lv([0.25, 0.45, 0.60], l); },
  },
  {
    id: "core_fire", name: "Tempo Core",
    descs: ["+15% fire rate.", "+28% fire rate.", "+38% fire rate."],
    glyph: "\u25b3", tint: "#ffd166", rarity: "rare", isPremiumOnly: true,
    apply: (m, l) => { m.fireRateMult += lv([0.15, 0.28, 0.38], l); },
  },
  {
    id: "core_move", name: "Gale Core",
    descs: ["+8% move speed.", "+14% move speed.", "+19% move speed."],
    glyph: "\u25bd", tint: "#7fdd5a", rarity: "rare", isPremiumOnly: true,
    apply: (m, l) => { m.moveSpeedMult += lv([0.08, 0.14, 0.19], l); },
  },
  // The dash core: one banked extra dash charge — skill-expressive mobility, capped at
  // ONE per run so movement never homogenizes into blink-spam.
  {
    id: "core_dash", name: "Echo Step",
    descs: ["+1 dash charge.", "+1 dash charge.", "+1 dash charge."],
    glyph: "\u00bb", tint: "#5ab6ff", rarity: "rare", isPremiumOnly: true, maxLevel: 1,
    apply: (m) => { m.extraDashCharge += 1; },
  },
];

// The stat cores the core-infusion pedestal may stock (the dash core prices higher —
// see shopSlotPriceFor's dashCorePriceMult).
export const CORE_ITEM_IDS: readonly string[] = ["core_damage", "core_fire", "core_move", "core_dash"];

export function normalItemsForCatalog(
  catalogVersion: ContentCatalogVersion = CURRENT_CONTENT_CATALOG_VERSION,
): readonly ItemDef[] {
  const allowed = new Set(contentCatalogFor(catalogVersion).normalBlessingIds);
  return ITEMS.filter((item) => allowed.has(item.id));
}

// A player's cumulative levels from their pick history (an id's count IS its level).
export function itemLevelsOf(ownedItemIds: readonly string[]): Map<string, number> {
  const levels = new Map<string, number>();
  for (const id of ownedItemIds) {
    levels.set(id, Math.min(MAX_ITEM_LEVEL, (levels.get(id) ?? 0) + 1));
  }
  return levels;
}

// Full build recompute: identity mods -> every owned blessing's total contribution at its
// level -> the kit's STAT LEAN -> raw caps. Mutates `mods` in place (held references stay
// valid). The kit lean is applied AFTER blessings and BEFORE the cap clamp, so a kit is a
// different ROUTE to the committed caps, never a higher ceiling (spec §1). Omitting `kit` (or
// passing "none") reproduces the pre-kit recompute byte-for-byte.
export function recomputeMods(mods: PlayerMods, ownedItemIds: readonly string[], kit: KitId = "none"): void {
  Object.assign(mods, createMods());
  for (const [id, level] of itemLevelsOf(ownedItemIds)) {
    const def = itemById(id);
    if (def) def.apply(mods, level);
  }
  applyKitStatLean(mods, kit);
  clampModCaps(mods);
}

export interface RollOpts {
  isRareOnly?: boolean;
  history?: BlessingOfferHistory;
  eligibleItems?: readonly ItemDef[];
  excludedIds?: ReadonlySet<string>;
  isPremiumAllowed?: boolean;
}

// Weighted, distinct draw for one blessing offer. The roll function is injected so the same
// logic serves both the local (solo) path — a client-seeded stream — and the authoritative
// server, which passes its own seeded generator so the OFFERED choices are server-decided
// and a client can't fabricate an off-pool item. Maxed (Lv3) blessings leave the pool; a
// new blessing weighs 3× an upgrade.
export function rollItemChoicesWith(
  count: number,
  rand: () => number,
  ownedItemIds: readonly string[] = [],
  opts: RollOpts = {},
): ItemDef[] {
  const levels = itemLevelsOf(ownedItemIds);
  const eligible = (opts.eligibleItems ?? ITEMS).filter((item) =>
    (opts.isPremiumAllowed === true || item.isPremiumOnly !== true)
    && (levels.get(item.id) ?? 0) < itemMaxLevel(item)
    && !opts.excludedIds?.has(item.id)
  );
  const pool = opts.isRareOnly
    ? eligible.filter((item) => item.rarity === "rare")
    : eligible;
  const weightOf = (item: ItemDef): number =>
    RARITY_WEIGHT[item.rarity]
    * (levels.has(item.id) ? 1 : NEW_ITEM_WEIGHT)
    * (opts.history ? blessingHistoryWeight(opts.history, item.id) : 1);

  const remaining = pool.slice();
  const chosen: ItemDef[] = [];
  const history = opts.history;
  const previous = history?.recentBlessingOffers.at(-1) ?? [];
  const isUnseenAvailable = history !== undefined
    && pool.some((item) => blessingSeenCount(history, item.id) === 0);
  let upgradeCount = 0;
  for (let n = 0; n < count && remaining.length > 0; n++) {
    let candidates = remaining;
    if (history && n === 0 && isUnseenAvailable) {
      candidates = candidates.filter((item) => blessingSeenCount(history, item.id) === 0);
    }
    const outsidePrevious = candidates.filter((item) => !previous.includes(item.id));
    if (outsidePrevious.length > 0) candidates = outsidePrevious;
    if (history && isUnseenAvailable && upgradeCount >= 1) {
      candidates = candidates.filter((item) => !levels.has(item.id));
      if (candidates.length === 0) {
        candidates = remaining.filter((item) => !levels.has(item.id));
      }
    }
    if (candidates.length === 0) break;

    let total = 0;
    for (const item of candidates) total += weightOf(item);
    let r = rand() * total;
    let idx = 0;
    for (; idx < candidates.length; idx++) {
      r -= weightOf(candidates[idx]);
      if (r <= 0) break;
    }
    if (idx >= candidates.length) idx = candidates.length - 1;
    const pick = candidates[idx];
    chosen.push(pick);
    if (levels.has(pick.id)) upgradeCount++;
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return chosen;
}

export interface PvpDraftRollOpts {
  tierBump?: number;
}

const PVP_BLESSING_IDS = new Set(PVP.blessingPool);
const PVP_BLACKLIST_IDS = new Set<string>(PVP.blessingBlacklist);

export function isPvpBlessingId(id: string): boolean {
  return PVP_BLESSING_IDS.has(id) && !PVP_BLACKLIST_IDS.has(id);
}

export function rollPvpDraftChoicesWith(
  count: number,
  rand: () => number,
  ownedItemIds: readonly string[] = [],
  opts: PvpDraftRollOpts = {},
): ItemDef[] {
  const levels = itemLevelsOf(ownedItemIds);
  const eligible = ITEMS.filter((item) =>
    isPvpBlessingId(item.id)
    && (levels.get(item.id) ?? 0) < itemMaxLevel(item)
  );
  const tierBump = Math.max(0, Math.floor(opts.tierBump ?? 0));
  const tierOf = (rarity: ItemRarity): number =>
    rarity === "rare" ? 2 : rarity === "uncommon" ? 1 : 0;
  const weightOf = (item: ItemDef): number => {
    const base = PVP.draftRarityWeight[item.rarity];
    const rarityBoost = 1 + tierBump * tierOf(item.rarity);
    return base * rarityBoost * (levels.has(item.id) ? 1 : NEW_ITEM_WEIGHT);
  };

  const remaining = eligible.slice();
  const chosen: ItemDef[] = [];
  for (let draw = 0; draw < count && remaining.length > 0; draw++) {
    let total = 0;
    for (const item of remaining) total += weightOf(item);
    if (total <= 0) break;
    let roll = rand() * total;
    let index = 0;
    for (; index < remaining.length; index++) {
      roll -= weightOf(remaining[index]);
      if (roll <= 0) break;
    }
    if (index >= remaining.length) index = remaining.length - 1;
    chosen.push(remaining[index]);
    remaining.splice(index, 1);
  }
  return chosen;
}

// Look up an item definition by id (the server validates a client's blessing pick against the
// offered ids, then applies the corresponding ItemDef).
export function itemById(id: string): ItemDef | undefined {
  return ITEMS.find((it) => it.id === id);
}

// The card/HUD text for a blessing at a cumulative level (1–3).
export function itemDesc(def: ItemDef, level: number): string {
  return def.descs[Math.max(1, Math.min(MAX_ITEM_LEVEL, level)) - 1];
}
