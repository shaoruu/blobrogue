import {
  chooseBlessingInWorld,
  createWorld,
  isPvpDraftRuntime,
  removePlayerFromWorld,
  setPlayerAbsence,
  spawnPlayerInWorld,
  stepWorld,
} from "../src/sim/world.js";
import type { PlayerSim, WorldState } from "../src/sim/world.js";
import {
  PVP,
  pvpDraftEveryTicks,
  pvpDraftOfferTicks,
  pvpDraftSeed,
  pvpBlessingBlacklist,
} from "../src/sim/pvp.js";
import {
  isPvpBlessingId,
  itemById,
  itemLevelsOf,
  itemMaxLevel,
  rollPvpDraftChoicesWith,
} from "../src/sim/items.js";
import type { SimEvent } from "../src/sim/events.js";
import type { InputCmd } from "../src/sim/input.js";
import { Rng } from "../src/sim/rng.js";
import { PRIVATE_DRAFT_PVP_POLICY } from "../src/net/pvpPolicy.js";

let passed = 0;
let failed = 0;

function check(name: string, isPassing: boolean, detail = ""): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? ` — ${detail}` : ""}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
}

function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

const DT = 1 / 20;

function idle(overrides: Partial<InputCmd> = {}): InputCmd {
  return {
    seq: 0,
    moveX: 0,
    moveY: 0,
    aim: 0,
    firing: false,
    dash: false,
    ...overrides,
  };
}

function draftWorld(
  seed: number,
  ids: readonly string[],
  policy: string | null = PRIVATE_DRAFT_PVP_POLICY,
): WorldState {
  const world = createWorld(seed, 1, {
    mode: "pvp",
    isShared: true,
    skipLocalPlayer: true,
    pvpPolicy: policy,
  });
  for (const id of ids) spawnPlayerInWorld(world, id);
  return world;
}

function clearProtection(player: PlayerSim): void {
  player.invuln = 0;
  player.spawnGraceT = 0;
  player.spawnShieldT = 0;
  player.spawnProtectionStartedTick = 0;
  player.spawnHardGraceEndsAtTick = 0;
  player.spawnShieldEndsAtTick = 0;
}

function advanceToLive(world: WorldState): void {
  let guard = 0;
  while (world.match?.phase !== "live" && guard++ < 5000) stepWorld(world, new Map(), DT);
  for (const player of world.players.values()) clearProtection(player);
}

function stepCollect(
  world: WorldState,
  ticks: number,
  inputs: Map<string, InputCmd> = new Map(),
): SimEvent[] {
  const events: SimEvent[] = [];
  for (let tick = 0; tick < ticks; tick++) events.push(...stepWorld(world, inputs, DT));
  return events;
}

function offerEvents(events: readonly SimEvent[]): Array<Extract<SimEvent, { t: "offerBlessing" }>> {
  return events.filter(
    (event): event is Extract<SimEvent, { t: "offerBlessing" }> => event.t === "offerBlessing",
  );
}

section("policy authority");
{
  const canonical = draftWorld(1, ["p1", "p2"]);
  const missing = draftWorld(2, ["p1", "p2"], null);
  const unsupported = draftWorld(3, ["p1", "p2"], "public_draft_v1");
  const coop = createWorld(4, 1, {
    isShared: true,
    skipLocalPlayer: true,
    pvpPolicy: PRIVATE_DRAFT_PVP_POLICY,
  });
  check("private_draft_v1 is the sole runtime switch",
    isPvpDraftRuntime(canonical)
    && !isPvpDraftRuntime(missing)
    && !isPvpDraftRuntime(unsupported)
    && !isPvpDraftRuntime(coop));
  for (const world of [missing, unsupported]) {
    advanceToLive(world);
    for (const player of world.players.values()) {
      player.pvpDraftFrags = PVP.draftEveryFrags;
      player.pvpDraftActiveTicks = pvpDraftEveryTicks();
    }
    check(`${world.pvpPolicy ?? "null"} emits zero drafts`,
      offerEvents(stepCollect(world, 1)).length === 0 && world.pendingBlessings.size === 0);
  }
}

section("exact active cadence and deterministic concurrency");
for (const count of [2, 4, 6]) {
  const ids = Array.from({ length: count }, (_, index) => `p${index + 1}`);
  const world = draftWorld(100 + count, ids);
  advanceToLive(world);
  const before = stepCollect(world, pvpDraftEveryTicks() - 1);
  const due = stepCollect(world, 1);
  const offers = offerEvents(due);
  check(`${count}p has no time offer before tick 900`, offerEvents(before).length === 0);
  check(`${count}p tick 900 raises one isolated offer per player`,
    offers.map((event) => event.pid).join(",") === ids.join(",")
    && world.pendingBlessings.size === count);
}

section("frag/time dedup and re-arm");
{
  const world = draftWorld(200, ["p1", "p2"]);
  advanceToLive(world);
  const scorer = world.players.get("p1")!;
  const other = world.players.get("p2")!;
  scorer.pvpDraftFrags = PVP.draftEveryFrags;
  scorer.pvpDraftActiveTicks = pvpDraftEveryTicks() - 1;
  const events = stepCollect(world, 1);
  const triggers = events.filter(
    (event): event is Extract<SimEvent, { t: "pvpDraftTriggered" }> =>
      event.t === "pvpDraftTriggered",
  );
  check("frag and clock on one tick produce exactly one dedup offer",
    offerEvents(events).length === 1
    && triggers.length === 1
    && triggers[0].pid === "p1"
    && triggers[0].source === "dedup");
  check("both cadence debts reset together",
    scorer.pvpDraftFrags === 0
    && scorer.pvpDraftActiveTicks === 0
    && other.pvpDraftActiveTicks === 1);
  const item = itemById(PVP.blessingPool[0])!;
  chooseBlessingInWorld(world, "p1", item);
  stepCollect(world, pvpDraftEveryTicks() - 1);
  check("resolution re-arms a full cadence with no immediate catch-up",
    !world.pendingBlessings.has("p1") && scorer.pvpDraftActiveTicks === pvpDraftEveryTicks() - 1);
  check("the next active tick raises the next offer",
    offerEvents(stepCollect(world, 1)).some((event) => event.pid === "p1"));
}

section("joins, absence, and present-only comeback");
{
  const world = draftWorld(300, ["p1", "p2", "p3", "p4", "away"]);
  advanceToLive(world);
  stepCollect(world, 200);
  spawnPlayerInWorld(world, "join");
  check("mid-match join starts with zero cadence debt",
    world.players.get("join")?.pvpDraftActiveTicks === 0);
  const absent = world.players.get("away")!;
  const beforeAbsence = absent.pvpDraftActiveTicks;
  setPlayerAbsence(world, "away", true);
  stepCollect(world, 100);
  check("absence accumulates no cadence backfill",
    absent.pvpDraftActiveTicks === beforeAbsence);
  setPlayerAbsence(world, "away", false);
  stepCollect(world, 1);
  check("reconnect resumes only the next active tick",
    absent.pvpDraftActiveTicks === beforeAbsence + 1);

  world.match!.scores.set("away", -100);
  world.match!.scores.set("p1", 0);
  world.match!.scores.set("p2", 1);
  world.match!.scores.set("p3", 2);
  world.match!.scores.set("p4", 3);
  world.match!.scores.set("join", 4);
  setPlayerAbsence(world, "away", true);
  const p2 = world.players.get("p2")!;
  p2.pvpDraftFrags = PVP.draftEveryFrags;
  const trigger = stepCollect(world, 1).find(
    (event): event is Extract<SimEvent, { t: "pvpDraftTriggered" }> =>
      event.t === "pvpDraftTriggered" && event.pid === "p2",
  );
  check("absent reserved seats do not displace the present bottom third",
    trigger?.comeback === true);
}

section("offer lifetime, death, reconnect, and isolation");
{
  const world = draftWorld(400, ["p1", "p2", "p3"]);
  advanceToLive(world);
  for (const player of world.players.values()) player.pvpDraftFrags = PVP.draftEveryFrags;
  stepCollect(world, 1);
  const p1 = world.players.get("p1")!;
  const p2 = world.players.get("p2")!;
  const p3 = world.players.get("p3")!;
  const p1Item = itemById(PVP.blessingPool[0])!;
  chooseBlessingInWorld(world, "p1", p1Item);
  check("one pick cannot clear another player's offer",
    !world.pendingBlessings.has("p1")
    && world.pendingBlessings.has("p2")
    && world.pendingBlessings.has("p3"));

  p2.hp = 0;
  p2.respawnT = 2;
  const p2Item = itemById(PVP.blessingPool[1])!;
  const pickedDead = chooseBlessingInWorld(world, "p2", p2Item);
  check("death preserves the offer and a safe stat-only pick resolves while dead",
    pickedDead.some((event) => event.t === "pvpDraftPicked")
    && p2.hp === 0
    && p2.ownedItemIds.filter((id) => id === p2Item.id).length === 1
    && !world.pendingBlessings.has("p2"));
  stepCollect(world, 3);
  check("respawn releases the pause without duplicating the pick",
    p2.hp === PVP.maxHp
    && p2.ownedItemIds.filter((id) => id === p2Item.id).length === 1
    && !world.pendingBlessings.has("p2"));

  const remainingBefore = p3.pvpDraftOfferTicksLeft;
  setPlayerAbsence(world, "p3", true);
  stepCollect(world, 50);
  check("an absent chooser keeps the same offer and remaining duration",
    world.pendingBlessings.has("p3")
    && p3.pvpDraftOfferTicksLeft === remainingBefore);
  setPlayerAbsence(world, "p3", false);
  p3.pvpDraftOfferTicksLeft = 1;
  const expiry = stepCollect(world, 1);
  check("expiry is deterministic and clears only its owner",
    !world.pendingBlessings.has("p3")
    && expiry.some((event) => event.t === "pvpDraftResolved" && event.pid === "p3" && event.outcome === "expiry"));
  setPlayerAbsence(world, "p3", true);
  setPlayerAbsence(world, "p3", false);
  check("an expired offer never resurrects on reconnect",
    !world.pendingBlessings.has("p3"));
  check("PVP offer TTL is exactly 60 active seconds",
    pvpDraftOfferTicks() === 1200 && PVP.draftOfferSec === 60);
  check("offer resolution leaves cadence re-armed at zero",
    p1.pvpDraftActiveTicks > 0 && p2.pvpDraftActiveTicks > 0);
}

section("minimum-present freeze");
{
  const world = draftWorld(500, ["p1", "p2"]);
  advanceToLive(world);
  const p1 = world.players.get("p1")!;
  const p2 = world.players.get("p2")!;
  p1.pvpDraftActiveTicks = 600;
  p1.pvpDraftFrags = PVP.draftEveryFrags;
  stepCollect(world, 1);
  const offerTicks = p1.pvpDraftOfferTicksLeft;
  setPlayerAbsence(world, "p2", true);
  stepCollect(world, 400);
  check("cadence and pending expiry freeze below two present players",
    p1.pvpDraftActiveTicks === 0 && p1.pvpDraftOfferTicksLeft === offerTicks);
  setPlayerAbsence(world, "p2", false);
  stepCollect(world, 1);
  check("reconnect resumes one remaining-duration tick without catch-up",
    p1.pvpDraftOfferTicksLeft === offerTicks - 1);
}

section("chooser input pause and damageability");
{
  const world = draftWorld(600, ["p1", "p2"]);
  advanceToLive(world);
  const chooser = world.players.get("p1")!;
  const attacker = world.players.get("p2")!;
  chooser.pvpDraftFrags = PVP.draftEveryFrags;
  stepCollect(world, 1);
  chooser.x = 360;
  chooser.y = 216;
  attacker.x = 300;
  attacker.y = 216;
  clearProtection(chooser);
  clearProtection(attacker);
  attacker.weapon = "railgun";
  attacker.ownedWeapons = ["railgun"];
  const xBefore = chooser.x;
  const hpBefore = chooser.hp;
  stepCollect(world, 1, new Map([
    ["p1", idle({ moveX: 1, firing: true, dash: true })],
  ]));
  check("only chooser input is paused", chooser.x === xBefore);
  stepCollect(world, 12, new Map([
    ["p1", idle({ moveX: 1, firing: true, dash: true })],
    ["p2", idle({ firing: true, aim: 0 })],
  ]));
  check("chooser remains damageable while selecting", chooser.hp < hpBefore);
  check("paused chooser cannot create a shot", !world.bullets.some((bullet) => bullet.owner === "p1"));
}

section("match lifecycle clears offers and drafted builds");
{
  const noContest = draftWorld(700, ["p1", "p2"]);
  advanceToLive(noContest);
  const survivor = noContest.players.get("p1")!;
  survivor.pvpDraftFrags = PVP.draftEveryFrags;
  stepCollect(noContest, 1);
  chooseBlessingInWorld(noContest, "p1", itemById(PVP.blessingPool[0])!);
  noContest.players.get("p2")!.pvpDraftFrags = PVP.draftEveryFrags;
  stepCollect(noContest, 1);
  const leaveEvents: SimEvent[] = [];
  removePlayerFromWorld(noContest, "p2", leaveEvents);
  check("final leave no-contest clears every survivor offer and build",
    noContest.match?.phase === "lobby"
    && noContest.pendingBlessings.size === 0
    && survivor.ownedItemIds.length === 0
    && survivor.pvpDraftOrdinal === 0);

  const matchOver = draftWorld(701, ["p1", "p2"]);
  advanceToLive(matchOver);
  const winner = matchOver.players.get("p1")!;
  winner.pvpDraftFrags = PVP.draftEveryFrags;
  stepCollect(matchOver, 1);
  chooseBlessingInWorld(matchOver, "p1", itemById(PVP.blessingPool[0])!);
  matchOver.players.get("p2")!.pvpDraftFrags = PVP.draftEveryFrags;
  stepCollect(matchOver, 1);
  matchOver.match!.scores.set("p1", matchOver.match!.fragLimit);
  stepCollect(matchOver, 1);
  check("match-over clears every offer and drafted build",
    matchOver.match?.phase === "over"
    && matchOver.pendingBlessings.size === 0
    && [...matchOver.players.values()].every((player) => player.ownedItemIds.length === 0));
}

section("10k deterministic offer seeds");
{
  const excluded = [
    "incendiary_rounds",
    "cryo_coating",
    "static_charge",
    "elementalist",
    "frostbite",
    "glass_cannon",
    "overload",
    "featherweight",
  ];
  check("dead status and erased-HP-cost picks are excluded",
    excluded.every((id) => !isPvpBlessingId(id) && !PVP.blessingPool.includes(id)));
  check("the locked blacklist remains excluded",
    pvpBlessingBlacklist.every((id) => !isPvpBlessingId(id)));
  let normalRare = 0;
  let comebackRare = 0;
  let slots = 0;
  let isClean = true;
  const seen = new Set<string>();
  for (let seed = 0; seed < 10_000; seed++) {
    const normalRng = new Rng(pvpDraftSeed(seed, "p1", 900, 1));
    const comebackRng = new Rng(pvpDraftSeed(seed, "p1", 900, 1));
    const normal = rollPvpDraftChoicesWith(3, () => normalRng.next(), [], { tierBump: 0 });
    const comeback = rollPvpDraftChoicesWith(3, () => comebackRng.next(), [], { tierBump: 1 });
    slots += normal.length;
    normalRare += normal.filter((item) => item.rarity === "rare").length;
    comebackRare += comeback.filter((item) => item.rarity === "rare").length;
    for (const item of normal) seen.add(item.id);
    if (normal.length !== 3
      || comeback.length !== 3
      || new Set(normal.map((item) => item.id)).size !== 3
      || normal.some((item) => !isPvpBlessingId(item.id))
      || comeback.some((item) => !isPvpBlessingId(item.id))) {
      isClean = false;
    }
  }
  const normalRate = normalRare / slots;
  const comebackRate = comebackRare / slots;
  check("10k offers are distinct, legal, and cover the entire pool",
    isClean && seen.size === PVP.blessingPool.length);
  check("normal U6/R3 rarity rate is 32% target ±2pp",
    normalRate >= 0.30 && normalRate <= 0.34,
    `${(normalRate * 100).toFixed(2)}%`);
  check("comeback U12/R9 rarity rate is 41% target ±2pp",
    comebackRate >= 0.39 && comebackRate <= 0.43,
    `${(comebackRate * 100).toFixed(2)}%`);

  const maxed = PVP.blessingPool.flatMap((id) => {
    const item = itemById(id)!;
    return Array.from({ length: itemMaxLevel(item) }, () => id);
  });
  const maxedRng = new Rng(1);
  check("max-capped pool produces an empty offer",
    rollPvpDraftChoicesWith(3, () => maxedRng.next(), maxed).length === 0);
  const echo = itemById("core_dash")!;
  check("Echo Step is legal and capped at Lv1",
    isPvpBlessingId(echo.id) && itemMaxLevel(echo) === 1);

  const upgradeId = "split_shot";
  let upgradeHits = 0;
  let newHits = 0;
  for (let seed = 0; seed < 10_000; seed++) {
    const rng = new Rng(seed ^ 0x61a9);
    const picks = rollPvpDraftChoicesWith(1, () => rng.next(), [upgradeId]);
    for (const pick of picks) {
      if (pick.id === upgradeId) upgradeHits++;
      else if (pick.rarity === "uncommon") newHits++;
    }
  }
  const uncommonNewCount = PVP.blessingPool
    .map((id) => itemById(id)!)
    .filter((item) => item.rarity === "uncommon" && item.id !== upgradeId)
    .length;
  check("new picks retain the locked 3x per-item upgrade weight",
    newHits / uncommonNewCount > upgradeHits * 2.8
    && newHits / uncommonNewCount < upgradeHits * 3.2,
    `new/item=${(newHits / uncommonNewCount).toFixed(0)} upgrade=${upgradeHits}`);
  check("owned levels never exceed each item's legal cap",
    [...itemLevelsOf(maxed)].every(([id, level]) => level === itemMaxLevel(itemById(id)!)));
}

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
