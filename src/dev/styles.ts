// Dev-sandbox styling. Injected once, only from the ?dev views. Everything resolves
// against the canonical :root pixel-font/palette tokens declared in index.html
// (--f-ui Silkscreen for labels/buttons, --f-num VT323 for numbers, dark-purple/amber),
// so the panel reads as part of the game and never falls back to a system font.

const DEV_CSS = `
  .dev-panel, .dev-sprites {
    font-family: var(--f-ui), monospace;
    color: var(--cream);
    -webkit-font-smoothing: none;
  }
  .dev-panel {
    position: fixed; top: 12px; right: 12px; z-index: 30;
    width: 268px; max-height: calc(100vh - 24px); overflow-y: auto;
    display: flex; flex-direction: column; gap: 10px;
    padding: 12px; background: rgba(14, 11, 26, 0.94);
    box-shadow: inset 0 0 0 2px var(--dun-3), 0 0 0 2px var(--ink), 0 8px 0 rgba(5, 3, 11, 0.5);
  }
  .dev-panel::-webkit-scrollbar { width: 8px; }
  .dev-panel::-webkit-scrollbar-thumb { background: var(--dun-3); }
  .dev-fps-meter {
    position: fixed; top: 12px; left: 12px; z-index: 30;
    width: 248px; padding: 7px 9px;
    font-family: var(--f-num), monospace; font-variant-numeric: tabular-nums;
    color: var(--cream); background: rgba(14, 11, 26, 0.84);
    box-shadow: inset 0 0 0 2px var(--dun-3), 0 0 0 2px var(--ink);
    pointer-events: none; contain: layout paint;
  }
  .dev-fps-meter .rate { display: block; height: 24px; font-size: 22px; line-height: 24px; color: var(--amber-hi); }
  .dev-fps-meter .rate.warn { color: var(--red); }
  .dev-fps-meter .detail { display: block; height: 15px; font-size: 13px; line-height: 15px; color: var(--dun-4); white-space: nowrap; }
  .dev-title {
    font-family: var(--f-logo), monospace; font-size: 11px; letter-spacing: 1px;
    color: var(--amber); text-shadow: 0 2px 0 var(--dun-0);
  }
  .dev-title .sub { display: block; margin-top: 4px; font-family: var(--f-num); font-size: 14px; color: var(--dun-4); letter-spacing: 0; }
  .dev-sec { display: flex; flex-direction: column; gap: 6px; }
  /* Section header doubles as a collapse toggle: full-width button, caret on the right. */
  .dev-h {
    display: flex; align-items: center; justify-content: space-between;
    font-family: var(--f-ui), monospace; font-weight: 700;
    font-size: 9px; letter-spacing: 2px; color: var(--amber-hi); text-transform: uppercase;
    padding: 4px 2px; box-shadow: inset 0 -2px 0 var(--dun-2);
    background: transparent; border: 0; width: 100%; text-align: left; cursor: pointer;
  }
  .dev-h:hover { color: var(--cream); }
  .dev-caret { font-size: 8px; color: var(--dun-4); }
  .dev-body { display: flex; flex-direction: column; gap: 6px; }
  .dev-sec.collapsed .dev-body { display: none; }
  .dev-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .dev-lbl { flex: 1 1 60px; font-size: 9px; letter-spacing: 1px; color: var(--dun-4); text-transform: uppercase; }
  .dev-btn {
    font-family: var(--f-ui), monospace; font-weight: 700; font-size: 10px; letter-spacing: 1px;
    text-transform: uppercase; color: var(--cream); background: var(--dun-3);
    border: 0; padding: 6px 8px; min-width: 0; cursor: pointer; line-height: 1;
    box-shadow: inset 0 0 0 2px var(--dun-2), 0 2px 0 var(--dun-0);
    text-shadow: none; clip-path: none; transition: background .06s, transform .04s;
  }
  .dev-btn:hover { background: var(--dun-4); }
  .dev-btn:active { transform: translateY(2px); box-shadow: inset 0 0 0 2px var(--dun-2); }
  .dev-btn.mini { padding: 6px 7px; }
  .dev-btn.wide { flex: 1 1 100%; }
  .dev-btn.on { background: var(--amber); color: var(--ink); box-shadow: inset 0 0 0 2px var(--amber-lo), 0 2px 0 var(--dun-0); }
  .dev-btn.danger:hover { background: var(--red); color: var(--ink); }
  .dev-chk { display: inline-flex; align-items: center; gap: 6px; font-size: 9px; letter-spacing: 1px; color: var(--dun-4); text-transform: uppercase; cursor: pointer; }
  .dev-chk input { width: 14px; height: 14px; accent-color: var(--amber); }
  .dev-read { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; font-family: var(--f-num), monospace; }
  .dev-read .k { font-family: var(--f-ui); font-size: 9px; letter-spacing: 1px; color: var(--dun-4); text-transform: uppercase; align-self: center; }
  .dev-read .v { font-size: 19px; line-height: 1; color: var(--cream); text-align: right; font-variant-numeric: tabular-nums; }
  .dev-read .v.warn { color: var(--red); }
  .dev-note { font-family: var(--f-num); font-size: 13px; color: var(--dun-4); line-height: 1.2; }

  /* Weapon inspection card: real pickup+held art plus the stats that distinguish it. */
  .dev-weapon-preview { display:grid; grid-template-columns:94px 1fr; gap:8px; align-items:center;
    min-height:76px; padding:7px; background:rgba(5,3,11,.66); box-shadow:inset 0 0 0 1px var(--dun-3); }
  .dev-weapon-art { position:relative; height:72px; overflow:hidden; background:rgba(23,18,39,.75); }
  .dev-weapon-img { position:absolute; image-rendering:pixelated; object-fit:contain; }
  .dev-weapon-img.pickup { width:64px; height:64px; left:2px; top:4px; }
  .dev-weapon-img.held { width:40px; height:40px; right:0; bottom:0; filter:drop-shadow(0 2px 0 rgba(0,0,0,.7)); }
  .dev-weapon-info { min-width:0; display:flex; flex-direction:column; gap:5px; }
  .dev-weapon-name { font-size:11px; color:var(--cream); letter-spacing:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .dev-weapon-type { font-size:8px; color:var(--amber); letter-spacing:1px; }
  .dev-weapon-stats { font-family:var(--f-num),monospace; font-size:14px; line-height:1.05; color:var(--dun-4); }

  /* Catalog thumbnails: a crisp pixel-art frame per spawnable entry. Fixed from creation
     (canvas width/height attrs drive both backing store + box), so paints never shift layout. */
  .dev-thumb { display:block; flex:0 0 auto; image-rendering:pixelated;
    background:rgba(5,3,11,.5); box-shadow:inset 0 0 0 1px var(--dun-3); }
  /* Abstract-entry fallback badge (kits/mutators/affixes): a 2-letter monogram, no fabricated art. */
  .dev-badge { display:inline-flex; align-items:center; justify-content:center; vertical-align:middle;
    min-width:15px; height:13px; margin-right:5px; padding:0 3px; font-size:8px; letter-spacing:0;
    color:var(--amber-hi); background:rgba(5,3,11,.5); box-shadow:inset 0 0 0 1px var(--dun-2); }
  /* Cosmetic / pet catalog grid + clickable tiles. */
  .dev-cat { display:flex; flex-wrap:wrap; gap:5px; }
  .dev-cat-cell { display:flex; flex-direction:column; align-items:center; gap:3px; width:52px; padding:4px 3px;
    cursor:pointer; background:rgba(5,3,11,.4); box-shadow:inset 0 0 0 1px var(--dun-2); }
  .dev-cat-cell:hover { background:var(--dun-2); }
  .dev-cat-cell.on { box-shadow:inset 0 0 0 2px var(--amber); }
  .dev-cat-name { max-width:46px; font-size:7px; line-height:1.1; letter-spacing:0; text-align:center;
    text-transform:uppercase; color:var(--dun-4); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  /* Live equipped-look / pet preview card (mirrors the weapon inspection card's frame). */
  .dev-preview-card { display:flex; gap:8px; align-items:center; padding:7px;
    background:rgba(5,3,11,.66); box-shadow:inset 0 0 0 1px var(--dun-3); }

  /* --- sprite / animation viewer (?dev=sprites) --- */
  .dev-sprites {
    position: fixed; inset: 0; z-index: 30; overflow-y: auto;
    background: radial-gradient(ellipse at center, var(--dun-1) 0%, var(--dun-0) 100%);
    padding: 20px 24px 60px;
  }
  .dev-sprites .head { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
  .dev-sprites h1 { font-family: var(--f-logo), monospace; font-size: 16px; color: var(--amber); letter-spacing: 1px; }
  .dev-sprites .hint { font-family: var(--f-num); font-size: 15px; color: var(--dun-4); }
  .dev-grid { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 26px; }
  .dev-cell {
    display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px;
    background: rgba(5, 3, 11, 0.55); box-shadow: inset 0 0 0 2px var(--dun-3);
  }
  .dev-cell canvas { image-rendering: pixelated; background:
    repeating-conic-gradient(var(--dun-2) 0% 25%, var(--dun-1) 0% 50%) 50% / 16px 16px; box-shadow: 0 0 0 1px var(--ink); }
  .dev-cell.flag canvas { box-shadow: 0 0 0 2px var(--red); }
  .dev-cap { font-size: 9px; letter-spacing: 1px; color: var(--cream); text-align: center; max-width: 128px; word-break: break-word; }
  .dev-cap .meta { display: block; font-family: var(--f-num); font-size: 14px; color: var(--dun-4); letter-spacing: 0; }
  .dev-cap .frame { display: block; font-family: var(--f-num); font-size: 15px; color: var(--amber-hi); letter-spacing: 0; }
  .dev-cap .flagmsg { display: block; font-family: var(--f-num); font-size: 13px; color: var(--red); letter-spacing: 0; }
`;

export function injectDevStyles(): void {
  if (document.getElementById("dev-styles")) return;
  const style = document.createElement("style");
  style.id = "dev-styles";
  style.textContent = DEV_CSS;
  document.head.appendChild(style);
}
