import { readFileSync } from "node:fs";
import {
  isGuestRefreshAuthorized,
  isGuestSessionAuthorized,
} from "../convex/guestCapabilityCore.js";
import { ConvexError } from "convex/values";
import { normalizeOnlineError } from "../src/net/onlineError.js";

let passed = 0;
let failed = 0;

function check(name: string, isPassing: boolean): void {
  if (isPassing) {
    passed++;
    process.stdout.write(`  PASS ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}\n`);
  }
}

const now = 1_000_000;
const session = {
  token: "guest-secret",
  refreshToken: "guest-refresh-secret",
  clientId: "browser-a",
  playerId: "guest-player",
  scopes: ["profile", "room", "ticket", "economy"] as const,
  expiresAt: now + 60_000,
  refreshExpiresAt: now + 120_000,
};
const guest = {
  playerId: "guest-player",
  clientId: "browser-a",
  isAccount: false,
};

check("valid scoped guest capability authorizes its guest row",
  isGuestSessionAuthorized(session, guest, "browser-a", "guest-secret", "ticket", now));
check("wrong token rejects",
  !isGuestSessionAuthorized(session, guest, "browser-a", "wrong", "ticket", now));
check("wrong browser rejects",
  !isGuestSessionAuthorized(session, guest, "browser-b", "guest-secret", "ticket", now));
check("wrong scope rejects",
  !isGuestSessionAuthorized({ ...session, scopes: ["profile"] }, guest, "browser-a", "guest-secret", "ticket", now));
check("expired capability rejects",
  !isGuestSessionAuthorized({ ...session, expiresAt: now }, guest, "browser-a", "guest-secret", "ticket", now));
check("valid refresh capability rotates an expired access capability",
  isGuestRefreshAuthorized(
    { ...session, expiresAt: now },
    guest,
    "browser-a",
    "guest-refresh-secret",
    now,
  ));
check("expired refresh capability rejects",
  !isGuestRefreshAuthorized(
    { ...session, expiresAt: now, refreshExpiresAt: now },
    guest,
    "browser-a",
    "guest-refresh-secret",
    now,
  ));
check("revoked capability rejects",
  !isGuestSessionAuthorized({ ...session, revokedAt: now - 1 }, guest, "browser-a", "guest-secret", "ticket", now));
check("capability can never authorize an account row after sign-out",
  !isGuestSessionAuthorized(session, { ...guest, isAccount: true }, "browser-a", "guest-secret", "ticket", now));
const upgradeError = normalizeOnlineError(new ConvexError({
  code: "guest_capability_required",
  message: "legacy client",
}));
check("legacy clients receive a clean refresh-required error",
  upgradeError.code === "client_outdated"
  && upgradeError.message.includes("refresh the page"));

const playersSource = readFileSync(new URL("../convex/players.ts", import.meta.url), "utf8");
const roomsSource = readFileSync(new URL("../convex/rooms.ts", import.meta.url), "utf8");
const ticketSource = readFileSync(new URL("../convex/gsTicket.ts", import.meta.url), "utf8");
const receiptSource = readFileSync(new URL("../convex/runReceipt.ts", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../convex/schema.ts", import.meta.url), "utf8");
const ticketCoreSource = readFileSync(new URL("../convex/gsTicketCore.ts", import.meta.url), "utf8");
const admissionSource = readFileSync(new URL("../src/net/generationAdmission.ts", import.meta.url), "utf8");
const migrationSource = readFileSync(new URL("../convex/migrations.ts", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server/src/server.ts", import.meta.url), "utf8");
const pvpSimSource = readFileSync(new URL("../src/sim/pvp.ts", import.meta.url), "utf8");
const routerSource = readFileSync(new URL("../server/src/messageRouter.ts", import.meta.url), "utf8");
const admissionClientSource = readFileSync(new URL("../server/src/generationAdmissionClient.ts", import.meta.url), "utf8");
const ticketAuthSource = readFileSync(new URL("../server/src/auth.ts", import.meta.url), "utf8");
const deployControllerSource = readFileSync(new URL("../control/src/deployController.ts", import.meta.url), "utf8");
const controlConfigSource = readFileSync(new URL("../control/src/config.ts", import.meta.url), "utf8");
const hmacEnvelopeSource = readFileSync(new URL("../convex/hmacEnvelopeCore.ts", import.meta.url), "utf8");
const receiptCoreSource = readFileSync(new URL("../convex/runReceiptCore.ts", import.meta.url), "utf8");

check("public recordRun and recordFloorProgress fail closed",
  (playersSource.match(/verified_receipt_required/g) ?? []).length >= 2);
check("guest merge guards and rewires room references before delete",
  playersSource.includes("guardAndRewireGuestReferences(ctx, guest, account)")
  && playersSource.indexOf("guardAndRewireGuestReferences(ctx, guest, account)")
    < playersSource.indexOf("await ctx.db.delete(guest._id)"));
check("ticket mint signs one transaction-consistent internal snapshot",
  ticketSource.includes("internal.rooms.ticketSnapshot")
  && !ticketSource.includes("api.players.getProfile")
  && !ticketSource.includes("api.rooms.membership"));
check("generation reopen requires server-attested completion",
  roomsSource.includes('room.generationState !== "completed"')
  && !/reopen[\s\S]{0,2500}rows\.some\(\(row\) => row\.gsWorldId/.test(roomsSource));
check("receipt consumption is one-time and generation-bound",
  receiptSource.includes('withIndex("by_jti"')
  && receiptSource.includes('"receipt_replayed"')
  && receiptSource.includes('room.generationState !== "active"'));
check("durable rooms carry only the canonical private PVP policy",
  schemaSource.includes('pvpPolicy: v.optional(v.literal("private_draft_v1"))'));
check("browser room creation cannot submit a policy claim",
  !roomsSource.slice(
    roomsSource.indexOf("export const create"),
    roomsSource.indexOf("handler:", roomsSource.indexOf("export const create")),
  ).includes("pvpPolicy"));
check("room policy is never patched during start, reopen, leave, or heartbeat",
  [...roomsSource.matchAll(/ctx\.db\.patch\([\s\S]*?\);/g)]
    .every((match) => !match[0].includes("pvpPolicy")));
check("PVP ticket v2 inserts policy immediately after world in fixed key order",
  ticketCoreSource.includes('wld: claims.worldId,\n    pp: claims.pvpPolicy')
  && ticketCoreSource.includes('const body = "v2."'));
check("generation admission is the policy-bound a2 envelope",
  admissionSource.includes('GENERATION_ADMISSION_PREFIX = "a2"')
  && admissionSource.includes("pvpPolicy: PvpPolicyId | null"));
check("legacy migration never upgrades missing PVP policy",
  migrationSource.includes("Deliberately do not infer pvpPolicy")
  && !/ctx\.db\.patch\([^)]*pvpPolicy/.test(migrationSource));
check("dark foundation leaves PVP drafts and verified progression off",
  pvpSimSource.includes("draftEnabled: false")
  && serverSource.includes("if (!world || world.isPvp) return;"));
check("Convex/browser ticket minter cannot emit the control-only probe purpose",
  !ticketCoreSource.includes("pr:"));
const probeBranch = routerSource.indexOf("auth.isPolicyAuthorityProbe === true");
check("terminal policy parser acknowledgement precedes rollout, admission, and world binding",
  probeBranch >= 0
  && probeBranch < routerSource.indexOf("pvpPrivateEnabled")
  && probeBranch < routerSource.indexOf("authorizeJoin(auth)")
  && probeBranch < routerSource.indexOf("bindVerifiedJoin(conn"));
check("admission client validates the closed response schema before authorization",
  admissionClientSource.indexOf("parseGenerationAdmissionDecision(body)")
  < admissionClientSource.indexOf("response.status === 200 && decision.isAllowed"));
check("admission client locks allow/deny to exact HTTP 200/403 pairs",
  admissionClientSource.includes("response.status === 200 && decision.isAllowed")
  && admissionClientSource.includes("response.status === 403 && !decision.isAllowed"));
check("signed tickets scan duplicate-aware JSON and canonicalize policy v2 bytes",
  ticketAuthSource.includes("isStrictJsonObject(payloadText)")
  && ticketAuthSource.includes("payloadText !== canonicalProbe")
  && ticketAuthSource.includes("payloadText !== JSON.stringify(canonicalPvpPayload(payload))"));
check("production control requires the parser secret before startup",
  controlConfigSource.includes('throw new Error("policy_probe_secret_missing")'));
check("lifecycle operations use authority verification and never diagnostic verification",
  (deployControllerSource.match(/verifyForDeploy\(\)/g) ?? []).length === 3
  && !deployControllerSource.includes("verifyDiagnostic"));
check("shared Convex HMAC envelopes require canonical payload and 32-byte signatures",
  hmacEnvelopeSource.includes("decodeCanonicalBase64Url(parts[1]")
  && hmacEnvelopeSource.includes("decodeCanonicalBase64Url(parts[2]")
  && hmacEnvelopeSource.includes("exactEncodedLength: HMAC_SHA256_BASE64URL_LENGTH")
  && hmacEnvelopeSource.includes("exactDecodedLength: HMAC_SHA256_BYTES"));
check("r1 and a2 payloads both require fatal UTF-8 and strict JSON",
  receiptCoreSource.includes('new TextDecoder("utf-8", { fatal: true })')
  && receiptCoreSource.includes("isStrictJsonObject(payloadText)"));

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
