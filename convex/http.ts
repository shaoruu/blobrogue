import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { auth } from "./auth";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { verifyGenerationAdmissionProof } from "./generationAdmissionCore";
import { verifyRunCompletionReceipt } from "./runReceiptCore";

// Convex Auth mounts its OAuth routes (sign-in redirect + provider callback) under
// /api/auth on the deployment's .convex.site domain. The Google "Authorized redirect
// URI" the operator adds in Google Cloud Console is:
//   https://<deployment>.convex.site/api/auth/callback/google
// See AUTH_SETUP.md.
const http = httpRouter();

auth.addHttpRoutes(http);

http.route({
  path: "/gs/run-completion",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.GS_RECEIPT_SECRET;
    if (!secret) return new Response("receipt secret unavailable", { status: 503 });
    if (secret === process.env.GS_AUTH_SECRET) {
      return new Response("receipt secret must be distinct", { status: 503 });
    }
    let body: { receipt?: string };
    try {
      body = JSON.parse(await request.text()) as { receipt?: string };
    } catch {
      return new Response("invalid receipt", { status: 400 });
    }
    if (typeof body.receipt !== "string" || body.receipt.length > 64 * 1024) {
      return new Response("invalid receipt", { status: 400 });
    }
    const payload = await verifyRunCompletionReceipt(secret, body.receipt);
    if (!payload) return new Response("invalid receipt", { status: 401 });
    try {
      const result = await ctx.runMutation(internal.runReceipt.apply, payload);
      return Response.json(result, { status: 200 });
    } catch (error) {
      if (error instanceof ConvexError
        && typeof error.data === "object"
        && error.data !== null
        && "code" in error.data
        && error.data.code === "receipt_replayed") {
        return Response.json({ code: "receipt_replayed" }, { status: 409 });
      }
      const code = error instanceof ConvexError
        && typeof error.data === "object"
        && error.data !== null
        && "code" in error.data
        && typeof error.data.code === "string"
        ? error.data.code
        : "receipt_rejected";
      return Response.json({ code }, { status: 422 });
    }
  }),
});

http.route({
  path: "/gs/admission",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.GS_RECEIPT_SECRET;
    if (!secret || secret === process.env.GS_AUTH_SECRET) {
      return Response.json({ isAllowed: false, code: "admission_unavailable" }, { status: 503 });
    }
    let body: { proof?: string };
    try {
      body = JSON.parse(await request.text()) as { proof?: string };
    } catch {
      return Response.json({ isAllowed: false, code: "invalid_proof" }, { status: 400 });
    }
    if (typeof body.proof !== "string" || body.proof.length > 8 * 1024) {
      return Response.json({ isAllowed: false, code: "invalid_proof" }, { status: 400 });
    }
    const payload = await verifyGenerationAdmissionProof(secret, body.proof);
    if (!payload) {
      return Response.json({ isAllowed: false, code: "invalid_proof" }, { status: 401 });
    }
    const decision = await ctx.runQuery(internal.rooms.generationAdmission, {
      playerId: payload.playerId,
      worldId: payload.worldId,
      roomCode: payload.roomCode,
      generation: payload.generation,
      mode: payload.mode,
      pvpPolicy: payload.pvpPolicy,
      kitId: payload.kitId,
      petId: payload.petId,
    });
    return Response.json(decision, { status: decision.isAllowed ? 200 : 403 });
  }),
});

export default http;
