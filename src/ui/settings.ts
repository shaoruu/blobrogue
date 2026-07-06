import { settings } from "../game/settings.js";
import { audio } from "../game/audio.js";

// The shared settings controls: independent music + sound-fx toggles (audio engine,
// persisted to blobrogue.audio) and the screen-shake slider (persisted to blobrogue.shake).
// Reused on the title screen and in the in-game pause overlay.
export function createSettingsControls(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings";

  const toggles = document.createElement("div");
  toggles.className = "btnrow";

  const music = document.createElement("button");
  music.className = "secondary settings-toggle";
  const syncMusic = () => { music.textContent = audio.isMusicOn ? "music: on" : "music: off"; };
  syncMusic();
  music.addEventListener("click", () => { audio.toggleMusic(); audio.unlock(); syncMusic(); });

  const fx = document.createElement("button");
  fx.className = "secondary settings-toggle";
  const syncFx = () => { fx.textContent = audio.isSfxOn ? "sound fx: on" : "sound fx: off"; };
  syncFx();
  fx.addEventListener("click", () => { audio.toggleSfx(); audio.unlock(); syncFx(); });

  toggles.append(music, fx);

  const shake = document.createElement("label");
  shake.className = "settings-shake";
  const label = document.createElement("span");
  label.className = "settings-label";
  const val = document.createElement("span");
  val.className = "settings-val";
  const syncVal = () => { val.textContent = `${Math.round(settings.shakeIntensity * 100)}%`; };
  label.append(document.createTextNode("screen shake "), val);
  const range = document.createElement("input");
  range.type = "range";
  range.min = "0"; range.max = "100"; range.step = "5";
  range.value = String(Math.round(settings.shakeIntensity * 100));
  syncVal();
  range.addEventListener("input", () => {
    settings.setShakeIntensity(Number(range.value) / 100);
    syncVal();
  });
  shake.append(label, range);

  wrap.append(toggles, shake);
  return wrap;
}
