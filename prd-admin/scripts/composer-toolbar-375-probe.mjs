/*
 * 视觉创作首页输入框底部工具行，在 375px 上的**像素**探针。
 *
 * 类名对不对不算数——能不能滚、五个控件够不够得到才算。判据只看几何：
 *   1. scrollWidth > clientWidth  —— 是滚出去，不是被压扁；
 *   2. 把行滚到底之后，五个控件的可见宽度都 > 0 —— 都够得到。
 *
 * 为什么要量：放不下有两种结局，看代码分不出来。before 那一档里
 * 「开始生成」被挤成 6px 的一条缝——它在组外的 flex 里，没有 shrink-0
 * 就先被压，压到只剩边框，用户点不到、也看不出那是个按钮。
 *
 * 这是组件级探针，不是登录后的真页面（那需要部署环境注入的管理员凭据）。
 * 用法：node scripts/composer-toolbar-375-probe.mjs   （OUT_DIR 指定截图目录）
 *
 * 附一条环境经验：本仓库的沙箱里 Chromium 走 agent 代理时，TLS 1.3 的
 * ClientHello 会被中继打断（表现为 ERR_CONNECTION_RESET，连 example.com
 * 都连不上）。要打真实站点时给 launch 加 args:['--ssl-version-max=tls1.2']，
 * 证书校验照常开着。本探针只用 setContent，不需要它。
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
const OUT=process.env.OUT_DIR || '/tmp';
const CTRL="display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 9px;border-radius:7px;border:0;background:transparent;color:var(--text-secondary);font-size:10px;white-space:nowrap;";
const row = (groupExtra, childExtra) => `
<div style="width:375px;overflow:hidden;background:var(--bg-base)">
 <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:58px;padding:9px 10px 9px 13px;border-top:1px solid var(--border-faint)">
  <div id="grp" style="display:flex;align-items:center;gap:3px;${groupExtra}">
   <button id="c1" style="${CTRL}${childExtra}">[img] 参考图</button>
   <span id="c2" style="display:inline-flex;${childExtra}"><button style="${CTRL}">[sp] Nano Banana Pro &#9662;</button></span>
   <span id="c3" style="display:inline-flex;${childExtra}"><button style="${CTRL}">[rc] 1K &#183; 1:1 &#9662;</button></span>
   <button id="c4" style="${CTRL}${childExtra}">[bug] 反馈</button>
  </div>
  <button id="c5" style="display:inline-flex;align-items:center;gap:7px;min-height:40px;padding:0 16px;border-radius:7px;border:0;font-size:11px;white-space:nowrap;${childExtra}">开始生成</button>
 </div>
</div>`;
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const p=await (await b.newContext({viewport:{width:375,height:200},deviceScaleFactor:2})).newPage();
for (const [name, grp, child] of [
  ['before', '', ''],
  ['after',  'min-width:0;flex:1 1 0%;overflow-x:auto;', 'flex-shrink:0;white-space:nowrap;'],
]) {
  await p.setContent(`<!doctype html><html><meta charset="utf-8"><style>${tokens}
html,body{margin:0;background:var(--bg-base);font-family:system-ui}
::-webkit-scrollbar{display:none}</style>${row(grp, child)}`);
  // 「够得到」= 存在某个滚动位置让它**完整**露出来。只判 >0 是不够的：
  // before 那一档里「开始生成」剩 6px，判据照样说 true——那正是要抓的 bug
  // （predicate-and-wiring-discipline 形状 1：判据比它该管的范围窄）。
  const m = await p.evaluate(() => {
    const g=document.getElementById('grp');
    const ids=['c1','c2','c3','c4','c5'];
    const shot=()=>ids.map((id)=>{
      const r=document.getElementById(id).getBoundingClientRect();
      const vis=Math.max(0, Math.min(r.right,375)-Math.max(r.left,0));
      return { vis:Math.round(vis), own:Math.round(r.width) };
    });
    g.scrollLeft=0;      const head=shot();
    g.scrollLeft=99999;  const tail=shot();
    return { scrollW:g.scrollWidth, clientW:g.clientWidth, head, tail };
  });
  const scrollable = m.scrollW > m.clientW;
  const full = m.head.map((h,i)=>
    (h.own>0 && h.vis>=h.own-1) || (m.tail[i].own>0 && m.tail[i].vis>=m.tail[i].own-1));
  const reachable = full.every(Boolean);
  console.log(name.padEnd(6), 'scrollW', m.scrollW, 'clientW', m.clientW,
    '| 可横滚', scrollable,
    '| 滚到底后可见宽/自身宽', m.tail.map((t)=>`${t.vis}/${t.own}`).join(' '),
    '| 五个都能完整露出', reachable);
  await p.screenshot({path:`${OUT}/toolbar-375-${name}.png`});
}
await b.close();
