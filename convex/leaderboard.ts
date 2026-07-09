import { query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

// Global best-run leaderboard. One row per player (their deepest run; kills break ties),
// written ONLY by players.recordRun through foldBestRun below — the same trust boundary as
// the all-time stats. Reads return name/appearance/run data only: the entry shape is the
// public profile, so a leaderboard click can render a player page without any extra query
// (and without any way to reach account fields).

export interface RunBuild {
  weapons: string[];
  items: Array<{ id: string; count: number }>;
}

export interface LeaderboardEntry {
  playerId: string;
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
    playerId: doc.playerId,
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
// the player's post-run doc). Floor 0 runs never chart; a run that doesn't beat the stored
// best only refreshes the appearance snapshot so the board tracks renames/re-equips.
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
  } else {
    await ctx.db.patch(existing._id, identity);
  }
}

// Keep the public row's identity snapshot in step when the player renames or re-equips
// (called from players.ensurePlayer only when something actually changed).
export async function syncIdentity(ctx: MutationCtx, player: Doc<"players">): Promise<void> {
  const existing = await ctx.db
    .query("leaderboard")
    .withIndex("by_player", (q) => q.eq("playerId", player._id))
    .unique();
  if (!existing) return;
  const next = {
    name: player.name,
    colorIndex: player.colorIndex,
    hat: player.cosmeticLoadout?.hat,
    face: player.cosmeticLoadout?.face,
    body: player.cosmeticLoadout?.body,
    title: player.cosmeticLoadout?.title,
  };
  if (
    existing.name !== next.name ||
    existing.colorIndex !== next.colorIndex ||
    existing.hat !== next.hat ||
    existing.face !== next.face ||
    existing.body !== next.body ||
    existing.title !== next.title
  ) {
    await ctx.db.patch(existing._id, next);
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

// The public top-N (deepest floor, kills tie-break). Reads a fixed window off the by_floor
// index then orders ties, so the query stays cheap regardless of table size.
export const top = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const n = Math.max(1, Math.min(TOP_MAX, Math.round(limit ?? 10)));
    const window = await ctx.db
      .query("leaderboard")
      .withIndex("by_floor")
      .order("desc")
      .take(TOP_MAX);
    window.sort((a, b) => b.floor - a.floor || b.kills - a.kills || a.achievedAt - b.achievedAt);
    return window.slice(0, n).map(toEntry);
  },
});
