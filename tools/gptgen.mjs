#!/usr/bin/env node
// gptgen — text-to-image via fal openai/gpt-image-2 (OpenAI's model, strong clean shading).
import * as fal from "@fal-ai/serverless-client";
import { writeFileSync } from "node:fs";
if(!process.env.FAL_KEY){console.error("FAL_KEY not set");process.exit(1);}
fal.config({credentials:process.env.FAL_KEY});
const args={};
for(let i=2;i<process.argv.length;i++){const a=process.argv[i];if(a.startsWith("--")){const k=a.slice(2);const v=process.argv[i+1]?.startsWith("--")?"true":process.argv[++i];args[k]=v;}}
const {prompt,out,size="square",quality="high"}=args;
if(!prompt||!out){console.error("usage: gptgen --prompt \"...\" --out x.png [--size square|landscape_4_3|portrait_4_3] [--quality high|medium|low]");process.exit(1);}
async function run(){
  const res=await fal.subscribe("openai/gpt-image-2",{input:{prompt,image_size:size,quality,num_images:1},logs:false});
  const url=res.images?.[0]?.url; if(!url){console.error("no image "+JSON.stringify(res).slice(0,400));process.exit(1);}
  writeFileSync(out, Buffer.from(await (await fetch(url)).arrayBuffer()));
  console.log(`gpt-gen -> ${out}`);
}
run().catch(e=>{console.error("gptgen error:",e?.message||e);process.exit(1);});
