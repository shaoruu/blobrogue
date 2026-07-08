// Ticket mint/verify agreement suite: the production Convex minter (convex/gsTicketCore.ts,
// Web Crypto) and the game server's verifier (server/src/auth.ts, Node crypto) MUST agree
// byte-for-byte on the v1 ticket format — the exact class of bug where two sides speak
// different token formats. This imports BOTH real implementations and locks:
//   1. a Convex-minted ticket verifies on the server (same identity, not expired)
//   2. the Convex mint is BYTE-IDENTICAL to the server's own mint for identical inputs
//   3. tampering (sig/payload/format), expiry, and wrong-secret all reject
// Run: npm run test:ticket (in server/).

import { mintGsTicket } from "../../convex/gsTicketCore.js";
import { mintTicket, verifyTicket, type AuthConfig } from "../src/auth.js";

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

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nTicket mint/verify agreement locked (Convex minter == server verifier).\n");
}

void main();
