// SECTION C: pixel-icon rasterizer + icon set (from ui designer, verbatim). For src/game/hud.ts (adapt to TS).
const INK = '#120a24';
export function pxIcon(map, pal, scale = 2){
  const w = map[0].length, h = map.length;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  for (let y = 0; y < h; y++)
    for (let i = 0; i < w; i++){
      const ch = map[y][i];
      if (pal[ch]){ x.fillStyle = pal[ch]; x.fillRect(i, y, 1, 1); }
    }
  c.style.imageRendering = 'pixelated';
  c.style.width  = (w * scale) + 'px';
  c.style.height = (h * scale) + 'px';
  return c;
}
const HEART_FULL  = ["..X..X..",".XRRXRRX","XRWWRRRX","XRRRRRRX",".XRRRRX.","..XRRX..","...XX...","........"];
const HEART_EMPTY = ["..X..X..",".XddXddX","Xd....dX","Xd....dX",".Xd..dX.","..XddX..","...XX...","........"];
const HEART_PAL   = { X:INK, R:'#ff5a5a', W:'#ffb0b0', d:'#241a38' };
export function renderHearts(el, hp, maxHp, scale = 2.8){
  el.innerHTML = '';
  for (let n = 0; n < maxHp; n++)
    el.appendChild(pxIcon(n < hp ? HEART_FULL : HEART_EMPTY, HEART_PAL, scale));
}
export const ICONS = {
  play:  { map:[".X......",".XX.....",".XXX....",".XXXX...",".XXX....",".XX.....",".X......","........"], pal:{ X:INK }, s:2 },
  coin:  { map:["..XXXX..",".XWWWWhX","XWhhWWhX","XWhhhWhX","XWhhhWhX","XWWhhWhX",".XWWWWhX","..XXXX.."], pal:{ X:INK, W:'#ffd166', h:'#b06e12' }, s:2 },
  skull: { map:[".XXXXXX.","XWWWWWWX","XWKWWKWX","XWWWWWWX","XWKKKKWX",".XWWWWX.",".XKXKXKX","..X.X..."], pal:{ X:INK, W:'#e8e0c8', K:INK }, s:2 },
  gun:   { map:["................","...XXXXXXXX.....","..XLLLLLLLLX....",".XLhhhhhhhLX....","XXXXXXXXXXLX....","XLLLLLLLLXLX....","XLbbbbbbLXXX....","XXXXXXXXXX.X....","...XLLX...XX....","...XLLXXXXX.....","...XXXX........."], pal:{ X:INK, L:'#6b401e', h:'#9c6633', b:'#301c0e' }, s:2.4 },
};
export function mountIcons(root = document){
  root.querySelectorAll('[data-ic]').forEach(el => {
    if (el.dataset.mounted) return;
    const d = ICONS[el.getAttribute('data-ic')];
    if (!d) return;
    const cv = pxIcon(d.map, d.pal, d.s);
    if (el.style.width){ cv.style.width = el.style.width; cv.style.height = el.style.height; }
    el.appendChild(cv); el.dataset.mounted = '1';
  });
}
// WIRING: once mountIcons(hudEl); on change renderHearts([data-hearts], hp, maxHp);
// [data-floor/kills/coins/wname/wammo].textContent; dash .bar i --dash-fill=dashCooldown01, .dash.ready when >=1
// PERF: renderHearts only on hp/maxHp change; mountIcons once.
