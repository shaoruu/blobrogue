// PartyGate unit suite: the pure readiness state machine behind the WAITING FOR PARTY veil.
// Locks the timeout/leave semantics the Sev-0 fix defines:
//   - the gate cannot open until EVERY currently-expected member is connected (self included;
//     an empty/undelivered expectation can never vacuously open it)
//   - a member who leaves/goes stale drops OUT of the expectation and the gate opens for the
//     rest (one absent client never deadlocks the party forever)
//   - past the deadline the gate reports FAILED with the missing members' names — an explicit
//     state, never a silent solo run
//   - readiness latches: a satisfied gate stays ready even if the roster wobbles afterwards
// Run: npm run test:partygate

import { PartyGate, PARTY_GATE_DEADLINE_MS } from "../src/net/partyGate.js";
import type { ExpectedMember } from "../src/net/partyGate.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

const HOST: ExpectedMember = { playerId: "host", name: "Host", colorIndex: 0 };
const GUEST: ExpectedMember = { playerId: "guest", name: "Guest", colorIndex: 3 };

function main(): void {
  section("the gate waits until every expected member is connected");
  {
    const gate = new PartyGate("host");
    const t0 = 1000;
    let v = gate.evaluate(t0, [HOST, GUEST], new Set(["host"]));
    check("only the host connected -> waiting", v.phase === "waiting");
    check("member statuses are explicit", v.members.find((m) => m.playerId === "host")?.isConnected === true
      && v.members.find((m) => m.playerId === "guest")?.isConnected === false);
    check("self is marked", v.members.find((m) => m.playerId === "host")?.isSelf === true);
    v = gate.evaluate(t0 + 500, [HOST, GUEST], new Set(["host", "guest"]));
    check("everyone connected -> ready", v.phase === "ready");
    check("ready leaves nobody missing", v.missingNames.length === 0);
  }

  section("an empty or self-less expectation can never vacuously open the gate");
  {
    const gate = new PartyGate("host");
    check("empty expectation (roster not delivered yet) -> waiting", gate.evaluate(0, [], new Set(["host"])).phase === "waiting");
    check("expectation without self -> waiting", gate.evaluate(1, [GUEST], new Set(["guest"])).phase === "waiting");
  }

  section("leave semantics: a pruned member releases the gate (no deadlock)");
  {
    const gate = new PartyGate("host");
    let v = gate.evaluate(0, [HOST, GUEST], new Set(["host"]));
    check("waiting on the absent guest", v.phase === "waiting");
    // The guest's presence went stale (client closed) -> the live roster prunes them.
    v = gate.evaluate(5000, [HOST], new Set(["host"]));
    check("expectation shrank to the connected set -> ready", v.phase === "ready");
  }

  section("deadline: explicit FAILED naming who never made it — never a silent solo run");
  {
    const gate = new PartyGate("host", 20000);
    check("the clock anchors at the first evaluation", gate.evaluate(0, [HOST, GUEST], new Set(["host"])).phase === "waiting");
    check("still waiting just under the deadline", gate.evaluate(19999, [HOST, GUEST], new Set(["host"])).phase === "waiting");
    const v = gate.evaluate(20000, [HOST, GUEST], new Set(["host"]));
    check("failed at the deadline", v.phase === "failed");
    check("the absent member is NAMED", v.missingNames.length === 1 && v.missingNames[0] === "Guest", v.missingNames.join(","));
    check("default deadline outlives the presence stale window", PARTY_GATE_DEADLINE_MS > 12000, `${PARTY_GATE_DEADLINE_MS}ms`);
  }

  section("readiness latches once satisfied");
  {
    const gate = new PartyGate("host", 100);
    check("ready when assembled", gate.evaluate(0, [HOST, GUEST], new Set(["host", "guest"])).phase === "ready");
    // A roster wobble (e.g. one Convex update lag) or the deadline passing must not regress
    // an already-satisfied gate into failed.
    const v = gate.evaluate(500, [HOST, GUEST], new Set(["host"]));
    check("stays ready after satisfaction (no failed regression)", v.phase === "ready");
  }

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll party-gate assertions passed.\n");
}

main();
