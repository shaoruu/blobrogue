import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const backfillGenerationState = internalMutation({
  args: { isLegacyWorldsDrained: v.boolean() },
  handler: async (ctx, { isLegacyWorldsDrained }) => {
    if (!isLegacyWorldsDrained) {
      throw new ConvexError({
        code: "legacy_drain_required",
        message: "drain every legacy game-server world before running this migration",
      });
    }
    const rooms = await ctx.db.query("rooms").collect();
    let updated = 0;
    for (const room of rooms) {
      if ((room.kind ?? "coop") !== "online" || room.generationState !== undefined) continue;
      // Deliberately do not infer pvpPolicy. A legacy PVP row without one stays inaccessible.
      await ctx.db.patch(room._id, {
        generationState: room.status === "playing"
          ? "completed"
          : room.status === "lobby"
            ? "pending"
            : "completed",
        ...(room.status === "playing" ? { generationCompletedAt: Date.now() } : {}),
      });
      updated++;
    }
    return updated;
  },
});
