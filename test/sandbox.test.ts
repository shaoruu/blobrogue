import assert from "node:assert/strict";
import { ENEMY_KINDS } from "../src/dev/sandboxCatalog.js";
import {
  BOSS_FLOORS,
  BOSS_KINDS,
  bossKindForFloor,
} from "../src/sim/enemies.js";

const sandboxKinds = new Set(ENEMY_KINDS);
for (const kind of BOSS_KINDS) {
  assert.ok(sandboxKinds.has(kind), `${kind} is missing from the dev spawn catalog`);
}

const canonicalKinds = BOSS_FLOORS.map((floor) => {
  const kind = bossKindForFloor(0, floor);
  assert.notEqual(kind, null, `F${floor} has no canonical boss`);
  return kind;
});

assert.equal(new Set(BOSS_FLOORS).size, BOSS_FLOORS.length, "canonical boss floors must be unique");
assert.equal(new Set(canonicalKinds).size, canonicalKinds.length, "canonical boss floors must map to unique bosses");
assert.deepEqual(
  new Set(canonicalKinds),
  new Set(BOSS_KINDS),
  "canonical boss floors must cover every boss fight kind",
);

process.stdout.write("PASS dev sandbox boss catalogs stay source-of-truth driven\n");
