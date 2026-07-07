import type { ItemDef, ItemRarity } from "../game/items.js";

// The between-floor "choose a blessing" overlay. Modeled on PauseOverlay: it owns its
// own fixed layer (never fights #overlay), freezes nothing itself — the game decides
// when to show it and resumes on pick. Keyboard (1/2/3, arrows + Enter) and click both
// select. Matches the dungeon token aesthetic from index.html.
const RARITY_LABEL: Record<ItemRarity, string> = {
  common: "COMMON",
  uncommon: "UNCOMMON",
  rare: "RARE",
};

export class BlessingOverlay {
  private root: HTMLElement;
  private cardsEl: HTMLElement;
  private cards: HTMLElement[] = [];
  private choices: ItemDef[] = [];
  private selected = 0;
  private onPick: ((item: ItemDef) => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor() {
    const root = document.createElement("div");
    root.className = "blessing-overlay hidden";

    const card = document.createElement("div");
    card.className = "menu blessing";

    const title = document.createElement("h1");
    title.textContent = "CHOOSE A BLESSING";
    card.appendChild(title);

    const sub = document.createElement("p");
    sub.className = "muted";
    sub.textContent = "one pick, stacks for the rest of the run";
    card.appendChild(sub);

    this.cardsEl = document.createElement("div");
    this.cardsEl.className = "blessing-cards";
    card.appendChild(this.cardsEl);

    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "1 / 2 / 3 or click \u00b7 \u2190 \u2192 then ENTER";
    card.appendChild(hint);

    root.appendChild(card);
    document.body.appendChild(root);
    this.root = root;
  }

  show(choices: ItemDef[], onPick: (item: ItemDef) => void): void {
    this.choices = choices;
    this.onPick = onPick;
    this.selected = 0;
    this.render();
    this.root.classList.remove("hidden");
    this.keyHandler = (e) => this.onKey(e);
    window.addEventListener("keydown", this.keyHandler, true);
  }

  hide(): void {
    this.root.classList.add("hidden");
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler, true);
      this.keyHandler = null;
    }
    this.onPick = null;
  }

  private render(): void {
    this.cardsEl.replaceChildren();
    this.cards = [];
    this.choices.forEach((item, i) => {
      const el = document.createElement("button");
      el.className = "blessing-card";
      el.type = "button";

      const key = document.createElement("span");
      key.className = "bc-key";
      key.textContent = String(i + 1);
      el.appendChild(key);

      const icon = document.createElement("span");
      icon.className = "bc-icon";
      icon.style.setProperty("--t", item.tint);
      icon.textContent = item.glyph;
      el.appendChild(icon);

      const name = document.createElement("span");
      name.className = "bc-name";
      name.textContent = item.name;
      el.appendChild(name);

      const rarity = document.createElement("span");
      rarity.className = `bc-rarity ${item.rarity}`;
      rarity.textContent = RARITY_LABEL[item.rarity];
      el.appendChild(rarity);

      const desc = document.createElement("span");
      desc.className = "bc-desc";
      desc.textContent = item.desc;
      el.appendChild(desc);

      el.addEventListener("click", () => this.pick(i));
      el.addEventListener("mouseenter", () => this.setSelected(i));
      this.cardsEl.appendChild(el);
      this.cards.push(el);
    });
    this.setSelected(0);
  }

  private setSelected(i: number): void {
    this.selected = i;
    this.cards.forEach((c, idx) => c.classList.toggle("selected", idx === i));
  }

  private onKey(e: KeyboardEvent): void {
    const k = e.key.toLowerCase();
    if (k >= "1" && k <= String(this.choices.length)) {
      e.preventDefault(); e.stopPropagation();
      this.pick(Number(k) - 1);
    } else if (k === "arrowright" || k === "d") {
      e.preventDefault(); e.stopPropagation();
      this.setSelected((this.selected + 1) % this.choices.length);
    } else if (k === "arrowleft" || k === "a") {
      e.preventDefault(); e.stopPropagation();
      this.setSelected((this.selected + this.choices.length - 1) % this.choices.length);
    } else if (k === "enter" || k === " ") {
      e.preventDefault(); e.stopPropagation();
      this.pick(this.selected);
    }
  }

  private pick(i: number): void {
    const item = this.choices[i];
    const cb = this.onPick;
    if (!item || !cb) return;
    this.hide();
    cb(item);
  }
}
