/** Offline asset authoring on CI. Acceptance still records the real public page in real time. */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
const out = new URL('../work/entry-portrait/',import.meta.url);
await mkdir(new URL('frames/',out),{recursive:true});
const document = new URL('../llmgw/web/entry-render.html',import.meta.url);
await writeFile(document,`<!doctype html><style>html,body{margin:0;background:black;overflow:hidden}canvas{width:1672px;height:941px;display:block}</style><canvas></canvas><script type="module">
import {createPortraitRenderer,loadPortraitImages} from '/src/components/entry/portraitRenderer.ts';
const canvas=document.querySelector('canvas');const renderer=createPortraitRenderer(canvas,await loadPortraitImages());
if(!renderer)throw new Error('Offline renderer unavailable');window.draw=time=>renderer.draw(time);window.ready=true;
</script>`);
const server=spawn('pnpm',['-C','llmgw/web','exec','vite','--host','127.0.0.1','--port','4173'],{stdio:'inherit'});
let browser;
try {
  for(let n=0;n<100;n++){
    try{if((await fetch('http://127.0.0.1:4173/entry-render.html')).ok)break;}catch{}
    await new Promise(r=>setTimeout(r,200));
  }
  browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
  const page=await browser.newPage({viewport:{width:1672,height:941},deviceScaleFactor:1});
  await page.goto('http://127.0.0.1:4173/entry-render.html');
  await page.waitForFunction(()=>window.ready===true);
  for(let frame=0;frame<=309;frame++){
    await page.evaluate(time=>window.draw(time),frame/60);
    await page.screenshot({path:new URL(`frames/frame-${String(frame).padStart(4,'0')}.png`,out).pathname});
    if(frame%60===0)console.log('Rendered source frame',frame,'of 309');
  }
  const encode=spawn('ffmpeg',['-hide_banner','-y','-framerate','60','-i',new URL('frames/frame-%04d.png',out).pathname,
    '-vf','pad=1672:942:0:0','-c:v','libx264','-preset','slow','-crf','17','-pix_fmt','yuv420p','-movflags','+faststart',
    new URL('portrait-motion.mp4',out).pathname],{stdio:'inherit'});
  const [code]=await once(encode,'close');if(code!==0)throw new Error('Portrait encoding failed');
} finally { await browser?.close();server.kill('SIGTERM'); }
