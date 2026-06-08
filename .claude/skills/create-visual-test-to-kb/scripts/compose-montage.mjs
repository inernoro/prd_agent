import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');
const fs=require('fs');
const b64=(p)=>{try{return 'data:image/png;base64,'+fs.readFileSync(p).toString('base64');}catch(e){return '';}};
const imgs=[1,2,3,4].map(i=>b64('/tmp/kbacc/slide'+i+'.png'));
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
const html=`<html><head><meta charset=utf8><style>
body{margin:0;background:#0b0f1c;font-family:'PingFang SC','Microsoft YaHei',system-ui;color:#eef2ff;padding:26px;}
h1{font-size:24px;margin:0 0 4px;font-weight:800;}.sub{color:#9aa6c4;margin:0 0 20px;font-size:14px;}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;}
.cell{position:relative;}.cell img{width:100%;border-radius:10px;border:1px solid rgba(255,255,255,.1);display:block;}
.n{position:absolute;top:8px;left:8px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;font-weight:700;padding:3px 9px;border-radius:6px;}
</style></head><body>
<h1>MD 转网页 PPT · 用真实知识库文章生成（日报-2026-06-08，8 页）</h1>
<p class="sub">同一份真实文章，连续 4 页效果（封面 + 3 张内容页），翻页按钮实测可用</p>
<div class="grid">
${imgs.map((s,i)=>`<div class="cell"><span class="n">第 ${i+1} 页</span><img src="${s}"></div>`).join('')}
</div></body></html>`;
const p=await (await b.newContext({viewport:{width:1280,height:980}})).newPage();
await p.setContent(html,{waitUntil:'load'});await p.waitForTimeout(700);
await p.screenshot({path:'/tmp/kb-montage.png',fullPage:true});
console.log('montage done', imgs.filter(Boolean).length,'slides');
await b.close();
