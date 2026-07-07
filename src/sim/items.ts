// In-run item / synergy system. Every item is a small data-driven modifier that
// mutates a PlayerMods struct; the game core reads those mods in its fire / move /
// dash / damage paths. Items stack and persist for the whole run (lost on death),
// so a handful of picks compound into a distinct build. Solo-authoritative and purely
// local — see the co-op note in game.ts (each client picks its own blessings).

// The neutral run-stat modifiers. Every field starts at its identity value (1 for a
// multiplier, 0 for an additive) so an un-blessed run behaves exactly as before.
// Only fields that at least one item touches live here — no dead knobs.
export interface PlayerMods {
  damageMult: number;      // ×bullet damage
  fireRateMult: number;    // shots/sec multiplier (fireCd is divided by this)
  moveSpeedMult: number;   // ×walk speed
  maxHpBonus: number;      // ± hearts added to the base max HP
  extraPellets: number;    // + projectiles per shot
  spreadAdd: number;       // + cone width (rad) once a shot fires >1 pellet
  pierce: number;          // enemies a bullet punches through before dying
  bulletSizeMult: number;  // ×bullet radius (bigger = easier hits)
  bulletSpeedMult: number; // ×bullet speed
  bulletLifeMult: number;  // ×bullet lifetime (range)
  lifestealChance: number; // chance to regain a heart on kill
  critChance: number;      // chance a pellet crits
  critMult: number;        // ×damage on a crit
  dashCdMult: number;      // ×dash cooldown (lower = dash more often)
  coinMult: number;        // ×coins per pickup
  coinMagnet: number;      // px radius that vacuums loose coins toward you
  thorns: number;          // damage reflected onto whatever touches you
  adrenaline: number;      // + fire-rate multiplier scaled by how low your HP is
  berserk: number;         // + damage multiplier scaled by how low your HP is
  burnChance: number;      // 0..1 chance a hit also ignites (burn DoT)
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
    thorns: 0,
    adrenaline: 0,
    berserk: 0,
    burnChance: 0,
    chillChance: 0,
    shockChance: 0,
  };
}

export type ItemRarity = "common" | "uncommon" | "rare";

// Rarer items are stronger / more build-defining and show up less often. The number
// is the raw weight used by the weighted draw.
const RARITY_WEIGHT: Record<ItemRarity, number> = {
  common: 10,
  uncommon: 6,
  rare: 3,
};

export interface ItemDef {
  id: string;
  name: string;
  desc: string;        // short, punchy — one line on the card
  glyph: string;       // single-char icon shown on the card + HUD strip (tint gives identity)
  tint: string;        // accent color for the drawn icon chip
  rarity: ItemRarity;
  apply: (m: PlayerMods) => void;
}

// The curated pool. Effects are intentionally a touch generous — this is a hobby game
// meant to feel powerful. Several are designed to combine: pellet stackers, low-HP
// scalers (Adrenaline + Berserk), and the crit / pierce / big-bullet damage lines.
export const ITEMS: readonly ItemDef[] = [
  {
    id: "glass_cannon", name: "Glass Cannon", desc: "+60% damage, but -2 max hearts.",
    glyph: "!", tint: "#ff5a5a", rarity: "rare",
    apply: (m) => { m.damageMult += 0.6; m.maxHpBonus -= 2; },
  },
  {
    id: "hair_trigger", name: "Hair Trigger", desc: "+35% fire rate.",
    glyph: "T", tint: "#ffd166", rarity: "common",
    apply: (m) => { m.fireRateMult += 0.35; },
  },
  {
    id: "split_shot", name: "Split Shot", desc: "+1 projectile per shot.",
    glyph: "Y", tint: "#5ab6ff", rarity: "uncommon",
    apply: (m) => { m.extraPellets += 1; m.spreadAdd += 0.10; },
  },
  {
    id: "scattergun", name: "Scattergun", desc: "+2 projectiles, wider spread, -10% damage.",
    glyph: "W", tint: "#ffb43b", rarity: "uncommon",
    apply: (m) => { m.extraPellets += 2; m.spreadAdd += 0.22; m.damageMult -= 0.10; },
  },
  {
    id: "full_metal", name: "Full Metal", desc: "Bullets punch through +1 enemy.",
    glyph: "P", tint: "#e8e0c8", rarity: "uncommon",
    apply: (m) => { m.pierce += 1; },
  },
  {
    id: "swift_boots", name: "Swift Boots", desc: "+20% move speed.",
    glyph: "S", tint: "#7fdd5a", rarity: "common",
    apply: (m) => { m.moveSpeedMult += 0.20; },
  },
  {
    id: "big_iron", name: "Big Iron", desc: "Bigger, slower bullets hit +50% harder.",
    glyph: "O", tint: "#b06bff", rarity: "uncommon",
    apply: (m) => { m.bulletSizeMult += 0.8; m.damageMult += 0.5; m.bulletSpeedMult -= 0.22; m.fireRateMult -= 0.12; },
  },
  {
    id: "vampire_fang", name: "Vampire Fang", desc: "10% chance to heal a heart on kill.",
    glyph: "V", tint: "#ff6a9d", rarity: "uncommon",
    apply: (m) => { m.lifestealChance += 0.10; },
  },
  {
    id: "adrenaline", name: "Adrenaline", desc: "Fire faster the lower your HP.",
    glyph: "A", tint: "#7fdd5a", rarity: "uncommon",
    apply: (m) => { m.adrenaline += 0.6; },
  },
  {
    id: "berserk", name: "Berserk", desc: "Hit harder the lower your HP.",
    glyph: "R", tint: "#ff5a5a", rarity: "rare",
    apply: (m) => { m.berserk += 0.6; },
  },
  {
    id: "second_wind", name: "Second Wind", desc: "-35% dash cooldown.",
    glyph: "D", tint: "#5ab6ff", rarity: "common",
    apply: (m) => { m.dashCdMult *= 0.65; },
  },
  {
    id: "thorns", name: "Thorns", desc: "Attackers take 2 damage on contact.",
    glyph: "X", tint: "#7fdd5a", rarity: "uncommon",
    apply: (m) => { m.thorns += 2; },
  },
  {
    id: "coin_magnet", name: "Coin Magnet", desc: "Vacuum up nearby coins.",
    glyph: "M", tint: "#ffd166", rarity: "common",
    apply: (m) => { m.coinMagnet += 90; },
  },
  {
    id: "greed", name: "Greed", desc: "Coins are worth double.",
    glyph: "$", tint: "#ffd166", rarity: "uncommon",
    apply: (m) => { m.coinMult += 1; },
  },
  {
    id: "deadeye", name: "Deadeye", desc: "+25% crit chance for big hits.",
    glyph: "+", tint: "#ff5a5a", rarity: "rare",
    apply: (m) => { m.critChance += 0.25; m.critMult += 0.5; },
  },
  {
    id: "vitality", name: "Vitality", desc: "+2 max hearts, filled.",
    glyph: "H", tint: "#ff6a6a", rarity: "common",
    apply: (m) => { m.maxHpBonus += 2; },
  },
  // Elemental blessings — turn any weapon into a status-dealer. Chances stack across
  // copies; Elementalist rolls all three, so a build can lace every shot with fire,
  // frost, and lightning at once.
  {
    id: "incendiary_rounds", name: "Incendiary Rounds", desc: "+25% chance to ignite enemies.",
    glyph: "F", tint: "#ff8a3b", rarity: "uncommon",
    apply: (m) => { m.burnChance += 0.25; },
  },
  {
    id: "cryo_coating", name: "Cryo Coating", desc: "+25% chance to chill (slow, then freeze) enemies.",
    glyph: "C", tint: "#7fd3ff", rarity: "uncommon",
    apply: (m) => { m.chillChance += 0.25; },
  },
  {
    id: "static_charge", name: "Static Charge", desc: "+25% chance to shock enemies (+dmg, arcs).",
    glyph: "Z", tint: "#7fe9ff", rarity: "uncommon",
    apply: (m) => { m.shockChance += 0.25; },
  },
  {
    id: "elementalist", name: "Elementalist", desc: "+15% chance to burn, chill, AND shock.",
    glyph: "E", tint: "#c98bff", rarity: "rare",
    apply: (m) => { m.burnChance += 0.15; m.chillChance += 0.15; m.shockChance += 0.15; },
  },
];

// Weighted, distinct draw for one blessing offer. Math.random is fine here — the
// offered choices don't need to be deterministic across clients (picks are local).
export function rollItemChoices(count: number): ItemDef[] {
  const pool = ITEMS.slice();
  const chosen: ItemDef[] = [];
  for (let n = 0; n < count && pool.length > 0; n++) {
    let total = 0;
    for (const it of pool) total += RARITY_WEIGHT[it.rarity];
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length; idx++) {
      r -= RARITY_WEIGHT[pool[idx].rarity];
      if (r <= 0) break;
    }
    if (idx >= pool.length) idx = pool.length - 1;
    chosen.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return chosen;
}
