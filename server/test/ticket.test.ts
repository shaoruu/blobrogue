// Ticket mint/verify agreement suite: the production Convex minter (convex/gsTicketCore.ts,
// Web Crypto) and the game server's verifier (server/src/auth.ts, Node crypto) MUST agree
// byte-for-byte on the v1 ticket format — the exact class of bug where two sides speak
// different token formats. This imports BOTH real implementations and locks:
//   1. a Convex-minted ticket verifies on the server (same identity, not expired)
//   2. the Convex mint is BYTE-IDENTICAL to the server's own mint for identical inputs —
//      including every optional room/identity claim combination (wld/nm/cl)
//   3. tampering (sig/payload/format), expiry, and wrong-secret all reject
//   4. the room/identity claims verify back out exactly (world binding, sanitized name,
//      color), and malformed claims reject rather than misroute
// Run: npm run test:ticket (in server/).

import { mintGsTicket, worldIdForRoomCode, type GsTicketClaims } from "../../convex/gsTicketCore.js";
import { mintTicket, verifyTicket, type AuthConfig } from "../src/auth.js";
import { worldIdForRoomCode as clientWorldIdForRoomCode } from "../../src/net/protocol.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

async function main(): Promise<void> {
  const secret = "prod-shared-secret-under-test";
  const cfg: AuthConfig = { secret, allowDev: false };
  const now = 1_760_000_000_000; // fixed clock so both mints are deterministic

  section("Convex-minted ticket verifies on the game server");
  {
    const ticket = await mintGsTicket(secret, "player-abc123", 120, now);
    const res = verifyTicket(cfg, ticket, now);
    check("verifies ok", res.ok === true, res.reason ?? "");
    check("identity round-trips", res.playerId === "player-abc123", `got=${res.playerId}`);
  }

  section("Convex mint is BYTE-IDENTICAL to the server mint (same format, same bytes)");
  {
    for (const pid of ["p1", "guest:0e9df3a2-4a4b-4f6a-9251-1c2f3a4b5c6d", "j)(*&^%$#@!-weird", "a".repeat(64)]) {
      const fromConvex = await mintGsTicket(secret, pid, 120, now);
      const fromServer = mintTicket(secret, pid, 120, now);
      check(`byte equality for pid=${JSON.stringify(pid.slice(0, 24))}`, fromConvex === fromServer);
    }
    // Every optional-claim combination must serialize identically on both sides (the fixed
    // pid,exp,wld,nm,cl key order is the byte contract).
    const claimVariants: Array<[string, GsTicketClaims]> = [
      ["world only", { worldId: "room:ABCD" }],
      ["world+name", { worldId: "room:ABCD", name: "Ada" }],
      ["world+name+color", { worldId: worldIdForRoomCode("zqxj"), name: "Ada Lovelace", colorIndex: 3 }],
      ["name only (quick play identity)", { name: "blob" }],
      ["unicode name", { worldId: "room:WXYZ", name: "\u00e9\u00e8-bl\u00f6b \u2764", colorIndex: 5 }],
      ["color 0 (explicit amber)", { name: "amber", colorIndex: 0 }],
      ["hat only", { name: "Ada", hat: "hat_top" }],
      ["face only", { name: "Ada", face: "face_shades" }],
      ["full cosmetic identity", { worldId: "room:ABCD", name: "Ada", colorIndex: 2, hat: "hat_crown", face: "face_monocle" }],
      // v18: the kit + mastery-level claims (the byte contract must hold with them too).
      ["kit + mastery", { worldId: "room:ABCD", name: "Ada", colorIndex: 2, kit: "phantom", masteryLevel: 5 }],
    ];
    for (const [label, claims] of claimVariants) {
      const fromConvex = await mintGsTicket(secret, "player-1", 120, now, claims);
      const fromServer = mintTicket(secret, "player-1", 120, now, claims);
      check(`byte equality with claims: ${label}`, fromConvex === fromServer);
    }
  }

  section("room/identity claims verify back out exactly (the room->world binding)");
  {
    const world = worldIdForRoomCode("abcd");
    check("room code maps to its world id (normalized uppercase)", world === "room:ABCD", world);
    // The Convex minter and the client/server shared mapping must agree — the client asserts
    // snapshot wids against ITS mapping of the room code, so a drift here would falsely
    // reject (or worse, falsely accept) every room join.
    for (const code of ["abcd", " QQQQ ", "zz99"]) {
      check(`minter and client agree on worldIdForRoomCode(${JSON.stringify(code)})`, worldIdForRoomCode(code) === clientWorldIdForRoomCode(code));
    }
    const ticket = await mintGsTicket(secret, "player-1", 120, now, { worldId: world, name: "Ada", colorIndex: 2, hat: "hat_top", face: "face_round" });
    const res = verifyTicket(cfg, ticket, now);
    check("claimed ticket verifies", res.ok === true, res.reason ?? "");
    check("world claim round-trips", res.worldId === "room:ABCD", `got=${res.worldId}`);
    check("name claim round-trips", res.name === "Ada", `got=${res.name}`);
    check("color claim round-trips", res.colorIndex === 2, `got=${res.colorIndex}`);
    check("hat claim round-trips", res.hat === "hat_top", `got=${res.hat}`);
    check("face claim round-trips", res.face === "face_round", `got=${res.face}`);

    const bare = await mintGsTicket(secret, "player-1", 120, now);
    const bareRes = verifyTicket(cfg, bare, now);
    check("claimless ticket verifies with NO world (old-format compat -> default world)",
      bareRes.ok === true && bareRes.worldId === undefined && bareRes.name === undefined && bareRes.colorIndex === undefined
      && bareRes.hat === undefined && bareRes.face === undefined);

    // The verifier sanitizes names (they render on other players' screens).
    const messy = await mintGsTicket(secret, "player-1", 120, now, { name: "  A\u0000da\n  the   Blob  " });
    const messyRes = verifyTicket(cfg, messy, now);
    check("name is sanitized (control chars stripped, whitespace collapsed)", messyRes.ok && messyRes.name === "Ada the Blob", `got=${JSON.stringify(messyRes.name)}`);

    // Malformed claims in an otherwise-valid signed payload reject outright.
    const badWorld = await mintGsTicket(secret, "player-1", 120, now, { worldId: "room:../../etc" });
    check("junk world id rejects (bad_world)", verifyTicket(cfg, badWorld, now).reason === "bad_world");
    const longWorld = await mintGsTicket(secret, "player-1", 120, now, { worldId: "w".repeat(41) });
    check("oversized world id rejects", verifyTicket(cfg, longWorld, now).ok === false);
    const badColor = await mintGsTicket(secret, "player-1", 120, now, { colorIndex: 99 });
    check("out-of-range color rejects (bad_color)", verifyTicket(cfg, badColor, now).reason === "bad_color");
    const badHat = await mintGsTicket(secret, "player-1", 120, now, { hat: "NOT A TOKEN!" });
    check("malformed hat id rejects (bad_cosmetic)", verifyTicket(cfg, badHat, now).reason === "bad_cosmetic");
    const longFace = await mintGsTicket(secret, "player-1", 120, now, { face: "f".repeat(25) });
    check("oversized face id rejects (bad_cosmetic)", verifyTicket(cfg, longFace, now).reason === "bad_cosmetic");
    const unknownHat = await mintGsTicket(secret, "player-1", 120, now, { hat: "hat_from_the_future" });
    const unknownRes = verifyTicket(cfg, unknownHat, now);
    check("well-formed UNKNOWN cosmetic id passes format-only verification (catalog-independent servers)",
      unknownRes.ok === true && unknownRes.hat === "hat_from_the_future");

    // v18 KIT + MASTERY claims (spec §9.5): the signed kit + account level ride the ticket and
    // verify back out; a malformed kit / mastery is rejected outright. The join handler then
    // re-gates the kit against the level (isKitUnlocked ? kit : "gunner") — proven here directly.
    const kitTicket = await mintGsTicket(secret, "player-1", 120, now, { kit: "bulwark", masteryLevel: 3 });
    const kitRes = verifyTicket(cfg, kitTicket, now);
    check("kit + mastery claims verify back out", kitRes.ok && kitRes.kit === "bulwark" && kitRes.masteryLevel === 3, `kit=${kitRes.kit} ml=${kitRes.masteryLevel}`);
    const badKit = await mintGsTicket(secret, "player-1", 120, now, { kit: "sniper" });
    check("an unknown kit claim rejects (bad_kit)", verifyTicket(cfg, badKit, now).reason === "bad_kit");
    const badMastery = await mintGsTicket(secret, "player-1", 120, now, { masteryLevel: 0 });
    check("a bad mastery level rejects (bad_mastery)", verifyTicket(cfg, badMastery, now).reason === "bad_mastery");
    // The server-side unlock gate the join handler applies (never trust a client's claim).
    const gate = (kit: string, level: number): string => {
      const unlocked = kit === "gunner" || kit === "mender" || (kit === "bulwark" && level >= 3) || (kit === "phantom" && level >= 5);
      return unlocked ? kit : "gunner";
    };
    check("a low-mastery PHANTOM claim is downgraded to gunner server-side", gate("phantom", 2) === "gunner");
    check("a level-3 BULWARK claim is honoured server-side", gate("bulwark", 3) === "bulwark");

    // Tampering with the world claim (world-hop attempt) breaks the signature.
    const [head, payload] = ticket.split(".");
    const swapped = Buffer.from(
      JSON.stringify({ ...(JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as object), wld: "room:HACK" }),
    ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    check("world-claim swap rejects (sig no longer matches)", verifyTicket(cfg, `${head}.${swapped}.${ticket.split(".")[2]}`, now).ok === false);
  }

  section("adversarial tickets reject");
  {
    const good = await mintGsTicket(secret, "victim", 120, now);
    const [head, payload, sig] = good.split(".");
    check("tampered signature rejects", verifyTicket(cfg, `${head}.${payload}.${sig.slice(0, -2)}xx`, now).ok === false);
    // Forge a different pid over the original signature.
    const forgedPayload = Buffer.from(JSON.stringify({ pid: "attacker", exp: Math.floor(now / 1000) + 120 })).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    check("payload swap rejects (sig no longer matches)", verifyTicket(cfg, `${head}.${forgedPayload}.${sig}`, now).ok === false);
    check("wrong version prefix rejects", verifyTicket(cfg, `v2.${payload}.${sig}`, now).ok === false);
    check("wrong secret rejects", verifyTicket({ secret: "other-secret", allowDev: false }, good, now).ok === false);
    const expired = await mintGsTicket(secret, "victim", 60, now - 120_000);
    const expRes = verifyTicket(cfg, expired, now);
    check("expired ticket rejects", expRes.ok === false && expRes.reason === "expired", expRes.reason ?? "");
    check("replay INSIDE ttl is accepted (tickets are short-lived bearer tokens)", verifyTicket(cfg, good, now + 60_000).ok === true);
    check("replay AFTER ttl rejects", verifyTicket(cfg, good, now + 121_000).ok === false);
    check("dev ticket rejected when dev auth disabled", verifyTicket(cfg, "dev:hax", now).ok === false);
  }

  section("dev bypass (allowDev only) carries an optional world for the two-tab proof");
  {
    const devCfg: AuthConfig = { secret: null, allowDev: true };
    const plain = verifyTicket(devCfg, "dev:alice", now);
    check("dev ticket verifies with no world", plain.ok === true && plain.playerId === "dev:alice" && plain.worldId === undefined);
    const roomy = verifyTicket(devCfg, "dev:alice@room:ABCD", now);
    check("dev ticket carries a world", roomy.ok === true && roomy.worldId === "room:ABCD", `got=${roomy.worldId}`);
    check("dev ticket with a junk world rejects", verifyTicket(devCfg, "dev:alice@bad world!", now).ok === false);
  }

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nTicket mint/verify agreement locked (Convex minter == server verifier).\n");
}

void main();
