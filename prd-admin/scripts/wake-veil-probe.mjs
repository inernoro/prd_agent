/*
 * 唤醒幕（.wake-veil）的几何探针。
 *
 * 判据三条，全部只看像素，不看代码：
 *   1. t=0    四角必须全等于页面底色 —— 幕真的盖住了，「被点亮」才有起点；
 *   2. t=末   四角必须全等于原图     —— 幕真的退干净了，没有残留的暗角；
 *   3. t=中途 至少一角亮、一角暗     —— 确实有一条推进的前沿，不是整体淡入。
 *
 * 为什么必须靠量：translate 的百分比按元素自身算，而这个元素是父级的三倍多，
 * 再叠上 135deg 的斜向投影，手推必错。第一版就是这么写歪的——inset:-55% 配
 * translate:±55%，实际位移是父级的 115%，幕直接滑出画面，t=0 就漏了大半张图。
 *
 * 用法：node scripts/wake-veil-probe.mjs
 * 改 globals.css 里 .wake-veil 的 inset / translate / 渐变停靠点之后必须重跑。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 路径一律从本文件的位置推出来，不写死绝对路径——写死的话换一个 clone 或到 CI 上
// 就是 ERR_MODULE_NOT_FOUND，等于提交了一个只在作者机器上跑得起来的脚本
//（Codex PR #1476 P2）。本文件在 prd-admin/scripts/，Playwright 装在仓库根的 e2e/ 下。
const admin = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const { chromium } = await import(
  new URL('../../e2e/node_modules/@playwright/test/index.mjs', import.meta.url).href);
const tokens=readFileSync(`${admin}/src/styles/tokens.css`,'utf8');
const photo='data:image/webp;base64,'+readFileSync(`${admin}/src/assets/backdrops/contour.webp`).toString('base64');
const CONFIGS=[
  { inset:'-55%', from:-55, to:55,  stops:'transparent 0%, transparent 39%, var(--wake-beam-soft) 44%, var(--wake-beam-core) 47%, var(--bg-base) 54%, var(--bg-base) 100%' },
  { inset:'-100%', from:-34, to:34, stops:'transparent 0%, transparent 40%, var(--wake-beam-soft) 45%, var(--wake-beam-core) 47%, var(--bg-base) 52%, var(--bg-base) 100%' },
  { inset:'-120%', from:-30, to:30, stops:'transparent 0%, transparent 42%, var(--wake-beam-soft) 46%, var(--wake-beam-core) 48%, var(--bg-base) 53%, var(--bg-base) 100%' },
];
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const p=await(await b.newContext({viewport:{width:1520,height:760},deviceScaleFactor:1})).newPage();
const CORN=[['左上',12,12],['右上',1508,12],['左下',12,748],['右下',1508,748]];
for(const [i,c] of CONFIGS.entries()){
  await p.setContent(`<!doctype html><html><meta charset="utf-8"><style>${tokens}
html,body{margin:0;background:var(--bg-base)}
.stage{position:relative;width:1520px;height:760px;overflow:hidden}
.ph{position:absolute;inset:0;background-image:url('${photo}');background-size:cover;background-position:50% 50%}
.veil{position:absolute;inset:${c.inset};background:linear-gradient(135deg, ${c.stops});
  transform:translate3d(${c.from}%,${c.from}%,0);
  animation:go 1900ms linear forwards}
@keyframes go{from{transform:translate3d(${c.from}%,${c.from}%,0)}to{transform:translate3d(${c.to}%,${c.to}%,0)}}
</style><div class="stage"><div class="ph"></div><div class="veil"></div></div>`);
  const out=[];
  for(const t of [0,950,1899]){
    await p.evaluate((t)=>{document.getAnimations().forEach(a=>{a.pause();a.currentTime=t;});},t);
    await p.waitForTimeout(50);
    const buf=await p.locator('.stage').screenshot();
    const px=await p.evaluate(async({b64,CORN})=>{
      const load=(d)=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src='data:image/png;base64,'+d;});
      const im=await load(b64); const cv=document.createElement('canvas');
      cv.width=im.width;cv.height=im.height;const g=cv.getContext('2d');g.drawImage(im,0,0);
      return CORN.map(([n,x,y])=>{const d=g.getImageData(x,y,1,1).data;
        return [n, Math.round(0.2126*d[0]+0.7152*d[1]+0.0722*d[2])];});
    },{b64:buf.toString('base64'),CORN});
    out.push([t,px]);
  }
  console.log(`\n配置 ${i+1}  inset ${c.inset}  translate ${c.from}% → ${c.to}%`);
  for(const [t,px] of out) console.log('  t='+String(t).padStart(4), px.map(([n,l])=>`${n} ${String(l).padStart(3)}`).join('  '));
}
await b.close();
