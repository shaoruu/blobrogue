// Redaction tests: secret-shaped keys and token-shaped values are masked in log context and in
// gs log lines returned via GET /v1/logs, so a token or secret can never leak through the ops
// surface.

import { HttpGameServerProbe, type TailReader } from "../src/adapters/httpProbe.js";
import { redactFields, redactString, redactValue } from "../src/redact.js";
import { TestRunner } from "./harness.js";

class StubTail implements TailReader {
  constructor(private lines: string[]) {}
  async tail(_path: string, _maxLines: number): Promise<string[]> {
    return this.lines;
  }
}

export async function suite(t: TestRunner): Promise<void> {
  await t.suite("redact: keys + token-shaped values", async () => {
    t.check("secret-named key masked", redactValue("authorization", "Bearer abc") === "[REDACTED]");
    t.check("token key masked", redactValue("confirmToken", "v1.aaaa.bbbb") === "[REDACTED]");
    t.check("plain value preserved", redactValue("count", 5) === 5);
    const long = "v1." + "A".repeat(50) + ".sig";
    t.check("token-shaped value in a normal field masked", redactString(`ticket=${long}`).includes("[REDACTED]"));
    const fields = redactFields({ msg: "ok", secret: "hunter2", n: 3 });
    t.check("fields redaction masks secret, keeps others", fields.secret === "[REDACTED]" && fields.n === 3 && fields.msg === "ok");
  });

  await t.suite("redact: gs log tail is redacted before return", async () => {
    const line = JSON.stringify({ time: "t", level: "info", msg: "join", playerId: "p1", token: "v1.header.signature", note: "bearer " + "Z".repeat(48) });
    const probe = new HttpGameServerProbe(
      { baseUrl: "http://127.0.0.1:1", wsUrl: "ws://127.0.0.1:1/ws", logOutFile: "/tmp/does-not-matter.log", syntheticTicketSecret: null, controlSecret: null, logTailMax: 100 },
      new StubTail([line]),
    );
    const logs = await probe.logs({ limit: 10, level: null });
    t.check("one log record parsed", logs.length === 1);
    if (logs.length === 1) {
      t.check("secret-named field redacted", logs[0].fields.token === "[REDACTED]");
      t.check("token-shaped value redacted", String(logs[0].fields.note).includes("[REDACTED]"));
      t.check("benign field preserved", logs[0].fields.playerId === "p1");
    }
  });
}
