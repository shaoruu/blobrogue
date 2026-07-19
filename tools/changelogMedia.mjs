// Attaches real, already-shipped sprite art to changelog entries by matching each entry's
// text against a small rule table. Pure and isomorphic (no fs, no DOM) so the TypeScript
// generator, the standalone-site builder, and the tests can all share one source of truth.
//
// Every path returned here MUST point at a file that already exists under public/ — this is
// verified by test/changelogMedia.test.mjs, which walks the whole table and fs.existsSync's
// each path. Never invent art: if a boss/feature has no shipped sprite, it simply gets none.
//
// Matching is deliberately layered:
//   1. SOLO rules win outright — a montage entry ("more hats + more face items") uses exactly
//      its curated set and skips the keyword table, so it stays a hand-picked strip instead of
//      dumping every sprite whose name happens to appear in the prose.
//   2. KEYWORD rules otherwise accumulate — every matching rule contributes, paths are then
//      de-duplicated and capped.

const CAP = 6;

// `words(...)` matches any of the given terms as a whole word, so "cat" never fires inside
// "communicate" and "slime" never fires inside a longer token. Terms may contain spaces
// (e.g. "hermit crab"); the word boundaries wrap the whole term.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (...terms) => {
  const re = new RegExp(`\\b(?:${terms.map(escapeRe).join("|")})\\b`, "i");
  return (text) => re.test(text);
};
const both = (...tests) => (text) => tests.every((t) => t(text));
const either = (...tests) => (text) => tests.some((t) => t(text));

const PET = (name) => [`/sprites/pets/${name}.png`];
const HAT = (name) => `/sprites/cosmetics/hat_${name}_side.png`;
const FACE = (name) => `/sprites/cosmetics/face_${name}_side.png`;
const GUN = (name) => [`/sprites/weapon_${name}.png`];

// Curated montages — checked first, and terminal when matched.
const SOLO_RULES = [
  {
    // Unreleased "More hats + more face items" — the new curated cosmetic wave. Its prose
    // names guns ("Lamplighter's Brim") and a boss ("Choir Veil"), so a curated strip is the
    // only way to keep it a cosmetics-only montage.
    test: either(words("more hats"), words("8 new hats")),
    cap: 8,
    paths: [
      HAT("cork"), HAT("lamp_brim"), HAT("root"), HAT("ember_visor"),
      FACE("amber_specs"), FACE("coal_smudge"), FACE("shale_goggles"), FACE("choir_veil"),
    ],
  },
  {
    // The older cosmetic drops ("New cosmetics + legendary art", "More cosmetics") — the old
    // hat wave shown beside the five legendary guns that shipped alongside them.
    test: either(words("new cosmetics"), words("more cosmetics")),
    cap: 8,
    paths: [
      HAT("top"), HAT("crown"), HAT("wizard"), HAT("halo"),
      ...GUN("umbra"), ...GUN("reaper"), ...GUN("hive"), ...GUN("midas"),
    ],
  },
];

// Keyword rules — order sets the thumbnail order within an entry's strip.
const KEYWORD_RULES = [
  // Pets — the base sprite reads best at thumbnail size; multi-pet entries become a clean
  // row of distinct companions.
  { test: words("wick", "moth"), paths: PET("wick") },
  { test: words("pebble", "toad"), paths: PET("pebble") },
  { test: words("clatter", "hermit", "crab"), paths: PET("clatter") },
  { test: words("nullfin", "fish"), paths: PET("nullfin") },
  { test: words("doggie", "shiba", "pup"), paths: PET("doggie") },
  { test: words("cat"), paths: PET("cat") },
  { test: words("dragon"), paths: PET("dragon") },
  {
    // "slime" alone is an enemy (Slime King); the pet only counts when it reads as a
    // companion ("baby slime") or sits in the pet roster beside doggie/cat/dragon.
    test: either(words("baby slime", "slime pet"), both(words("slime"), words("doggie", "cat", "dragon"))),
    paths: PET("slime"),
  },
  // Named guns — pickup art (weapon_*.png).
  { test: words("hushiron"), paths: GUN("hushiron") },
  { test: words("backtalk"), paths: GUN("backtalk") },
  { test: words("lamplighter"), paths: GUN("lamplighter") },
  { test: words("faultlink"), paths: GUN("faultlink") },
  { test: words("cleaver"), paths: GUN("cleaver") },
  { test: words("scrapper"), paths: GUN("scrapper") },
  { test: words("skipper"), paths: GUN("skipper") },
  { test: words("arcbolt"), paths: GUN("arcbolt") },
  { test: words("cryobolt"), paths: GUN("cryobolt") },
  { test: words("firebomb"), paths: GUN("firebomb") },
  { test: words("tracker"), paths: GUN("tracker") },
  { test: words("singularity"), paths: GUN("singularity") },
  { test: words("oddsmaker"), paths: GUN("oddsmaker") },
  { test: words("umbra"), paths: GUN("umbra") },
  { test: words("reaper"), paths: GUN("reaper") },
  { test: words("hive"), paths: GUN("hive") },
  { test: words("midas"), paths: GUN("midas") },
  { test: words("lodestone"), paths: GUN("lodestone") },
  { test: words("frostline"), paths: GUN("frostline") },
  { test: words("snapwire"), paths: GUN("snapwire") },
  { test: words("razor halo", "halo"), paths: GUN("halo") },
  { test: words("prism sentry", "sentry"), paths: GUN("sentry") },
  { test: words("breach"), paths: GUN("breach") },
  { test: words("lastlight"), paths: GUN("lastlight") },
  { test: words("crooked chain", "crook"), paths: GUN("crook") },
  // Bosses — only those with shipped sprites. Undertow / Claimant / Wake have none, so their
  // entries intentionally stay text-only.
  {
    test: words("gorge", "f50 giant"),
    paths: ["/sprites/gorge_shell_core.png", "/sprites/gorge_shell_rind.png", "/sprites/gorge_shell_chitin.png"],
  },
  { test: words("jet", "mirror boss"), paths: ["/sprites/jet_phase1.png", "/sprites/jet_expose.png"] },
  { test: words("tithe"), paths: ["/sprites/tithe_tribute.png", "/sprites/tithe_phase2.png"] },
  {
    // The Quorum entries are about the three role-bearing husks and their splinters.
    test: words("quorum"),
    paths: [
      "/sprites/quorum_merge.png",
      "/sprites/quorum_splinter_dmg.png",
      "/sprites/quorum_splinter_heal.png",
      "/sprites/quorum_splinter_shield.png",
    ],
  },
  { test: words("hollow choir"), paths: ["/sprites/choir.png", "/sprites/choir_attack.png"] },
  {
    // "pale throne" only — a bare floor number like "F75" also shows up as a forward
    // reference in other bosses' prose (the Gorge teases the F75/F100 giants).
    test: words("pale throne"),
    paths: ["/sprites/pale_shell_core.png", "/sprites/pale_shell_cracked.png", "/sprites/pale_shell_stone.png"],
  },
];

const dedupe = (paths) => [...new Set(paths)];

export function mediaForEntry(entry) {
  const text = `${entry.title ?? ""} ${entry.body ?? ""}`;
  for (const rule of SOLO_RULES) {
    if (rule.test(text)) return dedupe(rule.paths).slice(0, rule.cap ?? CAP);
  }
  const paths = [];
  for (const rule of KEYWORD_RULES) if (rule.test(text)) paths.push(...rule.paths);
  return dedupe(paths).slice(0, CAP);
}

export function attachMedia(sections) {
  return sections.map((section) => ({
    ...section,
    entries: section.entries.map((entry) => {
      const media = mediaForEntry(entry);
      return media.length ? { ...entry, media } : { ...entry };
    }),
  }));
}
