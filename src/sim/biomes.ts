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
  // ---- structural value grade (client-consumed, data-only) ----
  // Walkability is a VALUE read before it is a hue read: floors sit darker than wall
  // caps in every band. These per-biome alphas calibrate that hierarchy against the
  // band's authored art (test/readability.test.ts gates the resulting grayscale
  // separation), preserving each material's hue and texture.
  readonly floorDim: number;  // alpha of the floor darkening layer
  readonly wallLift: number;  // alpha of the screen-blend cap lift over authored wall art
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
    floorDim: 0.28,
    wallLift: 0.13,
  },
  {
    // Floors 6-10 — the same living ecology as Amberwild grown DENSE and darker; the
    // accepted lane is deep GREEN-BROWN braided roots threaded with amber channels (the
    // accent). Capped by the F10 Miniboss Gauntlet.
    name: "Rootbound Warrens",
    tileKey: "rootbound",
    bgColor: "#0d0e09",
    floorA: "#171a10",
    floorB: "#1c1e12",
    wallFront: "#242718",
    wallCap: "#383a22",
    wallSideRgb: "30,31,19",
    wallCorner: "rgba(10,11,7,0.5)",
    tint: "#565232",
    tintAlpha: 0.24,
    accent: "#d9a24a",
    glow: "#ffd166",
    lightLevel: 0.06,
    vignette: 0.14,
    vignetteColor: "#070905",
    pulse: 0,
    detailDensity: 0.11,
    detailTint: "#6b8a2e",
    torchesPerRoom: 1,
    floorDim: 0.28,
    wallLift: 0.13,
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
    floorDim: 0.38,
    wallLift: 0.26,
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
    // Recalibrated (readability gates): the Deep's authored art measured Δ10.0 — exactly
    // AT the luma gate, zero margin — so any layout change (the shop room reshapes floor
    // 18) could tip a viewport under it. A stronger floor dim + wall lift buys real
    // headroom while staying inside the band's jet-resin grading.
    floorDim: 0.50,
    wallLift: 0.66,
  },
  {
    // Floors 21-25 — order, armor, claimed space. The accepted lane: RIGID amber/brass
    // + cold mineral — dead honey and tarnished metal, order turned to imprisonment
    // (never the Camp's warm gold). Capped by the Gilded Warden.
    name: "Gilded Archive",
    tileKey: "gilded",
    bgColor: "#100e09",
    floorA: "#1d1a11",
    floorB: "#222016",
    wallFront: "#2d2819",
    wallCap: "#453c24",
    wallSideRgb: "38,33,22",
    wallCorner: "rgba(13,11,7,0.5)",
    tint: "#7d6a3a",
    tintAlpha: 0.24,
    accent: "#e8c265",
    glow: "#ffe9b0",
    lightLevel: 0.24,
    vignette: 0.34,
    vignetteColor: "#0a0703",
    pulse: 0.04,
    detailDensity: 0.19,
    detailTint: "#d9b03b",
    torchesPerRoom: 3,
    floorDim: 0.28,
    wallLift: 0.13,
  },
  {
    // Floors 26-30 — convection and pressure: clinker, vents, thermal lanes, the dark
    // glowing from below. Capped by the Hollow Choir — the first-clear finale.
    name: "Emberreach",
    tileKey: "ember",
    bgColor: "#120a08",
    floorA: "#1a110e",
    floorB: "#1e1412",
    wallFront: "#3a2318",
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
    floorDim: 0.28,
    wallLift: 0.16,
  },
  {
    // Floors 31+ — THE SUMP: the wave-1 render band of THE UNMAKING (everything drains
    // together; warm/cold materials melt; corrupted mixed ecology). This ONE terminal
    // biome band is the coarse render/pressure granularity for all of post-F30; the
    // encounter REGION model (REGIONS below) is the fine granularity that names the four
    // post-F30 regions (Sump 31-50, Veinworks 51-70, Pale 71-90, Null Core 91-100). The
    // palette band is split per-region when each region gets its own authored tile art;
    // until then floors 31+ render the Sump palette and the region names the floor banner.
    // Interim Sump hexes are the AD's gate target (JET F35 contrasts against a real Sump
    // floor); TODO(AD-palette): relock with the AD's canonical palette when it lands.
    // Mood/lighting fields carry forward the terminal band's values (the ladder darkens
    // monotonically; readability grades against this Sump floor).
    name: "The Sump",
    tileKey: "nullvoid", // TODO(AD-palette): rename to "sump" when dedicated Sump tiles land
    bgColor: "#080610",
    floorA: "#16131a",
    floorB: "#1a1620",
    wallFront: "#2a2333",
    wallCap: "#3a2f2a",
    wallSideRgb: "34,28,42",
    wallCorner: "rgba(6,4,10,0.6)",
    tint: "#4a3358",
    tintAlpha: 0.34,
    accent: "#b48ac0",
    glow: "#c9a6ff",
    lightLevel: 0.36,
    vignette: 0.48,
    vignetteColor: "#050208",
    pulse: 0.12,
    detailDensity: 0.27,
    detailTint: "#8a6aa0",
    torchesPerRoom: 3,
    floorDim: 0.3,
    wallLift: 0.44,
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


// ---- the encounter REGION model (the roadmap's post-F30 granularity) ----
// A region is the encounter-identity unit of docs/blobrogue_CONTENT_ROADMAP_to100. The six
// pre-F30 regions map 1:1 onto the six curriculum biome bands; the four post-F30 regions of THE
// UNMAKING (Sump/Veinworks/Pale/Null Core) each span multiple floors and are the granularity the
// biome-selective encounter deck (roster.ts) keys off. This is DELIBERATELY coarser-below /
// finer-above than the palette biome ladder: the ladder is one terminal band (rendered as the
// Sump for wave 1), while regions name all four post-F30 spans. When a post-F30 region gets its
// own authored tile art, its palette graduates from REGION_PALETTES into a real biome band.
export type RegionId =
  | "amberwild" | "rootbound" | "sunless" | "deep" | "gilded" | "ember"
  | "sump" | "veinworks" | "pale" | "nullcore";

export interface Region {
  readonly id: RegionId;
  readonly name: string;
  readonly fromFloor: number;
  readonly toFloor: number | null; // null = terminal (holds forever)
}

export const REGIONS: readonly Region[] = [
  { id: "amberwild", name: "Amberwild", fromFloor: 1, toFloor: 5 },
  { id: "rootbound", name: "Rootbound Warrens", fromFloor: 6, toFloor: 10 },
  { id: "sunless", name: "Sunless Caves", fromFloor: 11, toFloor: 15 },
  { id: "deep", name: "The Deep", fromFloor: 16, toFloor: 20 },
  { id: "gilded", name: "Gilded Archive", fromFloor: 21, toFloor: 25 },
  { id: "ember", name: "Emberreach", fromFloor: 26, toFloor: 30 },
  // THE UNMAKING (post-F30) — the roadmap's four corrupted regions.
  { id: "sump", name: "The Sump", fromFloor: 31, toFloor: 50 },
  { id: "veinworks", name: "The Veinworks", fromFloor: 51, toFloor: 70 },
  { id: "pale", name: "The Pale", fromFloor: 71, toFloor: 90 },
  { id: "nullcore", name: "Null Core", fromFloor: 91, toFloor: null },
];

export function regionIndexForFloor(floor: number): number {
  const f = Math.max(1, Math.floor(floor));
  for (let i = REGIONS.length - 1; i >= 0; i--) {
    if (f >= REGIONS[i].fromFloor) return i;
  }
  return 0;
}

export function regionForFloor(floor: number): Region {
  return REGIONS[regionIndexForFloor(floor)];
}

// Authored post-F30 region palettes (the packet's OPEN ITEM). Sump reuses the terminal biome
// band's interim AD hexes (single source — the band IS the Sump render palette for wave 1). The
// other three are distinct placeholders marked TODO(AD-palette): not on the render path yet
// (wave 1 stops at F50), authored so the data exists when their regions get art + a contrast
// gate. Pre-F30 regions have no entry — their biome band already owns the palette.
export type RegionPalette = Pick<Biome, "floorA" | "floorB" | "wallFront" | "wallCap" | "bgColor" | "accent">;

export const REGION_PALETTES: Readonly<Partial<Record<RegionId, RegionPalette>>> = {
  // Sump — the AD's interim hexes (mirrors the terminal biome band above).
  sump: { bgColor: "#080610", floorA: "#16131a", floorB: "#1a1620", wallFront: "#2a2333", wallCap: "#3a2f2a", accent: "#b48ac0" },
  // TODO(AD-palette): Veinworks — resin/amber arteries; warm-corrupted circulatory red.
  veinworks: { bgColor: "#0c0605", floorA: "#1a1210", floorB: "#20160f", wallFront: "#3a221a", wallCap: "#4a2a1e", accent: "#d07a4a" },
  // TODO(AD-palette): The Pale — warmth/color draining out; approaching Null, near-grey.
  pale: { bgColor: "#0a0a0c", floorA: "#161618", floorB: "#1a1a1e", wallFront: "#2a2a30", wallCap: "#3a3a40", accent: "#9aa0aa" },
  // TODO(AD-palette): Null Core — subtraction complete; the source; near-black void-bright.
  nullcore: { bgColor: "#05030b", floorA: "#0a0714", floorB: "#0d0918", wallFront: "#241a44", wallCap: "#241a40", accent: "#ff4ad8" },
};

export function floorBannerText(floor: number, opts?: { isBoss?: boolean; isGauntlet?: boolean; isDescend?: boolean }): string {
  if (opts?.isGauntlet) return "MINIBOSS GAUNTLET";
  if (opts?.isBoss) return "BOSS FLOOR";
  // The region names the floor (authoritative below AND above F30, where four regions share one
  // render band); the biome band only sets the palette.
  const name = regionForFloor(floor).name.toUpperCase();
  if (opts?.isDescend) return `${name} · DOWN TO FLOOR ${floor}`;
  return `${name} · FLOOR ${floor}`;
}
