import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { sanitizeEquip, earnedCosmeticsFor } from "./cosmeticsCore";
import { foldBestRun, mergeBestRun, syncIdentity, cleanBuild } from "./leaderboard";
import type { RunBuild } from "./leaderboard";

export interface Profile {
  playerId: string;
  name: string;
  // Chosen blob tint (client palette index); null until the player picks one.
  colorIndex: number | null;
  // Equipped visual-only cosmetics; null slots render the natural blob.
  cosmetics: { hat: string | null; glasses: string | null };
  totalKills: number;
  deepestFloor: number;
  totalCoins: number;
  gamesPlayed: number;
  unlocks: string[];
  // Present when the row is linked to a signed-in account (Google avatar URL).
  image?: string;
  // True when this stats row is account-backed rather than guest-only.
  isAccount: boolean;
}

function toProfile(doc: Doc<"players">, user?: Doc<"users"> | null): Profile {
  return {
    playerId: doc._id,
    name: doc.name,
    colorIndex: doc.colorIndex ?? null,
    cosmetics: { hat: doc.cosmetics?.hat ?? null, glasses: doc.cosmetics?.glasses ?? null },
    totalKills: doc.totalKills,
    deepestFloor: doc.deepestFloor,
    totalCoins: doc.totalCoins,
    gamesPlayed: doc.gamesPlayed,
    unlocks: doc.unlocks,
    image: user?.image,
    isAccount: doc.userId !== undefined,
  };
}

function cleanName(name: string): string {
  return name.trim().slice(0, 20) || "blob";
}

// Clamp a chosen color to a sane palette range; undefined = "no pick", never a write.
function cleanColor(colorIndex: number | undefined): number | undefined {
  if (colorIndex === undefined || !Number.isInteger(colorIndex)) return undefined;
  return Math.min(15, Math.max(0, colorIndex));
}

// The wire shape of an explicit cosmetics pick: per-slot, "none" clears the slot, an id
// equips it (validated against ownership), absent = "don't touch" (like colorIndex).
type CosmeticsPick = { hat?: string; glasses?: string };

// The stored-cosmetics patch for an explicit pick, or undefined when nothing valid changed.
// Locked/unknown ids are IGNORED (never stored), so a tampered client can't fake-equip.
function cosmeticsPatch(
  row: Doc<"players">,
  pick: CosmeticsPick | undefined,
): { hat?: string; glasses?: string } | undefined {
  if (!pick) return undefined;
  const current = { hat: row.cosmetics?.hat, glasses: row.cosmetics?.glasses };
  const next = { ...current };
  for (const slot of ["hat", "glasses"] as const) {
    const raw = pick[slot];
    if (raw === undefined) continue;
    if (raw === "none") { delete next[slot]; continue; }
    const valid = sanitizeEquip(slot, raw, row.unlocks);
    if (valid !== undefined) next[slot] = valid;
  }
  if (next.hat === current.hat && next.glasses === current.glasses) return undefined;
  return next;
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

// Fold an unowned guest row into an EXISTING account row (the second-device sign-in path:
// the account already has its row, but this browser accrued guest progress before signing
// in). Stats sum/max, unlocks union, appearance fills only empty account slots, and the
// guest's charted run merges — then the guest row is DELETED, which is what makes the merge
// idempotent (a re-run finds no guest row) and prevents duplicated progress.
async function absorbGuestRow(
  ctx: MutationCtx,
  account: Doc<"players">,
  guest: Doc<"players">,
): Promise<Doc<"players">> {
  const merged = {
    totalKills: account.totalKills + guest.totalKills,
    totalCoins: account.totalCoins + guest.totalCoins,
    deepestFloor: Math.max(account.deepestFloor, guest.deepestFloor),
    gamesPlayed: account.gamesPlayed + guest.gamesPlayed,
    unlocks: [...new Set([...account.unlocks, ...guest.unlocks])],
    ...(account.colorIndex === undefined && guest.colorIndex !== undefined ? { colorIndex: guest.colorIndex } : {}),
    ...(account.cosmetics === undefined && guest.cosmetics !== undefined ? { cosmetics: guest.cosmetics } : {}),
    // The account row adopts this browser's clientId (when free) so guest play after a
    // sign-out keeps accruing onto the same identity — the first-sign-in semantics.
    ...(account.clientId === undefined ? { clientId: guest.clientId } : {}),
  };
  await ctx.db.patch(account._id, merged);
  const updated = (await ctx.db.get(account._id))!;
  await mergeBestRun(ctx, guest, updated);
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
    const guest = await findByClientId(ctx, clientId);
    if (guest && guest.userId === undefined && guest._id !== existing._id) {
      const absorbed = await absorbGuestRow(ctx, existing, guest);
      await ctx.db.patch(absorbed._id, { name: accountName, lastSeen: now });
      return { row: { ...absorbed, name: accountName, lastSeen: now }, user };
    }
    await ctx.db.patch(existing._id, { name: accountName, lastSeen: now });
    return { row: { ...existing, name: accountName, lastSeen: now }, user };
  }

  const guest = await findByClientId(ctx, clientId);
  if (guest && guest.userId === undefined) {
    await ctx.db.patch(guest._id, { userId, name: accountName, lastSeen: now });
    return { row: { ...guest, userId, name: accountName, lastSeen: now }, user };
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
  const patch: { colorIndex?: number; cosmetics?: { hat?: string; glasses?: string } } = {};
  if (color !== undefined && row.colorIndex !== color) patch.colorIndex = color;
  const nextCosmetics = cosmeticsPatch(row, cosmetics);
  if (nextCosmetics !== undefined) patch.cosmetics = nextCosmetics;
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
    name: v.string(),
    colorIndex: v.optional(v.number()),
    cosmetics: v.optional(v.object({ hat: v.optional(v.string()), glasses: v.optional(v.string()) })),
  },
  handler: async (ctx, { clientId, name, colorIndex, cosmetics }) => {
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
      await ctx.db.patch(existing._id, { name: trimmed, lastSeen: now });
      const updated = await applyAppearance(ctx, { ...existing, name: trimmed, lastSeen: now }, color, cosmetics);
      await syncIdentity(ctx, updated);
      return toProfile(updated);
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
    return toProfile(updated);
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

interface RunArgs {
  floor: number;
  kills: number;
  coins: number;
  durationMs: number;
  build: RunBuild;
}

async function foldRun(ctx: MutationCtx, doc: Doc<"players">, run: RunArgs): Promise<Doc<"players"> | null> {
  const totals = {
    totalKills: doc.totalKills + Math.max(0, run.kills),
    totalCoins: doc.totalCoins + Math.max(0, run.coins),
    deepestFloor: Math.max(doc.deepestFloor, run.floor),
    gamesPlayed: doc.gamesPlayed + 1,
  };
  // Earned cosmetics unlock off the post-fold all-time stats (the one grant path).
  const earned = earnedCosmeticsFor(totals).filter((id) => !doc.unlocks.includes(id));
  await ctx.db.patch(doc._id, {
    ...totals,
    ...(earned.length > 0 ? { unlocks: [...doc.unlocks, ...earned] } : {}),
    lastSeen: Date.now(),
  });
  const updated = await ctx.db.get(doc._id);
  if (updated) await foldBestRun(ctx, updated, run);
  return updated;
}

// Fold a finished run into the caller's all-time stats + the global leaderboard (called on
// game over). Signed in: folds into the account row, creating/migrating it if login hadn't
// yet (so a run is never lost to a startup race). Guest: folds into the existing clientId
// row, or no-ops if there isn't one — exactly as before. durationMs/build are optional so
// already-deployed clients keep recording runs.
export const recordRun = mutation({
  args: {
    clientId: v.string(),
    floor: v.number(),
    kills: v.number(),
    coins: v.number(),
    durationMs: v.optional(v.number()),
    build: v.optional(v.object({
      weapons: v.array(v.string()),
      items: v.array(v.object({ id: v.string(), count: v.number() })),
    })),
  },
  handler: async (ctx, { clientId, floor, kills, coins, durationMs, build }) => {
    const run: RunArgs = { floor, kills, coins, durationMs: durationMs ?? 0, build: cleanBuild(build) };
    const userId = await getAuthUserId(ctx);
    if (userId) {
      const { row, user } = await ensureAccountRow(ctx, userId, clientId, "blob");
      const updated = await foldRun(ctx, row, run);
      return updated ? toProfile(updated, user) : null;
    }
    const row = await findByClientId(ctx, clientId);
    if (!row) return null;
    const updated = await foldRun(ctx, row, run);
    return updated ? toProfile(updated) : null;
  },
});
