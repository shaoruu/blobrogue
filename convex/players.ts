import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isPetKind, petUnlocksFor, PET_KINDS } from "../src/sim/pets";
import type { PetKind } from "../src/sim/types";

export interface Profile {
  playerId: string;
  name: string;
  // Chosen blob tint (client palette index); null until the player picks one.
  colorIndex: number | null;
  totalKills: number;
  deepestFloor: number;
  totalCoins: number;
  gamesPlayed: number;
  unlocks: string[];
  // Deepest floor whose boss this player's party ever defeated (0 = never).
  deepestBossKill: number;
  // Companion pets earned by this ACCOUNT (guests always read empty — unlocks are only
  // ever written to account-backed rows) and the one currently equipped.
  unlockedPets: PetKind[];
  activePet: PetKind | null;
  // Present when the row is linked to a signed-in account (Google avatar URL).
  image?: string;
  // True when this stats row is account-backed rather than guest-only.
  isAccount: boolean;
}

// The persisted pet fields, narrowed to the closed PetKind set at the READ boundary. The
// equip invariant is enforced here too (activePet must sit in unlockedPets), so every
// consumer — the menu picker, the ticket mint, presence — inherits it for free.
function petStateOf(doc: Doc<"players">): { unlockedPets: PetKind[]; activePet: PetKind | null } {
  const unlockedPets = (doc.unlockedPets ?? []).filter(isPetKind);
  const active = doc.activePet;
  const activePet = active !== undefined && isPetKind(active) && unlockedPets.includes(active) ? active : null;
  return { unlockedPets, activePet };
}

// The validated equipped companion of a players row (rooms/presence stamp it on the roster).
export function activePetOf(doc: Doc<"players">): PetKind | null {
  return petStateOf(doc).activePet;
}

function toProfile(doc: Doc<"players">, user?: Doc<"users"> | null): Profile {
  return {
    playerId: doc._id,
    name: doc.name,
    colorIndex: doc.colorIndex ?? null,
    totalKills: doc.totalKills,
    deepestFloor: doc.deepestFloor,
    totalCoins: doc.totalCoins,
    gamesPlayed: doc.gamesPlayed,
    unlocks: doc.unlocks,
    deepestBossKill: doc.deepestBossKill ?? 0,
    ...petStateOf(doc),
    image: user?.image,
    isAccount: doc.userId !== undefined,
  };
}

// The union of already-earned pets and everything the given milestones unlock, in canonical
// roster order. Pure + idempotent: re-folding the same run can neither duplicate nor revoke.
function withPetUnlocks(owned: string[], stats: { deepestFloor: number; deepestBossKill: number }): PetKind[] {
  const earned = new Set<string>(owned.filter(isPetKind));
  for (const kind of petUnlocksFor(stats)) earned.add(kind);
  return PET_KINDS.filter((kind) => earned.has(kind));
}

function cleanName(name: string): string {
  return name.trim().slice(0, 20) || "blob";
}

// Clamp a chosen color to a sane palette range; undefined = "no pick", never a write.
function cleanColor(colorIndex: number | undefined): number | undefined {
  if (colorIndex === undefined || !Number.isInteger(colorIndex)) return undefined;
  return Math.min(15, Math.max(0, colorIndex));
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
): Promise<{ row: Doc<"players"> | null; user: Doc<"users"> | null }> {
  const userId = await getAuthUserId(ctx);
  if (userId) {
    return { row: await findByUserId(ctx, userId), user: await ctx.db.get(userId) };
  }
  return { row: await findByClientId(ctx, clientId), user: null };
}

const ZERO_STATS = {
  totalKills: 0,
  deepestFloor: 0,
  totalCoins: 0,
  gamesPlayed: 0,
  unlocks: [] as string[],
};

// Get-or-create the account-backed stats row for a signed-in user. Idempotent, so it's
// safe to call from both the login (ensurePlayer) and the run-save (recordRun) paths —
// which means saving a run never silently no-ops just because login hadn't run first.
//
// On first creation it adopts this browser's *unowned* guest row (migrating its
// all-time stats onto the account); a guest row owned by someone else is never
// hijacked, and the unique `by_clientId` invariant is preserved by not re-claiming an
// already-owned clientId.
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
    await ctx.db.patch(existing._id, { name: accountName, lastSeen: now });
    return { row: { ...existing, name: accountName, lastSeen: now }, user };
  }

  const guest = await findByClientId(ctx, clientId);
  if (guest && guest.userId === undefined) {
    // Adopting a guest row is the moment its history becomes account progression: evaluate
    // pet unlocks from the migrated stats right here, so milestones earned as a guest grant
    // their companions the instant the player signs in (idempotent set union).
    const unlockedPets = withPetUnlocks(guest.unlockedPets ?? [], {
      deepestFloor: guest.deepestFloor,
      deepestBossKill: guest.deepestBossKill ?? 0,
    });
    await ctx.db.patch(guest._id, { userId, name: accountName, unlockedPets, lastSeen: now });
    return { row: { ...guest, userId, name: accountName, unlockedPets, lastSeen: now }, user };
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

// Upsert the caller's player row, returning the saved profile. This is the "login":
// called on boot with the localStorage clientId + chosen name (+ optionally the chosen
// blob color — only ever written when the player has explicitly picked one, so logging in
// from a fresh browser can never clobber an account's saved pick).
//
// - Guest (no auth token): upserts by clientId, exactly as before.
// - Signed in: keys off the authenticated userId (see ensureAccountRow).
export const ensurePlayer = mutation({
  args: { clientId: v.string(), name: v.string(), colorIndex: v.optional(v.number()) },
  handler: async (ctx, { clientId, name, colorIndex }) => {
    const color = cleanColor(colorIndex);
    const userId = await getAuthUserId(ctx);
    if (userId) {
      const { row, user } = await ensureAccountRow(ctx, userId, clientId, name);
      if (color !== undefined && row.colorIndex !== color) {
        await ctx.db.patch(row._id, { colorIndex: color });
        return toProfile({ ...row, colorIndex: color }, user);
      }
      return toProfile(row, user);
    }

    // Guest path (unchanged behaviour, plus the optional color pick).
    const now = Date.now();
    const trimmed = cleanName(name);
    const existing = await findByClientId(ctx, clientId);
    if (existing) {
      const patch: { name: string; lastSeen: number; colorIndex?: number } = { name: trimmed, lastSeen: now };
      if (color !== undefined) patch.colorIndex = color;
      await ctx.db.patch(existing._id, patch);
      return toProfile({ ...existing, ...patch });
    }
    const id = await ctx.db.insert("players", {
      clientId,
      name: trimmed,
      ...(color !== undefined ? { colorIndex: color } : {}),
      ...ZERO_STATS,
      createdAt: now,
      lastSeen: now,
    });
    return toProfile((await ctx.db.get(id))!);
  },
});

export const getProfile = query({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const { row, user } = await resolveRow(ctx, clientId);
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

async function foldRun(
  ctx: MutationCtx,
  doc: Doc<"players">,
  floor: number,
  kills: number,
  coins: number,
  bossKill: number,
): Promise<Doc<"players"> | null> {
  const deepestFloor = Math.max(doc.deepestFloor, floor);
  const deepestBossKill = Math.max(doc.deepestBossKill ?? 0, Math.max(0, Math.floor(bossKill)));
  const patch: Partial<Doc<"players">> = {
    totalKills: doc.totalKills + Math.max(0, kills),
    totalCoins: doc.totalCoins + Math.max(0, coins),
    deepestFloor,
    deepestBossKill,
    gamesPlayed: doc.gamesPlayed + 1,
    lastSeen: Date.now(),
  };
  // Pet unlocks are ACCOUNT progression: the milestone stats accrue for everyone, but only
  // an account-backed row earns the companions themselves ("guests cannot unlock until
  // sign-in" — a later sign-in grants them retroactively via ensureAccountRow).
  if (doc.userId !== undefined) {
    patch.unlockedPets = withPetUnlocks(doc.unlockedPets ?? [], { deepestFloor, deepestBossKill });
  }
  await ctx.db.patch(doc._id, patch);
  return await ctx.db.get(doc._id);
}

// Fold a finished run into the caller's all-time stats (called on game over). Signed
// in: folds into the account row, creating/migrating it if login hadn't yet (so a run
// is never lost to a startup race). Guest: folds into the existing clientId row, or
// no-ops if there isn't one — exactly as before. deepestBossKill is the deepest floor
// whose boss the run's party defeated (0/absent = none — older clients simply omit it).
export const recordRun = mutation({
  args: {
    clientId: v.string(),
    floor: v.number(),
    kills: v.number(),
    coins: v.number(),
    deepestBossKill: v.optional(v.number()),
  },
  handler: async (ctx, { clientId, floor, kills, coins, deepestBossKill }) => {
    const userId = await getAuthUserId(ctx);
    if (userId) {
      const { row, user } = await ensureAccountRow(ctx, userId, clientId, "blob");
      const updated = await foldRun(ctx, row, floor, kills, coins, deepestBossKill ?? 0);
      return updated ? toProfile(updated, user) : null;
    }
    const row = await findByClientId(ctx, clientId);
    if (!row) return null;
    const updated = await foldRun(ctx, row, floor, kills, coins, deepestBossKill ?? 0);
    return updated ? toProfile(updated) : null;
  },
});

// Equip (or clear, with null) the account's active companion. Account-only by design:
// guests have no unlock set to equip from, so the mutation refuses rather than silently
// no-oping — the picker greys itself out for guests, and a tampered call changes nothing.
export const setActivePet = mutation({
  args: { clientId: v.string(), pet: v.union(v.string(), v.null()) },
  handler: async (ctx, { clientId, pet }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("sign in to equip a companion");
    const { row, user } = await ensureAccountRow(ctx, userId, clientId, "blob");
    if (pet !== null) {
      const { unlockedPets } = petStateOf(row);
      if (!isPetKind(pet) || !unlockedPets.includes(pet)) throw new Error("that companion is not unlocked");
    }
    // Patching undefined REMOVES the optional field — "no pet" is the absent state.
    await ctx.db.patch(row._id, { activePet: pet ?? undefined });
    const updated = await ctx.db.get(row._id);
    return updated ? toProfile(updated, user) : null;
  },
});
