// The pure run-result core (convex/statsCore.ts) + the body signer (convex/gsSignCore.ts):
// validation/clamping of every field, the derived score, aggregate folding, per-category
// bests, board eligibility, and the HMAC envelope the game server signs. This is the exact
// code the Convex deployment runs — imported directly, no mocks.
//
// Run: npx tsx test/statscore.test.ts

import {
  validateRun, parseServerSubmission, scoreForRun, foldRunIntoAggregates, emptyAggregates,
  favoriteWeapon, improvedBests, isBoardEligibleRun, bossIdForFloor, partyBucketFor,
  DEFAULT_DIFFICULTY, SUBMISSION_MAX_AGE_MS,
} from "../convex/statsCore.js";
import type { CleanRun, JsonValue } from "../convex/statsCore.js";
import { signRunBody, verifyRunBody } from "../convex/gsSignCore.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}

function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function baseRun(overrides: Record<string, JsonValue | undefined> = {}): Record<string, JsonValue | undefined> {
  return {
    mode: "online", result: "death", difficulty: "standard",
    floor: 7, startFloor: 1, kills: 42, coins: 130, coinsEarned: 200, coinsSpent: 70,
    durationMs: 600000, damageDealt: 900, damageTaken: 12, bestCombo: 18,
    bossKills: 1, bossKillFloors: [5], firstBossKillMs: 210000,
    killsByWeapon: { pistol: 20, shotgun: 22 }, weapons: ["pistol", "shotgun"],
    blessings: ["hair_trigger", "hair_trigger"],
    deathCause: "boss_slam",
    ...overrides,
  };
}

function mustValidate(raw: Record<string, JsonValue | undefined>): CleanRun {
  const r = validateRun(raw);
  if (!r.ok) throw new Error("expected valid run, got " + r.reason);
  return r.run;
}

section("validation: a well-formed run round-trips unchanged");
{
  const run = mustValidate(baseRun());
  check("fields preserved", run.floor === 7 && run.kills === 42 && run.bestCombo === 18
    && run.firstBossKillMs === 210000 && run.killsByWeapon.shotgun === 22);
  check("difficulty preserved", run.difficulty === "standard");
}

section("validation: difficulty defaults to standard only when ABSENT");
{
  const run = mustValidate(baseRun({ difficulty: undefined }));
  check("absent -> standard", run.difficulty === DEFAULT_DIFFICULTY);
  const bad = validateRun(baseRun({ difficulty: "nightmare" }));
  check("invalid present value rejected", !bad.ok && bad.reason === "bad_difficulty");
  const casual = mustValidate(baseRun({ difficulty: "casual" }));
  check("casual accepted", casual.difficulty === "casual");
}

section("validation: numbers clamp into bounds; wrong types reject");
{
  const clamped = mustValidate(baseRun({ floor: 99999, kills: -5, damageDealt: 1e12, bestCombo: 3.7 }));
  check("floor clamps to 1000", clamped.floor === 1000);
  check("negative kills clamp to 0", clamped.kills === 0);
  check("damage clamps to the ceiling", clamped.damageDealt === 10000000);
  check("fractional combo rounds", clamped.bestCombo === 4);
  check("string kills reject", !validateRun(baseRun({ kills: "9999" })).ok);
  check("NaN floor rejects", !validateRun(baseRun({ floor: Number.NaN })).ok);
  check("bad mode rejects", !validateRun(baseRun({ mode: "speedrun" })).ok);
  check("bad result rejects", !validateRun(baseRun({ result: "won" })).ok);
}

section("validation: floor can never sit below startFloor");
{
  const run = mustValidate(baseRun({ floor: 2, startFloor: 6, bossKills: 0, bossKillFloors: [], firstBossKillMs: undefined }));
  check("floor raised to startFloor", run.floor === 6 && run.startFloor === 6);
}

section("validation: incoherent boss time is dropped, lists are bounded");
{
  const run = mustValidate(baseRun({ bossKills: 0, bossKillFloors: [], firstBossKillMs: 100 }));
  check("boss time without a boss kill dropped", run.firstBossKillMs === null);
  const many = mustValidate(baseRun({ weapons: Array.from({ length: 200 }, (_, i) => "w" + i) }));
  check("weapons list truncates to 64", many.weapons.length === 64);
  check("junk killsByWeapon rejects", !validateRun(baseRun({ killsByWeapon: { pistol: "lots" } })).ok);
  check("non-string weapon entries reject", !validateRun(baseRun({ weapons: [7] })).ok);
}

section("validation: death cause is bounded and optional");
{
  check("cause preserved", mustValidate(baseRun()).deathCause === "boss_slam");
  check("absent cause -> null", mustValidate(baseRun({ deathCause: undefined })).deathCause === null);
  check("null cause -> null", mustValidate(baseRun({ deathCause: null })).deathCause === null);
  check("overlong cause truncates", mustValidate(baseRun({ deathCause: "x".repeat(100) })).deathCause === "x".repeat(48));
  const bad = validateRun(baseRun({ deathCause: 7 }));
  check("non-string cause rejects", !bad.ok && bad.reason === "bad_cause");
}

section("validation: party size clamps; the board bucket splits at 2");
{
  check("absent party -> 1", mustValidate(baseRun({ partySize: undefined })).partySize === 1);
  check("party preserved", mustValidate(baseRun({ partySize: 4 })).partySize === 4);
  check("party clamps into [1,8]", mustValidate(baseRun({ partySize: 99 })).partySize === 8
    && mustValidate(baseRun({ partySize: 0 })).partySize === 1);
  check("non-number party rejects", !validateRun(baseRun({ partySize: "four" })).ok);
  check("bucket: 1 -> solo", partyBucketFor(1) === "solo");
  check("bucket: 2+ -> party", partyBucketFor(2) === "party" && partyBucketFor(4) === "party");
}

section("score: derived, deterministic, floor-dominated, difficulty-normalized");
{
  const run = mustValidate(baseRun());
  const again = mustValidate(baseRun());
  check("same run -> same score", scoreForRun(run) === scoreForRun(again), `score=${scoreForRun(run)}`);
  const deeper = mustValidate(baseRun({ floor: 8 }));
  check("a deeper floor always outranks its shallower twin", scoreForRun(deeper) > scoreForRun(run));
  const base = 7 * 1000 + 1 * 500 + 42 * 10 + 18 * 20 + 200;
  check("standard weight is identity", scoreForRun(run) === base);
  const casual = mustValidate(baseRun({ difficulty: "casual" }));
  const brutal = mustValidate(baseRun({ difficulty: "brutal" }));
  check("casual normalizes down (3/4)", scoreForRun(casual) === Math.round((base * 3) / 4), `score=${scoreForRun(casual)}`);
  check("brutal normalizes up (5/4)", scoreForRun(brutal) === Math.round((base * 5) / 4), `score=${scoreForRun(brutal)}`);
  check("identical play orders casual < standard < brutal",
    scoreForRun(casual) < scoreForRun(run) && scoreForRun(run) < scoreForRun(brutal));
}

section("aggregation: one run folds into every lifetime counter");
{
  const run = mustValidate(baseRun());
  const agg = foldRunIntoAggregates(emptyAggregates(), run);
  check("counts and sums", agg.gamesPlayed === 1 && agg.totalKills === 42 && agg.totalCoins === 130
    && agg.playtimeMs === 600000 && agg.coinsEarned === 200 && agg.coinsSpent === 70
    && agg.damageDealt === 900 && agg.damageTaken === 12);
  check("outcome counters", agg.deaths === 1 && agg.wins === 0);
  check("maxima", agg.deepestFloor === 7 && agg.bestCombo === 18);
  check("boss aggregation keyed by roster id", agg.bossKills === 1
    && agg.bossKillsByBoss[bossIdForFloor(5)] === 1);
  check("fastest boss adopted", agg.fastestBossMs === 210000);

  const second = mustValidate(baseRun({ result: "victory", floor: 4, bestCombo: 30, firstBossKillMs: 150000, kills: 8 }));
  const agg2 = foldRunIntoAggregates(agg, second);
  check("second run folds additively", agg2.gamesPlayed === 2 && agg2.totalKills === 50 && agg2.wins === 1);
  check("deepest keeps the max", agg2.deepestFloor === 7);
  check("bestCombo keeps the max", agg2.bestCombo === 30);
  check("fastest boss keeps the min", agg2.fastestBossMs === 150000);
  check("killsByWeapon merges", agg2.killsByWeapon.pistol === 40 && agg2.killsByWeapon.shotgun === 44);
}

section("aggregation: fastest-boss ignores mid-run joins (startFloor > 1)");
{
  const joiner = mustValidate(baseRun({ startFloor: 4, firstBossKillMs: 9000 }));
  const agg = foldRunIntoAggregates(emptyAggregates(), joiner);
  check("9s 'record' from a floor-4 join not adopted", agg.fastestBossMs === null);
  check("their boss kill still counts in totals", agg.bossKills === 1);
}

section("favorite weapon: most killing blows, deterministic on ties");
{
  check("clear winner", favoriteWeapon({ pistol: 3, tesla: 9 }) === "tesla");
  check("tie breaks lexicographically", favoriteWeapon({ b: 5, a: 5 }) === "a");
  check("empty -> null", favoriteWeapon({}) === null);
}

section("leaderboard eligibility: server-sourced full runs only");
{
  const run = mustValidate(baseRun());
  check("server + startFloor 1 -> eligible", isBoardEligibleRun("server", run));
  check("local sim never eligible", !isBoardEligibleRun("local", run));
  const joiner = mustValidate(baseRun({ startFloor: 3 }));
  check("mid-run join not eligible", !isBoardEligibleRun("server", joiner));
}

section("bests: only genuine improvements patch");
{
  const run = mustValidate(baseRun());
  const first = improvedBests(null, run, scoreForRun(run), 1111);
  check("first entry sets every earned category", first.deepestFloor === 7 && first.fastestBossMs === 210000
    && first.mostBossKills === 1 && first.bestCombo === 18 && first.bestScore === scoreForRun(run));
  const prev = { deepestFloor: 7, fastestBossMs: 210000, mostBossKills: 1, bestScore: scoreForRun(run), bestCombo: 18 };
  check("identical rerun improves nothing", Object.keys(improvedBests(prev, run, scoreForRun(run), 2222)).length === 0);
  const better = mustValidate(baseRun({ firstBossKillMs: 100000, floor: 6 }));
  const patch = improvedBests(prev, better, scoreForRun(better), 3333);
  check("lower boss time improves; shallower floor does not", patch.fastestBossMs === 100000 && patch.deepestFloor === undefined);
}

section("server submission envelope: parse, freshness, tamper surface");
{
  const now = Date.now();
  const envelope = {
    v: 1, submissionId: "s".repeat(12), playerId: "players|abc123", worldId: "room:ABCD",
    sentAt: now, ...baseRun(),
  };
  const parsed = parseServerSubmission(JSON.stringify(envelope), now);
  check("valid envelope parses", parsed.ok && parsed.sub.playerId === "players|abc123" && parsed.sub.run.floor === 7);
  const stale = parseServerSubmission(JSON.stringify({ ...envelope, sentAt: now - SUBMISSION_MAX_AGE_MS - 1 }), now);
  check("stale submission rejected", !stale.ok && stale.reason === "stale");
  const badVer = parseServerSubmission(JSON.stringify({ ...envelope, v: 2 }), now);
  check("unknown version rejected", !badVer.ok && badVer.reason === "bad_version");
  const shortId = parseServerSubmission(JSON.stringify({ ...envelope, submissionId: "x" }), now);
  check("undersized submissionId rejected", !shortId.ok && shortId.reason === "bad_envelope");
  check("garbage body rejected", !parseServerSubmission("{nope", now).ok);
  const badRun = parseServerSubmission(JSON.stringify({ ...envelope, kills: "many" }), now);
  check("run field validation reaches the envelope", !badRun.ok && badRun.reason === "bad_number");
}

section("body signing: roundtrip verifies, any tamper fails");
{
  const secret = "test-secret-42";
  const body = JSON.stringify({ v: 1, hello: "world" });
  const sig = await signRunBody(secret, body);
  check("signature verifies over the exact bytes", await verifyRunBody(secret, body, sig));
  check("one flipped byte fails", !(await verifyRunBody(secret, body.replace("world", "worle"), sig)));
  check("wrong secret fails", !(await verifyRunBody("other-secret", body, sig)));
  check("truncated signature fails", !(await verifyRunBody(secret, body, sig.slice(0, -2))));
  check("empty signature fails", !(await verifyRunBody(secret, body, "")));
  const again = await signRunBody(secret, body);
  check("signing is deterministic", sig === again);
}

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(failures.map((f) => "  FAILED: " + f).join("\n") + "\n");
  process.exit(1);
}
process.stdout.write("\nAll stats-core assertions passed.\n");
