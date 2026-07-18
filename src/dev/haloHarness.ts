import { Game } from "../game/game.js";
import { haloVisualStrength, haloVisualTier } from "../game/haloVisual.js";
import { itemById } from "../sim/items.js";

export type HaloHarnessScene = "low" | "mid" | "high";

export const HALO_HARNESS_SCENES: readonly HaloHarnessScene[] = ["low", "mid", "high"];

interface HaloHarnessState {
  scene: HaloHarnessScene;
  tier: number;
  strength: number;
  blades: number;
  bladeRadius: number;
  speed: number;
  flare: number;
}

function requestedScene(): HaloHarnessScene {
  const scene = new URLSearchParams(window.location.search).get("scene");
  return scene !== null && (HALO_HARNESS_SCENES as readonly string[]).includes(scene)
    ? scene as HaloHarnessScene
    : "low";
}

function grant(game: Game, itemId: string, count: number): void {
  const item = itemById(itemId);
  if (item === undefined) throw new Error(`Halo harness item is missing: ${itemId}`);
  for (let index = 0; index < count; index++) game.devGrantItem(item);
}

function applyScene(game: Game, scene: HaloHarnessScene): void {
  if (scene === "mid") {
    grant(game, "split_shot", 1);
    return;
  }
  if (scene === "high") {
    grant(game, "split_shot", 2);
    grant(game, "frostbite", 3);
    grant(game, "marksman", 3);
  }
}

function readState(game: Game, scene: HaloHarnessScene): HaloHarnessState | null {
  const effect = game.devWorld().effects.find((candidate) => candidate.kind === "orbit");
  if (effect === undefined || effect.kind !== "orbit") return null;
  return {
    scene,
    tier: haloVisualTier(effect.blades, effect.bladeRadius, effect.speed),
    strength: haloVisualStrength(effect.blades, effect.bladeRadius, effect.speed),
    blades: effect.blades,
    bladeRadius: effect.bladeRadius,
    speed: effect.speed,
    flare: effect.flare,
  };
}

declare global {
  interface Window {
    __haloVisual?: {
      scenes: readonly HaloHarnessScene[];
      state: () => HaloHarnessState | null;
      isReady: () => boolean;
    };
  }
}

export function bootHaloHarness(
  canvas: HTMLCanvasElement,
  minimap: HTMLCanvasElement,
  overlay: HTMLElement,
): void {
  overlay.classList.add("hidden");
  const scene = requestedScene();
  const game = new Game(
    canvas,
    minimap,
    document.body,
    () => game.devStartSandbox(),
    () => { window.location.href = window.location.pathname; },
  );
  game.devStartSandbox();
  game.devGiveWeapon("halo");
  applyScene(game, scene);

  if (scene === "high") {
    const fire = (): void => {
      canvas.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
      window.setTimeout(() => window.dispatchEvent(new MouseEvent("mouseup", { button: 0 })), 120);
    };
    window.setTimeout(fire, 250);
    window.setInterval(fire, 750);
  }

  window.__haloVisual = {
    scenes: HALO_HARNESS_SCENES,
    state: () => readState(game, scene),
    isReady: () => readState(game, scene)?.tier === HALO_HARNESS_SCENES.indexOf(scene),
  };
}
