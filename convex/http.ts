import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { verifyRunBody } from "./gsSignCore";
import { parseServerSubmission } from "./statsCore";

// Convex Auth mounts its OAuth routes (sign-in redirect + provider callback) under
// /api/auth on the deployment's .convex.site domain. The Google "Authorized redirect
// URI" the operator adds in Google Cloud Console is:
//   https://<deployment>.convex.site/api/auth/callback/google
// See AUTH_SETUP.md.
const http = httpRouter();

auth.addHttpRoutes(http);

function json(status: number, body: Record<string, string | number | boolean>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// The authoritative run-result inbox: the game server POSTs each finished run here, signed
// with HMAC-SHA256 over the exact body bytes (x-gs-signature header). This is the ONLY
// door into applyServerRun — the endpoint is public (convex.site), the secret is the gate.
//
// SECRET SEPARATION (security review): run-result signing uses its OWN shared secret,
// GS_RUN_RESULTS_SECRET — deliberately NOT the join-ticket secret (GS_AUTH_SECRET), so the
// two trust channels rotate independently and a leak of one never compromises the other.
// There is intentionally no fallback to GS_AUTH_SECRET: an unset results secret disables
// the inbox (503) rather than silently re-coupling the channels.
//
// Verification order: size -> signature (over the exact raw bytes, BEFORE any parsing
// trusts them; no canonicalization step exists to disagree on) -> envelope freshness
// (sentAt ±10 min) + field clamps -> per-player rate cap -> idempotent apply
// (submissionId dedupe), so a replayed capture is settled as a duplicate no-op.
//
// Setup on the PRODUCTION Convex deployment + game server env (see MULTIPLAYER.md §8):
//   npx convex env set GS_RUN_RESULTS_SECRET <long random value>   (production deployment)
//   GS_RUN_RESULTS_SECRET=<same value>                             (game server .env)
//   GS_RUN_RESULTS_URL=https://<production deployment>.convex.site/gs/run-result
http.route({
  path: "/gs/run-result",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.GS_RUN_RESULTS_SECRET;
    if (!secret) return json(503, { ok: false, reason: "not_configured" });
    const body = await req.text();
    if (body.length === 0 || body.length > 16384) return json(413, { ok: false, reason: "bad_size" });
    const signature = req.headers.get("x-gs-signature") ?? "";
    if (!(await verifyRunBody(secret, body, signature))) return json(401, { ok: false, reason: "bad_signature" });

    const parsed = parseServerSubmission(body, Date.now());
    if (!parsed.ok) return json(400, { ok: false, reason: parsed.reason });

    const { sub } = parsed;
    const outcome = await ctx.runMutation(internal.stats.applyServerRun, {
      submissionId: sub.submissionId,
      playerId: sub.playerId,
      worldId: sub.worldId,
      mode: sub.run.mode,
      result: sub.run.result,
      difficulty: sub.run.difficulty,
      floor: sub.run.floor,
      startFloor: sub.run.startFloor,
      kills: sub.run.kills,
      coins: sub.run.coins,
      coinsEarned: sub.run.coinsEarned,
      coinsSpent: sub.run.coinsSpent,
      durationMs: sub.run.durationMs,
      damageDealt: sub.run.damageDealt,
      damageTaken: sub.run.damageTaken,
      bestCombo: sub.run.bestCombo,
      bossKills: sub.run.bossKills,
      bossKillFloors: sub.run.bossKillFloors,
      ...(sub.run.firstBossKillMs !== null ? { firstBossKillMs: sub.run.firstBossKillMs } : {}),
      killsByWeapon: sub.run.killsByWeapon,
      weapons: sub.run.weapons,
      blessings: sub.run.blessings,
      ...(sub.run.deathCause !== null ? { deathCause: sub.run.deathCause } : {}),
      partySize: sub.run.partySize,
    });
    if (!outcome.ok) {
      return json(outcome.reason === "rate_limited" ? 429 : 422, { ok: false, reason: outcome.reason ?? "rejected" });
    }
    return json(200, { ok: true, isDuplicate: outcome.isDuplicate ?? false, isSkipped: outcome.isSkipped ?? false });
  }),
});

export default http;
