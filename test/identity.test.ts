// Guest identity suite: the generated-default-name contract (the end of everyone joining
// as the literal "blob") and the Session-level guarantees around it:
//   - the generator is DETERMINISTIC from the clientId hash (a returning guest keeps the
//     same name), adjective+"Blob" from the curated list, numeric suffix ONLY on collision
//   - the reroll (name-gate dice) always lands on a different generated default
//   - the client sanitizer trims / collapses whitespace / strips control+zero-width junk /
//     caps at 20, and an input that sanitizes away (or IS the literal "blob") keeps the
//     generated default — no path can ever produce an empty name or "blob"
//   - a fresh Session assigns the generated default ONCE and persists it; a stored legacy
//     "blob" heals to the generated default; login() can never regress the name
// Run: npm run test:identity

import "./harness/domShim.js";
import {
  BLOB_NAME_ADJECTIVES, generatedBlobName, rerollBlobName, sanitizeBlobName, resolveNameInput,
} from "../src/net/blobName.js";
import { Session } from "../src/net/session.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

function main(): void {
  section("generated defaults: deterministic, wholesome, never 'blob'");
  {
    const a = generatedBlobName("client-uuid-1234");
    check("deterministic for one clientId", a === generatedBlobName("client-uuid-1234"), a);
    check("adjective+Blob shape from the curated list",
      BLOB_NAME_ADJECTIVES.some((adj) => a === adj + "Blob"), a);
    check("no suffix without a collision", /^[A-Za-z]+Blob$/.test(a), a);
    const spread = new Set(["s1", "s2", "s3", "s4", "s5", "s6"].map((s) => generatedBlobName(s)));
    check("the hash spreads across the adjective list", spread.size > 1, [...spread].join(","));
    check("never the literal 'blob'", a.toLowerCase() !== "blob");
    check("fits the 20-char name cap (worst case adjective + 3-digit suffix)",
      Math.max(...BLOB_NAME_ADJECTIVES.map((adj) => adj.length)) + "Blob".length + 3 <= 20);
  }

  section("collision suffix: 2 digits when the base is taken, 3 as the fallback");
  {
    const base = generatedBlobName("seed-A");
    const withTwo = generatedBlobName("seed-A", [base]);
    check("a taken base gains a 2-digit suffix", new RegExp(`^${base}\\d{2}$`).test(withTwo), withTwo);
    const withThree = generatedBlobName("seed-A", [base, withTwo]);
    check("a taken 2-digit name widens to 3 digits", new RegExp(`^${base}\\d{3}$`).test(withThree), withThree);
    check("the collision check is case-insensitive",
      generatedBlobName("seed-A", [base.toUpperCase()]) !== base);
    check("suffixed names stay deterministic", withTwo === generatedBlobName("seed-A", [base]));
  }

  section("reroll (the gate's dice): always a different generated default");
  {
    let current = generatedBlobName("seed-R");
    for (let roll = 1; roll <= 8; roll++) {
      const next = rerollBlobName("seed-R", roll, current);
      if (next.toLowerCase() === current.toLowerCase()) {
        check(`roll ${roll} changed the name`, false, `${current} -> ${next}`);
        return;
      }
      current = next;
    }
    check("eight consecutive rolls each changed the name", true);
    check("rolls stay generated defaults", BLOB_NAME_ADJECTIVES.some((adj) => current.startsWith(adj)) && current.includes("Blob"), current);
  }

  section("sanitizer: trim, collapse, strip control/zero-width junk, cap 20");
  {
    check("plain name passes through", sanitizeBlobName("Ada") === "Ada");
    check("whitespace collapses and trims", sanitizeBlobName("  Ada   Lovelace  ") === "Ada Lovelace");
    check("control characters strip", sanitizeBlobName("A\u0000d\u001fa\u007f") === "Ada");
    check("zero-width/joiner junk strips", sanitizeBlobName("A\u200bd\u200da\u2060\ufeff") === "Ada");
    check("length caps at 20", sanitizeBlobName("x".repeat(40)).length === 20);
    check("a cap that lands on a space re-trims", !sanitizeBlobName("aaaaaaaaaaaaaaaaaaa bcd").endsWith(" "));
    check("pure junk sanitizes to empty", sanitizeBlobName(" \u200b\u0007  ") === "");
    check("unicode names survive", sanitizeBlobName("\u00e9\u00e8-bl\u00f6b \u2764") === "\u00e9\u00e8-bl\u00f6b \u2764");
  }

  section("resolveNameInput: empty and the literal 'blob' keep the generated default");
  {
    const fallback = "MossyBlob";
    check("typed name wins", resolveNameInput("Ada", fallback) === "Ada");
    check("empty keeps the default", resolveNameInput("", fallback) === fallback);
    check("whitespace keeps the default", resolveNameInput("   ", fallback) === fallback);
    check("literal 'blob' keeps the default", resolveNameInput("blob", fallback) === fallback);
    check("'BLOB' (any case) keeps the default", resolveNameInput("  BLOB ", fallback) === fallback);
    check("'blobby' is a real name, not the placeholder", resolveNameInput("blobby", fallback) === "blobby");
  }

  section("Session: the default is assigned once, persisted, and stable across boots");
  {
    localStorage.removeItem("blobrogue.name");
    localStorage.removeItem("blobrogue.nameConfirmed");
    const s1 = new Session(null);
    check("a fresh session gets a generated default", s1.name.length > 0 && s1.name.toLowerCase() !== "blob", s1.name);
    check("the default matches the clientId hash", s1.name === generatedBlobName(s1.clientId));
    check("the default persists to blobrogue.name", localStorage.getItem("blobrogue.name") === s1.name);
    const s2 = new Session(null);
    check("a returning guest keeps the same name", s2.name === s1.name);
    check("the gate has not been confirmed yet", s1.isNameConfirmed === false);
    s1.markNameConfirmed();
    check("markNameConfirmed latches", new Session(null).isNameConfirmed === true);
    localStorage.removeItem("blobrogue.nameConfirmed");
  }

  section("Session: a stored legacy 'blob' heals; login can never regress the name");
  {
    localStorage.setItem("blobrogue.name", "blob");
    const healed = new Session(null);
    check("a stored literal 'blob' heals to the generated default",
      healed.name === generatedBlobName(healed.clientId), healed.name);
    localStorage.setItem("blobrogue.name", "Ada");
    const ada = new Session(null);
    check("a real stored name is kept", ada.name === "Ada");
    void ada.login("");
    check("login('') keeps the standing name", ada.name === "Ada");
    void ada.login("blob");
    check("login('blob') keeps the standing name", ada.name === "Ada");
    void ada.login("  Grace   Hopper \u200b ");
    check("login sanitizes a typed name", ada.name === "Grace Hopper", ada.name);
    localStorage.removeItem("blobrogue.name");
  }

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll guest-identity assertions passed.\n");
}

main();
