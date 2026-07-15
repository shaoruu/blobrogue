import { internalMutation } from "./_generated/server";

export const backfillGenerationState = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rooms = await ctx.db.query("rooms").collect();
    let updated = 0;
    for (const room of rooms) {
      if ((room.kind ?? "coop") !== "online" || room.generationState !== undefined) continue;
      await ctx.db.patch(room._id, {
        generationState: room.status === "playing"
          ? "active"
          : room.status === "lobby"
            ? "pending"
            : "completed",
      });
      updated++;
    }
    return updated;
  },
});
