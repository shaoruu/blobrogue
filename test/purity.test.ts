// Purity guard: src/sim is the isomorphic core that BOTH the browser client and the Node
// server compile against, so it must never reach for a browser global, a socket, Convex, or
// anything under src/game (which pulls in DOM types). This scans every sim module's imports +
// identifiers and fails if the boundary is crossed. Cheap, static, and it locks the Stage-A/B/C
// invariant the whole authoritative-server design rests on.
//
// Run: npm run test:purity

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const simDir = join(here, "..", "src", "sim");

// Forbidden import specifiers (substring match on the module path) + forbidden runtime globals.
const FORBIDDEN_IMPORTS = ["../game/", "../net/", "../client/", "../ui/", "ws", "convex", "@convex", "vite"];
const FORBIDDEN_GLOBALS = ["document", "window", "navigator", "localStorage", "WebSocket", "requestAnimationFrame", "HTMLCanvasElement", "CanvasRenderingContext2D", "import.meta"];

let failed = 0;
const problems: string[] = [];

function scan(file: string): void {
  const src = readFileSync(join(simDir, file), "utf8");
  const importRe = /import\s+(?:type\s+)?[^;]*?from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src)) !== null) {
    const spec = m[1];
    for (const bad of FORBIDDEN_IMPORTS) {
      if (spec.includes(bad)) { failed++; problems.push(`${file}: forbidden import "${spec}" (matches "${bad}")`); }
    }
  }
  // Strip line + block comments so a doc-comment mention of `window` isn't a false positive.
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const g of FORBIDDEN_GLOBALS) {
    const re = new RegExp(`(^|[^.\\w])${g.replace(".", "\\.")}\\b`);
    if (re.test(code)) { failed++; problems.push(`${file}: forbidden global/reference "${g}"`); }
  }
}

const files = readdirSync(simDir).filter((f) => f.endsWith(".ts"));
for (const f of files) scan(f);

process.stdout.write(`purity: scanned ${files.length} src/sim modules\n`);
if (failed > 0) {
  process.stdout.write(`FAIL — ${failed} boundary violation(s):\n${problems.map((p) => "  - " + p).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("PASS — src/sim is DOM/socket/Convex/client-free (isomorphic core intact)\n");
