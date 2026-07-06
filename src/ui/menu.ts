import type { ConvexClient } from "convex/browser";
import type { Session } from "../net/session.js";
import type { ProfileDoc } from "../net/api.js";
import { Multiplayer } from "../net/multiplayer.js";
import type { RunResult } from "../game/game.js";
import { playerColor } from "../game/assets.js";

export interface MenuHost {
  startSolo(profile: ProfileDoc | null): void;
  startCoop(mp: Multiplayer, profile: ProfileDoc | null): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const CONTROLS = "WASD move \u00b7 Mouse aim \u00b7 Click shoot \u00b7 Shift dash \u00b7 hold TAB for stats";

// Drives everything shown in #overlay: the title/menu, the co-op lobby, and the
// game-over screen. It is the only place that knows whether multiplayer exists.
export class Menu {
  private overlay: HTMLElement;
  private session: Session;
  private client: ConvexClient | null;
  private host: MenuHost;
  private unsub: (() => void) | null = null;

  constructor(overlay: HTMLElement, session: Session, client: ConvexClient | null, host: MenuHost) {
    this.overlay = overlay;
    this.session = session;
    this.client = client;
    this.host = host;
  }

  hide() {
    this.teardownLobby();
    this.overlay.classList.add("hidden");
  }

  private show(...nodes: HTMLElement[]) {
    this.teardownLobby();
    this.overlay.classList.remove("hidden");
    this.overlay.replaceChildren(...nodes);
  }

  private teardownLobby() {
    if (this.unsub) { this.unsub(); this.unsub = null; }
  }

  async showTitle() {
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "", "BLOBROGUE"));
    wrap.appendChild(el("p", "", "An amber cowboy-blob lost in the depths. Blast your way down as far as you can \u2014 solo, or with friends."));

    if (!this.client) {
      wrap.appendChild(this.soloButton("descend \u25be"));
      wrap.appendChild(el("p", "muted", "multiplayer offline \u2014 no server configured for this build"));
    } else {
      const profileBox = el("div", "profile");
      wrap.appendChild(this.nameRow());
      wrap.appendChild(profileBox);
      const row = el("div", "btnrow");
      row.appendChild(this.soloButton("play solo"));
      const hostBtn = el("button", "", "host co-op");
      hostBtn.addEventListener("click", () => void this.doHost());
      const joinBtn = el("button", "secondary", "join with code");
      joinBtn.addEventListener("click", () => void this.showJoin());
      row.append(hostBtn, joinBtn);
      wrap.appendChild(row);
      void this.hydrateProfile(profileBox);
    }

    wrap.appendChild(el("p", "hint", CONTROLS));
    this.show(wrap);
  }

  private nameRow(): HTMLElement {
    const row = el("div", "namerow");
    const label = el("label", "", "name");
    const input = el("input");
    input.type = "text";
    input.maxLength = 20;
    input.placeholder = "your blob name";
    input.value = this.session.name;
    input.addEventListener("change", () => void this.session.login(input.value.trim() || "blob"));
    row.append(label, input);
    return row;
  }

  private async hydrateProfile(box: HTMLElement) {
    const profile = this.session.name
      ? await this.session.login(this.session.name)
      : await this.session.refreshProfile();
    if (!profile || profile.gamesPlayed === 0) return;
    box.replaceChildren();
    box.appendChild(el("div", "profile-title", `${profile.name} \u2014 all time`));
    const grid = el("div", "profile-grid");
    const stat = (label: string, value: number) => {
      const cell = el("div", "stat");
      cell.appendChild(el("span", "stat-value", String(value)));
      cell.appendChild(el("span", "stat-label", label));
      return cell;
    };
    grid.append(
      stat("deepest", profile.deepestFloor),
      stat("kills", profile.totalKills),
      stat("coins", profile.totalCoins),
      stat("runs", profile.gamesPlayed),
    );
    box.appendChild(grid);
  }

  private soloButton(label: string): HTMLButtonElement {
    const btn = el("button", "", label);
    btn.addEventListener("click", () => void this.doSolo());
    return btn;
  }

  private doSolo() {
    // Solo must never block on the network: kick off the (optional) identity
    // upsert in the background and start immediately with whatever profile we have.
    if (this.client) void this.session.login(this.session.name || "blob");
    this.host.startSolo(this.session.profile);
  }

  private async doHost() {
    if (!this.client) return;
    const status = this.busy("creating room\u2026");
    try {
      const profile = await this.session.login(this.session.name || "blob");
      const mp = new Multiplayer(this.client, this.session);
      await mp.host();
      this.showLobby(mp, profile);
    } catch (err) {
      status.textContent = this.cleanErr(err instanceof Error ? err.message : "could not create room");
    }
  }

  private async showJoin() {
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "", "JOIN GAME"));
    wrap.appendChild(el("p", "", "Enter the 4-letter code your host shared."));
    const input = el("input", "code-input");
    input.type = "text";
    input.maxLength = 5;
    input.placeholder = "CODE";
    input.autocapitalize = "characters";
    input.addEventListener("input", () => (input.value = input.value.toUpperCase()));
    wrap.appendChild(input);
    const status = el("p", "muted");
    const row = el("div", "btnrow");
    const go = el("button", "", "join");
    go.addEventListener("click", () => void this.doJoin(input.value, status));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") void this.doJoin(input.value, status); });
    const back = el("button", "secondary", "back");
    back.addEventListener("click", () => void this.showTitle());
    row.append(go, back);
    wrap.append(row, status);
    this.show(wrap);
    input.focus();
  }

  private async doJoin(code: string, status: HTMLElement) {
    if (!this.client || code.trim().length < 4) { status.textContent = "enter a valid code"; return; }
    status.textContent = "joining\u2026";
    try {
      const profile = await this.session.login(this.session.name || "blob");
      const mp = new Multiplayer(this.client, this.session);
      await mp.join(code);
      this.showLobby(mp, profile);
    } catch (err) {
      status.textContent = this.cleanErr(err instanceof Error ? err.message : "could not join");
    }
  }

  private showLobby(mp: Multiplayer, profile: ProfileDoc | null) {
    const render = () => {
      // The host clicking "start" flips status to playing; everyone launches here.
      if (mp.status === "playing") {
        this.teardownLobby();
        this.host.startCoop(mp, profile);
        return;
      }
      if (mp.status === "ended") { void this.showTitle(); return; }

      const wrap = el("div", "menu");
      wrap.appendChild(el("h1", "", "CO-OP LOBBY"));
      wrap.appendChild(el("p", "", "Share this code with friends on the same build:"));
      wrap.appendChild(el("div", "code-badge", mp.code));

      const list = el("div", "playerlist");
      for (const p of mp.lobbyPlayers()) {
        const rowEl = el("div", "playerrow");
        const dot = el("span", "dot");
        dot.style.background = playerColor(p.colorIndex);
        rowEl.append(dot, el("span", "", `${p.name}${p.isHost ? " (host)" : ""}`));
        list.appendChild(rowEl);
      }
      wrap.appendChild(list);

      const row = el("div", "btnrow");
      if (mp.isHost) {
        const start = el("button", "", "start descent \u25be");
        start.addEventListener("click", () => void mp.startGame());
        row.appendChild(start);
      } else {
        wrap.appendChild(el("p", "muted", "waiting for the host to start\u2026"));
      }
      const leave = el("button", "secondary", "leave");
      leave.addEventListener("click", () => { mp.leave(); void this.showTitle(); });
      row.appendChild(leave);
      wrap.appendChild(row);
      wrap.appendChild(el("p", "hint", CONTROLS));

      this.overlay.classList.remove("hidden");
      this.overlay.replaceChildren(wrap);
    };

    this.teardownLobby();
    this.unsub = mp.onChange(render);
    render();
  }

  showGameOver(result: RunResult, profile: ProfileDoc | null, wasCoop: boolean) {
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "died", "YOU DIED"));
    wrap.appendChild(el("p", "", `You reached floor ${result.floor}, downed ${result.kills} critters, and grabbed ${result.coins} coins.${wasCoop ? " The party fights on without you." : ""}`));
    if (profile) {
      wrap.appendChild(el("p", "muted", `all-time \u2014 deepest floor ${profile.deepestFloor} \u00b7 ${profile.totalKills} kills \u00b7 ${profile.totalCoins} coins \u00b7 ${profile.gamesPlayed} runs`));
    }
    const btn = el("button", "", "back to menu \u25b8");
    btn.addEventListener("click", () => void this.showTitle());
    wrap.appendChild(btn);
    this.show(wrap);
  }

  private busy(text: string): HTMLElement {
    const wrap = el("div", "menu");
    wrap.appendChild(el("h1", "", "\u2026"));
    const status = el("p", "muted", text);
    wrap.appendChild(status);
    this.show(wrap);
    return status;
  }

  private cleanErr(msg: string): string {
    return msg.replace(/^\[.*?\]\s*/, "");
  }
}
