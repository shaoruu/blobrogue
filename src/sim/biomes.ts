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
  // ---- THE UNMAKING (post-F30): four corrupted regions, each its own biome band, 1:1 with
  // REGIONS. Warmth drains as you descend (Sump warm-corrupted -> Veinworks resin/amber ->
  // Pale near-grey subtraction -> Null Core void). Canonical AD palettes (validated for the
  // readability walkability gate: floorA sits 24-48L below wallCap in every region, and JET
  // stays dark-on-dark safe). Mood fields continue the ladder ramp (deeper = dimmer + more
  // vignette + busier detail; pulse dips in the Pale's calm, peaks in the Null's throb).
  {
    // Floors 31-50 — THE SUMP: everything drains together; warm/cold materials melt.
    name: "The Sump",
    tileKey: "nullvoid",
    bgColor: "#0c0a10",
    floorA: "#16131a",
    floorB: "#1a1620",
    wallFront: "#2a2333",
    wallCap: "#3a2f2a",
    wallSideRgb: "36,30,42",
    wallCorner: "rgba(6,5,10,0.55)",
    tint: "#4a3f52",
    tintAlpha: 0.30,
    accent: "#9c7a52",
    glow: "#b89a72",
    lightLevel: 0.31,
    vignette: 0.45,
    vignetteColor: "#050408",
    pulse: 0.06,
    detailDensity: 0.25,
    detailTint: "#6b5a4a",
    torchesPerRoom: 3,
    floorDim: 0.30,
    wallLift: 0.30,
  },
  {
    // Floors 51-70 — THE VEINWORKS: the corruption's circulatory system; resin/amber arteries.
    name: "The Veinworks",
    tileKey: "ember",
    bgColor: "#0a0710",
    floorA: "#14101c",
    floorB: "#181322",
    wallFront: "#281c34",
    wallCap: "#3d2a1e",
    wallSideRgb: "30,22,40",
    wallCorner: "rgba(5,3,10,0.55)",
    tint: "#5a3a4a",
    tintAlpha: 0.30,
    accent: "#ffb43b",
    glow: "#e8913b",
    lightLevel: 0.36,
    vignette: 0.48,
    vignetteColor: "#040208",
    pulse: 0.10,
    detailDensity: 0.28,
    detailTint: "#c77320",
    torchesPerRoom: 3,
    // Retuned up (was 0.30) so the flat (no-art) tier darkens this floor enough to clear the
    // walkability luma gate against the wall cap; the AD's authored hexes are untouched.
    floorDim: 0.46,
    wallLift: 0.40,
  },
  {
    // Floors 71-90 — THE PALE: warmth/color draining out; subtraction begins; near-grey.
    name: "The Pale",
    tileKey: "sunless",
    bgColor: "#12131a",
    floorA: "#1c1e26",
    floorB: "#22242e",
    wallFront: "#343842",
    wallCap: "#4a4e5a",
    wallSideRgb: "44,48,56",
    wallCorner: "rgba(10,11,16,0.5)",
    tint: "#5a6070",
    tintAlpha: 0.26,
    accent: "#c9c9de",
    glow: "#bfc6d6",
    lightLevel: 0.40,
    vignette: 0.52,
    vignetteColor: "#060810",
    pulse: 0.05,
    detailDensity: 0.30,
    detailTint: "#6b7082",
    torchesPerRoom: 3,
    floorDim: 0.30,
    wallLift: 0.30,
  },
  {
    // Floors 91-100 — NULL CORE: subtraction complete; the source; near-black, void-bright.
    // Terminal: the ladder holds here forever.
    name: "Null Core",
    tileKey: "nullvoid",
    bgColor: "#030208",
    floorA: "#08060f",
    floorB: "#0a0713",
    wallFront: "#1e1638",
    wallCap: "#241a40",
    wallSideRgb: "12,8,24",
    wallCorner: "rgba(1,0,4,0.65)",
    tint: "#4a1470",
    tintAlpha: 0.38,
    accent: "#ff4ad8",
    glow: "#d9a6ff",
    lightLevel: 0.44,
    vignette: 0.56,
    vignetteColor: "#010003",
    pulse: 0.14,
    detailDensity: 0.33,
    detailTint: "#ff4ad8",
    torchesPerRoom: 3,
    floorDim: 0.30,
    wallLift: 0.44,
  },
];

// The biome band ladder is now 1:1 with the encounter REGION ladder (six curriculum bands + THE
// UNMAKING's four post-F30 regions), so the band index IS the region index — one granularity for
// palette, pressure, hazards AND encounter identity.
export function biomeIndexForFloor(floor: number): number {
  return regionIndexForFloor(floor);
}

export function biomeForFloor(floor: number): Biome {
  return BIOMES[biomeIndexForFloor(floor)];
}

// How deep into its region a floor sits, 0..1 (region start -> 0, region end -> 1). The terminal
// region clamps at 1. Drives within-region escalation: hazard density, room-shape drama and
// ambience all thicken as the region's end approaches — the curriculum's teach -> remix -> prove
// ramp, expressed by the level itself.
export function biomeDepthForFloor(floor: number): number {
  const f = Math.max(1, Math.floor(floor));
  const region = regionForFloor(f);
  // Terminal region (Null Core, no upper bound): ramp over a nominal 10-floor span, then hold at 1.
  const end = region.toFloor ?? region.fromFloor + FLOORS_PER_BIOME * 2 - 1;
  if (end <= region.fromFloor) return 1;
  return Math.min(1, Math.max(0, (f - region.fromFloor) / (end - region.fromFloor)));
}


// ---- the encounter REGION model ----
// A region is the encounter-identity unit of docs/blobrogue_CONTENT_ROADMAP_to100. The ladder is
// now 1:1 with the biome PALETTE bands (BIOMES) above: six curriculum regions (Amberwild ->
// Emberreach) then THE UNMAKING's four post-F30 regions (Sump 31-50, Veinworks 51-70, Pale 71-90,
// Null Core 91-100). REGIONS[i] and BIOMES[i] describe the same span — REGIONS carries the floor
// ranges (driving biomeIndexForFloor / biomeDepthForFloor / the encounter deck), BIOMES carries
// the palette. The pre-F30 regions keep their 5-floor spans; the post-F30 regions span 20/20/20/10.
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

export interface ExpeditionDestination {
  readonly floor: number;
  readonly name: string | null;
}

export interface ExpeditionRegionFraming {
  readonly regionId: Extract<RegionId, "sump" | "veinworks" | "pale" | "nullcore">;
  readonly name: string;
  readonly entryTitle: string;
  readonly entryFlavor: string;
  readonly capstone: ExpeditionDestination;
}

// THE UNMAKING PROPER is the canonical post-F30 region ladder, not a second set of ranges.
// TODO(creative-director): finalize the entryTitle/entryFlavor copy for all four regions.
export const EXPEDITION_REGIONS: readonly ExpeditionRegionFraming[] = [
  {
    regionId: "sump",
    name: "THE SUMP",
    entryTitle: "THE SUMP",
    entryFlavor: "THE DRAINED DEEP",
    capstone: { floor: 50, name: "the Sump-Mother" },
  },
  {
    regionId: "veinworks",
    name: "THE VEINWORKS",
    entryTitle: "THE VEINWORKS",
    entryFlavor: "THE WORLD FORGETS ITS OWN VEINS",
    capstone: { floor: 65, name: null },
  },
  {
    regionId: "pale",
    name: "THE PALE",
    entryTitle: "THE PALE",
    entryFlavor: "ONLY THE CORE REMEMBERS",
    capstone: { floor: 80, name: "the Pale Throne" },
  },
  {
    regionId: "nullcore",
    name: "NULL CORE",
    entryTitle: "NULL CORE",
    entryFlavor: "THE SOURCE WAITS BELOW",
    capstone: { floor: 100, name: "the Unmaker" },
  },
];

export function expeditionRegionForFloor(floor: number): ExpeditionRegionFraming | null {
  const region = regionForFloor(floor);
  return EXPEDITION_REGIONS.find((framing) => framing.regionId === region.id) ?? null;
}

export function expeditionObjectiveForFloor(floor: number): string | null {
  const f = Math.max(1, Math.floor(floor));
  const framing = expeditionRegionForFloor(f);
  if (framing === null) return null;
  const destination = EXPEDITION_REGIONS
    .map((candidate) => candidate.capstone)
    .find((candidate) => candidate.floor >= f);
  if (destination === undefined) return `${framing.name} \u2014 descend toward the core`;
  const target = destination.name === null ? "the deep" : destination.name;
  return `${framing.name} \u2014 toward ${target} (F${destination.floor})`;
}

export function expeditionRegionEntryForFloor(floor: number): ExpeditionRegionFraming | null {
  const f = Math.max(1, Math.floor(floor));
  const region = regionForFloor(f);
  if (region.fromFloor !== f) return null;
  return EXPEDITION_REGIONS.find((framing) => framing.regionId === region.id) ?? null;
}

export function floorBannerText(floor: number, opts?: { isBoss?: boolean; isGauntlet?: boolean; isDescend?: boolean }): string {
  if (opts?.isGauntlet) return "MINIBOSS GAUNTLET";
  if (opts?.isBoss) return "BOSS FLOOR";
  const name = regionForFloor(floor).name.toUpperCase();
  if (opts?.isDescend) return `${name} · DOWN TO FLOOR ${floor}`;
  return `${name} · FLOOR ${floor}`;
}
