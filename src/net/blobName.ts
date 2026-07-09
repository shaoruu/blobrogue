// Generated guest display names — the permanent end of the literal "blob" fallback. Every
// guest who never typed a name gets a wholesome adjective+"Blob" default, derived
// DETERMINISTICALLY from their clientId hash so a returning guest (same browser, cleared
// name key) regenerates the exact same identity. A short numeric suffix is appended ONLY
// when the caller supplies names the base would collide with — never speculatively.
//
// Pure and environment-free so both the Session (assignment) and the name gate (reroll)
// share one generator, and the identity suite can lock its behavior headlessly.

export const BLOB_NAME_ADJECTIVES = [
  "Brave", "Snug", "Ruddy", "Zippy", "Gutsy", "Plucky", "Chonky", "Wily",
  "Jolly", "Spry", "Bold", "Cozy", "Nimble", "Rowdy", "Sly", "Toasty",
  "Vivid", "Woolly", "Amber", "Dusty", "Mossy", "Pluff",
] as const;

export const MAX_NAME_LEN = 20;

// FNV-1a over UTF-16 code units: stable, dependency-free, and good enough spread for
// picking one adjective + one suffix per client.
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function nameFromHash(h: number, taken: ReadonlySet<string>): string {
  const base = BLOB_NAME_ADJECTIVES[h % BLOB_NAME_ADJECTIVES.length] + "Blob";
  if (!taken.has(base.toLowerCase())) return base;
  // Collision: append a hash-derived 2-digit suffix, widening to 3 digits if still taken.
  const two = base + String(10 + ((h >>> 5) % 90));
  if (!taken.has(two.toLowerCase())) return two;
  return base + String(100 + ((h >>> 7) % 900));
}

// The deterministic default for this client. `taken` (case-insensitive) lets a caller who
// KNOWS neighboring names (e.g. a lobby roster) avoid duplicates; without it the bare
// adjective+Blob stands — no uniqueness service, no blocking check, by design.
export function generatedBlobName(clientId: string, taken: Iterable<string> = []): string {
  const avoid = new Set<string>();
  for (const t of taken) avoid.add(t.toLowerCase());
  return nameFromHash(hashSeed(clientId), avoid);
}

// The name gate's dice button: another generated default, guaranteed different from the
// current one. Seeded by clientId + roll counter so successive rolls walk the list
// deterministically (testable) while still feeling like a shuffle.
export function rerollBlobName(clientId: string, roll: number, current: string): string {
  for (let i = 0; i < BLOB_NAME_ADJECTIVES.length; i++) {
    const next = nameFromHash(hashSeed(`${clientId}:${roll + i}`), new Set());
    if (next.toLowerCase() !== current.toLowerCase()) return next;
  }
  return nameFromHash(hashSeed(`${clientId}:${roll}`) + 1, new Set());
}

// Client-side display-name sanitizer (the server keeps its own in convex/players.ts /
// server/src/auth.ts — this one runs FIRST so what the player sees committed is what ships):
// strip control characters and zero-width/joiner junk, collapse whitespace runs, trim, cap
// at 20. Returns "" when nothing visible survives — callers keep their generated default.
export function sanitizeBlobName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LEN)
    .trim();
}

// The committed value for a typed name: the sanitized input, unless nothing visible
// survives OR it is the literal legacy "blob" placeholder — those keep the generated
// default, so no player can ever be named exactly "blob" again.
export function resolveNameInput(raw: string, generatedDefault: string): string {
  const clean = sanitizeBlobName(raw);
  if (clean.length === 0 || clean.toLowerCase() === "blob") return generatedDefault;
  return clean;
}
