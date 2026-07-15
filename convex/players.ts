import { mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { sanitizeEquip, earnedCosmeticsFor, COSMETIC_SLOTS } from "./cosmeticsCore";
import type { CosmeticLoadout } from "./cosmeticsCore";
import { foldBestRun, mergeBestRun, syncIdentity } from "./leaderboard";
import type { RunBuild } from "./leaderboard";
import { masteryXpForReachedFloor, masteryLevelForXp } from "./masteryCore";
import { bankedRunAmber, firstBossAmber, isBossKindId } from "../src/sim/balance.js";
import { canBuyNode, isPetOwned, CAMP_SHELL_ID, rescueNodesForRun } from "../src/sim/camp_nodes.js";
import { validateCombinedLoadout } from "./loadoutCore";
import {
  activeGuestSession,
  mintGuestSession,
  resolveAuthorizedPlayer,
  revokePlayerGuestSessions,
} from "./guestAuth";
import type { GuestScope } from "./guestAuth";

export interface Profile {
  playerId: string;
  name: string;
  // Chosen blob tint (client palette index); null until the player picks one.
  colorIndex: number | null;
  // Equipped visual-only cosmetic loadout; null slots render the classic blob.
  cosmetics: CosmeticLoadout;
  totalKills: number;
  deepestFloor: number;
  totalCoins: number;
  gamesPlayed: number;
  // The persistent currency: banked SERVER-SIDE at run end from run PROGRESS (floors, depth,
  // first-boss) + the premium cache trickle, and spent at the Camp on nodes/pets (buyNode).
  amber: number;
  unlocks: string[];
  // The equipped cosmetic companion pet id (WAVE 1), or null for none. Visual-only.
  equippedPet: string | null;
  // Convenience only: the last combined-gate kit, used to preselect the next gate.
  lastKitId: string | null;
  // Account MASTERY (KIT/XP spec §4): the persistent ACCESS track. masteryXp is the lifetime
  // total; masteryLevel is the derived level the lobby reads to gate kit selection. Never a
  // currency, never spendable.
  masteryXp: number;
  masteryLevel: number;
  // Present when the row is linked to a signed-in account (Google avatar URL).
  image?: string;
  // True when this stats row is account-backed rather than guest-only.
  isAccount: boolean;
  // Returned only when a new/rotated guest session is issued.
  guestCapability?: string;
}

function toProfile(
  doc: Doc<"players">,
  user?: Doc<"users"> | null,
  guestCapability?: string,
): Profile {
  return {
    playerId: doc._id,
    name: doc.name,
    colorIndex: doc.colorIndex ?? null,
    cosmetics: {
      hat: doc.cosmeticLoadout?.hat ?? null,
      face: doc.cosmeticLoadout?.face ?? null,
      body: doc.cosmeticLoadout?.body ?? null,
      title: doc.cosmeticLoadout?.title ?? null,
    },
    totalKills: doc.totalKills,
    deepestFloor: doc.deepestFloor,
    totalCoins: doc.totalCoins,
    gamesPlayed: doc.gamesPlayed,
    amber: doc.amber ?? 0,
    unlocks: doc.unlocks,
    equippedPet: doc.equippedPet ?? null,
    lastKitId: doc.lastKitId ?? null,
    masteryXp: doc.masteryXp ?? 0,
    masteryLevel: masteryLevelForXp(doc.masteryXp ?? 0),
    image: user?.image,
    isAccount: doc.userId !== undefined,
    ...(guestCapability ? { guestCapability } : {}),
  };
}

// Names render on other players' screens and on the public leaderboard: strip control
// characters, collapse whitespace runs, clamp length (mirrors the game server's
// sanitizeDisplayName). All UI rendering is textContent-only, so markup is inert data —
// this keeps stored names clean rather than trusting every consumer.
function cleanName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 20) || "blob";
}

// Clamp a chosen color to a sane palette range; undefined = "no pick", never a write.
function cleanColor(colorIndex: number | undefined): number | undefined {
  if (colorIndex === undefined || !Number.isInteger(colorIndex)) return undefined;
  return Math.min(15, Math.max(0, colorIndex));
}

// The wire shape of an explicit loadout pick: per-slot, "none" clears the slot, an id
// equips it (validated against ownership + slot), absent = "don't touch" (like colorIndex).
type CosmeticsPick = { hat?: string; face?: string; body?: string; title?: string };
type StoredLoadout = { hat?: string; face?: string; body?: string; title?: string };

// The stored-loadout patch for an explicit pick, or undefined when nothing valid changed.
// Locked/unknown/mis-slotted ids are IGNORED (never stored), so a tampered client can't
// fake-equip — ownership + slot validation is the server's authority here.
function cosmeticsPatch(
  row: Doc<"players">,
  pick: CosmeticsPick | undefined,
): StoredLoadout | undefined {
  if (!pick) return undefined;
  const current: StoredLoadout = { ...(row.cosmeticLoadout ?? {}) };
  const next: StoredLoadout = { ...current };
  for (const { slot } of COSMETIC_SLOTS) {
    const raw = pick[slot];
    if (raw === undefined) continue;
    if (raw === "none") { delete next[slot]; continue; }
    const valid = sanitizeEquip(slot, raw, row.unlocks);
    if (valid !== undefined) next[slot] = valid;
  }
  const isSame = COSMETIC_SLOTS.every(({ slot }) => next[slot] === current[slot]);
  return isSame ? undefined : next;
}

async function findByClientId(ctx: QueryCtx, clientId: string): Promise<Doc<"players"> | null> {
  return await ctx.db
    .query("players")
    .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
    .unique();
}

async function findByUserId(ctx: QueryCtx, userId: Id<"users">): Promise<Doc<"players"> | null> {
  return await ctx.db
    .query("players")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

// Resolve the stats row for the caller: the account row when signed in, else the
// guest row for this browser's clientId. Returns the matching `users` doc too so
// callers can surface the account's display name / avatar.
async function resolveRow(
  ctx: QueryCtx,
  clientId: string,
  guestCapability: string | undefined,
): Promise<{ row: Doc<"players"> | null; user: Doc<"users"> | null }> {
  const userId = await getAuthUserId(ctx);
  if (userId) {
    return { row: await findByUserId(ctx, userId), user: await ctx.db.get(userId) };
  }
  return {
    row: await resolveAuthorizedPlayer(ctx, clientId, guestCapability, "profile"),
    user: null,
  };
}

const ZERO_STATS = {
  totalKills: 0,
  deepestFloor: 0,
  totalCoins: 0,
  gamesPlayed: 0,
  unlocks: [] as string[],
};

async function guardAndRewireGuestReferences(
  ctx: MutationCtx,
  guest: Doc<"players">,
  account: Doc<"players">,
): Promise<void> {
  const hostedRooms = await ctx.db.query("rooms")
    .withIndex("by_host", (queryBuilder) => queryBuilder.eq("hostPlayerId", guest._id))
    .collect();
  for (const room of hostedRooms) {
    if (room.status !== "ended") {
      throw new ConvexError({
        code: "guest_active_in_room",
        message: "leave the active room before signing in",
      });
    }
    await ctx.db.patch(room._id, { hostPlayerId: account._id });
  }

  const rows = await ctx.db.query("presence")
    .withIndex("by_player", (queryBuilder) => queryBuilder.eq("playerId", guest._id))
    .collect();
  for (const row of rows) {
    const room = await ctx.db.get(row.roomId);
    if (room && room.status !== "ended" && row.isDeparted !== true) {
      throw new ConvexError({
        code: "guest_active_in_room",
        message: "leave the active room before signing in",
      });
    }
    const accountRow = await ctx.db.query("presence")
      .withIndex("by_room_player", (queryBuilder) => (
        queryBuilder.eq("roomId", row.roomId).eq("playerId", account._id)
      ))
      .unique();
    if (accountRow) await ctx.db.delete(row._id);
    else await ctx.db.patch(row._id, { playerId: account._id });
  }
}

// Fold an unowned guest row into an EXISTING account row (the second-device sign-in path:
// the account already has its row, but this browser accrued guest progress before signing
// in). The merge policy is DETERMINISTIC and never silently drops the richer side: stats
// sum/max, unlocks union, appearance fills only EMPTY account slots (an account's own
// loadout wins; the guest's items stay owned via the union), and the guest's charted run
// merges by the same better-run rule the leaderboard uses. The guest row is then DELETED —
// that single transactional delete is what makes the link exactly-once/idempotent AND
// multi-tab safe: Convex serializes mutations, so a second tab's concurrent link finds no
// guest row and no-ops instead of double-crediting. A mid-link failure aborts the whole
// transaction, leaving the guest save untouched (there is no partially-merged state).
async function absorbGuestRow(
  ctx: MutationCtx,
  account: Doc<"players">,
  guest: Doc<"players">,
): Promise<Doc<"players">> {
  await guardAndRewireGuestReferences(ctx, guest, account);
  const merged = {
    totalKills: account.totalKills + guest.totalKills,
    totalCoins: account.totalCoins + guest.totalCoins,
    deepestFloor: Math.max(account.deepestFloor, guest.deepestFloor),
    gamesPlayed: account.gamesPlayed + guest.gamesPlayed,
    amber: (account.amber ?? 0) + (guest.amber ?? 0),
    unlocks: [...new Set([...account.unlocks, ...guest.unlocks])],
    ...(account.colorIndex === undefined && guest.colorIndex !== undefined ? { colorIndex: guest.colorIndex } : {}),
    ...(account.cosmeticLoadout === undefined && guest.cosmeticLoadout !== undefined ? { cosmeticLoadout: guest.cosmeticLoadout } : {}),
    ...(account.equippedPet === undefined && guest.equippedPet !== undefined ? { equippedPet: guest.equippedPet } : {}),
    ...(account.lastKitId === undefined && guest.lastKitId !== undefined ? { lastKitId: guest.lastKitId } : {}),
    // The account row adopts this browser's clientId (when free) so guest play after a
    // sign-out keeps accruing onto the same identity — the first-sign-in semantics.
    ...(account.clientId === undefined ? { clientId: guest.clientId } : {}),
  };
  await ctx.db.patch(account._id, merged);
  const updated = (await ctx.db.get(account._id))!;
  await mergeBestRun(ctx, guest, updated);
  await revokePlayerGuestSessions(ctx, guest._id);
  await ctx.db.delete(guest._id);
  return updated;
}

// Get-or-create the account-backed stats row for a signed-in user. Idempotent, so it's
// safe to call from both the login (ensurePlayer) and the run-save (recordRun) paths —
// which means saving a run never silently no-ops just because login hadn't run first.
//
// On first creation it adopts this browser's *unowned* guest row (migrating its
// all-time stats onto the account); when the account row ALREADY exists, an unowned
// guest row with progress is absorbed instead (see absorbGuestRow). A guest row owned
// by someone else is never hijacked, and the unique `by_clientId` invariant is preserved
// by not re-claiming an already-owned clientId.
async function ensureAccountRow(
  ctx: MutationCtx,
  userId: Id<"users">,
  clientId: string,
  fallbackName: string,
): Promise<{ row: Doc<"players">; user: Doc<"users"> | null }> {
  const user = await ctx.db.get(userId);
  const accountName = cleanName(user?.name ?? fallbackName);
  const now = Date.now();

  const existing = await findByUserId(ctx, userId);
  if (existing) {
    await revokePlayerGuestSessions(ctx, existing._id);
    const guest = await findByClientId(ctx, clientId);
    if (guest && guest.userId === undefined && guest._id !== existing._id) {
      const absorbed = await absorbGuestRow(ctx, existing, guest);
      // The chosen customName wins; only fall back to the Google name when none is set —
      // a login/run-save must never revert a deliberately chosen display name.
      const name = absorbed.customName ?? accountName;
      await ctx.db.patch(absorbed._id, { name, lastSeen: now });
      return { row: { ...absorbed, name, lastSeen: now }, user };
    }
    const name = existing.customName ?? accountName;
    await ctx.db.patch(existing._id, { name, lastSeen: now });
    return { row: { ...existing, name, lastSeen: now }, user };
  }

  const guest = await findByClientId(ctx, clientId);
  if (guest && guest.userId === undefined) {
    // A fresh guest->account link: guests never carry a customName, so the account adopts
    // the Google name (respect any customName defensively, though it should be absent).
    const name = guest.customName ?? accountName;
    await ctx.db.patch(guest._id, { userId, name, lastSeen: now });
    await revokePlayerGuestSessions(ctx, guest._id);
    return { row: { ...guest, userId, name, lastSeen: now }, user };
  }

  const id = await ctx.db.insert("players", {
    clientId: guest ? undefined : clientId,
    userId,
    name: accountName,
    ...ZERO_STATS,
    createdAt: now,
    lastSeen: now,
  });
  return { row: (await ctx.db.get(id))!, user };
}

// Apply the optional explicit appearance picks (color + cosmetics) to a resolved row,
// returning the updated doc.
async function applyAppearance(
  ctx: MutationCtx,
  row: Doc<"players">,
  color: number | undefined,
  cosmetics: CosmeticsPick | undefined,
): Promise<Doc<"players">> {
  const patch: { colorIndex?: number; cosmeticLoadout?: StoredLoadout } = {};
  if (color !== undefined && row.colorIndex !== color) patch.colorIndex = color;
  const nextLoadout = cosmeticsPatch(row, cosmetics);
  if (nextLoadout !== undefined) patch.cosmeticLoadout = nextLoadout;
  if (Object.keys(patch).length === 0) return row;
  await ctx.db.patch(row._id, patch);
  return { ...row, ...patch };
}

// Upsert the caller's player row, returning the saved profile. This is the "login":
// called on boot with the localStorage clientId + chosen name (+ optionally the chosen
// blob color / cosmetics — only ever written when the player has explicitly picked, so
// logging in from a fresh browser can never clobber an account's saved appearance).
//
// - Guest (no auth token): upserts by clientId, exactly as before.
// - Signed in: keys off the authenticated userId (see ensureAccountRow).
export const ensurePlayer = mutation({
  args: {
    clientId: v.string(),
    guestCapability: v.optional(v.string()),
    name: v.string(),
    colorIndex: v.optional(v.number()),
    cosmetics: v.optional(v.object({
      hat: v.optional(v.string()),
      face: v.optional(v.string()),
      body: v.optional(v.string()),
      title: v.optional(v.string()),
    })),
  },
  handler: async (ctx, { clientId, guestCapability, name, colorIndex, cosmetics }) => {
    const color = cleanColor(colorIndex);
    const userId = await getAuthUserId(ctx);
    if (userId) {
      const { row, user } = await ensureAccountRow(ctx, userId, clientId, name);
      const updated = await applyAppearance(ctx, row, color, cosmetics);
      // Renames/re-equips reflect onto the public leaderboard row (no-op when unchanged).
      await syncIdentity(ctx, updated);
      return toProfile(updated, user);
    }

    // Guest path (unchanged behaviour, plus the optional appearance picks).
    const now = Date.now();
    const trimmed = cleanName(name);
    const existing = await findByClientId(ctx, clientId);
    if (existing) {
      if (existing.userId !== undefined) {
        throw new ConvexError({
          code: "account_auth_required",
          message: "sign in to access this account",
        });
      }
      let nextCapability: string | undefined;
      const activeSession = await activeGuestSession(ctx, existing._id);
      if (activeSession) {
        await resolveAuthorizedPlayer(ctx, clientId, guestCapability, "profile");
      } else {
        const sessions = await ctx.db.query("guestSessions")
          .withIndex("by_player", (queryBuilder) => queryBuilder.eq("playerId", existing._id))
          .collect();
        if (sessions.length > 0) {
          const renewal = guestCapability
            ? await ctx.db.query("guestSessions")
              .withIndex("by_token", (queryBuilder) => queryBuilder.eq("token", guestCapability))
              .unique()
            : null;
          if (!renewal
            || renewal.playerId !== existing._id
            || renewal.clientId !== clientId
            || renewal.revokedAt !== undefined) {
            throw new ConvexError({
              code: "guest_capability_required",
              message: "guest session expired — start a new guest",
            });
          }
        }
        nextCapability = await mintGuestSession(ctx, existing, clientId);
      }
      await ctx.db.patch(existing._id, { name: trimmed, lastSeen: now });
      const updated = await applyAppearance(ctx, { ...existing, name: trimmed, lastSeen: now }, color, cosmetics);
      await syncIdentity(ctx, updated);
      return toProfile(updated, null, nextCapability);
    }
    const id = await ctx.db.insert("players", {
      clientId,
      name: trimmed,
      ...(color !== undefined ? { colorIndex: color } : {}),
      ...ZERO_STATS,
      createdAt: now,
      lastSeen: now,
    });
    const inserted = (await ctx.db.get(id))!;
    const updated = await applyAppearance(ctx, inserted, undefined, cosmetics);
    const nextCapability = await mintGuestSession(ctx, updated, clientId);
    return toProfile(updated, null, nextCapability);
  },
});

// Bank the deepest floor a run has reached, PROGRESSIVELY, on each descend — the fix for
// depth that never charted because recordRun only fires on a clean full-party-wipe game
// over (a death-while-teammates-continue, a disconnect, or a quit all skipped it, so the
// board showed a stale floor). Deliberately NARROW: it only raises deepestFloor via
// Math.max and folds the floor into the leaderboard (foldFloorProgress). It must NOT do
// what recordRun does — no gamesPlayed increment, no kills/coins summing, no cosmetic
// unlock grants, no amber — because those are per-RUN, not per-floor, and would multiply
// wildly across a descent. Idempotent by Math.max: re-banking the same floor is a no-op,
// so a run that later disconnects still keeps the depth it already reached.
export const recordFloorProgress = mutation({
  args: { clientId: v.string(), floor: v.number() },
  handler: async () => {
    throw new ConvexError({
      code: "verified_receipt_required",
      message: "progress requires a verified game-server receipt",
    });
  },
});

export const getProfile = query({
  args: { clientId: v.string(), guestCapability: v.optional(v.string()) },
  handler: async (ctx, { clientId, guestCapability }) => {
    const { row, user } = await resolveRow(ctx, clientId, guestCapability);
    return row ? toProfile(row, user) : null;
  },
});

// The signed-in account's display name + avatar, independent of stats (so the menu
// can show the account chip before the player has completed any run). Null for guests.
export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    return { name: user.name ?? null, email: user.email ?? null, image: user.image ?? null };
  },
});

export const prepareSignOutGuest = mutation({
  args: { clientId: v.string(), name: v.string() },
  handler: async (ctx, { clientId, name }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new ConvexError({ code: "auth_required", message: "sign in before preparing sign out" });
    }
    const account = await findByUserId(ctx, userId);
    if (!account) {
      throw new ConvexError({ code: "player_missing", message: "account profile not found" });
    }
    if (account.clientId === clientId) await ctx.db.patch(account._id, { clientId: undefined });
    const existing = await findByClientId(ctx, clientId);
    let guest: Doc<"players">;
    if (existing) {
      if (existing.userId !== undefined) {
        throw new ConvexError({ code: "client_id_in_use", message: "guest identity is unavailable" });
      }
      guest = existing;
    } else {
      const now = Date.now();
      const guestId = await ctx.db.insert("players", {
        clientId,
        name: cleanName(name),
        ...ZERO_STATS,
        createdAt: now,
        lastSeen: now,
      });
      guest = (await ctx.db.get(guestId))!;
    }
    const guestCapability = await mintGuestSession(ctx, guest, clientId);
    return toProfile(guest, null, guestCapability);
  },
});

// Set a signed-in account's chosen display name (the override that beats the Google name).
// Authenticated only: guests keep editing their name through ensurePlayer as before. The
// name is sanitized the same way every stored name is (trim/collapse/strip control chars,
// cap 20); an empty or literal-"blob" result is REJECTED — the standing name is kept and the
// current profile returned unchanged, so a custom name can never be blanked or become "blob".
// On success both `customName` (the durable override) and `name` (the effective display field
// every consumer reads) are set, so login/recordRun's ensureAccountRow never reverts it.
export const setCustomName = mutation({
  args: { clientId: v.string(), name: v.string() },
  handler: async (ctx, { clientId, name }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const { row, user } = await ensureAccountRow(ctx, userId, clientId, "blob");
    const cleaned = cleanName(name);
    if (cleaned.toLowerCase() === "blob") return toProfile(row, user);
    await ctx.db.patch(row._id, { customName: cleaned, name: cleaned, lastSeen: Date.now() });
    const updated = { ...row, customName: cleaned, name: cleaned };
    // Keep the public leaderboard row's display name in step (no-op when uncharted).
    await syncIdentity(ctx, updated);
    return toProfile(updated, user);
  },
});

export interface RunArgs {
  floor: number;
  kills: number;
  coins: number;
  // Authoritative run FACTS the Amber bank is computed from (never a client-authored amber
  // number). floorsCleared is clamped to the deepest floor server-side; bossKills is filtered
  // to real boss kinds; the two cache flags mirror the premium economy's armed cache/windfall.
  floorsCleared: number;
  bossKills: string[];
  isCacheArmed: boolean;
  amberWindfall: number;
  isReturn: boolean;
  durationMs: number;
  build: RunBuild;
}

// The per-account first-kill flag for a boss kind (colon-namespaced, like discover:melee).
function bossKillFlag(kind: string): string {
  return "bosskill:" + kind;
}

// Defensive per-run bank ceiling: the pure math is deterministic, but this bounds a tampered
// client that inflates the run facts. A legit deep clear (F100+ plus every first-boss) sits
// comfortably under it.
const AMBER_RUN_CAP = 1000;

export async function foldVerifiedRun(
  ctx: MutationCtx,
  doc: Doc<"players">,
  run: RunArgs,
): Promise<Doc<"players"> | null> {
  // SERVER-AUTHORITATIVE Amber (the client never authors the number): the recurring run pool
  // banked at the outcome fraction, plus one-time first-boss grants at full.
  const floorsCleared = Math.max(0, Math.min(Math.floor(run.floorsCleared), Math.max(0, Math.floor(run.floor))));
  const runPool = bankedRunAmber({
    floorsCleared,
    deepestFloor: run.floor,
    unspentCoins: run.coins,
    isCacheArmed: run.isCacheArmed,
    windfall: run.amberWindfall,
  }, run.isReturn);
  // First-boss: one-time per boss KIND per account, banked at full (exempt from the wipe cut).
  const newBossKinds = [...new Set(run.bossKills)].filter(
    (k) => isBossKindId(k) && !doc.unlocks.includes(bossKillFlag(k)),
  );
  const bankedAmber = Math.max(0, Math.min(AMBER_RUN_CAP, runPool + firstBossAmber(newBossKinds)));
  const nextAmber = (doc.amber ?? 0) + bankedAmber;

  const totals = {
    totalKills: doc.totalKills + Math.max(0, run.kills),
    totalCoins: doc.totalCoins + Math.max(0, run.coins),
    deepestFloor: Math.max(doc.deepestFloor, run.floor),
    gamesPlayed: doc.gamesPlayed + 1,
    amber: nextAmber,
    // Account MASTERY XP (KIT/XP spec §4): granted every run from run performance (derived
    // from the deepest floor reached — a cleared floor always pays, win or lose). Access-only:
    // it unlocks kits, never a stat or a spendable balance.
    masteryXp: (doc.masteryXp ?? 0) + masteryXpForReachedFloor(run.floor),
  };
  // Earned cosmetics unlock off the post-fold all-time stats (the one grant path).
  const earned = earnedCosmeticsFor(totals).filter((id) => !doc.unlocks.includes(id));
  // Meta unlocks: the per-boss first-kill flags, plus the free Amber Camp shell the first time
  // this account banks any Amber (the loop's entry point).
  const metaUnlocks = newBossKinds.map(bossKillFlag);
  if (nextAmber > 0 && !doc.unlocks.includes(CAMP_SHELL_ID)) metaUnlocks.push(CAMP_SHELL_ID);
  // Companion pets are RESCUED, not bought (studio hard line): each is a one-time account
  // unlock granted like an achievement the first time a run reaches its rescue floor (doggie
  // shallow, cat + baby dragon deeper). The Kennel then adopts/equips them; Amber never buys a
  // pet. Data-driven from CAMP_NODES so a new rescue pet grants here with no code change.
  for (const nodeId of rescueNodesForRun(run.floor)) {
    if (!doc.unlocks.includes(nodeId)) metaUnlocks.push(nodeId);
  }
  const addedUnlocks = [...earned, ...metaUnlocks].filter((id) => !doc.unlocks.includes(id));
  await ctx.db.patch(doc._id, {
    ...totals,
    ...(addedUnlocks.length > 0 ? { unlocks: [...doc.unlocks, ...addedUnlocks] } : {}),
    lastSeen: Date.now(),
  });
  const updated = await ctx.db.get(doc._id);
  if (updated) await foldBestRun(ctx, updated, run);
  return updated;
}

// Fold a finished run into the caller's all-time stats + the global leaderboard (called on
// game over). Amber is computed SERVER-SIDE from the run facts here — a client can never mint
// it. Signed in: folds into the account row, creating/migrating it if login hadn't yet (so a
// run is never lost to a startup race). Guest: folds into the existing clientId row, or no-ops
// if there isn't one. Every gameplay-fact arg is optional so an older client still records.
export const recordRun = mutation({
  args: {
    clientId: v.string(),
    floor: v.number(),
    kills: v.number(),
    coins: v.number(),
    // The authoritative run facts (see RunArgs). All optional for forward-compat.
    floorsCleared: v.optional(v.number()),
    bossKills: v.optional(v.array(v.string())),
    isCacheArmed: v.optional(v.boolean()),
    amberWindfall: v.optional(v.number()),
    outcome: v.optional(v.union(v.literal("death"), v.literal("return"))),
    // Deprecated: a legacy client-authored amber value. Accepted but IGNORED — Amber is
    // computed server-side now, so a tampered client can no longer author it.
    amber: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    build: v.optional(v.object({
      weapons: v.array(v.string()),
      items: v.array(v.object({ id: v.string(), count: v.number() })),
    })),
  },
  handler: async () => {
    throw new ConvexError({
      code: "verified_receipt_required",
      message: "progress requires a verified game-server receipt",
    });
  },
});

// ---- WAVE 1: the Camp SPEND + pet equip (server-authoritative, reject client-authored amber) ----

// Resolve the caller's stats row (account-first, else guest by clientId) for a write mutation.
async function resolveWriteRow(
  ctx: MutationCtx,
  clientId: string,
  guestCapability: string | undefined,
  scope: GuestScope,
): Promise<Doc<"players">> {
  return await resolveAuthorizedPlayer(ctx, clientId, guestCapability, scope);
}

export const confirmRunLoadout = mutation({
  args: {
    clientId: v.string(),
    guestCapability: v.optional(v.string()),
    kitId: v.string(),
    petId: v.union(v.string(), v.null()),
    isKitChoiceMade: v.boolean(),
    isPetChoiceMade: v.boolean(),
  },
  handler: async (ctx, { clientId, guestCapability, kitId, petId, isKitChoiceMade, isPetChoiceMade }) => {
    const row = await resolveWriteRow(ctx, clientId, guestCapability, "profile");
    const validation = validateCombinedLoadout(row, {
      kitId, petId, isKitChoiceMade, isPetChoiceMade,
    });
    if (!validation.ok) {
      return {
        ok: false as const,
        reason: validation.reason,
        profile: await ensureProfileView(ctx, row),
      };
    }
    await ctx.db.patch(row._id, {
      lastKitId: validation.kitId,
      equippedPet: validation.petId ?? undefined,
      lastSeen: Date.now(),
    });
    const updated = (await ctx.db.get(row._id))!;
    return { ok: true as const, profile: await ensureProfileView(ctx, updated) };
  },
});

// Buy an Amber Camp node. The purchase is validated ENTIRELY server-side against the row's
// real Amber + owned nodes (canBuyNode): enough Amber, prereqs met, not already owned. On
// success it deducts the Amber and records the node id in unlocks[]. The client's optimistic
// UI reconciles from the returned profile; a rejected buy leaves the row untouched.
export const buyNode = mutation({
  args: { clientId: v.string(), guestCapability: v.optional(v.string()), nodeId: v.string() },
  handler: async (ctx, { clientId, guestCapability, nodeId }) => {
    const row = await resolveWriteRow(ctx, clientId, guestCapability, "economy");
    const amber = row.amber ?? 0;
    const check = canBuyNode(nodeId, amber, row.unlocks);
    if (!check.ok) {
      const profile = await ensureProfileView(ctx, row);
      return { ok: false as const, reason: check.reason, profile };
    }
    await ctx.db.patch(row._id, {
      amber: amber - check.cost,
      unlocks: [...row.unlocks, nodeId],
      lastSeen: Date.now(),
    });
    const updated = (await ctx.db.get(row._id))!;
    return { ok: true as const, profile: await ensureProfileView(ctx, updated) };
  },
});

// Equip (or clear, with null) the active companion pet. Only a pet the player OWNS via an
// owned companion node may be equipped — a tampered id is rejected and the row is untouched.
export const equipPet = mutation({
  args: { clientId: v.string(), guestCapability: v.optional(v.string()), petId: v.union(v.string(), v.null()) },
  handler: async (ctx, { clientId, guestCapability, petId }) => {
    const row = await resolveWriteRow(ctx, clientId, guestCapability, "economy");
    if (petId !== null && !isPetOwned(petId, row.unlocks)) {
      return { ok: false as const, reason: "unowned" as const, profile: await ensureProfileView(ctx, row) };
    }
    await ctx.db.patch(row._id, { equippedPet: petId ?? undefined, lastSeen: Date.now() });
    const updated = (await ctx.db.get(row._id))!;
    return { ok: true as const, profile: await ensureProfileView(ctx, updated) };
  },
});

// Resolve the profile view for a write row (loading the account user when linked), so buy/
// equip return the same shape as getProfile/ensurePlayer.
async function ensureProfileView(ctx: MutationCtx, row: Doc<"players">): Promise<Profile> {
  const user = row.userId ? await ctx.db.get(row.userId) : null;
  return toProfile(row, user);
}
