// The companion panel — the UI Director's shippable picker, built as a HOST-AGNOSTIC
// component so the exact same panel migrates to the physical Amber Camp station when the
// camp ships: it takes a tiny CompanionPanelHost adapter (state in, equip intent out),
// touches no Session/Convex/game internals, and renders plain DOM the title menu, the room
// lobby, or a future in-world kiosk overlay can mount verbatim.
//
// Director contract, in full:
//   - "CHOOSE A COMPANION" header; a grid of every roster pet
//   - 64px ANIMATED preview per pet: the AUTHORED sprite the moment it is registered in
//     assets.ts PET_SOURCES (FAL-generated, AD-approved — the art rule bans procedural
//     character bodies), and until then the shared neutral silhouette placeholder
//     (petArt.ts) — a position marker, never fake art
//   - name + behavior line; EXACT bounded stats straight from PET_BALANCE (petStats — power
//     is never hidden in flavor copy)
//   - Equip / Equipped states, server-validated by the host
//   - locked pets show a dark SILHOUETTE + exactly one clue (their unlock milestone)
//   - the readability promise in plain words: pets never block shots or loot
//   - controller/mobile-sized targets (≥44px equip buttons; the whole card is a target)

import { PETS, PET_KINDS, PET_CAPS, petStats } from "../sim/pets.js";
import { PET_SOURCES } from "../game/assets.js";
import type { PetKind } from "../sim/types.js";
import { drawPetPlaceholder } from "../game/petArt.js";

export interface CompanionPanelState {
  isAccount: boolean;
  unlockedPets: readonly PetKind[];
  activePet: PetKind | null;
}

export interface CompanionPanelHost {
  getState(): CompanionPanelState;
  // Equip a pet (or null to dismiss the current one). The host owns persistence and
  // validation; the panel re-renders from getState() when the promise settles.
  equip(pet: PetKind | null): Promise<void>;
}

export interface CompanionPanel {
  root: HTMLElement;
  refresh(): void; // re-render from the host's current state (e.g. after profile hydration)
  destroy(): void; // stop the preview animation loop (call on unmount)
}

const PREVIEW_PX = 64;
// Bodies are authored at sim scale (~20-26px across); scale into the 64px stage.
const PREVIEW_SCALE = 2;

// The registered pet sprites (assets.ts PET_SOURCES), loaded lazily the first time a
// preview needs one. Empty registry today -> every entry stays undefined and the preview
// draws the shared silhouette placeholder instead.
const spriteCache = new Map<PetKind, HTMLImageElement>();
function petSprite(kind: PetKind): HTMLImageElement | null {
  const src = PET_SOURCES[kind];
  if (!src) return null;
  let img = spriteCache.get(kind);
  if (!img) {
    img = new Image();
    img.src = src;
    spriteCache.set(kind, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createCompanionPanel(host: CompanionPanelHost): CompanionPanel {
  const root = el("section", "pets-panel");
  const note = el("p", "pet-note");
  const previews = new Map<PetKind, { canvas: HTMLCanvasElement; isLocked: boolean }>();
  let isBusy = false;
  let raf = 0;

  const render = () => {
    const state = host.getState();
    const unlocked = new Set(state.unlockedPets);
    previews.clear();

    const head = el("header", "pets-head");
    head.appendChild(el("h3", "pets-title", "CHOOSE A COMPANION"));
    if (state.isAccount) head.appendChild(el("span", "pets-count", `${unlocked.size}/${PET_KINDS.length} unlocked`));

    const grid = el("div", "pets-grid");
    for (const kind of PET_KINDS) {
      const def = PETS[kind];
      const isUnlocked = state.isAccount && unlocked.has(kind);
      const isActive = state.activePet === kind;

      const card = el("article", "pet-card" + (isUnlocked ? "" : " locked") + (isActive ? " sel" : ""));
      const canvas = el("canvas", "pet-preview");
      canvas.width = PREVIEW_PX;
      canvas.height = PREVIEW_PX;
      previews.set(kind, { canvas, isLocked: !isUnlocked });
      card.appendChild(canvas);

      const info = el("div", "pet-info");
      info.appendChild(el("div", "pet-name", def.name));
      if (isUnlocked) {
        // Behavior + the exact bounded numbers (never power hidden in flavor).
        info.appendChild(el("p", "pet-behavior", def.role));
        const [a, b] = petStats(kind);
        info.appendChild(el("p", "pet-exact", `${a}\n${b}`));
      } else {
        // A locked pet keeps its mystery: the silhouette plus exactly ONE clue.
        info.appendChild(el("p", "pet-clue", def.requirement.label));
      }
      card.appendChild(info);

      const btn = el("button", "secondary pet-equip" + (isActive ? " on" : ""), isActive ? "EQUIPPED" : isUnlocked ? "EQUIP" : "LOCKED");
      btn.type = "button";
      btn.disabled = !isUnlocked;
      btn.setAttribute("aria-label", isActive ? `Unequip ${def.name}` : isUnlocked ? `Equip ${def.name}` : `${def.name} locked — ${def.requirement.label}`);
      if (isActive) btn.title = "click to dismiss";
      card.appendChild(btn);

      const onPick = () => {
        if (!state.isAccount) { note.textContent = "sign in with Google to unlock companions"; return; }
        if (!isUnlocked) { note.textContent = def.requirement.label; return; }
        if (isBusy) return;
        isBusy = true;
        note.textContent = "";
        void host.equip(isActive ? null : kind)
          .catch(() => { note.textContent = "could not save the pick \u2014 try again"; })
          .finally(() => { isBusy = false; render(); });
      };
      btn.addEventListener("click", (e) => { e.stopPropagation(); onPick(); });
      // The whole card is a controller/touch-sized target; the button is the affordance.
      card.addEventListener("click", onPick);
      grid.appendChild(card);
    }

    const foot = el("p", "pets-foot",
      `Pets never block your shots or your loot. One per blob, capped at ${Math.round(PET_CAPS.ownerDpsShare * 100)}% of your damage.`);

    root.replaceChildren(head, grid, foot, note);
    drawPreviews(performance.now());
  };

  // One animation loop for every preview: an idle bob over the AUTHORED sprite when it is
  // registered, else the shared neutral silhouette placeholder (never fake art). A locked
  // preview darkens to a full silhouette (composite over whatever was drawn). jsdom (the
  // DOM test) has no canvas backend — a null context simply skips drawing.
  const drawPreviews = (nowMs: number) => {
    const clock = nowMs / 1000;
    for (const [kind, p] of previews) {
      const g = p.canvas.getContext("2d");
      if (!g) continue;
      g.clearRect(0, 0, PREVIEW_PX, PREVIEW_PX);
      const bob = Math.sin(clock * 3 + PET_KINDS.indexOf(kind)) * 2;
      // Grounding shadow (the wisp floats instead).
      if (kind !== "lantern_wisp") {
        g.save();
        g.globalAlpha = 0.3;
        g.fillStyle = "#05030b";
        g.beginPath();
        g.ellipse(PREVIEW_PX / 2, PREVIEW_PX * 0.78, 14, 5, 0, 0, 6.28);
        g.fill();
        g.restore();
      }
      const sprite = petSprite(kind);
      if (sprite) {
        g.drawImage(sprite, 0, bob, PREVIEW_PX, PREVIEW_PX);
      } else {
        g.save();
        g.translate(PREVIEW_PX / 2, PREVIEW_PX / 2 + bob);
        g.scale(PREVIEW_SCALE, PREVIEW_SCALE);
        drawPetPlaceholder(g, kind, PETS[kind].tint);
        g.restore();
      }
      if (p.isLocked) {
        g.save();
        g.globalCompositeOperation = "source-atop";
        g.fillStyle = "rgba(13, 8, 25, 0.92)";
        g.fillRect(0, 0, PREVIEW_PX, PREVIEW_PX);
        g.restore();
      }
    }
  };

  const loop = (t: number) => {
    drawPreviews(t);
    raf = requestAnimationFrame(loop);
  };

  render();
  // jsdom (the DOM test) exposes neither rAF nor a canvas backend; the panel is fully
  // functional statically and simply skips the idle animation there.
  const hasRaf = typeof requestAnimationFrame === "function";
  if (hasRaf) raf = requestAnimationFrame(loop);

  return {
    root,
    refresh: render,
    destroy: () => { if (hasRaf) cancelAnimationFrame(raf); },
  };
}
