import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import schema from "../convex/schema.js";
import type { RunCompletionPayload } from "../src/net/runReceipt.js";
import { RUN_RECEIPT_VERSION } from "../src/net/runReceipt.js";
import { mintRunCompletionReceipt } from "../server/src/runReceipt.js";
import { PRIVATE_DRAFT_PVP_POLICY } from "../src/net/pvpPolicy.js";
import {
  GENERATION_ADMISSION_TTL_MS,
  GENERATION_ADMISSION_VERSION,
  parseGenerationAdmissionDecision,
  type AdmissionJson,
  type GenerationAdmissionPayload,
} from "../src/net/generationAdmission.js";
import { mintGenerationAdmissionProof } from "../server/src/generationAdmissionClient.js";
import { encodeBase64Url } from "../src/net/base64url.js";

const modules = import.meta.glob("../convex/**/*.{ts,js}");

const applyReceipt = makeFunctionReference<
  "mutation",
  RunCompletionPayload,
  { ok: true; generation: number; playerIds: string[] }
>("runReceipt:apply");
const reopenRoom = makeFunctionReference<
  "mutation",
  {
    roomId: string;
    clientId: string;
    guestCapability?: string;
    generation?: number;
  },
  { loadoutGeneration: number; isReopened: boolean }
>("rooms:reopen");
const recordRun = makeFunctionReference<
  "mutation",
  { clientId: string; floor: number; kills: number; coins: number },
  null
>("players:recordRun");
const recordFloorProgress = makeFunctionReference<
  "mutation",
  { clientId: string; floor: number },
  null
>("players:recordFloorProgress");
const buyNode = makeFunctionReference<
  "mutation",
  { clientId: string; guestCapability?: string; nodeId: string },
  { ok: boolean } | null
>("players:buyNode");
const ensurePlayer = makeFunctionReference<
  "mutation",
  {
    clientId: string;
    guestCapability?: string;
    guestRefreshCapability?: string;
    name: string;
  },
  {
    playerId: string;
    guestCapability?: string;
    guestRefreshCapability?: string;
  }
>("players:ensurePlayer");
const generationAdmission = makeFunctionReference<
  "query",
  {
    playerId: string;
    worldId: string;
    roomCode: string;
    generation: number;
    mode: "coop" | "pvp";
    pvpPolicy: typeof PRIVATE_DRAFT_PVP_POLICY | null;
    kitId: string;
    petId: string | null;
  },
  { isAllowed: boolean; code: string }
>("rooms:generationAdmission");
const reportWorld = makeFunctionReference<
  "mutation",
  {
    roomId: string;
    clientId: string;
    guestCapability?: string;
    generation: number;
    worldId: string | null;
  },
  null
>("presence:reportWorld");
const backfillGenerationState = makeFunctionReference<
  "mutation",
  { isLegacyWorldsDrained: boolean },
  number
>("migrations:backfillGenerationState");
const prepareSignOutGuest = makeFunctionReference<
  "mutation",
  { clientId: string; name: string },
  {
    playerId: string;
    isAccount: boolean;
    guestCapability?: string;
  }
>("players:prepareSignOutGuest");
const createRoom = makeFunctionReference<
  "mutation",
  {
    clientId: string;
    guestCapability?: string;
    kind: "online";
    mode: "coop" | "pvp";
    kitId: string;
    petId: string | null;
    isKitChoiceMade: boolean;
    isPetChoiceMade: boolean;
  },
  { roomId: string }
>("rooms:create");
const quickPlayRoom = makeFunctionReference<
  "mutation",
  {
    clientId: string;
    guestCapability?: string;
    kind: "online";
    mode: "coop" | "pvp";
    kitId: string;
    petId: string | null;
    isKitChoiceMade: boolean;
    isPetChoiceMade: boolean;
  },
  { roomId: string }
>("rooms:quickPlay");
const joinRoom = makeFunctionReference<
  "mutation",
  {
    code: string;
    clientId: string;
    guestCapability?: string;
    kind: "online";
    kitId: string;
    petId: string | null;
    isKitChoiceMade: boolean;
    isPetChoiceMade: boolean;
  },
  { roomId: string }
>("rooms:join");
const confirmRoomLoadout = makeFunctionReference<
  "mutation",
  {
    roomId: string;
    clientId: string;
    guestCapability?: string;
    generation: number;
    editRevision: number;
  },
  | { ok: true; generation: number; kitId: string; petId: string | null }
  | { ok: false; reason: string; message?: string }
>("rooms:confirmLoadout");

function receipt(
  playerId: string,
  code: string,
  jti: string,
  overrides: Partial<RunCompletionPayload> = {},
): RunCompletionPayload {
  const now = Date.now();
  const worldId = `room:${code}:g1`;
  return {
    version: RUN_RECEIPT_VERSION,
    jti,
    runId: `${worldId}:seed:1`,
    worldId,
    roomCode: code,
    generation: 1,
    status: "completed",
    issuedAt: now,
    expiresAt: now + 60_000,
    isNoActiveSeat: true,
    participants: [{
      playerId,
      floor: 4,
      kills: 7,
      coins: 23,
      floorsCleared: 3,
      bossKills: [],
      isCacheArmed: false,
      amberWindfall: 0,
      durationMs: 20_000,
      weapons: ["pistol"],
      items: [],
    }],
    ...overrides,
  };
}

async function seedGeneration(isDeparted = false) {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const playerId = await ctx.db.insert("players", {
      clientId: "browser-a",
      name: "Runner",
      totalKills: 0,
      deepestFloor: 0,
      totalCoins: 0,
      gamesPlayed: 0,
      unlocks: [],
      createdAt: now,
      lastSeen: now,
    });
    const roomId = await ctx.db.insert("rooms", {
      code: "ABCD",
      kind: "online",
      mode: "coop",
      hostPlayerId: playerId,
      seed: 1,
      floor: 1,
      status: "playing",
      isPublic: false,
      loadoutGeneration: 1,
      generationState: "active",
      createdAt: now,
      lastActivity: now,
    });
    await ctx.db.insert("presence", {
      roomId,
      playerId,
      name: "Runner",
      x: 0,
      y: 0,
      facing: 1,
      hp: 6,
      maxHp: 6,
      weapon: "pistol",
      floor: 1,
      isDown: false,
      aimAngle: 0,
      shotSeq: 0,
      kills: 0,
      colorIndex: 0,
      reviveNonce: 0,
      updatedAt: now,
      isReady: true,
      loadoutKitId: "gunner",
      isKitChoiceMade: true,
      isPetChoiceMade: true,
      isLoadoutConfirmed: true,
      loadoutGeneration: 1,
      ...(isDeparted ? { isDeparted: true } : {}),
    });
    await ctx.db.insert("guestSessions", {
      token: "guest-capability",
      refreshToken: "guest-refresh-capability",
      clientId: "browser-a",
      playerId,
      scopes: ["profile", "room", "ticket", "economy"],
      createdAt: now,
      expiresAt: now + 60_000,
      refreshExpiresAt: now + 120_000,
    });
    return { playerId, roomId };
  });
  return { t, ...seeded };
}

describe("Convex run authority", () => {
  test("applies a valid receipt once and rejects replay without double rewards", async () => {
    const { t, playerId, roomId } = await seedGeneration();
    const payload = receipt(playerId, "ABCD", "11111111111111111111111111111111");
    await expect(t.mutation(applyReceipt, payload)).resolves.toMatchObject({ ok: true, generation: 1 });
    await expect(t.mutation(applyReceipt, payload)).rejects.toThrow();
    const state = await t.run(async (ctx) => ({
      player: await ctx.db.get(playerId),
      room: await ctx.db.get(roomId),
      receipts: await ctx.db.query("runReceipts").collect(),
      leaderboard: await ctx.db.query("leaderboard").collect(),
    }));
    expect(state.player?.gamesPlayed).toBe(1);
    expect(state.player?.totalKills).toBe(7);
    expect(state.player?.totalCoins).toBe(23);
    expect(state.room?.generationState).toBe("completed");
    expect(state.receipts).toHaveLength(1);
    expect(state.leaderboard).toHaveLength(1);
  });

  test("HTTP receipt seam rejects tampering and returns replay conflict", async () => {
    const { t, playerId } = await seedGeneration();
    const secret = "receipt-http-secret";
    const previousReceiptSecret = process.env.GS_RECEIPT_SECRET;
    const previousAuthSecret = process.env.GS_AUTH_SECRET;
    process.env.GS_RECEIPT_SECRET = secret;
    process.env.GS_AUTH_SECRET = "different-ticket-secret";
    try {
      const signed = mintRunCompletionReceipt(
        secret,
        receipt(playerId, "ABCD", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      );
      const [prefix, payloadSegment, signatureSegment] = signed.split(".");
      const tamperedPayload = Buffer.from(payloadSegment, "base64url");
      tamperedPayload[0] ^= 0x01;
      const tampered = `${prefix}.${encodeBase64Url(tamperedPayload)}.${signatureSegment}`;
      const rejected = await t.fetch("/gs/run-completion", {
        method: "POST",
        body: JSON.stringify({ receipt: tampered }),
      });
      expect(rejected.status).toBe(401);
      const accepted = await t.fetch("/gs/run-completion", {
        method: "POST",
        body: JSON.stringify({ receipt: signed }),
      });
      expect(accepted.status).toBe(200);
      const replayed = await t.fetch("/gs/run-completion", {
        method: "POST",
        body: JSON.stringify({ receipt: signed }),
      });
      expect(replayed.status).toBe(409);
    } finally {
      if (previousReceiptSecret === undefined) delete process.env.GS_RECEIPT_SECRET;
      else process.env.GS_RECEIPT_SECRET = previousReceiptSecret;
      if (previousAuthSecret === undefined) delete process.env.GS_AUTH_SECRET;
      else process.env.GS_AUTH_SECRET = previousAuthSecret;
    }
  });

  test("rejects wrong generation and wrong membership atomically", async () => {
    const { t, playerId } = await seedGeneration();
    const otherPlayerId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("players", {
        clientId: "browser-b",
        name: "Intruder",
        totalKills: 0,
        deepestFloor: 0,
        totalCoins: 0,
        gamesPlayed: 0,
        unlocks: [],
        createdAt: now,
        lastSeen: now,
      });
    });
    const wrongGeneration = receipt(playerId, "ABCD", "22222222222222222222222222222222", {
      runId: "room:ABCD:g2:seed:1",
      worldId: "room:ABCD:g2",
      generation: 2,
    });
    const wrongMember = receipt(otherPlayerId, "ABCD", "33333333333333333333333333333333");
    await expect(t.mutation(applyReceipt, wrongGeneration)).rejects.toThrow();
    await expect(t.mutation(applyReceipt, wrongMember)).rejects.toThrow();
    const state = await t.run(async (ctx) => ({
      receipts: await ctx.db.query("runReceipts").collect(),
      player: await ctx.db.get(playerId),
    }));
    expect(state.receipts).toHaveLength(0);
    expect(state.player?.gamesPlayed).toBe(0);
  });

  test("a departed member cannot mint rewards or wedge server completion", async () => {
    const { t, playerId, roomId } = await seedGeneration(true);
    await t.mutation(
      applyReceipt,
      receipt(playerId, "ABCD", "44444444444444444444444444444444"),
    );
    const state = await t.run(async (ctx) => ({
      player: await ctx.db.get(playerId),
      room: await ctx.db.get(roomId),
      presence: await ctx.db.query("presence").collect(),
    }));
    expect(state.player?.gamesPlayed).toBe(0);
    expect(state.room?.generationState).toBe("completed");
    expect(state.room?.status).toBe("ended");
    expect(state.presence).toHaveLength(0);
  });

  test("server completion opens exactly one next generation", async () => {
    const { t, playerId, roomId } = await seedGeneration();
    await t.mutation(
      applyReceipt,
      receipt(playerId, "ABCD", "55555555555555555555555555555555"),
    );
    const first = await t.mutation(reopenRoom, {
      roomId,
      clientId: "browser-a",
      guestCapability: "guest-capability",
      generation: 1,
    });
    const second = await t.mutation(reopenRoom, {
      roomId,
      clientId: "browser-a",
      guestCapability: "guest-capability",
      generation: 1,
    });
    expect(first).toEqual({ loadoutGeneration: 2, isReopened: true });
    expect(second).toEqual({ loadoutGeneration: 2, isReopened: false });
  });

  test("client world reports cannot forge generation completion", async () => {
    const { t, roomId } = await seedGeneration();
    await t.mutation(reportWorld, {
      roomId,
      clientId: "browser-a",
      guestCapability: "guest-capability",
      generation: 1,
      worldId: null,
    });
    const result = await t.mutation(reopenRoom, {
      roomId,
      clientId: "browser-a",
      guestCapability: "guest-capability",
      generation: 1,
    });
    const room = await t.run(async (ctx) => await ctx.db.get(roomId));
    expect(result).toEqual({ loadoutGeneration: 1, isReopened: false });
    expect(room?.generationState).toBe("active");
  });

  test("join admission rechecks durable generation, member, and loadout state", async () => {
    const { t, playerId } = await seedGeneration();
    const args = {
      playerId,
      worldId: "room:ABCD:g1",
      roomCode: "ABCD",
      generation: 1,
      mode: "coop" as const,
      pvpPolicy: null,
      kitId: "gunner",
      petId: null,
    };
    const allowedDecision = await t.query(generationAdmission, args);
    expect(allowedDecision).toEqual({
      isAllowed: true,
      code: "ok",
    });
    expect(parseGenerationAdmissionDecision(allowedDecision as AdmissionJson)).toEqual(allowedDecision);
    const deniedDecision = await t.query(generationAdmission, {
      ...args,
      kitId: "mender",
    });
    expect(deniedDecision).toEqual({
      isAllowed: false,
      code: "membership_changed",
    });
    expect(parseGenerationAdmissionDecision(deniedDecision as AdmissionJson)).toEqual(deniedDecision);
    await expect(t.query(generationAdmission, {
      ...args,
      petId: "doggie",
    })).resolves.toEqual({
      isAllowed: false,
      code: "membership_changed",
    });
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("presence").collect();
      await ctx.db.patch(rows[0]._id, { isDeparted: true });
    });
    await expect(t.query(generationAdmission, args)).resolves.toEqual({
      isAllowed: false,
      code: "membership_changed",
    });
  });

  test("admission HTTP endpoint emits only exact 200 allow and 403 deny pairs", async () => {
    const { t, playerId } = await seedGeneration();
    const secret = "admission-http-secret";
    const previousReceiptSecret = process.env.GS_RECEIPT_SECRET;
    const previousAuthSecret = process.env.GS_AUTH_SECRET;
    process.env.GS_RECEIPT_SECRET = secret;
    process.env.GS_AUTH_SECRET = "separate-auth-secret";
    try {
      const issuedAt = Date.now();
      const payload: GenerationAdmissionPayload = {
        version: GENERATION_ADMISSION_VERSION,
        jti: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
        playerId,
        worldId: "room:ABCD:g1",
        roomCode: "ABCD",
        generation: 1,
        mode: "coop",
        pvpPolicy: null,
        kitId: "gunner",
        petId: null,
        isPetChoiceMade: true,
        issuedAt,
        expiresAt: issuedAt + GENERATION_ADMISSION_TTL_MS,
      };
      const allowed = await t.fetch("/gs/admission", {
        method: "POST",
        body: JSON.stringify({ proof: mintGenerationAdmissionProof(secret, payload) }),
      });
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({ isAllowed: true, code: "ok" });

      await t.run(async (ctx) => {
        const rows = await ctx.db.query("presence").collect();
        await ctx.db.patch(rows[0]._id, { isDeparted: true });
      });
      const denied = await t.fetch("/gs/admission", {
        method: "POST",
        body: JSON.stringify({
          proof: mintGenerationAdmissionProof(secret, {
            ...payload,
            jti: "1234567890abcdef1234567890abcdef1234567890abcdef",
          }),
        }),
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ isAllowed: false, code: "membership_changed" });
    } finally {
      if (previousReceiptSecret === undefined) delete process.env.GS_RECEIPT_SECRET;
      else process.env.GS_RECEIPT_SECRET = previousReceiptSecret;
      if (previousAuthSecret === undefined) delete process.env.GS_AUTH_SECRET;
      else process.env.GS_AUTH_SECRET = previousAuthSecret;
    }
  });

  test("PVP admission requires the exact durable policy", async () => {
    const { t, playerId, roomId } = await seedGeneration();
    await t.run(async (ctx) => {
      await ctx.db.patch(roomId, {
        mode: "pvp",
        pvpPolicy: PRIVATE_DRAFT_PVP_POLICY,
      });
    });
    const args = {
      playerId,
      worldId: "pvp:room:ABCD:g1",
      roomCode: "ABCD",
      generation: 1,
      mode: "pvp" as const,
      pvpPolicy: PRIVATE_DRAFT_PVP_POLICY,
      kitId: "gunner",
      petId: null,
    };
    await expect(t.query(generationAdmission, args)).resolves.toEqual({
      isAllowed: true,
      code: "ok",
    });
    await expect(t.query(generationAdmission, {
      ...args,
      pvpPolicy: null,
    })).resolves.toEqual({
      isAllowed: false,
      code: "policy_mismatch",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(roomId, { pvpPolicy: undefined });
    });
    await expect(t.query(generationAdmission, {
      ...args,
      pvpPolicy: null,
    })).resolves.toEqual({
      isAllowed: false,
      code: "policy_required",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(roomId, {
        mode: "coop",
        pvpPolicy: PRIVATE_DRAFT_PVP_POLICY,
      });
    });
    await expect(t.query(generationAdmission, {
      ...args,
      worldId: "room:ABCD:g1",
      mode: "coop",
      pvpPolicy: PRIVATE_DRAFT_PVP_POLICY,
    })).resolves.toEqual({
      isAllowed: false,
      code: "policy_invalid",
    });
  });

  test("browser PVP intent cannot choose policy or bypass the public rollout flag", async () => {
    const { t } = await seedGeneration();
    const args = {
      clientId: "browser-a",
      guestCapability: "guest-capability",
      kind: "online" as const,
      mode: "pvp" as const,
      kitId: "gunner",
      petId: null,
      isKitChoiceMade: true,
      isPetChoiceMade: true,
    };
    const created = await t.mutation(createRoom, args);
    await expect(t.mutation(quickPlayRoom, args)).rejects.toMatchObject({
      data: { code: "public_disabled" },
    });
    const rooms = await t.run(async (ctx) => await ctx.db.query("rooms").collect());
    expect(rooms).toHaveLength(2);
    expect(rooms.find((room) => room._id === created.roomId)?.pvpPolicy).toBe(PRIVATE_DRAFT_PVP_POLICY);
  });

  test("arena confirms an unowned cosmetic pet while co-op keeps the rescue gate", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const playerId = await ctx.db.insert("players", {
        clientId: "arena-pet-browser",
        name: "Arena Pet",
        totalKills: 0,
        deepestFloor: 0,
        totalCoins: 0,
        gamesPlayed: 0,
        unlocks: [],
        createdAt: now,
        lastSeen: now,
      });
      const roomIds = [];
      for (const mode of ["pvp", "coop"] as const) {
        const roomId = await ctx.db.insert("rooms", {
          code: mode === "pvp" ? "PETP" : "PETC",
          kind: "online",
          mode,
          ...(mode === "pvp" ? { pvpPolicy: PRIVATE_DRAFT_PVP_POLICY } : {}),
          hostPlayerId: playerId,
          seed: 1,
          floor: 1,
          status: "lobby",
          isPublic: false,
          loadoutGeneration: 1,
          generationState: "pending",
          createdAt: now,
          lastActivity: now,
        });
        await ctx.db.insert("presence", {
          roomId,
          playerId,
          name: "Arena Pet",
          x: 0,
          y: 0,
          facing: 1,
          hp: 6,
          maxHp: 6,
          weapon: "pistol",
          floor: 1,
          isDown: false,
          aimAngle: 0,
          shotSeq: 0,
          kills: 0,
          colorIndex: 0,
          reviveNonce: 0,
          updatedAt: now,
          loadoutKitId: "mender",
          loadoutPetId: "pebble",
          isKitChoiceMade: true,
          isPetChoiceMade: true,
          loadoutGeneration: 1,
          loadoutEditRevision: 1,
        });
        roomIds.push(roomId);
      }
      await ctx.db.insert("guestSessions", {
        token: "arena-pet-capability",
        refreshToken: "arena-pet-refresh",
        clientId: "arena-pet-browser",
        playerId,
        scopes: ["profile", "room", "ticket", "economy"],
        createdAt: now,
        expiresAt: now + 60_000,
        refreshExpiresAt: now + 120_000,
      });
      return { pvpRoomId: roomIds[0], coopRoomId: roomIds[1] };
    });
    const caller = {
      clientId: "arena-pet-browser",
      guestCapability: "arena-pet-capability",
      generation: 1,
      editRevision: 1,
    };
    await expect(t.mutation(confirmRoomLoadout, {
      ...caller,
      roomId: seeded.pvpRoomId,
    })).resolves.toMatchObject({
      ok: true,
      kitId: "mender",
      petId: "pebble",
    });
    await expect(t.mutation(confirmRoomLoadout, {
      ...caller,
      roomId: seeded.coopRoomId,
    })).resolves.toEqual({
      ok: false,
      reason: "pet_unowned",
      message: "Rescue that pet before choosing it",
    });
  });

  test("concurrent online joins admit exactly four durable members", async () => {
    const { t, roomId } = await seedGeneration();
    const joiners = await t.run(async (ctx) => {
      const now = Date.now();
      const out: Array<{ clientId: string; token: string }> = [];
      for (let index = 2; index <= 6; index++) {
        const clientId = `cap-browser-${index}`;
        const playerId = await ctx.db.insert("players", {
          clientId,
          name: `Cap ${index}`,
          totalKills: 0,
          deepestFloor: 0,
          totalCoins: 0,
          gamesPlayed: 0,
          unlocks: [],
          createdAt: now,
          lastSeen: now,
        });
        const token = `cap-token-${index}`;
        await ctx.db.insert("guestSessions", {
          token,
          refreshToken: `cap-refresh-${index}`,
          clientId,
          playerId,
          scopes: ["profile", "room", "ticket", "economy"],
          createdAt: now,
          expiresAt: now + 60_000,
          refreshExpiresAt: now + 120_000,
        });
        out.push({ clientId, token });
      }
      return out;
    });
    const results = await Promise.allSettled(joiners.map(({ clientId, token }) =>
      t.mutation(joinRoom, {
        code: "ABCD",
        clientId,
        guestCapability: token,
        kind: "online",
        kitId: "gunner",
        petId: null,
        isKitChoiceMade: true,
        isPetChoiceMade: true,
      })
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    const members = await t.run(async (ctx) =>
      await ctx.db.query("presence").withIndex("by_room", (queryBuilder) =>
        queryBuilder.eq("roomId", roomId)
      ).collect()
    );
    expect(members.filter((member) => member.isDeparted !== true)).toHaveLength(4);
  });

  test("public client-authored progress mutations fail closed", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(recordRun, {
      clientId: "browser-a",
      floor: 999,
      kills: 999,
      coins: 999,
    })).rejects.toThrow();
    await expect(t.mutation(recordFloorProgress, {
      clientId: "browser-a",
      floor: 999,
    })).rejects.toThrow();
  });

  test("a retained guest capability cannot write an account after sign-out", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", { name: "Account" });
      const playerId = await ctx.db.insert("players", {
        clientId: "browser-account",
        userId,
        name: "Account",
        totalKills: 0,
        deepestFloor: 0,
        totalCoins: 0,
        gamesPlayed: 0,
        unlocks: [],
        createdAt: now,
        lastSeen: now,
      });
      await ctx.db.insert("guestSessions", {
        token: "retained-capability",
        refreshToken: "retained-refresh-capability",
        clientId: "browser-account",
        playerId,
        scopes: ["profile", "room", "ticket", "economy"],
        createdAt: now,
        expiresAt: now + 60_000,
        refreshExpiresAt: now + 120_000,
      });
    });
    await expect(t.mutation(buyNode, {
      clientId: "browser-account",
      guestCapability: "retained-capability",
      nodeId: "camp_shell",
    })).rejects.toThrow();
  });

  test("expired access rotates only through a live refresh capability", async () => {
    const t = convexTest(schema, modules);
    const playerId = await t.run(async (ctx) => {
      const now = Date.now();
      const id = await ctx.db.insert("players", {
        clientId: "refresh-browser",
        name: "Guest",
        totalKills: 0,
        deepestFloor: 0,
        totalCoins: 0,
        gamesPlayed: 0,
        unlocks: [],
        createdAt: now,
        lastSeen: now,
      });
      await ctx.db.insert("guestSessions", {
        token: "expired-access",
        refreshToken: "live-refresh",
        clientId: "refresh-browser",
        playerId: id,
        scopes: ["profile", "room", "ticket", "economy"],
        createdAt: now - 120_000,
        expiresAt: now - 60_000,
        refreshExpiresAt: now + 60_000,
      });
      return id;
    });
    const rotated = await t.mutation(ensurePlayer, {
      clientId: "refresh-browser",
      guestCapability: "expired-access",
      guestRefreshCapability: "live-refresh",
      name: "Guest",
    });
    expect(rotated.playerId).toBe(playerId);
    expect(rotated.guestCapability).toMatch(/^[a-f0-9]{64}$/);
    expect(rotated.guestRefreshCapability).toMatch(/^[a-f0-9]{64}$/);
    await t.run(async (ctx) => {
      const sessions = await ctx.db.query("guestSessions")
        .withIndex("by_player", (queryBuilder) => queryBuilder.eq("playerId", playerId))
        .collect();
      const active = sessions.find((session) => session.revokedAt === undefined);
      if (!active) throw new Error("rotated session missing");
      await ctx.db.patch(active._id, {
        expiresAt: Date.now() - 1,
        refreshExpiresAt: Date.now() - 1,
      });
    });
    await expect(t.mutation(ensurePlayer, {
      clientId: "refresh-browser",
      guestCapability: rotated.guestCapability,
      guestRefreshCapability: rotated.guestRefreshCapability,
      name: "Guest",
    })).rejects.toThrow();
  });

  test("sign-out rotates the browser onto a separate guest capability", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", { name: "Account" });
      const accountId = await ctx.db.insert("players", {
        clientId: "signout-browser",
        userId,
        name: "Account",
        totalKills: 0,
        deepestFloor: 0,
        totalCoins: 0,
        gamesPlayed: 0,
        unlocks: [],
        createdAt: now,
        lastSeen: now,
      });
      return { userId, accountId };
    });
    const authenticated = t.withIdentity({ subject: `${seeded.userId}|test-session` });
    const guest = await authenticated.mutation(prepareSignOutGuest, {
      clientId: "signout-browser",
      name: "Guest",
    });
    expect(guest.isAccount).toBe(false);
    expect(guest.playerId).not.toBe(seeded.accountId);
    expect(guest.guestCapability).toMatch(/^[a-f0-9]{64}$/);
    const refreshed = await t.mutation(ensurePlayer, {
      clientId: "signout-browser",
      guestCapability: guest.guestCapability,
      name: "Guest",
    });
    expect(refreshed.playerId).toBe(guest.playerId);
    const account = await t.run(async (ctx) => await ctx.db.get(seeded.accountId));
    expect(account?.clientId).toBeUndefined();
  });

  test("guest merge is atomic and blocked while room references are active", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const userId = await ctx.db.insert("users", { name: "Account" });
      const accountId = await ctx.db.insert("players", {
        clientId: "account-browser",
        userId,
        name: "Account",
        totalKills: 0,
        deepestFloor: 0,
        totalCoins: 0,
        gamesPlayed: 0,
        unlocks: [],
        createdAt: now,
        lastSeen: now,
      });
      const guestId = await ctx.db.insert("players", {
        clientId: "guest-browser",
        name: "Guest",
        totalKills: 0,
        deepestFloor: 0,
        totalCoins: 0,
        gamesPlayed: 0,
        unlocks: [],
        createdAt: now,
        lastSeen: now,
      });
      const roomId = await ctx.db.insert("rooms", {
        code: "MERG",
        kind: "online",
        mode: "coop",
        hostPlayerId: guestId,
        seed: 1,
        floor: 1,
        status: "playing",
        isPublic: false,
        loadoutGeneration: 1,
        generationState: "active",
        createdAt: now,
        lastActivity: now,
      });
      await ctx.db.insert("presence", {
        roomId,
        playerId: guestId,
        name: "Guest",
        x: 0,
        y: 0,
        facing: 1,
        hp: 6,
        maxHp: 6,
        weapon: "pistol",
        floor: 1,
        isDown: false,
        aimAngle: 0,
        shotSeq: 0,
        kills: 0,
        colorIndex: 0,
        reviveNonce: 0,
        updatedAt: now,
      });
      return { userId, accountId, guestId, roomId };
    });
    const authenticated = t.withIdentity({ subject: `${seeded.userId}|test-session` });
    await expect(authenticated.mutation(ensurePlayer, {
      clientId: "guest-browser",
      name: "Guest",
    })).rejects.toThrow();
    const state = await t.run(async (ctx) => ({
      account: await ctx.db.get(seeded.accountId),
      guest: await ctx.db.get(seeded.guestId),
      room: await ctx.db.get(seeded.roomId),
      presence: await ctx.db.query("presence").collect(),
    }));
    expect(state.account).not.toBeNull();
    expect(state.guest).not.toBeNull();
    expect(state.room?.hostPlayerId).toBe(seeded.guestId);
    expect(state.presence[0]?.playerId).toBe(seeded.guestId);
  });

  test("legacy generation migration requires an explicit drained-world assertion", async () => {
    const t = convexTest(schema, modules);
    const { roomId, legacyPvpRoomId } = await t.run(async (ctx) => {
      const now = Date.now();
      const playerId = await ctx.db.insert("players", {
        clientId: "legacy-browser",
        name: "Legacy",
        totalKills: 0,
        deepestFloor: 0,
        totalCoins: 0,
        gamesPlayed: 0,
        unlocks: [],
        createdAt: now,
        lastSeen: now,
      });
      const roomId = await ctx.db.insert("rooms", {
        code: "OLDX",
        kind: "online",
        mode: "coop",
        hostPlayerId: playerId,
        seed: 1,
        floor: 1,
        status: "playing",
        isPublic: false,
        loadoutGeneration: 1,
        createdAt: now,
        lastActivity: now,
      });
      const legacyPvpRoomId = await ctx.db.insert("rooms", {
        code: "OLDP",
        kind: "online",
        mode: "pvp",
        hostPlayerId: playerId,
        seed: 2,
        floor: 1,
        status: "playing",
        isPublic: false,
        loadoutGeneration: 1,
        createdAt: now,
        lastActivity: now,
      });
      return { roomId, legacyPvpRoomId };
    });
    await expect(t.mutation(backfillGenerationState, {
      isLegacyWorldsDrained: false,
    })).rejects.toThrow();
    await expect(t.mutation(backfillGenerationState, {
      isLegacyWorldsDrained: true,
    })).resolves.toBe(2);
    const { room, legacyPvpRoom } = await t.run(async (ctx) => ({
      room: await ctx.db.get(roomId),
      legacyPvpRoom: await ctx.db.get(legacyPvpRoomId),
    }));
    expect(room?.generationState).toBe("completed");
    expect(legacyPvpRoom?.generationState).toBe("completed");
    expect(legacyPvpRoom?.pvpPolicy).toBeUndefined();
  });
});
