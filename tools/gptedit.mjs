#!/usr/bin/env node
// gptedit — in-place image edit via fal openai/gpt-image-2/edit (OpenAI's model, strong at precise in-place replacements).
import * as fal from "@fal-ai/serverless-client";
import { writeFileSync, readFileSync } from "node:fs";
if(!process.env.FAL_KEY){console.error("FAL_KEY not set");process.exit(1);}
fal.config({credentials:process.env.FAL_KEY});
const src=process.argv[2], out=process.argv[3], prompt=process.argv[4];
if(!src||!out||!prompt){console.error("usage: gptedit <src.png|url> <out.png> <prompt>");process.exit(1);}
async function up(p){const b=readFileSync(p);return await fal.storage.upload(new Blob([b],{type:"image/png"}));}
async function run(){
  const image_url = src.startsWith("http")?src:await up(src);
  const res=await fal.subscribe("openai/gpt-image-2/edit",{input:{prompt,image_urls:[image_url],num_images:1},logs:false});
  const url=res.images?.[0]?.url; if(!url){console.error("no image "+JSON.stringify(res).slice(0,300));process.exit(1);}
  writeFileSync(out, Buffer.from(await (await fetch(url)).arrayBuffer()));
  console.log(`gpt-edited -> ${out}`);
}
run().catch(e=>{console.error("gptedit error:",e?.message||e);process.exit(1);});
