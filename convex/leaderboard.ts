import { query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

// Global best-run leaderboard. One row per player (their deepest run; kills break ties),
// written only by the verified run-receipt fold below — the same trust boundary as the
// all-time stats. Reads return name/appearance/run data only: the entry shape is the
// public profile, so a leaderboard click can render a player page without any extra query
// (and without any way to reach account fields).

export interface RunBuild {
  weapons: string[];
  items: Array<{ id: string; count: number }>;
}

// The PUBLIC leaderboard entry: strictly the presentation fields — name, appearance
// snapshot, run stats, build. Never the players-row id, clientId, userId, email, avatar
// URL, or any session/room identifier (public-schema-only is asserted by test).
export interface LeaderboardEntry {
  name: string;
  colorIndex: number | null;
  hat: string | null;
  face: string | null;
  body: string | null;
  title: string | null;
  floor: number;
  kills: number;
  coins: number;
  durationMs: number;
  weapons: string[];
  items: Array<{ id: string; count: number }>;
  achievedAt: number;
}

function toEntry(doc: Doc<"leaderboard">): LeaderboardEntry {
  return {
    name: doc.name,
    colorIndex: doc.colorIndex ?? null,
    hat: doc.hat ?? null,
    face: doc.face ?? null,
    body: doc.body ?? null,
    title: doc.title ?? null,
    floor: doc.floor,
    kills: doc.kills,
    coins: doc.coins,
    durationMs: doc.durationMs,
    weapons: doc.weapons,
    items: doc.items,
    achievedAt: doc.achievedAt,
  };
}

// Clamp a client-supplied build snapshot to sane display-only bounds. Never trusted for
// anything but rendering the profile's build strip.
export function cleanBuild(build: RunBuild | undefined): RunBuild {
  if (!build) return { weapons: [], items: [] };
  return {
    weapons: build.weapons.slice(0, 12).map((w) => w.slice(0, 32)),
    items: build.items.slice(0, 32).map((it) => ({
      id: it.id.slice(0, 32),
      count: Math.max(1, Math.min(99, Math.round(it.count))),
    })),
  };
}

// Is run A a better leaderboard showing than run B? Deepest floor first, kills tie-break.
function isBetterRun(a: { floor: number; kills: number }, b: { floor: number; kills: number }): boolean {
  return a.floor > b.floor || (a.floor === b.floor && a.kills > b.kills);
}

// Fold a finished run into the player's leaderboard row (called from players.recordRun with
// the player's post-run doc). Floor 0 runs never chart. The appearance snapshot is the
// loadout AS WORN FOR THE CHARTED RUN: it only ever changes when a new best run replaces
// the old one — later profile re-equips never rewrite history (only the display NAME stays
// current, via syncIdentity, so a rename can't strand an old alias on the board).
export async function foldBestRun(
  ctx: MutationCtx,
  player: Doc<"players">,
  run: { floor: number; kills: number; coins: number; durationMs: number; build: RunBuild },
): Promise<void> {
  const existing = await ctx.db
    .query("leaderboard")
    .withIndex("by_player", (q) => q.eq("playerId", player._id))
    .unique();
  // The appearance SNAPSHOT: the loadout as worn at record time, separate from the
  // mutable profile (renames/re-equips only refresh it via syncIdentity, never a join).
  const identity = {
    name: player.name,
    colorIndex: player.colorIndex,
    hat: player.cosmeticLoadout?.hat,
    face: player.cosmeticLoadout?.face,
    body: player.cosmeticLoadout?.body,
    title: player.cosmeticLoadout?.title,
  };
  if (!existing) {
    if (run.floor < 1) return;
    await ctx.db.insert("leaderboard", {
      playerId: player._id,
      ...identity,
      floor: run.floor,
      kills: Math.max(0, run.kills),
      coins: Math.max(0, run.coins),
      durationMs: Math.max(0, Math.min(1e8, run.durationMs)),
      weapons: run.build.weapons,
      items: run.build.items,
      achievedAt: Date.now(),
    });
    return;
  }
  if (isBetterRun(run, existing)) {
    await ctx.db.patch(existing._id, {
      ...identity,
      floor: run.floor,
      kills: Math.max(0, run.kills),
      coins: Math.max(0, run.coins),
      durationMs: Math.max(0, Math.min(1e8, run.durationMs)),
      weapons: run.build.weapons,
      items: run.build.items,
      achievedAt: Date.now(),
    });
  } else if (existing.name !== player.name) {
    await ctx.db.patch(existing._id, { name: player.name });
  }
}

// Keep the public row's display NAME in step when the player renames (called from
// players.ensurePlayer). Deliberately name-only: the appearance snapshot belongs to the
// charted RUN and must stay independent of later profile changes.
export async function syncIdentity(ctx: MutationCtx, player: Doc<"players">): Promise<void> {
  const existing = await ctx.db
    .query("leaderboard")
    .withIndex("by_player", (q) => q.eq("playerId", player._id))
    .unique();
  if (!existing) return;
  if (existing.name !== player.name) {
    await ctx.db.patch(existing._id, { name: player.name });
  }
}

// Account linking: the guest's charted run must survive the merge without duplicating.
// Keep whichever run is better under the account row, then drop the guest row.
export async function mergeBestRun(
  ctx: MutationCtx,
  guest: Doc<"players">,
  account: Doc<"players">,
): Promise<void> {
  const guestRow = await ctx.db
    .query("leaderboard")
    .withIndex("by_player", (q) => q.eq("playerId", guest._id))
    .unique();
  if (!guestRow) return;
  const accountRow = await ctx.db
    .query("leaderboard")
    .withIndex("by_player", (q) => q.eq("playerId", account._id))
    .unique();
  if (!accountRow) {
    await ctx.db.patch(guestRow._id, { playerId: account._id, name: account.name });
    return;
  }
  if (isBetterRun(guestRow, accountRow)) {
    await ctx.db.patch(accountRow._id, {
      floor: guestRow.floor,
      kills: guestRow.kills,
      coins: guestRow.coins,
      durationMs: guestRow.durationMs,
      weapons: guestRow.weapons,
      items: guestRow.items,
      achievedAt: guestRow.achievedAt,
    });
  }
  await ctx.db.delete(guestRow._id);
}

const TOP_MAX = 50;

// The ranked top window (deepest floor, kills tie-break). Reads a fixed slice off the
// by_floor index then orders ties, so queries stay cheap regardless of table size.
async function rankedWindow(ctx: QueryCtx): Promise<Doc<"leaderboard">[]> {
  const window = await ctx.db
    .query("leaderboard")
    .withIndex("by_floor")
    .order("desc")
    .take(TOP_MAX);
  window.sort((a, b) => b.floor - a.floor || b.kills - a.kills || a.achievedAt - b.achievedAt);
  return window;
}

// The public top-N.
export const top = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const n = Math.max(1, Math.min(TOP_MAX, Math.round(limit ?? 10)));
    return (await rankedWindow(ctx)).slice(0, n).map(toEntry);
  },
});

// Resolve the caller's own leaderboard row (account-first, else the guest clientId row).
async function callerRow(ctx: QueryCtx, clientId: string): Promise<Doc<"leaderboard"> | null> {
  const userId = await getAuthUserId(ctx);
  const me = userId
    ? await ctx.db.query("players").withIndex("by_userId", (q) => q.eq("userId", userId)).unique()
    : await ctx.db.query("players").withIndex("by_clientId", (q) => q.eq("clientId", clientId)).unique();
  if (!me) return null;
  return await ctx.db
    .query("leaderboard")
    .withIndex("by_player", (q) => q.eq("playerId", me._id))
    .unique();
}

// The CALLER's own charted standing (their data, nobody else's): best-run floor/kills plus
// the rank inside the top window, or rank null when the run sits below it. Null when the
// caller has no charted run. Powers the title glance's fixed "your best" state line.
export const standing = query({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const mine = await callerRow(ctx, clientId);
    if (!mine) return null;
    const idx = (await rankedWindow(ctx)).findIndex((d) => d._id === mine._id);
    return { floor: mine.floor, kills: mine.kills, rank: idx >= 0 ? idx + 1 : null };
  },
});

// The CALLER's own full charted entry (the same public shape a leaderboard click renders,
// plus their window rank) — the own-profile Overview's Top Run card. Null when uncharted.
export const mine = query({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const row = await callerRow(ctx, clientId);
    if (!row) return null;
    const idx = (await rankedWindow(ctx)).findIndex((d) => d._id === row._id);
    return { entry: toEntry(row), rank: idx >= 0 ? idx + 1 : null };
  },
});
