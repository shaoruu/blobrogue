// Cosmetics launch-slice suite. Locks the four load-bearing guarantees:
//   1. CATALOG INTEGRITY — unique wire-safe ids, valid slots, every earned item has a real
//      grant criterion + player-facing hint, every entry has overlay art (nothing ships
//      invisible), and at least one starter item per slot (no fabricated inventory needed)
//   2. OWNERSHIP — starters owned from day one, earned items locked until granted, and
//      sanitizeEquip refuses unknown/locked/mis-slotted picks (a tampered equip is ignored)
//   3. VISUAL-ONLY — src/sim never imports the cosmetics modules (static scan, the purity
//      gate), and the ids ride the wire purely as PlayerWire.ht/gl labels: decorate,
//      default safely when absent (old-server frames), reject when present-but-malformed
//   4. SIGN-IN NUDGE POLICY — meaningful-progress gating, the session latch, and the
//      persistent dismissal cooldown (no repeat spam)
// Run: npm run test:cosmetics

import "./harness/domShim.js";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  COSMETICS, cosmeticById, cosmeticsForSlot, isCosmeticOwned, sanitizeEquip,
  earnedCosmeticsFor, isCosmeticIdFormat,
} from "../src/game/cosmetics.js";
import { hasCosmeticArt } from "../src/game/cosmeticArt.js";
import { jsonCodec, ProtocolError, buildSnapshot } from "../src/net/protocol.js";
import { createWorld, spawnPlayerInWorld } from "../src/sim/world.js";
import {
  shouldShowSigninNudge, recordNudgeDismissed, NUDGE_COOLDOWN_MS, NUDGE_DISMISSED_AT_KEY,
} from "../src/ui/signinNudge.js";
import type { NudgeStore } from "../src/ui/signinNudge.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`); }
  else { failed++; failures.push(name + (detail ? " — " + detail : "")); process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`); }
}
function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function catalogTests(): void {
  section("catalog integrity: wire-safe ids, honest unlock criteria, art for every entry");
  const ids = COSMETICS.map((c) => c.id);
  check("ids are unique", new Set(ids).size === ids.length, ids.join(","));
  check("every id passes the wire/claim format gate", ids.every(isCosmeticIdFormat));
  check("every entry names a real slot", COSMETICS.every((c) => c.slot === "hat" || c.slot === "glasses"));
  const earned = COSMETICS.filter((c) => c.unlock === "earned");
  check("every EARNED item has a grant criterion (need)", earned.every((c) => c.need !== undefined && Object.keys(c.need).length > 0));
  check("every EARNED item has a player-facing hint", earned.every((c) => typeof c.hint === "string" && c.hint.length > 0));
  check("at least one starter hat + starter glasses (no fabricated inventory needed)",
    cosmeticsForSlot("hat").some((c) => c.unlock === "starter") && cosmeticsForSlot("glasses").some((c) => c.unlock === "starter"));
  check("every catalog entry has overlay art (nothing ships invisible)", ids.every(hasCosmeticArt), ids.filter((id) => !hasCosmeticArt(id)).join(","));
  check("lookup round-trips", ids.every((id) => cosmeticById(id)?.id === id));
}

function ownershipTests(): void {
  section("ownership: starters free, earned items locked until granted, tampered equips ignored");
  const starter = COSMETICS.find((c) => c.unlock === "starter")!;
  const lockedItem = COSMETICS.find((c) => c.unlock === "earned")!;
  check("starter owned with zero unlocks", isCosmeticOwned(starter, []));
  check("earned item locked with zero unlocks", !isCosmeticOwned(lockedItem, []));
  check("earned item owned once granted", isCosmeticOwned(lockedItem, [lockedItem.id]));
  check("sanitizeEquip accepts an owned pick", sanitizeEquip(starter.slot, starter.id, []) === starter.id);
  check("sanitizeEquip refuses a LOCKED pick", sanitizeEquip(lockedItem.slot, lockedItem.id, []) === undefined);
  check("sanitizeEquip refuses an unknown id", sanitizeEquip("hat", "hat_haxx", []) === undefined);
  const wrongSlot = lockedItem.slot === "hat" ? "glasses" : "hat";
  check("sanitizeEquip refuses a mis-slotted pick", sanitizeEquip(wrongSlot, lockedItem.id, [lockedItem.id]) === undefined);
}

function grantTests(): void {
  section("earned grants key off all-time stats (the recordRun grant path)");
  check("nothing granted at zero stats", earnedCosmeticsFor({ deepestFloor: 0, totalKills: 0 }).length === 0);
  const atTen = earnedCosmeticsFor({ deepestFloor: 10, totalKills: 0 });
  check("floor 10 grants the crown", atTen.includes("hat_crown"), atTen.join(","));
  check("floor 10 does NOT grant the floor-20 halo", !atTen.includes("hat_halo"));
  const atTwenty = earnedCosmeticsFor({ deepestFloor: 20, totalKills: 0 });
  check("floor 20 grants crown + halo", atTwenty.includes("hat_crown") && atTwenty.includes("hat_halo"));
  const killer = earnedCosmeticsFor({ deepestFloor: 0, totalKills: 500 });
  check("500 kills grants the monocle", killer.includes("glasses_monocle"));
  check("499 kills does not", !earnedCosmeticsFor({ deepestFloor: 0, totalKills: 499 }).includes("glasses_monocle"));
}

function purityTests(): void {
  section("visual-only: the sim never imports cosmetics; no gameplay module maps ids to behavior");
  const simDir = join(ROOT, "src/sim");
  const offenders: string[] = [];
  for (const f of readdirSync(simDir)) {
    if (!f.endsWith(".ts")) continue;
    const src = readFileSync(join(simDir, f), "utf8");
    if (/from\s+"[^"]*(cosmetic|convex)/i.test(src)) offenders.push(f);
  }
  check("src/sim has zero cosmetics/convex imports", offenders.length === 0, offenders.join(","));
}

function wireTests(): void {
  section("wire: ht/gl decorate PlayerWire, default safely when absent, reject when malformed");
  const w = createWorld(0xC05, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(w, "pMe");
  const dressed = spawnPlayerInWorld(w, "pDressed");
  const plain = spawnPlayerInWorld(w, "pPlain");
  plain.x = dressed.x + 30;

  const identities = new Map([
    ["pDressed", { name: "Ada", colorIndex: 2, hat: "hat_crown", glasses: "glasses_shades" }],
    ["pPlain", { name: "Bob", colorIndex: null }], // pre-cosmetics identity constructor shape
  ]);
  const snap = buildSnapshot(w, "pMe", 0, [], 0, false, { worldId: "w-test", identities });
  if (snap.t !== "snap") { check("snapshot built", false); return; }
  const wDressed = snap.players.find((p) => p.id === "pDressed");
  const wPlain = snap.players.find((p) => p.id === "pPlain");
  check("equipped cosmetics decorate the wire", wDressed?.ht === "hat_crown" && wDressed?.gl === "glasses_shades", `ht=${wDressed?.ht} gl=${wDressed?.gl}`);
  check("an identity without cosmetic fields decodes to null slots", wPlain?.ht === null && wPlain?.gl === null);

  const decoded = jsonCodec.decodeServer(jsonCodec.encodeServer(snap));
  check("ht/gl round-trip deep-equal", JSON.stringify(decoded) === JSON.stringify(snap));

  // An OLD server's PlayerWire (no ht/gl at all) still decodes, with the safe fallbacks.
  const legacy = JSON.parse(jsonCodec.encodeServer(snap)) as { players: Array<Record<string, unknown>> };
  for (const p of legacy.players) { delete p.ht; delete p.gl; }
  const fromLegacy = jsonCodec.decodeServer(JSON.stringify(legacy));
  if (fromLegacy.t === "snap") {
    const lp = fromLegacy.players.find((p) => p.id === "pDressed");
    check("absent ht/gl decode as null (old-server compat)", lp?.ht === null && lp?.gl === null);
  } else {
    check("legacy frame decoded", false);
  }

  // Present-but-malformed cosmetic fields are protocol errors.
  const badVariants: Array<[string, unknown]> = [
    ["non-string ht", 42],
    ["oversized ht", "x".repeat(25)],
    ["empty-string ht", ""],
  ];
  for (const [label, ht] of badVariants) {
    const bad = JSON.parse(jsonCodec.encodeServer(snap)) as { players: Array<Record<string, unknown>> };
    bad.players[0].ht = ht;
    let isRejected = false;
    try { jsonCodec.decodeServer(JSON.stringify(bad)); } catch (err) { isRejected = err instanceof ProtocolError; }
    check(`${label} rejected`, isRejected);
  }
}

function fakeStore(): NudgeStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
  };
}

function nudgeTests(): void {
  section("sign-in nudge policy: progress-gated, session-latched, cooldown after dismissal");
  const base = { isSignInAvailable: true, isSignedIn: false, hasMeaningfulProgress: true, isShownThisSession: false };
  const t0 = 1_760_000_000_000;

  check("shows for a guest with fresh progress", shouldShowSigninNudge(fakeStore(), base, t0));
  check("never for a signed-in player", !shouldShowSigninNudge(fakeStore(), { ...base, isSignedIn: true }, t0));
  check("never when sign-in is unavailable", !shouldShowSigninNudge(fakeStore(), { ...base, isSignInAvailable: false }, t0));
  check("never without meaningful progress", !shouldShowSigninNudge(fakeStore(), { ...base, hasMeaningfulProgress: false }, t0));
  check("at most once per session", !shouldShowSigninNudge(fakeStore(), { ...base, isShownThisSession: true }, t0));

  const store = fakeStore();
  recordNudgeDismissed(store, t0);
  check("dismissal persists a timestamp", store.data.get(NUDGE_DISMISSED_AT_KEY) === String(t0));
  check("suppressed inside the cooldown", !shouldShowSigninNudge(store, base, t0 + NUDGE_COOLDOWN_MS - 1));
  check("eligible again after the cooldown", shouldShowSigninNudge(store, base, t0 + NUDGE_COOLDOWN_MS + 1));

  const junk = fakeStore();
  junk.setItem(NUDGE_DISMISSED_AT_KEY, "not-a-number");
  check("junk stored timestamp fails open (shows)", shouldShowSigninNudge(junk, base, t0));
}

function main(): void {
  catalogTests();
  ownershipTests();
  grantTests();
  purityTests();
  wireTests();
  nudgeTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll cosmetics launch-slice assertions passed.\n");
}

main();
