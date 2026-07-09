export interface Biome {
  readonly name: string;
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
}

// The canonical 30-floor spine (docs/specs/blobrogue_ENCOUNTER_CURRICULUM_spec.md §0):
// six regions of five floors, each closed by its milestone — Amberwild/Slime King,
// Rootbound Warrens/the F10 Miniboss Gauntlet, Sunless Caves/Marrow, The Deep/Weaver,
// Gilded Archive/Warden, Emberreach/Hollow Choir. Past F30 the bands cycle.
const FLOORS_PER_BIOME = 5;

export const BIOMES: readonly Biome[] = [
  {
    name: "Amberwild",
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
  },
  {
    // Same living ecology as Amberwild, denser and darker — the accepted lane is deep
    // GREEN-BROWN braided roots threaded with amber channels (the accent).
    name: "Rootbound Warrens",
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
  },
  {
    name: "Sunless Caves",
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
  },
  {
    name: "The Deep",
    bgColor: "#0e0b1a",
    floorA: "#171227",
    floorB: "#1b1530",
    wallFront: "#241a3a",
    wallCap: "#2f2350",
    wallSideRgb: "27,21,48",
    wallCorner: "rgba(9,6,18,0.5)",
    tint: "#3d2a5c",
    tintAlpha: 0.10,
    accent: "#a24bff",
  },
  {
    // The accepted lane: RIGID amber/brass + cold mineral — dead honey and tarnished
    // metal, order turned to imprisonment (never the Camp's warm gold).
    name: "Gilded Archive",
    bgColor: "#100e09",
    floorA: "#1d1a11",
    floorB: "#222016",
    wallFront: "#2d2819",
    wallCap: "#453c24",
    wallSideRgb: "38,33,22",
    wallCorner: "rgba(13,11,7,0.5)",
    tint: "#7d6a3a",
    tintAlpha: 0.20,
    accent: "#e8c265",
  },
  {
    name: "Emberreach",
    bgColor: "#120a08",
    floorA: "#1f1410",
    floorB: "#241816",
    wallFront: "#301c14",
    wallCap: "#4a2820",
    wallSideRgb: "40,24,18",
    wallCorner: "rgba(14,8,6,0.5)",
    tint: "#8b3a20",
    tintAlpha: 0.24,
    accent: "#ffb43b",
  },
];

export function biomeForFloor(floor: number): Biome {
  const f = Math.max(1, Math.floor(floor));
  const index = Math.floor((f - 1) / FLOORS_PER_BIOME) % BIOMES.length;
  return BIOMES[index];
}

export function biomeIndexForFloor(floor: number): number {
  const f = Math.max(1, Math.floor(floor));
  return Math.floor((f - 1) / FLOORS_PER_BIOME) % BIOMES.length;
}

export function floorBannerText(floor: number, opts?: { isBoss?: boolean; isGauntlet?: boolean; isDescend?: boolean }): string {
  if (opts?.isGauntlet) return "MINIBOSS GAUNTLET";
  if (opts?.isBoss) return "BOSS FLOOR";
  const name = biomeForFloor(floor).name.toUpperCase();
  if (opts?.isDescend) return `${name} · DOWN TO FLOOR ${floor}`;
  return `${name} · FLOOR ${floor}`;
}
