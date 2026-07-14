import type { Dungeon } from "../sim/dungeon.js";
import { TILE } from "../sim/types.js";
import { isPvpPitWarningTile } from "../sim/pvp.js";

export interface MinimapDot { x: number; y: number; color: string; size: number; }

export interface MinimapView {
  dungeon: Dungeon;
  playerX: number;
  playerY: number;
  exit: { x: number; y: number } | null;
  isCleared: boolean;
  dots: MinimapDot[]; // enemies + teammates, in world coords
}

const MAX_W = 176;
const MAX_H = 132;

// Draws a simplified top-down map into a small overlay canvas. The static tile
// layer is baked once per dungeon; only the dots redraw each frame.
export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private baked: HTMLCanvasElement | null = null;
  private bakedFor: Dungeon | null = null;
  private scale = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  // Blank the map (online boot: no authoritative dungeon yet, so show nothing stale).
  clear() {
    this.baked = null;
    this.bakedFor = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private bake(d: Dungeon) {
    this.scale = Math.min(MAX_W / d.w, MAX_H / d.h);
    const w = Math.ceil(d.w * this.scale);
    const h = Math.ceil(d.h * this.scale);
    this.canvas.width = w;
    this.canvas.height = h;

    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const g = off.getContext("2d")!;
    g.fillStyle = "rgba(10,8,20,0.55)";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#3a2d5e";
    const s = this.scale;
    for (let ty = 0; ty < d.h; ty++) {
      for (let tx = 0; tx < d.w; tx++) {
        const tile = d.tiles[ty * d.w + tx];
        if (tile === 0) {
          g.fillStyle = isPvpPitWarningTile(d, tx, ty) ? "#8a5424" : "#3a2d5e";
          g.fillRect(Math.floor(tx * s), Math.floor(ty * s), Math.ceil(s), Math.ceil(s));
        } else if (tile === 2) {
          const x = Math.floor(tx * s);
          const y = Math.floor(ty * s);
          const size = Math.max(1, Math.ceil(s));
          g.fillStyle = "#1a050b";
          g.fillRect(x, y, size, size);
          g.strokeStyle = "#ff5a4f";
          g.lineWidth = 1;
          g.strokeRect(x + 0.5, y + 0.5, Math.max(0, size - 1), Math.max(0, size - 1));
          g.fillStyle = "#3a2d5e";
        }
      }
    }
    this.baked = off;
    this.bakedFor = d;
  }

  render(view: MinimapView) {
    const d = view.dungeon;
    if (this.bakedFor !== d || !this.baked) this.bake(d);
    const { ctx } = this;
    const s = this.scale;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.baked!, 0, 0);

    const toX = (wx: number) => (wx / TILE) * s;
    const toY = (wy: number) => (wy / TILE) * s;

    if (view.exit !== null) {
      ctx.fillStyle = view.isCleared ? "#8affc0" : "#4f7a63";
      const exX = (view.exit.x + 0.5) * s;
      const exY = (view.exit.y + 0.5) * s;
      ctx.beginPath();
      ctx.arc(exX, exY, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const dot of view.dots) {
      ctx.fillStyle = dot.color;
      ctx.beginPath();
      ctx.arc(toX(dot.x), toY(dot.y), dot.size, 0, Math.PI * 2);
      ctx.fill();
    }

    // player (drawn last, on top)
    ctx.fillStyle = "#ffb43b";
    ctx.strokeStyle = "#201436";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(toX(view.playerX), toY(view.playerY), 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // frame
    ctx.strokeStyle = "rgba(255,180,59,0.55)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, this.canvas.width - 2, this.canvas.height - 2);
  }
}
