import type { EnemyKind } from "../sim/types.js";
import { BOSS_KINDS as BOSS_FIGHT_KINDS } from "../sim/enemies.js";

const REGULAR_KINDS: readonly EnemyKind[] = [
  "slime", "bat", "skeleton", "ghost", "spitter", "charger", "burrower", "orbiter", "shielder",
];

export const ENEMY_KINDS: readonly EnemyKind[] = [
  ...new Set<EnemyKind>([...REGULAR_KINDS, ...BOSS_FIGHT_KINDS]),
];
