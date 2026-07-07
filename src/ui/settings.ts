import { settings } from "../game/settings.js";
import { audio } from "../game/audio.js";

// The shared mute + screen-shake controls, wired straight to the persisted `settings`
// singleton. Reused on the title screen and in the in-game pause overlay so both stay
// in sync automatically (they read/write the same source of truth).
export function createSettingsControls(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings";

  const mute = document.createElement("button");
  mute.className = "secondary settings-mute";
  const syncMute = () => { mute.textContent = settings.isMuted ? "sound: off" : "sound: on"; };
  syncMute();
  mute.addEventListener("click", () => {
    settings.toggleMuted();
    audio.unlock(); // this click is a gesture — resume the context so unmuting is instant
    syncMute();
  });

  const autofire = document.createElement("button");
  autofire.className = "secondary settings-autofire";
  const syncAutofire = () => { autofire.textContent = settings.isAutofire ? "autofire: on" : "autofire: off"; };
  syncAutofire();
  autofire.addEventListener("click", () => {
    settings.toggleAutofire();
    syncAutofire();
  });

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

  wrap.append(mute, autofire, shake);
  return wrap;
}
