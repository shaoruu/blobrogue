#!/usr/bin/env node
// falrmbg — remove background from an image via fal (birefnet), save cutout PNG.
import * as fal from "@fal-ai/serverless-client";
import { writeFileSync, readFileSync } from "node:fs";
if (!process.env.FAL_KEY) { console.error("FAL_KEY not set"); process.exit(1); }
fal.config({ credentials: process.env.FAL_KEY });
const inp = process.argv[2], out = process.argv[3];
if (!inp || !out) { console.error("usage: falrmbg <in.png|url> <out.png>"); process.exit(1); }
async function toUrl(p){
  if (p.startsWith("http")) return p;
  const buf = readFileSync(p);
  return await fal.storage.upload(new Blob([buf], { type: "image/png" }));
}
async function run(){
  const image_url = await toUrl(inp);
  const res = await fal.subscribe("fal-ai/birefnet", { input: { image_url }, logs:false });
  const url = res.image?.url || res.images?.[0]?.url;
  if(!url){ console.error("no cutout: "+JSON.stringify(res).slice(0,200)); process.exit(1); }
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  writeFileSync(out, buf);
  console.log(`cutout saved ${out} (${buf.length}b)`);
}
run().catch(e=>{console.error("falrmbg error:",e?.message||e);process.exit(1);});
