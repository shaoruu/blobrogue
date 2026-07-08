// In-run blessing system, leveled (spec §6). Every blessing has Lv1–3; a duplicate pick IS
// the Lv2/Lv3 upgrade. A player's build is their pick history (ownedItemIds — one entry per
// pick, so an id's count is its level) and mods are always RECOMPUTED from those levels,
// then clamped to the raw caps — no irreversible incremental applies, no cap escapes. The
// authoritative sim (solo LocalTransport and the server) runs the identical recompute.

import { CAPS } from "./balance.js";

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
  coinMult: number;        // ×coins per pickup
  coinMagnet: number;      // px radius that vacuums loose coins toward you
  coinMagnetPull: number;  // px/s pull speed of the vacuum
  thorns: number;          // damage reflected onto whatever touches you
  adrenaline: number;      // + fire-rate multiplier scaled by how low your HP is
  berserk: number;         // + damage multiplier scaled by how low your HP is
  burnChance: number;      // 0..1 chance a hit also ignites (each elemental cap 0.5)
  chillChance: number;     // 0..1 chance a hit also chills (slow → freeze)
  shockChance: number;     // 0..1 chance a hit also shocks (+dmg amp + arc)
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
    coinMult: 1,
    coinMagnet: 0,
    coinMagnetPull: 0,
    thorns: 0,
    adrenaline: 0,
    berserk: 0,
    burnChance: 0,
    chillChance: 0,
    shockChance: 0,
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
  // Writes the blessing's TOTAL contribution at the given cumulative level (1–3) onto a
  // fresh mods struct. Levels are lookups, never repeated multiplication.
  apply: (m: PlayerMods, level: number) => void;
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
    apply: (m, l) => { m.dashCdMult = lv([0.65, 0.55, 0.50], l); },
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
    apply: (m, l) => { m.critChance = lv([0.25, 0.40, 0.50], l); m.critMult = lv([2.5, 2.75, 3.0], l); },
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
];

// A player's cumulative levels from their pick history (an id's count IS its level).
export function itemLevelsOf(ownedItemIds: readonly string[]): Map<string, number> {
  const levels = new Map<string, number>();
  for (const id of ownedItemIds) {
    levels.set(id, Math.min(MAX_ITEM_LEVEL, (levels.get(id) ?? 0) + 1));
  }
  return levels;
}

// Full build recompute: identity mods -> every owned blessing's total contribution at its
// level -> raw caps. Mutates `mods` in place (held references stay valid).
export function recomputeMods(mods: PlayerMods, ownedItemIds: readonly string[]): void {
  Object.assign(mods, createMods());
  for (const [id, level] of itemLevelsOf(ownedItemIds)) {
    const def = itemById(id);
    if (def) def.apply(mods, level);
  }
  clampModCaps(mods);
}

export interface RollOpts {
  // Boss-chest reward: restrict the pool to rare blessings (falls back to the full pool
  // if every rare is maxed).
  rareOnly?: boolean;
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
  const eligible = ITEMS.filter((it) => (levels.get(it.id) ?? 0) < MAX_ITEM_LEVEL);
  let pool = opts.rareOnly ? eligible.filter((it) => it.rarity === "rare") : eligible;
  if (pool.length === 0) pool = eligible;
  const weightOf = (it: ItemDef) => RARITY_WEIGHT[it.rarity] * (levels.has(it.id) ? 1 : NEW_ITEM_WEIGHT);

  const remaining = pool.slice();
  const chosen: ItemDef[] = [];
  for (let n = 0; n < count && remaining.length > 0; n++) {
    let total = 0;
    for (const it of remaining) total += weightOf(it);
    let r = rand() * total;
    let idx = 0;
    for (; idx < remaining.length; idx++) {
      r -= weightOf(remaining[idx]);
      if (r <= 0) break;
    }
    if (idx >= remaining.length) idx = remaining.length - 1;
    chosen.push(remaining[idx]);
    remaining.splice(idx, 1);
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
