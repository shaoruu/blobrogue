import { createSettingsControls } from "./settings.js";

// A lightweight in-game pause screen (Esc). It owns its own fixed overlay so it never
// fights the menu for #overlay, and simply shows the shared settings controls plus
// resume / quit-to-menu actions. The game decides when it appears.
export class PauseOverlay {
  private root: HTMLElement;

  constructor(onResume: () => void, onQuit: () => void) {
    const root = document.createElement("div");
    root.className = "pause-overlay hidden";

    const card = document.createElement("div");
    card.className = "menu";
    const title = document.createElement("h1");
    title.textContent = "PAUSED";
    card.appendChild(title);
    card.appendChild(createSettingsControls());

    const row = document.createElement("div");
    row.className = "btnrow";
    const resume = document.createElement("button");
    resume.textContent = "resume \u25b8";
    resume.addEventListener("click", onResume);
    const quit = document.createElement("button");
    quit.className = "secondary";
    quit.textContent = "quit to menu";
    quit.addEventListener("click", onQuit);
    row.append(resume, quit);
    card.appendChild(row);

    root.appendChild(card);
    document.body.appendChild(root);
    this.root = root;
  }

  show(): void {
    this.root.classList.remove("hidden");
  }

  hide(): void {
    this.root.classList.add("hidden");
  }
}
