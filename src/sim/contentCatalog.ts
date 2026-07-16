import type { WeaponId } from "./types.js";

export type ContentCatalogVersion = 0 | 1;

export interface ContentCatalog {
  readonly version: ContentCatalogVersion;
  readonly pickupWeapons: readonly WeaponId[];
  readonly normalBlessingIds: readonly string[];
}

export const LEGACY_CONTENT_CATALOG_VERSION: ContentCatalogVersion = 0;
export const WAVE_A_CONTENT_CATALOG_VERSION: ContentCatalogVersion = 1;
export const CURRENT_CONTENT_CATALOG_VERSION = WAVE_A_CONTENT_CATALOG_VERSION;

const LEGACY_PICKUP_WEAPONS: readonly WeaponId[] = [
  "shotgun", "rapid", "smg", "cannon", "burst", "ricochet", "homing", "tesla",
  "sawnoff", "railgun", "nailer", "flamer", "mortar", "beam",
  "sword", "longsword", "spear",
  "lastlight", "breach", "snapwire", "frostline", "halo", "sentry", "crook",
  "reaper", "swarm", "midas", "phase", "vortex",
  "cleaver", "scrapper", "skipper", "arcbolt", "cryobolt", "firebomb", "tracker",
  "singularity",
];

const WAVE_A_PICKUP_WEAPONS: readonly WeaponId[] = [
  ...LEGACY_PICKUP_WEAPONS,
  "mooring_nail", "sluicegate", "oddsmaker", "pathmaker",
];

const LEGACY_NORMAL_BLESSING_IDS: readonly string[] = [
  "glass_cannon", "hair_trigger", "split_shot", "scattergun", "full_metal",
  "swift_boots", "big_iron", "vampire_fang", "adrenaline", "berserk",
  "second_wind", "thorns", "coin_magnet", "greed", "deadeye", "vitality",
  "incendiary_rounds", "cryo_coating", "static_charge", "elementalist",
  "marksman", "juggernaut", "heavy_rounds", "skirmisher", "executioner",
  "overload", "featherweight", "frostbite", "quickdraw", "vanguard",
];

const WAVE_A_NORMAL_BLESSING_IDS: readonly string[] = [
  ...LEGACY_NORMAL_BLESSING_IDS,
  "hold_fast", "nothing_wasted", "second_breath_muddy", "on_the_beat", "shared_rope",
];

export const CONTENT_CATALOGS: Readonly<Record<ContentCatalogVersion, ContentCatalog>> = {
  0: {
    version: LEGACY_CONTENT_CATALOG_VERSION,
    pickupWeapons: LEGACY_PICKUP_WEAPONS,
    normalBlessingIds: LEGACY_NORMAL_BLESSING_IDS,
  },
  1: {
    version: WAVE_A_CONTENT_CATALOG_VERSION,
    pickupWeapons: WAVE_A_PICKUP_WEAPONS,
    normalBlessingIds: WAVE_A_NORMAL_BLESSING_IDS,
  },
};

export function contentCatalogFor(version: ContentCatalogVersion): ContentCatalog {
  return CONTENT_CATALOGS[version];
}

export function isContentCatalogVersion(value: number): value is ContentCatalogVersion {
  return value === LEGACY_CONTENT_CATALOG_VERSION || value === WAVE_A_CONTENT_CATALOG_VERSION;
}
