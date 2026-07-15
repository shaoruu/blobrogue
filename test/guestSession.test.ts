import "./harness/domShim.js";
import { getFunctionName } from "convex/server";
import type { ConvexClient } from "convex/browser";
import type { ProfileDoc } from "../src/net/api.js";
import { Session } from "../src/net/session.js";

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

function profile(overrides: Partial<ProfileDoc> = {}): ProfileDoc {
  return {
    playerId: "guest-player",
    name: "Guest",
    colorIndex: null,
    cosmetics: { hat: null, face: null, body: null, title: null },
    totalKills: 0,
    deepestFloor: 0,
    totalCoins: 0,
    gamesPlayed: 0,
    amber: 0,
    unlocks: [],
    equippedPet: null,
    lastKitId: null,
    masteryXp: 0,
    masteryLevel: 1,
    isAccount: false,
    ...overrides,
  };
}

localStorage.removeItem("blobrogue.guestCapability");
localStorage.removeItem("blobrogue.guestRefreshCapability");
const calls: Array<{ name: string; args: Record<string, string> }> = [];
let ensureResponse = profile({
  guestCapability: "cap-one",
  guestRefreshCapability: "refresh-one",
});
const fake = {
  mutation: (ref: Parameters<typeof getFunctionName>[0], args: Record<string, string>) => {
    const name = getFunctionName(ref);
    calls.push({ name, args });
    if (name === "players:prepareSignOutGuest") {
      return Promise.resolve(profile({
        playerId: "fresh-guest",
        guestCapability: "cap-two",
        guestRefreshCapability: "refresh-two",
      }));
    }
    return Promise.resolve(ensureResponse);
  },
  query: () => Promise.resolve(ensureResponse),
  action: () => Promise.resolve(null),
  onUpdate: () => () => {},
};
const session = new Session(fake as never as ConvexClient);
await session.login();
check("first guest bootstrap stores the issued capability",
  session.guestCapabilityArgs.guestCapability === "cap-one"
  && localStorage.getItem("blobrogue.guestCapability") === "cap-one"
  && localStorage.getItem("blobrogue.guestRefreshCapability") === "refresh-one");

await session.login();
const secondEnsure = calls.filter((call) => call.name === "players:ensurePlayer")[1];
check("subsequent guest writes carry the scoped capability",
  secondEnsure?.args.guestCapability === "cap-one"
  && secondEnsure.args.guestRefreshCapability === "refresh-one");

ensureResponse = profile({
  playerId: "account-player",
  isAccount: true,
  lastKitId: "gunner",
});
await session.login();
check("authenticated account adoption revokes local guest authority",
  session.guestCapabilityArgs.guestCapability === undefined
  && localStorage.getItem("blobrogue.guestCapability") === null
  && localStorage.getItem("blobrogue.guestRefreshCapability") === null);

await session.prepareSignOutGuest();
check("sign-out preparation rotates to a fresh guest capability",
  session.profile?.playerId === "fresh-guest"
  && session.guestCapabilityArgs.guestCapability === "cap-two"
  && localStorage.getItem("blobrogue.guestRefreshCapability") === "refresh-two");

process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
