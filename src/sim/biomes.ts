// The descent's biome ladder. Six tiers, five floors each, each band capped by its boss
// floor (bosses land on 5/10/15/20/25): beat the biome's boss, descend into a new world.
// The ladder is ONE-WAY — no cycling back to the surface greens; past floor 25 the run
// holds in the terminal void tier forever. Everything here is plain data consumed by both
// the pure sim (biome pressure / hazard palettes key off biomeIndexForFloor) and the
// client renderer (palette, lighting, ambience), so it stays in src/sim.

export interface Biome {
  readonly name: string;
  // Per-biome tile-art registry key (client assets opt-in: /tiles/biomes/<tileKey>/...).
  // Art lands per biome without code changes; until then the renderer grades the shared
  // tile set with this biome's palette.
  readonly tileKey: string;
  readonly bgColor: string;
  readonly floorA: string;
  readonly floorB: string;
  readonly wallFront: string;
  readonly wallCap: string;
  readonly wallSideRgb: string;
  readonly wallCorner: string;
  readonly tint: string;
  readonly tintAlpha: number;
  readonly accent: string;
  // ---- lighting / mood (client-consumed, data-only) ----
  readonly glow: string;          // torch / ambient light tint
  readonly lightLevel: number;    // 0..1 multiply-darken over floors (deeper = dimmer)
  readonly vignette: number;      // 0..1 screen-edge darkness closing in with depth
  readonly vignetteColor: string;
  readonly pulse: number;         // ambient breathing amplitude (Ember heat, Null throb)
  readonly detailDensity: number; // floor-detail overlay frequency 0..1 (deeper = busier)
  readonly detailTint: string | null; // recolor for detail overlays (null = as-authored)
  readonly torchesPerRoom: number;
}

const FLOORS_PER_BIOME = 5;

export const BIOMES: readonly Biome[] = [
  {
    // Floors 1-5 — the warm, safe-ish home under the home. Roots, moss, amber torchlight.
    name: "Verdant Hollow",
    tileKey: "verdant",
    bgColor: "#0a120e",
    floorA: "#141f18",
    floorB: "#182419",
    wallFront: "#1e2e24",
    wallCap: "#2a4032",
    wallSideRgb: "24,36,28",
    wallCorner: "rgba(8,14,10,0.5)",
    tint: "#3d6b50",
    tintAlpha: 0.24,
    accent: "#5fbf7a",
    glow: "#ffc86b",
    lightLevel: 0,
    vignette: 0.10,
    vignetteColor: "#050b07",
    pulse: 0,
    detailDensity: 0.09,
    detailTint: null,
    torchesPerRoom: 1,
  },
  {
    // Floors 6-10 — shale and old bone. Colder, quieter, water somewhere in the dark.
    name: "Sunless Caves",
    tileKey: "sunless",
    bgColor: "#0a0e14",
    floorA: "#141820",
    floorB: "#181c26",
    wallFront: "#1e2430",
    wallCap: "#2a3448",
    wallSideRgb: "22,28,40",
    wallCorner: "rgba(8,10,16,0.5)",
    tint: "#4a6080",
    tintAlpha: 0.24,
    accent: "#7aa8c8",
    glow: "#9fd4ff",
    lightLevel: 0.08,
    vignette: 0.18,
    vignetteColor: "#04070c",
    pulse: 0,
    detailDensity: 0.11,
    detailTint: "#3e6a8a",
    torchesPerRoom: 1,
  },
  {
    // Floors 11-15 — resin and fracture. The geometry starts feeling wrong; arcane light.
    name: "The Deep",
    tileKey: "deep",
    bgColor: "#0e0b1a",
    floorA: "#171227",
    floorB: "#1b1530",
    wallFront: "#241a3a",
    wallCap: "#2f2350",
    wallSideRgb: "27,21,48",
    wallCorner: "rgba(9,6,18,0.5)",
    tint: "#4a2f78",
    tintAlpha: 0.20,
    accent: "#a24bff",
    glow: "#b06bff",
    lightLevel: 0.14,
    vignette: 0.26,
    vignetteColor: "#070313",
    pulse: 0.03,
    detailDensity: 0.14,
    detailTint: "#8a5cff",
    torchesPerRoom: 2,
  },
  {
    // Floors 16-20 — clinker and vents. Oppressive heat; the dark glows from below.
    name: "Emberreach",
    tileKey: "ember",
    bgColor: "#120a08",
    floorA: "#1f1410",
    floorB: "#241816",
    wallFront: "#301c14",
    wallCap: "#4a2820",
    wallSideRgb: "40,24,18",
    wallCorner: "rgba(14,8,6,0.5)",
    tint: "#a63c14",
    tintAlpha: 0.34,
    accent: "#ffb43b",
    glow: "#ff8a3b",
    lightLevel: 0.18,
    vignette: 0.32,
    vignetteColor: "#0c0402",
    pulse: 0.06,
    detailDensity: 0.16,
    detailTint: "#ff7a3b",
    torchesPerRoom: 2,
  },
  {
    // Floors 21-25 — the Fracture. Reality cracks; cold crystal light leaks through the
    // seams. Everything is slightly off-axis and too quiet.
    name: "The Fracture",
    tileKey: "fracture",
    bgColor: "#070b12",
    floorA: "#0e141d",
    floorB: "#111827",
    wallFront: "#16202e",
    wallCap: "#22384a",
    wallSideRgb: "18,28,40",
    wallCorner: "rgba(4,8,14,0.55)",
    tint: "#1a6b7a",
    tintAlpha: 0.34,
    accent: "#6ff0d8",
    glow: "#6ff0d8",
    lightLevel: 0.26,
    vignette: 0.40,
    vignetteColor: "#020608",
    pulse: 0.08,
    detailDensity: 0.20,
    detailTint: "#1fa892",
    torchesPerRoom: 2,
  },
  {
    // Floors 26+ — the Null. The world stops pretending. Near-black, void-bright seams,
    // light that falls upward. Terminal: the ladder holds here forever.
    name: "The Null",
    tileKey: "nullvoid",
    bgColor: "#05030b",
    floorA: "#0a0714",
    floorB: "#0d0918",
    wallFront: "#140e24",
    wallCap: "#241a40",
    wallSideRgb: "16,11,30",
    wallCorner: "rgba(2,1,6,0.6)",
    tint: "#5a1a80",
    tintAlpha: 0.36,
    accent: "#ff4ad8",
    glow: "#d9a6ff",
    lightLevel: 0.34,
    vignette: 0.48,
    vignetteColor: "#010004",
    pulse: 0.12,
    detailDensity: 0.26,
    detailTint: "#ff4ad8",
    torchesPerRoom: 3,
  },
];

export function biomeIndexForFloor(floor: number): number {
  const f = Math.max(1, Math.floor(floor));
  return Math.min(Math.floor((f - 1) / FLOORS_PER_BIOME), BIOMES.length - 1);
}

export function biomeForFloor(floor: number): Biome {
  return BIOMES[biomeIndexForFloor(floor)];
}

// How deep into its biome band a floor sits, 0..1 (floor 6 -> 0, floor 10 -> 1). The
// terminal band clamps at 1. Drives within-band escalation: hazard density, room-shape
// drama and ambience all thicken as the band's boss floor approaches.
export function biomeDepthForFloor(floor: number): number {
  const f = Math.max(1, Math.floor(floor));
  const idx = biomeIndexForFloor(f);
  if (idx >= BIOMES.length - 1) {
    const over = f - FLOORS_PER_BIOME * (BIOMES.length - 1) - 1;
    return Math.min(1, over / (FLOORS_PER_BIOME - 1));
  }
  return ((f - 1) % FLOORS_PER_BIOME) / (FLOORS_PER_BIOME - 1);
}

export function floorBannerText(floor: number, opts?: { isBoss?: boolean; isDescend?: boolean }): string {
  if (opts?.isBoss) return "BOSS FLOOR";
  const name = biomeForFloor(floor).name.toUpperCase();
  if (opts?.isDescend) return `${name} · DOWN TO FLOOR ${floor}`;
  return `${name} · FLOOR ${floor}`;
}
