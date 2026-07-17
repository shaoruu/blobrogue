// Builds the standalone visual changelog site at public/changelog/ from the SAME parse the
// in-game "What's New" panel uses (CHANGELOG.md -> parseChangelog -> attachMedia). The whole
// page is pre-rendered at build time — every hero/nav/card is real HTML with the data also
// inlined as JSON — so there is zero client-side layout shift; a tiny script only lights the
// sticky nav as you scroll. Emits:
//   public/changelog/index.html  (the page)
//   public/changelog/data.json   (the raw parsed sections + media, for anything that wants it)
//
// Run via the build (vite.config.ts buildStart) or directly: `node tools/genChangelogSite.mjs`.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { parseChangelog } from "./genChangelog.mjs";
import { attachMedia } from "./changelogMedia.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function sectionLabel(section) {
  if (section.version === "unreleased") return "In Progress";
  const m = section.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return section.date;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

function navLabel(section) {
  if (section.version === "unreleased") return "IN PROGRESS";
  const m = section.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return section.date;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`.toUpperCase();
}

function altFor(path) {
  return basename(path, ".png").replace(/_/g, " ");
}

function renderThumb(path) {
  return `<img class="cl-thumb" src="${escapeHtml(path)}" alt="${escapeHtml(altFor(path))}" `
    + `loading="lazy" width="64" height="64" />`;
}

function renderEntry(entry) {
  const parts = ['<article class="card">'];
  parts.push('<div class="card-text">');
  if (entry.title) parts.push(`<h3 class="card-title">${escapeHtml(entry.title)}</h3>`);
  if (entry.body) parts.push(`<p class="card-body">${escapeHtml(entry.body)}</p>`);
  parts.push("</div>");
  if (entry.media && entry.media.length) {
    parts.push('<div class="cl-media">');
    for (const path of entry.media) parts.push(renderThumb(path));
    parts.push("</div>");
  }
  parts.push("</article>");
  return parts.join("");
}

function renderSection(section) {
  const id = `v-${section.version}`;
  const isProgress = section.version === "unreleased";
  const cards = section.entries.map(renderEntry).join("");
  return `<section class="log-section" id="${id}">`
    + `<div class="section-head"><span class="section-date${isProgress ? " progress" : ""}">`
    + `${escapeHtml(sectionLabel(section))}</span></div>`
    + `<div class="cards">${cards}</div></section>`;
}

function renderNav(sections) {
  const links = sections
    .map((s) => `<a class="toc-link" href="#v-${s.version}" data-target="v-${s.version}">${escapeHtml(navLabel(s))}</a>`)
    .join("");
  return `<nav class="tocnav" aria-label="Releases"><div class="toc-inner">${links}</div></nav>`;
}

function renderPage(sections) {
  const nav = renderNav(sections);
  const log = sections.map(renderSection).join("");
  const data = JSON.stringify({ sections }, null, 0);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>BlobRogue — What's New</title>
    <meta name="description" content="Visual patch notes for BlobRogue, a co-op top-down roguelike shooter. Newest changes first." />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Silkscreen:wght@400;700&family=VT323&display=swap" rel="stylesheet" />
    <style>
      :root{
        --dun-0:#05030b; --dun-1:#0e0b1a; --dun-2:#171227; --dun-3:#2a2140; --dun-4:#46356b;
        --amber:#ffb43b; --amber-hi:#ffd166; --amber-lo:#b06e12; --cream:#ffe9b0;
        --ink:#120a24; --ink-mute:#9a8fb5; --ink-faint:#6f6689;
        --f-logo:'Press Start 2P',monospace;
        --f-ui:'Silkscreen','Press Start 2P',monospace;
        --f-num:'VT323',monospace;
      }
      *{ margin:0; padding:0; box-sizing:border-box; }
      html{ scroll-behavior:smooth; }
      body{
        min-height:100%; background:
          radial-gradient(1200px 600px at 50% -10%, rgba(255,180,59,.08), transparent 60%),
          var(--dun-0);
        color:var(--cream); font-family:var(--f-ui); line-height:1.6;
        -webkit-font-smoothing:none; padding-bottom:48px;
      }
      img{ display:block; }
      a{ color:var(--amber); text-decoration:none; }

      /* HERO */
      .hero{ padding:72px 20px 40px; text-align:center; border-bottom:2px solid var(--dun-3); }
      .hero-inner{ max-width:760px; margin:0 auto; display:flex; flex-direction:column; align-items:center; gap:16px; }
      .eyebrow{ font-family:var(--f-ui); font-size:11px; letter-spacing:6px; color:var(--amber-lo); text-transform:uppercase; }
      .hero-title{ font-family:var(--f-logo); font-size:clamp(22px,5vw,40px); letter-spacing:3px; color:var(--amber);
        line-height:1.4; text-shadow:0 3px 0 rgba(0,0,0,.5); }
      .hero-sub{ font-size:13px; color:var(--ink-mute); max-width:520px; }
      .play-cta{ margin-top:6px; font-family:var(--f-ui); font-size:12px; letter-spacing:2px; text-transform:uppercase;
        color:var(--dun-0); background:var(--amber); padding:12px 22px;
        box-shadow:0 0 0 3px var(--dun-0),0 0 0 6px var(--dun-4),0 4px 0 rgba(0,0,0,.5); }
      .play-cta:hover{ background:var(--amber-hi); }

      /* STICKY NAV */
      .tocnav{ position:sticky; top:0; z-index:5; background:rgba(5,3,11,.92);
        border-bottom:2px solid var(--dun-3); backdrop-filter:blur(4px); }
      .toc-inner{ max-width:920px; margin:0 auto; display:flex; gap:8px; overflow-x:auto; padding:10px 16px;
        scrollbar-width:none; }
      .toc-inner::-webkit-scrollbar{ display:none; }
      .toc-link{ flex:0 0 auto; font-family:var(--f-ui); font-size:10px; letter-spacing:1px; color:var(--ink-mute);
        text-transform:uppercase; padding:6px 10px; box-shadow:inset 0 0 0 2px var(--dun-3); white-space:nowrap; }
      .toc-link:hover{ color:var(--cream); box-shadow:inset 0 0 0 2px var(--dun-4); }
      .toc-link.active{ color:var(--dun-0); background:var(--amber); box-shadow:inset 0 0 0 2px var(--amber); }

      /* LOG */
      .log{ max-width:920px; margin:0 auto; padding:24px 16px 0; }
      .log-section{ padding:24px 0; border-bottom:2px solid var(--dun-3); scroll-margin-top:64px; }
      .log-section:last-child{ border-bottom:0; }
      .section-head{ margin-bottom:16px; }
      .section-date{ display:inline-block; font-family:var(--f-ui); font-size:12px; letter-spacing:3px;
        color:var(--amber-hi); text-transform:uppercase; padding:5px 12px; box-shadow:inset 0 0 0 2px var(--dun-3); }
      .section-date.progress{ color:var(--dun-0); background:var(--amber); box-shadow:inset 0 0 0 2px var(--amber); }

      .cards{ display:flex; flex-direction:column; gap:14px; }
      .card{ display:flex; gap:18px; align-items:flex-start; justify-content:space-between; flex-wrap:wrap;
        background:rgba(23,18,39,.55); box-shadow:inset 0 0 0 2px var(--dun-3),0 3px 0 rgba(0,0,0,.4);
        padding:16px 18px; }
      .card-text{ flex:1 1 320px; min-width:0; }
      .card-title{ font-family:var(--f-ui); font-size:14px; letter-spacing:1px; color:var(--cream); margin-bottom:6px;
        line-height:1.45; }
      .card-body{ font-size:13px; color:var(--ink-mute); }

      .cl-media{ display:flex; flex-wrap:wrap; gap:10px; align-items:center; flex:0 1 auto; }
      .cl-thumb{ width:64px; height:64px; image-rendering:pixelated; object-fit:contain;
        background:var(--dun-0); box-shadow:inset 0 0 0 2px var(--amber-lo),0 0 0 2px var(--dun-0); padding:4px; }

      footer{ max-width:920px; margin:40px auto 0; padding:24px 16px 0; text-align:center;
        border-top:2px solid var(--dun-3); color:var(--ink-faint); font-size:11px; letter-spacing:1px; }
      footer a{ font-family:var(--f-ui); text-transform:uppercase; letter-spacing:2px; }

      @media (max-width:560px){
        .hero{ padding:48px 16px 28px; }
        .card{ gap:12px; padding:14px; }
        .cl-thumb{ width:52px; height:52px; }
      }
    </style>
  </head>
  <body>
    <header class="hero">
      <div class="hero-inner">
        <p class="eyebrow">BlobRogue</p>
        <h1 class="hero-title">What's New</h1>
        <p class="hero-sub">Visual patch notes for our co-op top-down roguelike shooter. Newest changes first — with the real sprites that shipped.</p>
        <a class="play-cta" href="/">Play the game &rarr;</a>
      </div>
    </header>
    ${nav}
    <main class="log">
      ${log}
    </main>
    <footer>
      <p>BlobRogue &middot; <a href="/">back to the game &rarr;</a></p>
    </footer>
    <script type="application/json" id="changelog-data">${data.replace(/</g, "\\u003c")}</script>
    <script>
      // Progressive enhancement only: light the sticky-nav link for the section in view. The
      // page is fully rendered without this, so there is no layout shift if it never runs.
      (function () {
        var links = Array.prototype.slice.call(document.querySelectorAll(".toc-link"));
        var byId = {};
        links.forEach(function (a) { byId[a.getAttribute("data-target")] = a; });
        var sections = Array.prototype.slice.call(document.querySelectorAll(".log-section"));
        if (!("IntersectionObserver" in window) || !sections.length) return;
        var visible = {};
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (e) { visible[e.target.id] = e.isIntersecting ? e.intersectionRatio : 0; });
          var top = null, best = -1;
          sections.forEach(function (s) {
            var r = visible[s.id] || 0;
            if (r > best) { best = r; top = s.id; }
          });
          links.forEach(function (a) { a.classList.remove("active"); });
          if (top && byId[top]) byId[top].classList.add("active");
        }, { rootMargin: "-56px 0px -55% 0px", threshold: [0, 0.25, 0.5, 1] });
        sections.forEach(function (s) { io.observe(s); });
      })();
    </script>
  </body>
</html>
`;
}

export function writeChangelogSite(repoRoot = REPO_ROOT) {
  const md = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  const sections = attachMedia(parseChangelog(md));
  const outDir = join(repoRoot, "public", "changelog");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "index.html"), renderPage(sections), "utf8");
  writeFileSync(join(outDir, "data.json"), JSON.stringify({ sections }, null, 2) + "\n", "utf8");
  return sections[0]?.version ?? "unreleased";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const version = writeChangelogSite();
  process.stdout.write(`generated public/changelog/index.html + data.json (latest: ${version})\n`);
}
