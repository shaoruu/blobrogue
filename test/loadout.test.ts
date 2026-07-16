import "./harness/domShim.js";
import { validateCombinedLoadout } from "../convex/loadoutCore.js";
import { evaluateLobbyStart } from "../convex/lobbyLoadoutCore.js";
import type { LobbyStartMember } from "../convex/lobbyLoadoutCore.js";
import {
  getRememberedPet,
  getSelectedKitSelection,
  rememberRunLoadout,
} from "../src/net/kitSelection.js";
import {
  pvpWorldIdForRoomCode,
  worldIdForRoomCode,
} from "../src/net/worldId.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    process.stdout.write(`  PASS ${name}${detail ? " — " + detail : ""}\n`);
  } else {
    failed++;
    failures.push(name + (detail ? " — " + detail : ""));
    process.stdout.write(`  FAIL ${name}${detail ? " — " + detail : ""}\n`);
  }
}

function section(name: string): void {
  process.stdout.write(`\n[${name}]\n`);
}

const explicitNoPet = {
  kitId: "mender",
  petId: null,
  isKitChoiceMade: true,
  isPetChoiceMade: true,
} as const;

section("combined authority distinguishes explicit No Pet from no pet choice");
{
  const authority = { masteryXp: 0, unlocks: [] };
  const missing = validateCombinedLoadout(authority, {
    ...explicitNoPet,
    isPetChoiceMade: false,
  });
  const confirmed = validateCombinedLoadout(authority, explicitNoPet);
  check("null + isPetChoiceMade false is rejected",
    !missing.ok && missing.reason === "pet_choice_required");
  check("null + isPetChoiceMade true is an authoritative No Pet choice",
    confirmed.ok && confirmed.kitId === "mender" && confirmed.petId === null);
}

section("server-side unlock and rescue gates reject tampered pairs");
{
  const locked = validateCombinedLoadout(
    { masteryXp: 0, unlocks: [] },
    { ...explicitNoPet, kitId: "phantom" },
  );
  const unowned = validateCombinedLoadout(
    { masteryXp: 0, unlocks: [] },
    { ...explicitNoPet, petId: "doggie" },
  );
  const rescued = validateCombinedLoadout(
    { masteryXp: 0, unlocks: ["pet_doggie"] },
    { ...explicitNoPet, petId: "doggie" },
  );
  check("locked Phantom is rejected at account level 1", !locked.ok && locked.reason === "kit_locked");
  check("unrescued Doggie is rejected", !unowned.ok && unowned.reason === "pet_unowned");
  check("rescued Doggie is accepted", rescued.ok && rescued.petId === "doggie");
}

function member(overrides: Partial<LobbyStartMember> = {}): LobbyStartMember {
  return {
    playerId: "host",
    name: "Ada",
    updatedAt: 100_000,
    isReady: true,
    isKitChoiceMade: true,
    isPetChoiceMade: true,
    isLoadoutConfirmed: true,
    loadoutGeneration: 3,
    loadoutKitId: "mender",
    ...overrides,
  };
}

section("atomic start decision rejects the exact first blocker");
{
  const now = 100_000;
  const missingKit = evaluateLobbyStart(
    [member({ isKitChoiceMade: false, isPetChoiceMade: false, isLoadoutConfirmed: false })],
    "host",
    3,
    now,
    12_000,
  );
  check("missing kit is the first exact blocker",
    !missingKit.ok
    && missingKit.code === "kit_missing"
    && missingKit.message === "Ada must choose a kit");

  const missingPet = evaluateLobbyStart(
    [member(), member({
      playerId: "guest",
      name: "Bob",
      isPetChoiceMade: false,
      isLoadoutConfirmed: false,
    })],
    "host",
    3,
    now,
    12_000,
  );
  check("missing pet is distinct from missing confirmation",
    !missingPet.ok
    && missingPet.code === "pet_missing"
    && missingPet.message === "Bob must choose a pet or No Pet");

  const unconfirmed = evaluateLobbyStart(
    [member({ isLoadoutConfirmed: false })],
    "host",
    3,
    now,
    12_000,
  );
  check("review confirmation is required after both choices",
    !unconfirmed.ok
    && unconfirmed.code === "loadout_missing"
    && unconfirmed.message === "Ada must confirm loadout");

  const staleGeneration = evaluateLobbyStart(
    [member({ loadoutGeneration: 2 })],
    "host",
    3,
    now,
    12_000,
  );
  check("a prior-generation confirmation is invalid",
    !staleGeneration.ok && staleGeneration.code === "loadout_missing");

  const notReady = evaluateLobbyStart(
    [member(), member({ playerId: "guest", name: "Bob", isReady: false })],
    "host",
    3,
    now,
    12_000,
  );
  check("confirmed but unready member reports the exact blocker",
    !notReady.ok
    && notReady.code === "not_ready"
    && notReady.message === "Bob is not ready");

  const allReady = evaluateLobbyStart(
    [member(), member({ playerId: "guest", name: "Bob" })],
    "host",
    3,
    now,
    12_000,
  );
  check("all active members confirmed and ready may start", allReady.ok);

  const staleHost = evaluateLobbyStart(
    [member({ updatedAt: now - 12_001 })],
    "host",
    3,
    now,
    12_000,
  );
  check("an empty active set cannot vacuously start",
    !staleHost.ok
    && staleHost.code === "loadout_missing"
    && staleHost.message.includes("reconnect"));
}

section("room generations bind distinct authoritative worlds");
{
  check("co-op generations never share a world id",
    worldIdForRoomCode("abcd", 1) === "room:ABCD:g1"
    && worldIdForRoomCode("abcd", 2) === "room:ABCD:g2");
  check("PVP generations stay isolated in the PVP namespace",
    pvpWorldIdForRoomCode("abcd", 4) === "pvp:room:ABCD:g4");
  check("the legacy helper remains byte-compatible when no generation is supplied",
    worldIdForRoomCode("abcd") === "room:ABCD");
}

section("profile convenience remembers explicit null without authorizing it");
{
  localStorage.removeItem("blobrogue.selectedKit");
  localStorage.removeItem("blobrogue.lastPetId");
  check("fresh defaults are not remembered consent",
    !getSelectedKitSelection().isRemembered && !getRememberedPet().isRemembered);
  rememberRunLoadout({ kitId: "mender", petId: null });
  const kit = getSelectedKitSelection();
  const pet = getRememberedPet();
  check("final persistence remembers Mender for preselection",
    kit.isRemembered && kit.kitId === "mender");
  check("explicit No Pet survives reload as remembered null",
    pet.isRemembered && pet.petId === null);
}

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) {
  process.stdout.write(`FAILURES:\n${failures.map((failure) => "  - " + failure).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("\nAll combined-loadout authority assertions passed.\n");
