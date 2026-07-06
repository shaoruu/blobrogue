import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";

export interface Profile {
  playerId: string;
  name: string;
  totalKills: number;
  deepestFloor: number;
  totalCoins: number;
  gamesPlayed: number;
  unlocks: string[];
}

function toProfile(doc: Doc<"players">): Profile {
  return {
    playerId: doc._id,
    name: doc.name,
    totalKills: doc.totalKills,
    deepestFloor: doc.deepestFloor,
    totalCoins: doc.totalCoins,
    gamesPlayed: doc.gamesPlayed,
    unlocks: doc.unlocks,
  };
}

// Upsert a player by their persistent clientId, returning the saved profile.
// This is the login: called on boot with the localStorage clientId + chosen name.
export const ensurePlayer = mutation({
  args: { clientId: v.string(), name: v.string() },
  handler: async (ctx, { clientId, name }) => {
    const trimmed = name.trim().slice(0, 20) || "blob";
    const existing = await ctx.db
      .query("players")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { name: trimmed, lastSeen: now });
      return toProfile({ ...existing, name: trimmed });
    }
    const id = await ctx.db.insert("players", {
      clientId,
      name: trimmed,
      totalKills: 0,
      deepestFloor: 0,
      totalCoins: 0,
      gamesPlayed: 0,
      unlocks: [],
      createdAt: now,
      lastSeen: now,
    });
    const doc = await ctx.db.get(id);
    return toProfile(doc!);
  },
});

export const getProfile = query({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const doc = await ctx.db
      .query("players")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .unique();
    return doc ? toProfile(doc) : null;
  },
});

// Fold a finished run into the player's all-time stats (called on game over).
export const recordRun = mutation({
  args: { clientId: v.string(), floor: v.number(), kills: v.number(), coins: v.number() },
  handler: async (ctx, { clientId, floor, kills, coins }) => {
    const doc = await ctx.db
      .query("players")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .unique();
    if (!doc) return null;
    await ctx.db.patch(doc._id, {
      totalKills: doc.totalKills + Math.max(0, kills),
      totalCoins: doc.totalCoins + Math.max(0, coins),
      deepestFloor: Math.max(doc.deepestFloor, floor),
      gamesPlayed: doc.gamesPlayed + 1,
      lastSeen: Date.now(),
    });
    const updated = await ctx.db.get(doc._id);
    return updated ? toProfile(updated) : null;
  },
});
