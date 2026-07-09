#!/usr/bin/env node
// gen-sprites — generate blobrogue's full sprite set via fal (flux) + birefnet cutout.
// Produces clean transparent PNGs into /workspace/fal-art/<name>-cut.png
import * as fal from "@fal-ai/serverless-client";
import { writeFileSync, readFileSync } from "node:fs";
if (!process.env.FAL_KEY) { console.error("FAL_KEY not set"); process.exit(1); }
fal.config({ credentials: process.env.FAL_KEY });

const SUBJECTS = {
  hero: "a cute round glowing amber-gold slime blob wearing a small brown cowboy hat with a sheriff star, two friendly dark eyes",
  slime: "an angry purple slime monster with glowing red eyes and a fanged mouth",
  bat: "a small dark-red demon bat with spread leathery wings and tiny fangs",
  skeleton: "a small angry skeleton warrior holding a rusty short sword",
  ghost: "a translucent pale-blue floating ghost with a wispy tail and hollow eyes",
  boss: "a huge menacing purple slime KING with a golden crown, glowing red eyes and a big fanged grin",
  charger: "a stocky angular bone-plated boar beast monster with a lowered ram head and heavy shoulders, dull copper and bone colors, small furious red eyes",
  burrower: "a pale dirt-crusted mole-grub monster with oversized digging claws and a segmented earthen back, beady dark eyes",
  orbiter: "a small floating one-eyed observer wisp monster, pale cold blue, thin trailing fins, a single unblinking eye",
  shielder: "a squat verdigris-bronze armored monster hiding behind a huge tower shield covering its whole front, only eyes peeking over the rim",
  marrow: "a huge menacing eyeless bone golem brute of fused pale rock and exposed bone, angular bull-like silhouette, empty eye sockets glowing faint red",
  choir: "a huge tragic ghost boss made of many fused sorrowful translucent pale-blue ghost faces with hollow singing mouths, wispy trailing tendrils",
  weaver: "a sleek menacing spider-like boss monster, cold indigo and violet, many angular thin legs, glinting cluster of eyes",
  gilded: "a huge ancient armored golem boss of sacred gilded amber plate armor with ornate geometric engravings, a narrow glowing core seam down the chest",
  heart: "a single glossy bright-red heart health pickup icon",
  coin: "a single shiny gold coin with a star engraved, pickup icon",
  gun: "a single small golden six-shooter revolver pickup icon",
  held_mortar: "a single small chunky bronze grenade launcher with a fat stubby barrel, side profile pointing right, game weapon icon",
  held_beam: "a single slender golden lance-rifle with a glowing amber crystal at the muzzle, side profile pointing right, game weapon icon",
  held_vortex: "a single deep-blue orb caster gun with a swirling glass sphere chamber, side profile pointing right, game weapon icon",
};

async function upload(p){ const buf=readFileSync(p); return await fal.storage.upload(new Blob([buf],{type:"image/png"})); }

async function genOne(name, desc){
  const prompt = `a single top-down video-game character sprite of ${desc}, centered, isolated on a plain flat pure white background, no shadow, no border, no scenery, no text, clean crisp 2D game asset illustration`;
  const res = await fal.subscribe("fal-ai/flux/dev", { input:{ prompt, image_size:"square_hd", num_images:1, enable_safety_checker:false, output_format:"png" }, logs:false });
  const url = res.images?.[0]?.url; if(!url) throw new Error("no image for "+name);
  const raw = `/workspace/fal-art/${name}.png`;
  writeFileSync(raw, Buffer.from(await (await fetch(url)).arrayBuffer()));
  const up = await upload(raw);
  const cut = await fal.subscribe("fal-ai/birefnet", { input:{ image_url: up }, logs:false });
  const curl = cut.image?.url || cut.images?.[0]?.url; if(!curl) throw new Error("no cutout for "+name);
  const cpath = `/workspace/fal-art/${name}-cut.png`;
  writeFileSync(cpath, Buffer.from(await (await fetch(curl)).arrayBuffer()));
  console.log(`${name}: ok`);
}

const only = process.argv.slice(2);
const names = only.length ? only : Object.keys(SUBJECTS);
for (const n of names){ try { await genOne(n, SUBJECTS[n]); } catch(e){ console.error(`${n}: FAILED ${e?.message||e}`); } }
console.log("gen-sprites done");
