// The descent's biome ladder — the CANONICAL 30-floor six-region spine from
// docs/specs/blobrogue_ENCOUNTER_CURRICULUM_spec.md §0, plus the terminal Null band as
// the approved post-F30 expansion slot. Five floors per band, each capped by its
// milestone (Slime King F5, the F10 Miniboss Gauntlet, then Marrow F15 / Weaver F20 /
// Gilded Warden F25 / Hollow Choir F30). The ladder is ONE-WAY; past floor 30 the run
// holds in the Null forever. Everything here is plain data consumed by both the pure sim
// (biome pressure / hazard palettes key off biomeIndexForFloor) and the client renderer
// (palette, lighting, ambience), so it stays in src/sim.

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
    // Floors 1-5 — living, elastic, warm. Wet roots and amber torchlight: the safe-ish
    // home under the home. Capped by the Slime King.
    name: "Amberwild",
    tileKey: "amberwild",
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
    // Floors 6-10 — the same living ecology grown DENSE: branching root warrens,
    // formation corridors, bark and old amber. Capped by the F10 Miniboss Gauntlet.
    name: "Rootbound Warrens",
    tileKey: "rootbound",
    bgColor: "#0b0e08",
    floorA: "#151a10",
    floorB: "#191e13",
    wallFront: "#232b18",
    wallCap: "#334022",
    wallSideRgb: "28,34,20",
    wallCorner: "rgba(10,12,7,0.5)",
    tint: "#4d5a26",
    tintAlpha: 0.26,
    accent: "#9cbf3f",
    glow: "#ffd166",
    lightLevel: 0.06,
    vignette: 0.14,
    vignetteColor: "#070905",
    pulse: 0,
    detailDensity: 0.11,
    detailTint: "#6b8a2e",
    torchesPerRoom: 1,
  },
  {
    // Floors 11-15 — sound and momentum: shale, bone dust, charge lanes, echoing dark.
    // Capped by Marrow.
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
    tintAlpha: 0.26,
    accent: "#7aa8c8",
    glow: "#9fd4ff",
    lightLevel: 0.12,
    vignette: 0.20,
    vignetteColor: "#04070c",
    pulse: 0,
    detailDensity: 0.13,
    detailTint: "#3e6a8a",
    torchesPerRoom: 2,
  },
  {
    // Floors 16-20 — fracture and wrong geometry: jet resin, load seams, offsets that
    // should not hold. Capped by the Weaver.
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
    tintAlpha: 0.28,
    accent: "#a24bff",
    glow: "#b06bff",
    lightLevel: 0.18,
    vignette: 0.28,
    vignetteColor: "#070313",
    pulse: 0.03,
    detailDensity: 0.16,
    detailTint: "#8a5cff",
    torchesPerRoom: 2,
  },
  {
    // Floors 21-25 — order, armor, claimed space: the Gilded Archive. Dead-prism amber,
    // columned shelves, lamplight on gold. Capped by the Gilded Warden.
    name: "Gilded Archive",
    tileKey: "gilded",
    bgColor: "#120e05",
    floorA: "#221b0d",
    floorB: "#282010",
    wallFront: "#33290f",
    wallCap: "#4d3d16",
    wallSideRgb: "42,33,13",
    wallCorner: "rgba(14,11,4,0.55)",
    tint: "#8a6b1f",
    tintAlpha: 0.32,
    accent: "#ffd166",
    glow: "#ffe9b0",
    lightLevel: 0.24,
    vignette: 0.34,
    vignetteColor: "#0a0703",
    pulse: 0.04,
    detailDensity: 0.19,
    detailTint: "#d9b03b",
    torchesPerRoom: 3,
  },
  {
    // Floors 26-30 — convection and pressure: clinker, vents, thermal lanes, the dark
    // glowing from below. Capped by the Hollow Choir — the first-clear finale.
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
    lightLevel: 0.30,
    vignette: 0.42,
    vignetteColor: "#0c0402",
    pulse: 0.08,
    detailDensity: 0.23,
    detailTint: "#ff7a3b",
    torchesPerRoom: 3,
  },
  {
    // Floors 31+ — the Null: the approved post-F30 expansion slot (curriculum: "Null/Jet
    // is a later post-F30 expansion"). Near-black, void-bright seams, light that falls
    // upward. Terminal: the ladder holds here forever.
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
    lightLevel: 0.36,
    vignette: 0.48,
    vignetteColor: "#010004",
    pulse: 0.12,
    detailDensity: 0.27,
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
// drama and ambience all thicken as the band's milestone floor approaches — the
// curriculum's teach -> remix -> prove ramp, expressed by the level itself.
export function biomeDepthForFloor(floor: number): number {
  const f = Math.max(1, Math.floor(floor));
  const idx = biomeIndexForFloor(f);
  if (idx >= BIOMES.length - 1) {
    const over = f - FLOORS_PER_BIOME * (BIOMES.length - 1) - 1;
    return Math.min(1, over / (FLOORS_PER_BIOME - 1));
  }
  return ((f - 1) % FLOORS_PER_BIOME) / (FLOORS_PER_BIOME - 1);
}

// The F10 milestone is the curriculum's authored Miniboss Gauntlet — a non-boss beat
// that breaks the boss cadence without replacing named content. It shares the %5
// milestone machinery (grand arena, zero generator hazards, banner) but announces
// itself as what it is.
export function isGauntletFloor(floor: number): boolean {
  return Math.floor(floor) === 10;
}

export function floorBannerText(floor: number, opts?: { isBoss?: boolean; isDescend?: boolean }): string {
  if (opts?.isBoss) return isGauntletFloor(floor) ? "MINIBOSS GAUNTLET" : "BOSS FLOOR";
  const name = biomeForFloor(floor).name.toUpperCase();
  if (opts?.isDescend) return `${name} · DOWN TO FLOOR ${floor}`;
  return `${name} · FLOOR ${floor}`;
}
