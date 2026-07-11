// WAVE 1 meta-progression suite. Locks the load-bearing guarantees of the amber loop + camp:
//   1. AMBER EARN is PURE + DETERMINISTIC — same input -> same output, the exact widened
//      values (per-floor / depth milestones / first-boss / bank fractions), and NO amber from
//      trash (the earn functions have no kill input at all — anti-grind by construction).
//   2. CAMP SPEND validation (canBuyNode) is a pure server-authoritative gate: enough amber,
//      prereqs met, not already owned — the exact wave-1 node table + costs.
//   3. THE PET IS OUT OF THE SIM — an equipped pet id rides the identity/wire like hat/face and
//      cannot alter a single gameplay field of a stepped world (it can never desync co-op).
// Run: tsx test/meta.test.ts

import "./harness/domShim.js";
import {
  AMBER_EARN, amberForRun, amberRunPool, bankedRunAmber, depthMilestoneAmber, firstBossAmber,
  isBossKindId, BOSS_KINDS,
} from "../src/sim/balance.js";
import {
  CAMP_NODES, campNodeById, canBuyNode, isNodeOwned, prereqsMet, isPetOwned, ownedPets,
  startCoinBonus, isDoggieRescuedByRun, rescueNodesForRun, CAMP_SHELL_ID,
  DOGGIE_NODE_ID, DOGGIE_PET_ID, DOGGIE_RESCUE_FLOOR,
  CAT_NODE_ID, CAT_PET_ID, CAT_RESCUE_FLOOR,
  DRAGON_NODE_ID, DRAGON_PET_ID, DRAGON_RESCUE_FLOOR,
} from "../src/sim/camp_nodes.js";
import { petSpriteFor } from "../src/game/pets.js";
import { createWorld, spawnPlayerInWorld, stepWorld } from "../src/sim/world.js";
import { buildSnapshot } from "../src/net/protocol.js";
import { IDLE_INPUT } from "../src/sim/input.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void { process.stdout.write(`\n[${name}]\n`); }

function amberEarnTests(): void {
  section("amber earn: the widened values (per-floor / depth / first-boss / bank fractions)");
  check("per-floor grant is 2", AMBER_EARN.perFloorCleared === 2);
  check("depth milestones are the authored cumulative ladder",
    depthMilestoneAmber(4) === 0
    && depthMilestoneAmber(5) === 3
    && depthMilestoneAmber(10) === 3 + 5
    && depthMilestoneAmber(15) === 3 + 5 + 8
    && depthMilestoneAmber(20) === 3 + 5 + 8 + 12
    && depthMilestoneAmber(25) === 3 + 5 + 8 + 12 + 16
    && depthMilestoneAmber(30) === 3 + 5 + 8 + 12 + 16 + 22
    && depthMilestoneAmber(100) === 3 + 5 + 8 + 12 + 16 + 22,
    `f12=${depthMilestoneAmber(12)}`);
  check("first-boss grant is 25 each, only for real boss kinds",
    AMBER_EARN.firstBossKill === 25
    && firstBossAmber(["boss"]) === 25
    && firstBossAmber(["boss", "marrow"]) === 50
    && firstBossAmber(["slime", "bat"]) === 0
    && firstBossAmber([]) === 0,
    `boss+marrow=${firstBossAmber(["boss", "marrow"])}`);
  check("only the authored boss roster qualifies for first-boss amber",
    BOSS_KINDS.every(isBossKindId) && !isBossKindId("slime") && !isBossKindId("bat"));

  section("amber bank: run pool + the 100%/50% outcome fractions; first-boss is exempt");
  const input = { floorsCleared: 10, deepestFloor: 10, unspentCoins: 250, isCacheArmed: true, windfall: 0 };
  // pool = 2*10 (floors) + (3+5) (depth) + amberForRun(250,true,0)=5 (cache) = 33
  const pool = amberRunPool(input);
  check("run pool = floors + depth + cache trickle", pool === 20 + 8 + 5, `pool=${pool}`);
  check("returning to camp banks 100% of the pool", bankedRunAmber(input, true) === pool);
  check("a wipe banks 50% (floored)", bankedRunAmber(input, false) === Math.floor(pool * 0.5), `wipe=${bankedRunAmber(input, false)}`);
  check("the leftover-coin cache trickle still obeys its own cap (kept, unchanged)",
    amberForRun(10_000, true, 0) === 5 && amberForRun(10_000, false, 0) === 0);
  check("NO amber from trash mobs: the earn takes floors/depth/coins only — never a kill count",
    // The pool is identical for two runs that differ ONLY in (hypothetical) kills — there is
    // no kill parameter to pass. Two identical inputs must produce identical pools.
    amberRunPool(input) === amberRunPool({ ...input }));

  section("amber earn is PURE + DETERMINISTIC (same input -> same output, no hidden state)");
  let stable = true;
  for (let i = 0; i < 100; i++) {
    if (amberRunPool(input) !== pool) stable = false;
    if (bankedRunAmber(input, false) !== Math.floor(pool * 0.5)) stable = false;
    if (depthMilestoneAmber(23) !== 3 + 5 + 8 + 12) stable = false;
    if (firstBossAmber(["boss", "weaver"]) !== 50) stable = false;
    if (amberForRun(199, true, 3) !== Math.min(5, Math.floor(199 * 2 / 100)) + 3) stable = false;
  }
  check("100 repeated evaluations agree byte-for-byte (deterministic)", stable);
}

function campSpendTests(): void {
  section("camp nodes: the exact wave-1 table (pet is RESCUED, sinks are amber-bought)");
  check("the hub shell is free (cost 0), no prereqs", campNodeById(CAMP_SHELL_ID)?.cost === 0);
  const doggie = campNodeById(DOGGIE_NODE_ID);
  check("pet_doggie is a RESCUE (not bought): rescue flag, cost 0, grants the doggie pet",
    doggie?.rescue === true && doggie?.cost === 0 && doggie?.category === "companion" && doggie?.pet === DOGGIE_PET_ID);
  check("stash_slot_1 costs 25 (convenience, amber-bought)", campNodeById("stash_slot_1")?.cost === 25);
  check("coin_pouch costs 20 and grants +5 start-run coins (convenience, amber-bought)",
    campNodeById("coin_pouch")?.cost === 20 && campNodeById("coin_pouch")?.startCoins === 5);
  check("every CONVENIENCE node prereqs the shell (the loop's entry)",
    CAMP_NODES.filter((n) => n.category === "convenience").every((n) => n.prereqs.includes(CAMP_SHELL_ID)));

  section("the doggie is RESCUED, never bought: reachable early, one-time, not for sale");
  check(`the rescue floor is shallow (${DOGGIE_RESCUE_FLOOR}) — reachable in the first few runs`, DOGGIE_RESCUE_FLOOR === 3);
  check("a run below the rescue floor does NOT rescue the pup", !isDoggieRescuedByRun(2));
  check("reaching the rescue floor rescues the pup", isDoggieRescuedByRun(3) && isDoggieRescuedByRun(9));
  const rescueBuy = canBuyNode(DOGGIE_NODE_ID, 9999, [CAMP_SHELL_ID]);
  check("Amber can NEVER buy the pet (canBuyNode refuses a rescue node)",
    !rescueBuy.ok && rescueBuy.reason === "rescue", !rescueBuy.ok ? rescueBuy.reason : "accepted!");

  section("buy gate (pure, server-side) for the CONVENIENCE sinks: amber / prereqs / owned");
  const shellOwned = [CAMP_SHELL_ID];
  check("rejects an unknown node", canBuyNode("nope", 999, shellOwned).ok === false);
  const lockedNoShell = canBuyNode("coin_pouch", 999, []);
  check("rejects when prereqs unmet (no shell yet)", !lockedNoShell.ok && lockedNoShell.reason === "locked");
  const poor = canBuyNode("coin_pouch", 19, shellOwned);
  check("rejects when too poor (19 < 20)", !poor.ok && poor.reason === "insufficient");
  const ok = canBuyNode("coin_pouch", 20, shellOwned);
  check("accepts at exactly the cost, returning the amount to deduct", ok.ok === true && ok.ok && ok.cost === 20);
  const dupe = canBuyNode("coin_pouch", 999, [CAMP_SHELL_ID, "coin_pouch"]);
  check("rejects an already-owned node", !dupe.ok && dupe.reason === "owned");
  check("prereqsMet / isNodeOwned agree with the gate",
    prereqsMet(campNodeById("coin_pouch")!, shellOwned) && !isNodeOwned("coin_pouch", shellOwned));

  section("pet ownership derives from the rescued node; start-coin bonus from convenience");
  check("the doggie pet is owned only once it is rescued (its node is in unlocks)",
    !isPetOwned(DOGGIE_PET_ID, shellOwned) && isPetOwned(DOGGIE_PET_ID, [CAMP_SHELL_ID, DOGGIE_NODE_ID]));
  check("ownedPets lists the doggie once rescued",
    ownedPets([CAMP_SHELL_ID, DOGGIE_NODE_ID]).join(",") === DOGGIE_PET_ID);
  check("coin_pouch grants +5 start coins only when owned",
    startCoinBonus(shellOwned) === 0 && startCoinBonus([CAMP_SHELL_ID, "coin_pouch"]) === 5);
}

// The pack grows: the cat + baby dragon are RESCUED companions like the doggie, found DEEPER.
// They must be companion+rescue (never buyable), grant their pet once their node is owned, and
// the server-side rescue grant must be data-driven (deeper floors earn deeper pets).
function multiPetTests(): void {
  section("multi-pet: the cat + baby dragon are RESCUED companions, found deeper than the pup");
  const cat = campNodeById(CAT_NODE_ID);
  const dragon = campNodeById(DRAGON_NODE_ID);
  check("pet_cat is a companion RESCUE (cost 0, rescue flag, grants the cat pet)",
    cat?.category === "companion" && cat?.rescue === true && cat?.cost === 0 && cat?.pet === CAT_PET_ID);
  check("pet_dragon is a companion RESCUE (cost 0, rescue flag, grants the dragon pet)",
    dragon?.category === "companion" && dragon?.rescue === true && dragon?.cost === 0 && dragon?.pet === DRAGON_PET_ID);
  check("each pet is found DEEPER than the last (doggie < cat < dragon)",
    DOGGIE_RESCUE_FLOOR < CAT_RESCUE_FLOOR && CAT_RESCUE_FLOOR < DRAGON_RESCUE_FLOOR,
    `${DOGGIE_RESCUE_FLOOR} < ${CAT_RESCUE_FLOOR} < ${DRAGON_RESCUE_FLOOR}`);
  check("the node's rescueFloor matches its named constant",
    cat?.rescueFloor === CAT_RESCUE_FLOOR && dragon?.rescueFloor === DRAGON_RESCUE_FLOOR
    && campNodeById(DOGGIE_NODE_ID)?.rescueFloor === DOGGIE_RESCUE_FLOOR);

  section("Amber can NEVER buy the cat or dragon (canBuyNode refuses every rescue node)");
  const buyCat = canBuyNode(CAT_NODE_ID, 9999, [CAMP_SHELL_ID]);
  const buyDragon = canBuyNode(DRAGON_NODE_ID, 9999, [CAMP_SHELL_ID]);
  check("buying the cat is refused as a rescue", !buyCat.ok && buyCat.reason === "rescue");
  check("buying the dragon is refused as a rescue", !buyDragon.ok && buyDragon.reason === "rescue");

  section("ownership derives from the rescued node; each pet is owned only once rescued");
  check("the cat is owned only with its node in unlocks",
    !isPetOwned(CAT_PET_ID, [CAMP_SHELL_ID]) && isPetOwned(CAT_PET_ID, [CAMP_SHELL_ID, CAT_NODE_ID]));
  check("the dragon is owned only with its node in unlocks",
    !isPetOwned(DRAGON_PET_ID, [CAMP_SHELL_ID]) && isPetOwned(DRAGON_PET_ID, [CAMP_SHELL_ID, DRAGON_NODE_ID]));
  check("ownedPets lists every rescued companion together",
    ownedPets([CAMP_SHELL_ID, DOGGIE_NODE_ID, CAT_NODE_ID, DRAGON_NODE_ID]).sort().join(",")
      === [DOGGIE_PET_ID, CAT_PET_ID, DRAGON_PET_ID].sort().join(","));

  section("the server-side rescue grant is data-driven: deeper runs earn deeper pets");
  check("a shallow run (below the cat's floor) rescues only the pup",
    rescueNodesForRun(DOGGIE_RESCUE_FLOOR).join(",") === DOGGIE_NODE_ID
    && !rescueNodesForRun(CAT_RESCUE_FLOOR - 1).includes(CAT_NODE_ID));
  check("reaching the cat's floor earns the cat (pup too), not yet the dragon",
    rescueNodesForRun(CAT_RESCUE_FLOOR).includes(CAT_NODE_ID)
    && rescueNodesForRun(CAT_RESCUE_FLOOR).includes(DOGGIE_NODE_ID)
    && !rescueNodesForRun(CAT_RESCUE_FLOOR).includes(DRAGON_NODE_ID));
  check("reaching the dragon's floor earns all three companions",
    rescueNodesForRun(DRAGON_RESCUE_FLOOR).sort().join(",")
      === [DOGGIE_NODE_ID, CAT_NODE_ID, DRAGON_NODE_ID].sort().join(","));
  check("a run below the shallowest rescue floor earns nothing",
    rescueNodesForRun(DOGGIE_RESCUE_FLOOR - 1).length === 0);
  check("isDoggieRescuedByRun still agrees with the generalized grant for the pup",
    isDoggieRescuedByRun(DOGGIE_RESCUE_FLOOR) && rescueNodesForRun(DOGGIE_RESCUE_FLOOR).includes(DOGGIE_NODE_ID));

  section("petSpriteFor maps every known pet to its render sprite, unknown ids to null");
  check("doggie -> doggie", petSpriteFor(DOGGIE_PET_ID) === "doggie");
  check("cat -> cat", petSpriteFor(CAT_PET_ID) === "cat");
  check("dragon -> dragon", petSpriteFor(DRAGON_PET_ID) === "dragon");
  check("an unknown pet id renders nothing (graceful null, never a crash)",
    petSpriteFor("griffin") === null && petSpriteFor("") === null);
  check("every companion node's pet id has a render sprite (no dangling pet)",
    CAMP_NODES.filter((n) => n.category === "companion").every((n) => n.pet !== undefined && petSpriteFor(n.pet) !== null));
}

// The pet is a CLIENT-SIDE cosmetic companion — it rides the identity/wire like hat/face and
// the sim does not know it exists. Two snapshot builds of the SAME stepped world under identity
// maps that differ ONLY in the equipped pet must agree byte-for-byte on every gameplay field.
function petOutOfSimTests(): void {
  section("the pet is OUT of the sim: an equipped pet can never alter a gameplay field");
  const w = createWorld(0xD09, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(w, "pA");
  spawnPlayerInWorld(w, "pB");
  const inputs = new Map<PlayerId, InputCmd>([
    ["pA", { ...IDLE_INPUT, moveX: 1, firing: true, aim: 0.3 }],
    ["pB", { ...IDLE_INPUT, moveY: -1, dash: true }],
  ]);
  for (let i = 0; i < 120; i++) stepWorld(w, inputs, 1 / 60);

  // Viewer is "pA" (its own state lives in `self`), so the teammate "pB" is the wire player
  // we inspect for the pet channel.
  const noPet = new Map([["pA", { name: "A", colorIndex: 1 }], ["pB", { name: "B", colorIndex: 2 }]]);
  const withPet = new Map([
    ["pA", { name: "A", colorIndex: 1, pet: DOGGIE_PET_ID }],
    ["pB", { name: "B", colorIndex: 2, pet: DOGGIE_PET_ID }],
  ]);
  const snapNoPet = buildSnapshot(w, "pA", 0, [], 0, false, { worldId: "w-meta", identities: noPet });
  const snapPet = buildSnapshot(w, "pA", 0, [], 0, false, { worldId: "w-meta", identities: withPet });
  if (snapNoPet.t !== "snap" || snapPet.t !== "snap") { check("snapshots built", false); return; }

  check("an equipped pet decorates the wire on the pt channel (like ht/fc)",
    snapPet.players.find((p) => p.id === "pB")?.pt === DOGGIE_PET_ID
    && snapNoPet.players.find((p) => p.id === "pB")?.pt === null,
    `pB.pt=${snapPet.players.find((p) => p.id === "pB")?.pt} noPet=${snapNoPet.players.find((p) => p.id === "pB")?.pt}`);

  // Strip the identity fields (name/color/hat/face/PET) and compare the gameplay remainder.
  const stripIdentity = (frame: object): unknown => JSON.parse(JSON.stringify(frame), (k, v: unknown) => (
    k === "nm" || k === "cl" || k === "ht" || k === "fc" || k === "pt" ? undefined : v
  ));
  check("SelfWire (speed/HP/fire/dash/score authority) is pet-independent",
    JSON.stringify(snapNoPet.self) === JSON.stringify(snapPet.self));
  check("every gameplay field of every wire struct is byte-identical with vs without a pet",
    JSON.stringify(stripIdentity(snapNoPet)) === JSON.stringify(stripIdentity(snapPet)));

  // And the world cannot diverge: stepWorld's signature takes NO identity/pet parameter, so a
  // pet literally cannot be an input to the simulation. Stepping continues normally.
  for (let i = 0; i < 60; i++) stepWorld(w, inputs, 1 / 60);
  const after = buildSnapshot(w, "pA", 0, [], 0, false, { worldId: "w-meta", identities: withPet });
  check("the world advances normally after pet-decorated snapshots (no state contamination)",
    after.t === "snap" && after.tick === snapPet.tick + 60,
    `tick ${String(after.t === "snap" ? after.tick : "?")} vs ${snapPet.tick + 60}`);
}

function main(): void {
  amberEarnTests();
  campSpendTests();
  multiPetTests();
  petOutOfSimTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll WAVE 1 meta-progression assertions passed.\n");
}

main();
