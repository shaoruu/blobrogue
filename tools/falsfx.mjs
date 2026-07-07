#!/usr/bin/env node
// falsfx — generate one-shot game SFX via fal.ai ElevenLabs sound-effects/v2.
// Usage: node tools/falsfx.mjs --prompt "..." --out public/audio/sfx/x.mp3 --dur 0.5
// FAL_KEY must be in env (source /workspace/.secrets/env.sh).
import * as fal from "@fal-ai/serverless-client";
import { writeFileSync } from "node:fs";
if (!process.env.FAL_KEY) { console.error("FAL_KEY not set"); process.exit(1); }
fal.config({ credentials: process.env.FAL_KEY });
const args = {};
for (let i = 2; i < process.argv.length; i++) { const a = process.argv[i]; if (a.startsWith("--")) { const k = a.slice(2); const v = process.argv[i+1]?.startsWith("--") ? "true" : process.argv[++i]; args[k] = v; } }
const { prompt, out } = args;
const dur = parseFloat(args.dur || "0.6");
if (!prompt || !out) { console.error("need --prompt and --out"); process.exit(1); }
const res = await fal.subscribe("fal-ai/elevenlabs/sound-effects/v2", {
  input: { text: prompt, duration_seconds: dur, prompt_influence: parseFloat(args.infl || "0.5") },
  logs: false,
});
const url = res?.audio?.url || res?.audio_url?.url || res?.data?.audio?.url;
if (!url) { console.error("no audio url in response:", JSON.stringify(res).slice(0,400)); process.exit(1); }
const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
writeFileSync(out, buf);
console.log("wrote", out, buf.length, "bytes");
