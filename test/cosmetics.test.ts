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
  COSMETICS, COSMETIC_SLOTS, cosmeticById, cosmeticsForSlot, isCosmeticOwned, sanitizeEquip,
  earnedCosmeticsFor, isCosmeticIdFormat, bodyItemForPaletteIndex, bodyPaletteIndex,
} from "../src/game/cosmetics.js";
import { hasCosmeticArt, resolveOverlay } from "../src/game/cosmeticArt.js";
import {
  COSMETIC_ORIENTATIONS, SOCKET_KINDS, socketFor, capCosmeticXform,
  COSMETIC_SCALE_CAP, COSMETIC_ROT_CAP, COSMETIC_BOB_CAP, COSMETIC_ASSET_SOURCES,
  LAYERED_HERO_BASE_SRC, LAYERED_HERO_BASE_WALK_SRC,
} from "../src/game/cosmeticSockets.js";
import { heroBodySprite, SHEETS, devSpriteManifest } from "../src/game/assets.js";
import { jsonCodec, ProtocolError, buildSnapshot } from "../src/net/protocol.js";
import { createWorld, spawnPlayerInWorld, stepWorld } from "../src/sim/world.js";
import { IDLE_INPUT } from "../src/sim/input.js";
import type { InputCmd, PlayerId } from "../src/sim/input.js";
import {
  shouldShowSigninNudge, recordNudgeShown, recordNudgeDismissed,
  NUDGE_COOLDOWN_MS, NUDGE_SHOWN_COOLDOWN_MS, NUDGE_DISMISSED_AT_KEY, NUDGE_SHOWN_AT_KEY,
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
  section("catalog integrity: shipped slots only, wire-safe ids, honest criteria, art where art is due");
  const ids = COSMETICS.map((c) => c.id);
  const shipped = new Set(COSMETIC_SLOTS.map((s) => s.slot));
  check("the shipped slot registry is exactly body/hat/face/title",
    [...shipped].sort().join(",") === "body,face,hat,title", [...shipped].join(","));
  check("ids are unique", new Set(ids).size === ids.length, ids.join(","));
  check("every id passes the wire/claim format gate", ids.every(isCosmeticIdFormat));
  check("every entry belongs to a SHIPPED slot (the UI only shows the registry)", COSMETICS.every((c) => shipped.has(c.slot)));
  const earned = COSMETICS.filter((c) => c.unlock === "earned");
  check("every EARNED item has a grant criterion (need)", earned.every((c) => c.need !== undefined && Object.keys(c.need).length > 0));
  check("every EARNED item exposes its exact condition (hint)", earned.every((c) => typeof c.hint === "string" && c.hint.length > 0));
  check("at least one starter hat + starter face (no fabricated inventory needed)",
    cosmeticsForSlot("hat").some((c) => c.unlock === "starter") && cosmeticsForSlot("face").some((c) => c.unlock === "starter"));
  const overlays = COSMETICS.filter((c) => c.slot === "hat" || c.slot === "face");
  check("every hat/face entry has overlay art (nothing ships invisible)",
    overlays.every((c) => hasCosmeticArt(c.id)), overlays.filter((c) => !hasCosmeticArt(c.id)).map((c) => c.id).join(","));
  const bodies = cosmeticsForSlot("body");
  check("every body entry maps to an authored palette slot (>0; slot 0 is the default look)",
    bodies.every((c) => Number.isInteger(c.paletteIndex) && (c.paletteIndex ?? 0) > 0));
  check("body palette slots are unique", new Set(bodies.map((c) => c.paletteIndex)).size === bodies.length);
  check("all body colors are starter (the authored palette is free)", bodies.every((c) => c.unlock === "starter"));
  check("titles are text honors (no art required, earned only)", cosmeticsForSlot("title").every((c) => c.unlock === "earned"));
  check("lookup round-trips", ids.every((id) => cosmeticById(id)?.id === id));
}

function bodyPaletteTests(): void {
  section("body palette vs party color: separated in the model, in step at launch");
  check("palette slot 1 maps to a body item", bodyItemForPaletteIndex(1)?.id === "body_cyan");
  check("palette slot 0 (classic amber) is the EMPTY body slot", bodyItemForPaletteIndex(0) === undefined);
  check("a worn body item resolves its own palette slot", bodyPaletteIndex("body_pink", 0) === 3);
  check("an empty body slot falls back to the PARTY color", bodyPaletteIndex(null, 4) === 4);
  check("an unknown body id falls back safely", bodyPaletteIndex("body_from_the_future", 2) === 2);
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
  const wrongSlot = lockedItem.slot === "hat" ? "face" : "hat";
  check("sanitizeEquip refuses a mis-slotted pick", sanitizeEquip(wrongSlot, lockedItem.id, [lockedItem.id]) === undefined);
}

function grantTests(): void {
  section("earned grants key off all-time stats (the recordRun grant path)");
  check("nothing granted at zero stats", earnedCosmeticsFor({ deepestFloor: 0, totalKills: 0 }).length === 0);
  const atTen = earnedCosmeticsFor({ deepestFloor: 10, totalKills: 0 });
  check("floor 10 grants the crown AND the Depth Diver title", atTen.includes("hat_crown") && atTen.includes("title_depth_diver"), atTen.join(","));
  check("floor 10 does NOT grant the floor-20 halo", !atTen.includes("hat_halo"));
  const atTwenty = earnedCosmeticsFor({ deepestFloor: 20, totalKills: 0 });
  check("floor 20 grants crown + halo", atTwenty.includes("hat_crown") && atTwenty.includes("hat_halo"));
  const killer = earnedCosmeticsFor({ deepestFloor: 0, totalKills: 500 });
  check("500 kills grants the monocle AND the Blob Slayer title", killer.includes("face_monocle") && killer.includes("title_blob_slayer"));
  check("499 kills does not", !earnedCosmeticsFor({ deepestFloor: 0, totalKills: 499 }).includes("face_monocle"));
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
  section("wire: ht/fc decorate PlayerWire, default safely when absent, reject when malformed");
  const w = createWorld(0xC05, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(w, "pMe");
  const dressed = spawnPlayerInWorld(w, "pDressed");
  const plain = spawnPlayerInWorld(w, "pPlain");
  plain.x = dressed.x + 30;

  const identities = new Map([
    ["pDressed", { name: "Ada", colorIndex: 2, hat: "hat_crown", face: "face_shades" }],
    ["pPlain", { name: "Bob", colorIndex: null }], // pre-cosmetics identity constructor shape
  ]);
  const snap = buildSnapshot(w, "pMe", 0, [], 0, false, { worldId: "w-test", identities });
  if (snap.t !== "snap") { check("snapshot built", false); return; }
  const wDressed = snap.players.find((p) => p.id === "pDressed");
  const wPlain = snap.players.find((p) => p.id === "pPlain");
  check("equipped cosmetics decorate the wire", wDressed?.ht === "hat_crown" && wDressed?.fc === "face_shades", `ht=${wDressed?.ht} fc=${wDressed?.fc}`);
  check("an identity without cosmetic fields decodes to null slots", wPlain?.ht === null && wPlain?.fc === null);

  const decoded = jsonCodec.decodeServer(jsonCodec.encodeServer(snap));
  check("ht/fc round-trip deep-equal", JSON.stringify(decoded) === JSON.stringify(snap));

  // An OLD server's PlayerWire (no ht/fc at all) still decodes, with the safe fallbacks.
  const legacy = JSON.parse(jsonCodec.encodeServer(snap)) as { players: Array<Record<string, unknown>> };
  for (const p of legacy.players) { delete p.ht; delete p.fc; }
  const fromLegacy = jsonCodec.decodeServer(JSON.stringify(legacy));
  if (fromLegacy.t === "snap") {
    const lp = fromLegacy.players.find((p) => p.id === "pDressed");
    check("absent ht/fc decode as null (old-server compat)", lp?.ht === null && lp?.fc === null);
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

// The hard proof that cosmetic ids cannot alter gameplay: identities are not INPUTS to the
// simulation at all — they exist only at snapshot-BUILD time as decoration. Two snapshot
// builds of the SAME world under wildly different identity maps must agree byte-for-byte on
// every gameplay field (position/HP/weapon/dash/revive/score...), and stepping the world is
// impossible to influence because stepWorld's signature has no identity parameter.
function simImmunityTests(): void {
  section("cosmetic ids cannot alter the simulation: identity maps decorate, never steer");
  const w = createWorld(0xFACE, 1, { isShared: true, skipLocalPlayer: true });
  spawnPlayerInWorld(w, "pA");
  spawnPlayerInWorld(w, "pB");
  const inputs = new Map<PlayerId, InputCmd>([
    ["pA", { ...IDLE_INPUT, moveX: 1, firing: true, aim: 0.5 }],
    ["pB", { ...IDLE_INPUT, moveY: -1, dash: true }],
  ]);
  for (let i = 0; i < 120; i++) stepWorld(w, inputs, 1 / 60);

  const plain = new Map([["pA", { name: "A", colorIndex: null }]]);
  const dressed = new Map([
    ["pA", { name: "Fancy", colorIndex: 5, hat: "hat_crown", face: "face_monocle" }],
    ["pB", { name: "Cone", colorIndex: 2, hat: "hat_party", face: "face_shades" }],
  ]);
  const snapPlain = buildSnapshot(w, "pA", 0, [], 0, false, { worldId: "w-imm", identities: plain });
  const snapDressed = buildSnapshot(w, "pA", 0, [], 0, false, { worldId: "w-imm", identities: dressed });
  if (snapPlain.t !== "snap" || snapDressed.t !== "snap") { check("snapshots built", false); return; }
  const stripIdentity = (frame: object): unknown => JSON.parse(JSON.stringify(frame), (k, v: unknown) => (
    k === "nm" || k === "cl" || k === "ht" || k === "fc" ? undefined : v
  ));
  check("SelfWire (speed/HP/fire/dash/score authority) is identity-independent",
    JSON.stringify(snapPlain.self) === JSON.stringify(snapDressed.self));
  check("every gameplay field of every wire struct is byte-identical under different identities",
    JSON.stringify(stripIdentity(snapPlain)) === JSON.stringify(stripIdentity(snapDressed)));

  // And the world itself cannot diverge: identities are not an argument to stepWorld —
  // stepping continues normally after decorated snapshot builds.
  for (let i = 0; i < 60; i++) stepWorld(w, inputs, 1 / 60);
  const after = buildSnapshot(w, "pA", 0, [], 0, false, { worldId: "w-imm", identities: dressed });
  check("the world advances normally after decorated snapshots (no state contamination)",
    after.t === "snap" && after.tick === snapDressed.tick + 60, `tick ${String(after.t === "snap" ? after.tick : "?")} vs ${snapDressed.tick + 60}`);
}

// Static render/markup gates: overlays draw before the weapon (never on top of it), and
// the DOM surfaces that render player-authored strings never use innerHTML.
function renderContractTests(): void {
  section("render contract: weapon above overlays; user-string surfaces are textContent-only");
  const game = readFileSync(join(ROOT, "src/game/game.ts"), "utf8");
  const renderPlayer = game.slice(game.indexOf("private renderPlayer()"), game.indexOf("private renderReviveRings"));
  check("local player: cosmetics draw BEFORE the held weapon (weapon/muzzle stay readable)",
    renderPlayer.indexOf("drawCosmetics") !== -1 && renderPlayer.indexOf("drawCosmetics") < renderPlayer.indexOf("renderHeldWeapon"));
  const renderRemotes = game.slice(game.indexOf("private renderRemotePlayers()"), game.indexOf("private selfTint()"));
  check("remotes: cosmetics draw BEFORE weapon and name label (identity redundant beyond color)",
    renderRemotes.indexOf("drawCosmetics") !== -1
    && renderRemotes.indexOf("drawCosmetics") < renderRemotes.indexOf("renderHeldWeapon")
    && renderRemotes.indexOf("drawCosmetics") < renderRemotes.indexOf("fillText"));
  const uiDir = join(ROOT, "src/ui");
  const offenders: string[] = [];
  for (const f of readdirSync(uiDir)) {
    if (f.endsWith(".ts") && readFileSync(join(uiDir, f), "utf8").includes("innerHTML")) offenders.push(f);
  }
  check("src/ui never uses innerHTML (names/titles/build labels are inert text)", offenders.length === 0, offenders.join(","));

  // ONE shared loadout renderer: every surface that draws worn cosmetics goes through
  // drawLoadoutOverlays — no surface keeps private overlay draw math to drift on.
  const preview = readFileSync(join(ROOT, "src/ui/blobPreview.ts"), "utf8");
  check("the world renderer delegates to drawLoadoutOverlays", game.includes("drawLoadoutOverlays("));
  check("the menu/profile/closet mirror delegates to drawLoadoutOverlays", preview.includes("drawLoadoutOverlays("));
  check("no surface keeps private overlay resolution (game)", !game.includes("resolveOverlay("));
  check("no surface keeps private overlay resolution (preview)", !preview.includes("resolveOverlay("));
}

// The public leaderboard projection is a whitelist: presentation fields only.
function publicSchemaTests(): void {
  section("public schema only: the leaderboard entry exposes no account/internal identifiers");
  const src = readFileSync(join(ROOT, "convex/leaderboard.ts"), "utf8");
  const entryBlock = src.slice(src.indexOf("export interface LeaderboardEntry"), src.indexOf("function toEntry"));
  for (const banned of ["playerId", "email", "userId", "clientId", "image", "token", "roomId", "sessionId"]) {
    check(`public entry never carries ${banned}`, !entryBlock.includes(banned));
  }
  check("the module never READS account fields at all", !/\b(doc|player|existing|guest|account)\.(email|userId|clientId|image)\b/.test(src));
  const apiSrc = readFileSync(join(ROOT, "src/net/api.ts"), "utf8");
  const docBlock = apiSrc.slice(apiSrc.indexOf("export interface LeaderboardEntryDoc"), apiSrc.indexOf("// The run-build subset"));
  check("the client contract matches (no ids in LeaderboardEntryDoc)", !docBlock.includes("playerId"));
}

// The socket gate (fal-art/COSMETIC_LAYER_SPEC.md integration): deterministic anchors
// across every orientation x socket x frame, capped transforms, layer order (covered by
// renderContractTests), and the FIRST integration pair only on the asset hooks.
function socketGateTests(): void {
  section("sockets: deterministic per-facing/per-frame anchors, full coverage, safe clamping");
  check("three orientations ship (down/up/side — side mirrored for left)",
    COSMETIC_ORIENTATIONS.join(",") === "down,up,side");
  check("three socket kinds ship (head/face/back)", SOCKET_KINDS.join(",") === "head,face,back");
  let covered = 0;
  let isDeterministic = true;
  let isInFrame = true;
  for (const o of COSMETIC_ORIENTATIONS) {
    for (const k of SOCKET_KINDS) {
      for (let f = -4; f < 12; f++) {
        const a = socketFor(k, o, f);
        const b = socketFor(k, o, f);
        if (a.x !== b.x || a.y !== b.y || a.isVisible !== b.isVisible || a.isBehindBody !== b.isBehindBody) isDeterministic = false;
        if (!(a.x >= 0 && a.x <= 64 && a.y >= 0 && a.y <= 64)) isInFrame = false;
        covered++;
      }
    }
  }
  check("every orientation x socket x frame (incl. negative/oversized) resolves", covered === 3 * 3 * 16);
  check("lookups are deterministic (same inputs, same anchor, every client)", isDeterministic);
  check("every anchor sits inside the 64px frame", isInFrame);
  check("frame index wraps by modulo (frame 4 == frame 0)",
    socketFor("head", "side", 4).x === socketFor("head", "side", 0).x);
  check("the face socket is INVISIBLE facing away (up)", !socketFor("face", "up", 0).isVisible);
  check("...but visible facing down and side", socketFor("face", "down", 0).isVisible && socketFor("face", "side", 0).isVisible);

  section("capped transforms: cosmetics follow bob/lean/squash only up to the readability caps");
  const wild = capCosmeticXform({ ox: 9, oy: -14, sx: 1.4, sy: 0.5, rot: 0.8 });
  check("bob capped", Math.abs(wild.oy) <= COSMETIC_BOB_CAP, String(wild.oy));
  check("squash/stretch capped", wild.sx <= 1 + COSMETIC_SCALE_CAP && wild.sy >= 1 - COSMETIC_SCALE_CAP, `${wild.sx},${wild.sy}`);
  check("lean capped", Math.abs(wild.rot) <= COSMETIC_ROT_CAP, String(wild.rot));
  const mild = capCosmeticXform({ ox: 0.5, oy: -1, sx: 1.02, sy: 0.99, rot: 0.01 });
  check("mild body motion passes through untouched", mild.oy === -1 && mild.sx === 1.02 && mild.sy === 0.99 && mild.rot === 0.01);

  section("asset hooks: every overlay wired to its Wave 1 sprite, oriented paths, no procedural art");
  for (const [key, def] of Object.entries(COSMETIC_ASSET_SOURCES)) {
    const oriented = COSMETIC_ORIENTATIONS.every((o) => def.src[o] === `/sprites/cosmetics/${key}_${o}.png`);
    check(`${key}: all three oriented asset paths follow the pipeline contract`, oriented);
  }
  // EVERY hat/face catalog entry hooks a real asset (nothing renders procedurally anymore),
  // and its assetKey resolves to a COSMETIC_ASSET_SOURCES entry with the right socket.
  const overlays = COSMETICS.filter((c) => c.slot === "hat" || c.slot === "face");
  for (const c of overlays) {
    const key = c.assetKey;
    check(`${c.id} carries an assetKey`, typeof key === "string" && key.length > 0, String(key));
    const def = key ? COSMETIC_ASSET_SOURCES[key] : undefined;
    check(`${c.id} resolves to a wired asset (${key})`, def !== undefined);
    if (def) check(`${c.id} sockets to the ${c.slot === "hat" ? "head" : "face"}`,
      def.socket === (c.slot === "hat" ? "head" : "face"), def.socket);
  }
  check("round_glasses hooks the shipped Round Specs item", cosmeticById("face_round")?.assetKey === "round_glasses");
  check("cowboy_hat_classic is now a normal equippable hat layer (starter, hooks its overlay art)",
    COSMETIC_ASSET_SOURCES.cowboy_hat_classic !== undefined
    && cosmeticById("cowboy_hat_classic")?.slot === "hat"
    && cosmeticById("cowboy_hat_classic")?.unlock === "starter"
    && cosmeticById("cowboy_hat_classic")?.assetKey === "cowboy_hat_classic");
  check("the layered bald base + walk sheet have explicit hooks for the art pipeline",
    LAYERED_HERO_BASE_SRC === "/sprites/cosmetics/hero_base_bald.png"
    && LAYERED_HERO_BASE_WALK_SRC === "/sprites/cosmetics/hero_base_bald_walk.png");
  // Sprites are the ONLY cosmetic art: with no image binaries loaded in this headless
  // harness, resolution yields nothing (never a fabricated placeholder) — a wired id with an
  // unloaded asset and an unknown id alike resolve to null.
  check("a wired overlay resolves to NOTHING while its sprite is unloaded (no procedural fallback)",
    resolveOverlay("face_round", "side", 0) === null);
  check("an unknown id resolves to NOTHING (multiplayer-safe fallback)", resolveOverlay("hat_from_2031", "side", 0) === null);
}

// The hat-layering fix (the "double cowboy hat" regression): a blob wearing ANY head
// cosmetic renders from the BALD base so the equipped hat replaces the baked cowboy hat
// instead of stacking on it; a bare-headed blob keeps the classic hatted hero. heroBodySprite
// is the single decision every render surface routes through, so this locks both the choice
// and that every surface (self/remotes/dash ghosts/menu preview) actually uses it. Pure and
// client-only — no sim, no image binaries, no protocol.
function baldBaseTests(): void {
  section("bald base under hats: the equipped hat REPLACES the baked cowboy hat (no double hat)");

  check("no hat equipped -> the classic hatted hero is the default body",
    heroBodySprite(null) === "hero");
  check("any hat equipped -> the bald base body (so the worn hat replaces the baked hat)",
    heroBodySprite("hat_crown") === "hero_bald");
  check("the cowboy hat, re-picked as a real layer, also rides the bald base",
    heroBodySprite("cowboy_hat_classic") === "hero_bald");

  // The bald base must animate IDENTICALLY to the hatted hero: same 4-frame walk sheet
  // cadence (fps) so a hatted blob's walk never desyncs from a bare-headed one.
  const heroWalk = SHEETS["hero.walk"];
  const baldWalk = SHEETS["hero_bald.walk"];
  check("the bald base registers a walk sheet", baldWalk !== undefined && baldWalk.src === LAYERED_HERO_BASE_WALK_SRC);
  check("the bald walk cadence matches the hero walk exactly (identical fps)",
    baldWalk !== undefined && heroWalk !== undefined && baldWalk.fps === heroWalk.fps);

  // The bald base is a registered SPRITE (drives get() AND the tintedSprite/tintedSheetCanvas
  // tint path), so the player's chosen body color tints the bald blob exactly like the hero.
  const sprites = devSpriteManifest();
  check("the bald base is a registered body sprite (tintable like the hero)",
    sprites.some((s) => s.label === "hero_bald" && s.src === LAYERED_HERO_BASE_SRC));

  // Every render surface resolves the base through heroBodySprite — static-scan the three the
  // owner watches (self world, remotes world, the menu/closet preview) so none can drift.
  const game = readFileSync(join(ROOT, "src/game/game.ts"), "utf8");
  const renderPlayer = game.slice(game.indexOf("private renderPlayer()"), game.indexOf("private renderReviveRings"));
  const renderRemotes = game.slice(game.indexOf("private renderRemotePlayers()"), game.indexOf("private selfTint()"));
  const preview = readFileSync(join(ROOT, "src/ui/blobPreview.ts"), "utf8");
  check("self world render picks the base via heroBodySprite", renderPlayer.includes("heroBodySprite("));
  check("remote world render picks the base via heroBodySprite", renderRemotes.includes("heroBodySprite("));
  check("the menu/closet preview picks the base via heroBodySprite", preview.includes("heroBodySprite("));
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

  // Merely SEEING the prompt (no dismissal) starts the shorter shown-cooldown, so a
  // multi-run day is nagged at most once per window.
  const seen = fakeStore();
  recordNudgeShown(seen, t0);
  check("shownAt persists", seen.data.get(NUDGE_SHOWN_AT_KEY) === String(t0));
  check("suppressed inside the shown-cooldown (multi-run day)", !shouldShowSigninNudge(seen, base, t0 + NUDGE_SHOWN_COOLDOWN_MS - 1));
  check("eligible again after the shown-cooldown", shouldShowSigninNudge(seen, base, t0 + NUDGE_SHOWN_COOLDOWN_MS + 1));
  check("the dismissal cooldown is the LONGER of the two", NUDGE_COOLDOWN_MS > NUDGE_SHOWN_COOLDOWN_MS);
}

// OAuth/token hygiene: the code parameter is stripped from the URL immediately, the PKCE
// verifier is consumed (removed) on use, and no token variable is ever logged.
function authHygieneTests(): void {
  section("auth hygiene: PKCE verifier consumed, ?code stripped, no tokens in logs");
  const src = readFileSync(join(ROOT, "src/net/auth.ts"), "utf8");
  check("completeOAuth strips ?code= from the URL before the exchange", src.includes("this.stripCodeFromUrl()"));
  check("the PKCE verifier is removed once read", src.includes("safeRemove(this.key(VERIFIER_KEY))"));
  check("tokens are never logged", !/console\.(log|warn|error)\([^)]*token/i.test(src));
  check("the URL is rewritten without the code (replaceState)", src.includes("window.history.replaceState"));
}

function main(): void {
  catalogTests();
  bodyPaletteTests();
  ownershipTests();
  grantTests();
  purityTests();
  wireTests();
  simImmunityTests();
  renderContractTests();
  publicSchemaTests();
  socketGateTests();
  baldBaseTests();
  nudgeTests();
  authHygieneTests();
  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll cosmetics launch-slice assertions passed.\n");
}

main();
