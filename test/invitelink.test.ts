// Room-invite link contract suite: the parse/validation grammar for both accepted URL
// shapes (/r/<CODE> and ?room=CODE, case-insensitive), byte-agreement with the REAL room
// code grammar in convex/rooms.ts, the canonical share-URL builder, URL consumption
// (refresh never re-joins), the share/copy outcome matrix (native share sheet on touch,
// clipboard everywhere else, honest failures), and the boot/warm routing wiring in
// src/main.ts (cold loads and popstate arrivals both consume the SAME parse and route
// through Menu.openInvite — no parallel router).
// Run: npm run test:invitelink

import "./harness/domShim.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  normalizeRoomCode, parseInviteCode, hasInviteIntent, inviteUrlFor,
  stripInviteFromLocation, shareInviteUrl, copyInviteUrl, canShareInvite,
  INVITE_SHARE_TITLE, INVITE_SHARE_TEXT,
} from "../src/net/inviteLink.js";
import type { ShareCapabilities } from "../src/net/inviteLink.js";

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

function caps(over: Partial<ShareCapabilities>): ShareCapabilities {
  return { share: null, writeClipboard: null, execCopy: null, ...over };
}

async function main(): Promise<void> {
  section("path form: /r/<CODE>, case-insensitive, validated against the room-code grammar");
  check("clean path parses", parseInviteCode("/r/ABCD", "") === "ABCD");
  check("lowercase path normalizes", parseInviteCode("/r/abcd", "") === "ABCD");
  check("mixed case + trailing slash", parseInviteCode("/r/AbCd/", "") === "ABCD");
  check("uppercase R path segment", parseInviteCode("/R/ABCD", "") === "ABCD");
  check("percent-encoded code decodes before validating", parseInviteCode("/r/%41BCD", "") === "ABCD");
  check("the 5-char collision-fallback code is legal", parseInviteCode("/r/ABCDE", "") === "ABCDE");
  check("too short rejects", parseInviteCode("/r/ABC", "") === null);
  check("too long rejects", parseInviteCode("/r/ABCDEF", "") === null);
  check("ambiguous O rejects (not in the alphabet)", parseInviteCode("/r/AOCD", "") === null);
  check("ambiguous 0/1/I reject", parseInviteCode("/r/A0CD", "") === null && parseInviteCode("/r/A1CD", "") === null && parseInviteCode("/r/AICD", "") === null);
  check("punctuation/injection rejects", parseInviteCode("/r/AB%2FD", "") === null && parseInviteCode("/r/AB.D", "") === null);
  check("deeper paths are not invites", parseInviteCode("/r/ABCD/extra", "") === null);
  check("unrelated paths are not invites", parseInviteCode("/", "") === null && parseInviteCode("/robots.txt", "") === null);

  section("query form fallback: ?room=CODE, same grammar, path wins when both are valid");
  check("query form parses", parseInviteCode("/", "?room=ABCD") === "ABCD");
  check("lowercase query normalizes", parseInviteCode("/", "?room=wxyz") === "WXYZ");
  check("query rides along other params", parseInviteCode("/", "?dev=1&room=ABCD&x=2") === "ABCD");
  check("bad query code rejects", parseInviteCode("/", "?room=AB") === null && parseInviteCode("/", "?room=") === null);
  check("a valid path outranks the query", parseInviteCode("/r/WXYZ", "?room=ABCD") === "WXYZ");
  check("an invalid path falls back to a valid query", parseInviteCode("/r/A0CD", "?room=ABCD") === "ABCD");

  section("invite INTENT is detected even when the code is mangled (honest broken-link landing)");
  check("valid path is intent", hasInviteIntent("/r/ABCD", ""));
  check("mangled path is still intent", hasInviteIntent("/r/nope!", ""));
  check("mangled query is still intent", hasInviteIntent("/", "?room=x"));
  check("no invite shape, no intent", !hasInviteIntent("/", "?dev=1") && !hasInviteIntent("/other", ""));

  section("grammar agreement: the client validator accepts exactly convex/rooms.ts codes");
  {
    const roomsSrc = readFileSync(join(ROOT, "convex/rooms.ts"), "utf8");
    const alphabet = /const CODE_ALPHABET = "([^"]+)"/.exec(roomsSrc)?.[1] ?? "";
    const codeLen = Number(/const CODE_LEN = (\d+)/.exec(roomsSrc)?.[1] ?? "0");
    check("the real alphabet + length were read from the convex source", alphabet.length > 0 && codeLen === 4, `${alphabet} / ${codeLen}`);
    check("every alphabet char is accepted in a code",
      [...alphabet].every((c) => normalizeRoomCode(c.repeat(codeLen)) === c.repeat(codeLen)));
    const excluded = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].filter((c) => !alphabet.includes(c));
    check("every excluded char is rejected", excluded.every((c) => normalizeRoomCode(c.repeat(codeLen)) === null), excluded.join(""));
    // uniqueCode's collision fallback appends ONE extra alphabet char.
    check("the fallback length (CODE_LEN + 1) is accepted, longer is not",
      normalizeRoomCode(alphabet[0].repeat(codeLen + 1)) !== null && normalizeRoomCode(alphabet[0].repeat(codeLen + 2)) === null);
  }

  section("inviteUrlFor: the canonical clean-path share URL");
  check("plain origin", inviteUrlFor("ABCD", "https://blob.example") === "https://blob.example/r/ABCD");
  check("trailing-slash origin never doubles", inviteUrlFor("ABCD", "https://blob.example/") === "https://blob.example/r/ABCD");
  check("code uppercases", inviteUrlFor("abcd", "http://localhost") === "http://localhost/r/ABCD");

  section("stripInviteFromLocation consumes the invite (a refresh never re-joins)");
  {
    const loc = window.location as unknown as { pathname: string; search: string; hash: string; href: string };
    loc.pathname = "/r/ABCD"; loc.search = ""; loc.hash = ""; loc.href = "http://localhost/r/ABCD";
    stripInviteFromLocation();
    check("path form resets to /", loc.pathname === "/" && loc.search === "", `${loc.pathname}${loc.search}`);
    loc.pathname = "/"; loc.search = "?dev=1&room=ABCD"; loc.hash = "#x"; loc.href = "http://localhost/?dev=1&room=ABCD#x";
    stripInviteFromLocation();
    check("query form drops ONLY room (other params + hash survive)", loc.search === "?dev=1" && loc.hash === "#x", `${loc.search}${loc.hash}`);
    loc.pathname = "/"; loc.search = ""; loc.hash = ""; loc.href = "http://localhost/";
  }

  section("share/copy outcome matrix: sheet when present, then writeText -> execCommand -> honest failure");
  {
    const shared: Array<{ title: string; text: string; url: string }> = [];
    const copied: string[] = [];
    const url = "https://blob.example/r/ABCD";
    check("a platform with navigator.share is share-capable (SHARE INVITE label driver)",
      canShareInvite(caps({ share: () => Promise.resolve() })) && !canShareInvite(caps({})));
    check("the sheet gets the spec payload (title/text/url) -> shared", await shareInviteUrl(url, caps({
      share: (d) => { shared.push(d); return Promise.resolve(); },
    })) === "shared" && shared[0].url === url && shared[0].title === INVITE_SHARE_TITLE && shared[0].text === INVITE_SHARE_TEXT);
    check("a CANCELLED sheet is a no-op, never a fake copy", await shareInviteUrl(url, caps({
      share: () => Promise.reject(Object.assign(new Error("canceled"), { name: "AbortError" })),
      writeClipboard: () => { throw new Error("must not fall through on dismiss"); },
    })) === "dismissed");
    check("an UNSUPPORTED sheet falls back to the clipboard", await shareInviteUrl(url, caps({
      share: () => Promise.reject(new TypeError("unsupported")),
      writeClipboard: (t) => { copied.push(t); return Promise.resolve(); },
    })) === "copied" && copied[0] === url);
    check("no sheet -> the clipboard chain", await shareInviteUrl(url, caps({
      writeClipboard: () => Promise.resolve(),
    })) === "copied");
    const execTried: string[] = [];
    check("a blocked writeText falls back to execCommand('copy')", await copyInviteUrl(url, caps({
      writeClipboard: () => Promise.reject(new Error("denied")),
      execCopy: (t) => { execTried.push(t); return true; },
    })) === "copied" && execTried[0] === url);
    check("both clipboard paths refused -> honest failure (the UI reveals the link)", await copyInviteUrl(url, caps({
      writeClipboard: () => Promise.reject(new Error("denied")),
      execCopy: () => false,
    })) === "failed");
    check("no capability at all reports failure", await shareInviteUrl(url, caps({})) === "failed");
  }

  section("routing wiring: cold boot and warm popstate both consume the ONE parse (no parallel router)");
  {
    const mainSrc = readFileSync(join(ROOT, "src/main.ts"), "utf8");
    check("cold load routes invites before the plain title", mainSrc.includes("hasInviteIntent(window.location.pathname, window.location.search)")
      && mainSrc.indexOf("hasInviteIntent") < mainSrc.indexOf("void menu.showTitle()"));
    check("warm arrivals route through popstate", mainSrc.includes('window.addEventListener("popstate"'));
    check("both paths land on the same Menu.openInvite door", (mainSrc.match(/menu\.openInvite\(/g) ?? []).length >= 2);
    check("a warm invite never yanks a live run", mainSrc.includes("if (isInRun || !hasInviteIntent"));
    const menuSrc = readFileSync(join(ROOT, "src/ui/menu.ts"), "utf8");
    check("the URL is consumed when the ATTEMPT RESOLVES (menu strips; unjoinable invites strip in main)",
      menuSrc.includes("stripInviteFromLocation()") && mainSrc.includes("stripInviteFromLocation()"));
    check("the invite join IS the manual join (openInvite routes through doJoinOnline)",
      menuSrc.includes("await this.doJoinOnline(code, status,"));
  }

  section("the deploy serves the clean path (SPA rewrite for /r/<CODE>)");
  {
    const vercel = readFileSync(join(ROOT, "vercel.json"), "utf8");
    check("vercel.json rewrites /r/:code to the app shell", vercel.includes('"/r/:code"') && vercel.includes('"/index.html"'));
  }

  process.stdout.write(`\n${passed} checks passed, ${failed} failed\n`);
  if (failed > 0) { process.stdout.write(`FAILURES:\n${failures.map((f) => "  - " + f).join("\n")}\n`); process.exit(1); }
  process.stdout.write("\nAll room-invite link contract assertions passed.\n");
}

void main();
