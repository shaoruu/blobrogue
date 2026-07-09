// The signed run-result inbox, exercised through the REAL HTTP action (convex-test t.fetch):
// signature over exact bytes (canonicalization = none, byte tampering fails), replay
// idempotency (same signed capture re-POSTed settles as a duplicate with no double fold),
// timestamp freshness, size limits, per-player rate caps, and secret separation. This is
// the replay/canonicalization test matrix from the security review.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import schema from "../../convex/schema";
import { api, internal } from "../../convex/_generated/api";
import { signRunBody } from "../../convex/gsSignCore";
import { SUBMISSION_MAX_AGE_MS } from "../../convex/statsCore";
import type { JsonValue } from "../../convex/statsCore";

const modules = import.meta.glob(["../../convex/**/*.{js,ts}", "!**/*.d.ts"]);

type T = TestConvex<typeof schema>;

const SECRET = "inbox-test-results-secret";
const TICKET_SECRET = "inbox-test-ticket-secret"; // a DIFFERENT channel's secret

beforeEach(() => {
  process.env.GS_RUN_RESULTS_SECRET = SECRET;
  process.env.GS_AUTH_SECRET = TICKET_SECRET;
});

afterEach(() => {
  delete process.env.GS_RUN_RESULTS_SECRET;
  delete process.env.GS_AUTH_SECRET;
});

async function makeAccount(t: T, name: string, clientId: string): Promise<string> {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", { name }));
  const asUser = t.withIdentity({ subject: `${userId}|session1` }) as T;
  const profile = await asUser.mutation(api.players.ensurePlayer, { clientId, name });
  return profile.playerId;
}

function envelope(playerId: string, overrides: Record<string, string | number> = {}): string {
  return JSON.stringify({
    v: 1, submissionId: crypto.randomUUID(), playerId, worldId: "room:TEST",
    sentAt: Date.now(), mode: "online", difficulty: "standard", result: "death",
    floor: 6, startFloor: 1, kills: 20, coins: 40, coinsEarned: 60, coinsSpent: 20,
    durationMs: 300000, damageDealt: 500, damageTaken: 9, bestCombo: 12,
    bossKills: 1, bossKillFloors: [5], firstBossKillMs: 200000,
    killsByWeapon: { pistol: 20 }, weapons: ["pistol"], blessings: [],
    deathCause: "shot", partySize: 1,
    ...overrides,
  });
}

async function post(t: T, body: string, signature: string): Promise<Response> {
  return t.fetch("/gs/run-result", {
    method: "POST",
    headers: { "content-type": "application/json", "x-gs-signature": signature },
    body,
  });
}

describe("run-result inbox (real HTTP action)", () => {
  test("a correctly signed submission lands and folds", async () => {
    const t = convexTest(schema, modules);
    const playerId = await makeAccount(t, "ada", "cid-inbox");
    const body = envelope(playerId);
    const res = await post(t, body, await signRunBody(SECRET, body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, isDuplicate: false });
    const stats = await t.query(api.stats.getMyStats, { clientId: "cid-inbox" });
    expect(stats?.aggregates.gamesPlayed).toBe(1);
  });

  test("replay: re-POSTing the exact signed capture settles as a duplicate, no double fold", async () => {
    const t = convexTest(schema, modules);
    const playerId = await makeAccount(t, "ada", "cid-replay");
    const body = envelope(playerId);
    const sig = await signRunBody(SECRET, body);
    expect((await post(t, body, sig)).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      const replay = await post(t, body, sig);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ ok: true, isDuplicate: true });
    }
    const stats = await t.query(api.stats.getMyStats, { clientId: "cid-replay" });
    expect(stats?.aggregates.gamesPlayed).toBe(1);
    expect(stats?.aggregates.totalKills).toBe(20);
  });

  test("byte canonicalization: ANY body byte change breaks the signature (even whitespace)", async () => {
    const t = convexTest(schema, modules);
    const playerId = await makeAccount(t, "ada", "cid-bytes");
    const body = envelope(playerId);
    const sig = await signRunBody(SECRET, body);
    const inflated = body.replace('"floor":6', '"floor":900');
    expect((await post(t, inflated, sig)).status).toBe(401);
    const whitespace = body.replace('{"v":1', '{ "v":1');
    expect((await post(t, whitespace, sig)).status).toBe(401);
    expect((await post(t, body, "")).status).toBe(401);
    // The signature authenticates BYTES, not meaning: the same JSON with `v` moved to the
    // end is different bytes, so the old signature fails; re-signing those exact bytes
    // succeeds (and, being a fresh submissionId-free replay of the same content, applies).
    const { v: version, ...rest } = JSON.parse(body) as { v: number } & Record<string, JsonValue>;
    const reordered = JSON.stringify({ ...rest, v: version });
    expect(reordered).not.toBe(body);
    expect((await post(t, reordered, sig)).status).toBe(401);
    expect((await post(t, reordered, await signRunBody(SECRET, reordered))).status).toBe(200);
  });

  test("secret separation: the ticket secret can never authorize a run result", async () => {
    const t = convexTest(schema, modules);
    const playerId = await makeAccount(t, "ada", "cid-sep");
    const body = envelope(playerId);
    expect((await post(t, body, await signRunBody(TICKET_SECRET, body))).status).toBe(401);
    // Unconfigured inbox refuses everything rather than falling back to the ticket secret.
    delete process.env.GS_RUN_RESULTS_SECRET;
    expect((await post(t, body, await signRunBody(SECRET, body))).status).toBe(503);
  });

  test("freshness: a stale sentAt is rejected even with a valid signature", async () => {
    const t = convexTest(schema, modules);
    const playerId = await makeAccount(t, "ada", "cid-stale");
    const body = envelope(playerId, { sentAt: Date.now() - SUBMISSION_MAX_AGE_MS - 1000 });
    const res = await post(t, body, await signRunBody(SECRET, body));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, reason: "stale" });
  });

  test("size limit: oversized bodies are refused before any work", async () => {
    const t = convexTest(schema, modules);
    const playerId = await makeAccount(t, "ada", "cid-size");
    const body = envelope(playerId, { worldId: "room:TEST" }).slice(0, -1) + `,"pad":"${"x".repeat(17000)}"}`;
    const res = await post(t, body, await signRunBody(SECRET, body));
    expect(res.status).toBe(413);
  });

  test("rate cap: a player row cannot absorb more than the hourly run budget", async () => {
    const t = convexTest(schema, modules);
    const playerId = await makeAccount(t, "ada", "cid-rate");
    // Seed the row to the cap through the internal mutation (cheaper than 120 HTTP trips).
    for (let i = 0; i < 120; i++) {
      const outcome = await t.mutation(internal.stats.applyServerRun, {
        submissionId: `seed-${i}`, playerId, worldId: "room:TEST",
        mode: "online", result: "death", difficulty: "standard",
        floor: 2, startFloor: 1, kills: 1, coins: 1, coinsEarned: 1, coinsSpent: 0,
        durationMs: 60000, damageDealt: 5, damageTaken: 6, bestCombo: 1,
        bossKills: 0, bossKillFloors: [], killsByWeapon: {}, weapons: ["pistol"], blessings: [],
        partySize: 1,
      });
      expect(outcome.ok).toBe(true);
    }
    const body = envelope(playerId);
    const res = await post(t, body, await signRunBody(SECRET, body));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ ok: false, reason: "rate_limited" });
    const stats = await t.query(api.stats.getMyStats, { clientId: "cid-rate" });
    expect(stats?.aggregates.gamesPlayed).toBe(120);
  });
});
