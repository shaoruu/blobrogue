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
    // Same living ecology as Amberwild, denser and darker — root-choked formation floors.
    name: "Rootbound Warrens",
    bgColor: "#0b0f0a",
    floorA: "#151b12",
    floorB: "#191f14",
    wallFront: "#20291a",
    wallCap: "#2e3c24",
    wallSideRgb: "26,32,20",
    wallCorner: "rgba(9,12,7,0.5)",
    tint: "#4a5c34",
    tintAlpha: 0.24,
    accent: "#9fbf5f",
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
    // Ordered amber-and-gold stacks — the Warden's archive of claimed space.
    name: "Gilded Archive",
    bgColor: "#120e08",
    floorA: "#1f1a10",
    floorB: "#242014",
    wallFront: "#302818",
    wallCap: "#4a3c20",
    wallSideRgb: "40,32,20",
    wallCorner: "rgba(14,11,6,0.5)",
    tint: "#8b6f2a",
    tintAlpha: 0.20,
    accent: "#ffd166",
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
