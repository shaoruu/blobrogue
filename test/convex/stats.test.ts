// Convex function tests (convex-test over the real schema + handlers): run submission
// idempotency, guest exclusion vs account eligibility on the global boards, identity
// resolution across both submission paths, leaderboard ordering/ties/pagination/difficulty
// filters, and run-history pagination. Run: npm run test:convex

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import schema from "../../convex/schema";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

// Every convex module incl. _generated (convex-test locates the functions root by it);
// .d.ts excluded — the extglob form from the convex-test docs doesn't match under
// vitest 4's glob engine, so spell the exclusion out.
const modules = import.meta.glob(["../../convex/**/*.{js,ts}", "!**/*.d.ts"]);

type T = TestConvex<typeof schema>;

function freshBackend(): T {
  return convexTest(schema, modules);
}

async function makeGuest(t: T, clientId: string, name: string): Promise<string> {
  const profile = await t.mutation(api.players.ensurePlayer, { clientId, name });
  return profile.playerId;
}

// A signed-in account: a users row + an authed session whose ensurePlayer creates the
// account-backed players row (subject format: "<userId>|<sessionId>", per @convex-dev/auth).
async function makeAccount(t: T, name: string, clientId: string): Promise<{ playerId: string; asUser: T }> {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", { name }));
  const asUser = t.withIdentity({ subject: `${userId}|session1` }) as T;
  const profile = await asUser.mutation(api.players.ensurePlayer, { clientId, name });
  return { playerId: profile.playerId, asUser };
}

interface RunOverrides {
  submissionId?: string;
  playerId?: string;
  difficulty?: "casual" | "standard" | "brutal";
  result?: "death" | "victory" | "abandon";
  floor?: number;
  startFloor?: number;
  kills?: number;
  bestCombo?: number;
  bossKills?: number;
  bossKillFloors?: number[];
  firstBossKillMs?: number;
  partySize?: number;
}

function serverRunArgs(playerId: string, o: RunOverrides = {}) {
  return {
    submissionId: o.submissionId ?? crypto.randomUUID(),
    playerId,
    worldId: "room:TEST",
    mode: "online" as const,
    result: o.result ?? ("death" as const),
    difficulty: o.difficulty ?? ("standard" as const),
    floor: o.floor ?? 6,
    startFloor: o.startFloor ?? 1,
    kills: o.kills ?? 20,
    coins: 40,
    coinsEarned: 60,
    coinsSpent: 20,
    durationMs: 300000,
    damageDealt: 500,
    damageTaken: 9,
    bestCombo: o.bestCombo ?? 12,
    bossKills: o.bossKills ?? 1,
    bossKillFloors: o.bossKillFloors ?? [5],
    ...(o.firstBossKillMs !== undefined ? { firstBossKillMs: o.firstBossKillMs } : { firstBossKillMs: 200000 }),
    killsByWeapon: { pistol: 20 },
    weapons: ["pistol"],
    blessings: ["hair_trigger"],
    deathCause: "boss_slam",
    partySize: o.partySize ?? 1,
  };
}

describe("applyServerRun (authoritative path)", () => {
  test("folds aggregates, inserts history, and is idempotent on submissionId", async () => {
    const t = freshBackend();
    const { playerId } = await makeAccount(t, "ada", "cid-ada");
    const args = serverRunArgs(playerId);
    const first = await t.mutation(internal.stats.applyServerRun, args);
    expect(first).toMatchObject({ ok: true, isDuplicate: false });

    // The exact same submission again (a reporter retry): acknowledged, applied once.
    const second = await t.mutation(internal.stats.applyServerRun, args);
    expect(second).toMatchObject({ ok: true, isDuplicate: true });

    const stats = await t.query(api.stats.getMyStats, { clientId: "cid-ada" });
    expect(stats?.aggregates.gamesPlayed).toBe(1);
    expect(stats?.aggregates.totalKills).toBe(20);
    expect(stats?.aggregates.deaths).toBe(1);
    expect(stats?.aggregates.bossKills).toBe(1);
    expect(stats?.aggregates.bossKillsByBoss.slime_king).toBe(1);
    expect(stats?.aggregates.fastestBossMs).toBe(200000);

    const runs = await t.query(api.stats.listMyRuns, { clientId: "cid-ada", cursor: null, numItems: 10 });
    expect(runs.page).toHaveLength(1);
    expect(runs.page[0].source).toBe("server");
    expect(runs.page[0].deathCause).toBe("boss_slam");
    // Score is DERIVED server-side, never submitted.
    expect(runs.page[0].score).toBe(6 * 1000 + 1 * 500 + 20 * 10 + 12 * 20 + 60);
  });

  test("account rows chart on the board; guest rows never do (guest exclusion)", async () => {
    const t = freshBackend();
    const { playerId: accountId } = await makeAccount(t, "ada", "cid-acct");
    const guestId = await makeGuest(t, "cid-guest", "gus");
    await t.mutation(internal.stats.applyServerRun, serverRunArgs(accountId, { floor: 8 }));
    await t.mutation(internal.stats.applyServerRun, serverRunArgs(guestId, { floor: 11 }));

    const board = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    expect(board.entries).toHaveLength(1);
    expect(board.entries[0].playerId).toBe(accountId);

    // The guest's PERSONAL stats still folded — exclusion is board-only.
    const guestStats = await t.query(api.stats.getMyStats, { clientId: "cid-guest" });
    expect(guestStats?.aggregates.deepestFloor).toBe(11);
    expect(guestStats?.isAccount).toBe(false);
  });

  test("mid-run joins (startFloor > 1) fold stats but never chart", async () => {
    const t = freshBackend();
    const { playerId } = await makeAccount(t, "ada", "cid-join");
    await t.mutation(internal.stats.applyServerRun, serverRunArgs(playerId, { floor: 40, startFloor: 12 }));
    const board = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    expect(board.entries).toHaveLength(0);
    const stats = await t.query(api.stats.getMyStats, { clientId: "cid-join" });
    expect(stats?.aggregates.deepestFloor).toBe(40);
  });

  test("identity resolution: guest:<clientId> pids and unknown identities", async () => {
    const t = freshBackend();
    await makeGuest(t, "cid-tick", "gus");
    // The mint's guest fallback identity resolves to the same guest row by clientId.
    const viaGuestPid = await t.mutation(internal.stats.applyServerRun,
      serverRunArgs("guest:cid-tick", { floor: 4 }));
    expect(viaGuestPid).toMatchObject({ ok: true, isDuplicate: false });
    const stats = await t.query(api.stats.getMyStats, { clientId: "cid-tick" });
    expect(stats?.aggregates.deepestFloor).toBe(4);
    // A dev-auth identity can never resolve: acknowledged as skipped (no retry storm).
    const skipped = await t.mutation(internal.stats.applyServerRun, serverRunArgs("dev:someone"));
    expect(skipped).toMatchObject({ ok: true, isSkipped: true });
  });

  test("bests only improve: a worse follow-up run leaves the board entry alone", async () => {
    const t = freshBackend();
    const { playerId } = await makeAccount(t, "ada", "cid-best");
    await t.mutation(internal.stats.applyServerRun, serverRunArgs(playerId, { floor: 9, firstBossKillMs: 100000 }));
    await t.mutation(internal.stats.applyServerRun, serverRunArgs(playerId, { floor: 3, firstBossKillMs: 300000 }));
    const deepest = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    expect(deepest.entries[0].value).toBe(9);
    const fastest = await t.query(api.leaderboard.top, {
      category: "fastestBoss", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    expect(fastest.entries[0].value).toBe(100000);
  });
});

describe("recordLocalRun (untrusted client path)", () => {
  test("folds personal stats + history as source 'local' and never charts", async () => {
    const t = freshBackend();
    await makeGuest(t, "cid-solo", "gus");
    const result = await t.mutation(api.stats.recordLocalRun, {
      clientId: "cid-solo",
      submissionId: crypto.randomUUID(),
      mode: "solo", result: "death",
      floor: 14, startFloor: 1, kills: 50, coins: 90, coinsEarned: 120, coinsSpent: 30,
      durationMs: 500000, damageDealt: 800, damageTaken: 20, bestCombo: 22,
      bossKills: 2, bossKillFloors: [5, 10], firstBossKillMs: 150000,
      killsByWeapon: { tesla: 50 }, weapons: ["pistol", "tesla"], blessings: [],
    });
    expect(result?.aggregates.deepestFloor).toBe(14);
    const runs = await t.query(api.stats.listMyRuns, { clientId: "cid-solo", cursor: null, numItems: 5 });
    expect(runs.page[0].source).toBe("local");

    // Even a monster local run never touches a board — the untrusted path is stats-only.
    for (const category of ["deepestFloor", "fastestBoss", "bossKills", "score", "combo"] as const) {
      const board = await t.query(api.leaderboard.top, { category, difficulty: "standard", party: "solo", cursor: null, numItems: 10 });
      expect(board.entries).toHaveLength(0);
    }
  });

  test("signed-in local runs land on the ACCOUNT row (account identity), still no board", async () => {
    const t = freshBackend();
    const { asUser } = await makeAccount(t, "ada", "cid-mix");
    const result = await asUser.mutation(api.stats.recordLocalRun, {
      clientId: "cid-mix",
      submissionId: crypto.randomUUID(),
      mode: "solo", result: "death",
      floor: 9, startFloor: 1, kills: 5, coins: 10, coinsEarned: 10, coinsSpent: 0,
      durationMs: 60000, damageDealt: 50, damageTaken: 6, bestCombo: 4,
      bossKills: 1, bossKillFloors: [5], firstBossKillMs: 50000,
      killsByWeapon: { pistol: 5 }, weapons: ["pistol"], blessings: [],
    });
    expect(result?.isAccount).toBe(true);
    const board = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    expect(board.entries).toHaveLength(0);
  });

  test("a guest with no players row records nothing (same rule as legacy recordRun)", async () => {
    const t = freshBackend();
    const result = await t.mutation(api.stats.recordLocalRun, {
      clientId: "cid-nobody",
      submissionId: crypto.randomUUID(),
      mode: "solo", result: "death",
      floor: 3, startFloor: 1, kills: 1, coins: 1, coinsEarned: 1, coinsSpent: 0,
      durationMs: 30000, damageDealt: 5, damageTaken: 6, bestCombo: 1,
      bossKills: 0, bossKillFloors: [], killsByWeapon: {}, weapons: ["pistol"], blessings: [],
    });
    expect(result).toBeNull();
    const runs = await t.run(async (ctx) => ctx.db.query("runs").collect());
    expect(runs).toHaveLength(0);
  });
});

describe("leaderboard.top ordering / ties / pagination / difficulty", () => {
  async function seedAccounts(t: T, entries: Array<{ name: string; floor: number; difficulty?: "casual" | "standard" | "brutal"; firstBossKillMs?: number; bossKills?: number; bestCombo?: number }>): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const { playerId } = await makeAccount(t, e.name, `cid-${e.name}-${i}`);
      await t.mutation(internal.stats.applyServerRun, serverRunArgs(playerId, {
        floor: e.floor,
        difficulty: e.difficulty,
        firstBossKillMs: e.firstBossKillMs,
        bossKills: e.bossKills,
        bestCombo: e.bestCombo,
      }));
      ids.push(playerId);
    }
    return ids;
  }

  test("deepest floor orders descending; fastest boss ascending", async () => {
    const t = freshBackend();
    await seedAccounts(t, [
      { name: "mid", floor: 9, firstBossKillMs: 220000 },
      { name: "top", floor: 15, firstBossKillMs: 90000 },
      { name: "low", floor: 4, firstBossKillMs: 310000 },
    ]);
    const deepest = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    expect(deepest.entries.map((e) => e.value)).toEqual([15, 9, 4]);
    expect(deepest.entries.map((e) => e.name)).toEqual(["top", "mid", "low"]);
    const fastest = await t.query(api.leaderboard.top, {
      category: "fastestBoss", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    expect(fastest.entries.map((e) => e.value)).toEqual([90000, 220000, 310000]);
  });

  test("ties are deterministic: equal values order by board-row age per index direction", async () => {
    const t = freshBackend();
    await seedAccounts(t, [
      { name: "first", floor: 9, firstBossKillMs: 100000 },
      { name: "second", floor: 9, firstBossKillMs: 100000 },
    ]);
    const deepest = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    // Descending boards reverse the whole index — the newer row leads inside a tie.
    expect(deepest.entries.map((e) => e.name)).toEqual(["second", "first"]);
    const fastest = await t.query(api.leaderboard.top, {
      category: "fastestBoss", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    // Ascending boards read index order — the earlier row leads inside a tie.
    expect(fastest.entries.map((e) => e.name)).toEqual(["first", "second"]);
  });

  test("pagination pages are disjoint, ordered, and terminate", async () => {
    const t = freshBackend();
    await seedAccounts(t, [
      { name: "p1", floor: 21 }, { name: "p2", floor: 17 }, { name: "p3", floor: 13 },
      { name: "p4", floor: 11 }, { name: "p5", floor: 7 },
    ]);
    const page1 = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "solo", cursor: null, numItems: 2,
    });
    expect(page1.entries.map((e) => e.value)).toEqual([21, 17]);
    expect(page1.isDone).toBe(false);
    const page2 = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "solo", cursor: page1.continueCursor, numItems: 2,
    });
    expect(page2.entries.map((e) => e.value)).toEqual([13, 11]);
    const page3 = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "solo", cursor: page2.continueCursor, numItems: 2,
    });
    expect(page3.entries.map((e) => e.value)).toEqual([7]);
    expect(page3.isDone).toBe(true);
    const seen = [...page1.entries, ...page2.entries, ...page3.entries].map((e) => e.playerId);
    expect(new Set(seen).size).toBe(5);
  });

  test("difficulty filters isolate boards; schema accepts the enum with standard default", async () => {
    const t = freshBackend();
    await seedAccounts(t, [
      { name: "casualcat", floor: 30, difficulty: "casual" },
      { name: "standardsam", floor: 8 },
      { name: "brutalbee", floor: 5, difficulty: "brutal" },
    ]);
    const standard = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    expect(standard.entries.map((e) => e.name)).toEqual(["standardsam"]);
    const casual = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "casual", party: "solo", cursor: null, numItems: 10,
    });
    expect(casual.entries.map((e) => e.name)).toEqual(["casualcat"]);
    const brutal = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "brutal", party: "solo", cursor: null, numItems: 10,
    });
    expect(brutal.entries.map((e) => e.name)).toEqual(["brutalbee"]);

    // Stored scores are difficulty-NORMALIZED at the authoritative source (statsCore
    // weights: casual 3/4, standard 1, brutal 5/4) — never submitted, always derived.
    const brutalBase = 5 * 1000 + 1 * 500 + 20 * 10 + 12 * 20 + 60;
    const brutalScore = await t.query(api.leaderboard.top, {
      category: "score", difficulty: "brutal", party: "solo", cursor: null, numItems: 10,
    });
    expect(brutalScore.entries[0].value).toBe(Math.round((brutalBase * 5) / 4));
    const casualBase = 30 * 1000 + 1 * 500 + 20 * 10 + 12 * 20 + 60;
    const casualScore = await t.query(api.leaderboard.top, {
      category: "score", difficulty: "casual", party: "solo", cursor: null, numItems: 10,
    });
    expect(casualScore.entries[0].value).toBe(Math.round((casualBase * 3) / 4));
  });

  test("unearned categories never chart (zero boss kills / combo)", async () => {
    const t = freshBackend();
    const { playerId } = await makeAccount(t, "pacifist", "cid-zero");
    await t.mutation(internal.stats.applyServerRun, serverRunArgs(playerId, {
      floor: 6, bossKills: 0, bossKillFloors: [], bestCombo: 0, firstBossKillMs: undefined,
    }));
    const bossBoard = await t.query(api.leaderboard.top, {
      category: "bossKills", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    expect(bossBoard.entries).toHaveLength(0);
    const comboBoard = await t.query(api.leaderboard.top, {
      category: "combo", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    expect(comboBoard.entries).toHaveLength(0);
    const deepest = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    expect(deepest.entries).toHaveLength(1);
  });

  test("the caller's own standing rides along with a computed rank even when off the page", async () => {
    const t = freshBackend();
    await seedAccounts(t, [
      { name: "p1", floor: 30 }, { name: "p2", floor: 25 },
    ]);
    const { playerId, asUser } = await makeAccount(t, "me", "cid-me");
    await t.mutation(internal.stats.applyServerRun, serverRunArgs(playerId, { floor: 2, bossKills: 0, bossKillFloors: [], firstBossKillMs: undefined }));
    const page = await asUser.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "solo", cursor: null, numItems: 2, clientId: "cid-me",
    });
    expect(page.entries.map((e) => e.name)).toEqual(["p1", "p2"]);
    expect(page.me?.playerId).toBe(playerId);
    expect(page.me?.value).toBe(2);
    // Standard competition rank: two strictly better entries -> #3 (drives the pinned row).
    expect(page.me?.rank).toBe(3);
  });

  test("boards split by party: a party run never competes with solo runs", async () => {
    const t = freshBackend();
    const { playerId: soloist } = await makeAccount(t, "soloist", "cid-solo-b");
    const { playerId: grouper } = await makeAccount(t, "grouper", "cid-party-b");
    await t.mutation(internal.stats.applyServerRun, serverRunArgs(soloist, { floor: 6 }));
    await t.mutation(internal.stats.applyServerRun, serverRunArgs(grouper, { floor: 22, partySize: 3 }));
    const solo = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    expect(solo.entries.map((e) => e.name)).toEqual(["soloist"]);
    const party = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "party", cursor: null, numItems: 10,
    });
    expect(party.entries.map((e) => e.name)).toEqual(["grouper"]);
    // One player keeps SEPARATE bests per bucket: a deep party run can't inflate solo.
    await t.mutation(internal.stats.applyServerRun, serverRunArgs(soloist, { floor: 40, partySize: 4 }));
    const soloAfter = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    expect(soloAfter.entries.find((e) => e.name === "soloist")?.value).toBe(6);
    const partyAfter = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "party", cursor: null, numItems: 10,
    });
    expect(partyAfter.entries.map((e) => e.value)).toEqual([40, 22]);
    // Party size lands in the run history too.
    const runs = await t.query(api.stats.listMyRuns, { clientId: "cid-party-b", cursor: null, numItems: 5 });
    expect(runs.page[0].partySize).toBe(3);
  });
});

describe("run history + legacy compatibility", () => {
  test("listMyRuns pages newest-first", async () => {
    const t = freshBackend();
    const { playerId } = await makeAccount(t, "ada", "cid-hist");
    for (let i = 1; i <= 5; i++) {
      await t.mutation(internal.stats.applyServerRun, serverRunArgs(playerId, { floor: i }));
    }
    const page1 = await t.query(api.stats.listMyRuns, { clientId: "cid-hist", cursor: null, numItems: 3 });
    expect(page1.page.map((r) => r.floor)).toEqual([5, 4, 3]);
    expect(page1.isDone).toBe(false);
    const page2 = await t.query(api.stats.listMyRuns, { clientId: "cid-hist", cursor: page1.continueCursor, numItems: 3 });
    expect(page2.page.map((r) => r.floor)).toEqual([2, 1]);
    expect(page2.isDone).toBe(true);
  });

  test("legacy players.recordRun still folds the basic aggregates", async () => {
    const t = freshBackend();
    await makeGuest(t, "cid-old", "gus");
    const profile = await t.mutation(api.players.recordRun, { clientId: "cid-old", floor: 6, kills: 9, coins: 12 });
    expect(profile?.deepestFloor).toBe(6);
    expect(profile?.totalKills).toBe(9);
    expect(profile?.gamesPlayed).toBe(1);
  });

  test("guest stats migrate onto the account on first sign-in (identity continuity)", async () => {
    const t = freshBackend();
    const guestId = await makeGuest(t, "cid-migrate", "gus");
    await t.mutation(internal.stats.applyServerRun, serverRunArgs(guestId, { floor: 7 }));
    // Sign in from the same browser: ensurePlayer adopts the guest row (same _id).
    const { playerId } = await makeAccount(t, "ada", "cid-migrate");
    expect(playerId).toBe(guestId);
    const stats = await t.query(api.stats.getMyStats, { clientId: "cid-migrate" });
    expect(stats?.isAccount).toBe(true);
    expect(stats?.aggregates.deepestFloor).toBe(7);
    // The next server run (same pid the ticket already carries) NOW charts globally.
    await t.mutation(internal.stats.applyServerRun, serverRunArgs(guestId, { floor: 9 }));
    const board = await t.query(api.leaderboard.top, {
      category: "deepestFloor", difficulty: "standard", party: "solo", cursor: null, numItems: 10,
    });
    expect(board.entries.map((e) => e.value)).toEqual([9]);
  });
});
