import { Game } from "./game/game.js";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLElement;
const overlay = document.getElementById("overlay") as HTMLElement;
const startBtn = document.getElementById("startBtn") as HTMLButtonElement;

const game = new Game(canvas, hud, (floor, kills) => {
  overlay.classList.remove("hidden");
  overlay.innerHTML = `
    <h1 style="color:#ff6a6a">YOU DIED</h1>
    <p>You reached <b>floor ${floor}</b> and downed <b>${kills}</b> critters.<br/>The depths claim another cowboy-blob.</p>
    <button id="againBtn">descend again ▾</button>`;
  document.getElementById("againBtn")!.addEventListener("click", run);
});

function run() {
  overlay.classList.add("hidden");
  game.start();
}

startBtn.addEventListener("click", run);
