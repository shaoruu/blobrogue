// The menu/settings' SINGLE lazy entry into the audio engine. Both surfaces dynamic-import
// this one specifier, so the whole engine (audio.ts + the wave sound specs + the director)
// loads as ONE off-critical-path chunk instead of a scatter of tiny ones — and it is shared
// with the game-engine chunk, never duplicated. Nothing here runs at first paint.
import { audio } from "./audio.js";
import { waveAudio } from "./waveAudio.js";
import type { WaveEventId } from "./waveSpec.js";

// Fire a menu cue through the wave audio director (camp open / purchase / denied).
export function playCue(cue: WaveEventId): void {
  waveAudio.play(cue);
}

// Resume the AudioContext on a settings gesture. The engine also self-binds a gesture unlock
// when it loads, so this is belt-and-suspenders — never the only path to sound.
export function unlockAudio(): void {
  audio.unlock();
}
