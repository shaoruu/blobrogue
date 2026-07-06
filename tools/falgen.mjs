#!/usr/bin/env node
// falgen — generate game art via fal.ai using Ian's providers (ported from town).
// Usage:
//   node tools/falgen.mjs --provider recraft --style icon --prompt "..." --out public/sprites/hero.png [--ar square]
//   node tools/falgen.mjs --provider flux --prompt "..." --out foo.png
//   node tools/falgen.mjs --provider ideogram --style DESIGN --prompt "..." --out foo.png
// Providers: recraft (best for clean game icons w/ transparent-ish bg), flux, flux-schnell,
//            ideogram, nano-banana, sd35, gpt (openai/gpt-image-2).
// FAL_KEY must be in env (source /workspace/.secrets/env.sh).
import * as fal from "@fal-ai/serverless-client";
import { writeFileSync } from "node:fs";

if (!process.env.FAL_KEY) { console.error("FAL_KEY not set — run: source /workspace/.secrets/env.sh"); process.exit(1); }
fal.config({ credentials: process.env.FAL_KEY });

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) { const k = a.slice(2); const v = process.argv[i+1]?.startsWith("--") ? "true" : process.argv[++i]; args[k] = v; }
}
const provider = args.provider || "recraft";
const prompt = args.prompt;
const out = args.out;
const ar = args.ar || "square";              // 1:1 style aspect
const size = args.size || "square_hd";       // for image_size providers
const style = args.style;                    // provider-specific
if (!prompt || !out) { console.error("need --prompt and --out"); process.exit(1); }

const arLegacy = { square: "1:1", square_hd: "1:1", portrait: "3:4", landscape: "4:3" }[ar] || ar;

async function run() {
  let model, input;
  switch (provider) {
    case "recraft": // clean vector/icon art; style e.g. digital_illustration/pixel_art, icon, vector_illustration
      model = "fal-ai/recraft/v3/text-to-image";
      input = { prompt, image_size: size, style: style || "digital_illustration/pixel_art" };
      break;
    case "flux":
      model = "fal-ai/flux/dev";
      input = { prompt, image_size: size, num_images: 1, enable_safety_checker: false, output_format: "png" };
      break;
    case "flux-schnell":
      model = "fal-ai/flux/schnell";
      input = { prompt, image_size: size, num_images: 1, enable_safety_checker: false, output_format: "png" };
      break;
    case "ideogram":
      model = "fal-ai/ideogram/v3";
      input = { prompt, aspect_ratio: arLegacy, style_type: style || "DESIGN", output_format: "png" };
      break;
    case "nano-banana":
      model = "fal-ai/nano-banana";
      input = { prompt, aspect_ratio: arLegacy, num_images: 1, output_format: "png" };
      break;
    case "sd35":
      model = "fal-ai/stable-diffusion-v35-large";
      input = { prompt, image_size: size, num_inference_steps: 28, guidance_scale: 3.5, num_images: 1, enable_safety_checker: false, output_format: "png" };
      break;
    case "gpt":
      model = "openai/gpt-image-2";
      input = { prompt, image_size: size, quality: "high", num_images: 1, output_format: "png" };
      break;
    default:
      console.error("unknown provider " + provider); process.exit(1);
  }
  console.error(`[falgen] ${model}  ar=${ar} style=${style||"-"}`);
  const res = await fal.subscribe(model, { input, logs: false });
  const img = res.images?.[0];
  if (!img?.url) { console.error("no image in result: " + JSON.stringify(res).slice(0,300)); process.exit(1); }
  const buf = Buffer.from(await (await fetch(img.url)).arrayBuffer());
  writeFileSync(out, buf);
  console.log(`saved ${out} (${buf.length} bytes) from ${model}`);
}
run().catch((e) => { console.error("falgen error:", e?.message || e); process.exit(1); });
