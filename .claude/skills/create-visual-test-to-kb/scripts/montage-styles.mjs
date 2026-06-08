import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');
const fs=require('fs');
const b64=(p)=>'data:image/png;base64,'+fs.readFileSync(p).toString('base64');
const styles=[['dark-glass','深色玻璃'],['corporate-blue','商务蓝'],['light-clean','浅色简洁']];
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
const html=`<html><head><meta charset=utf8><style>
body{margin:0;background:#0b0f1c;font-family:'PingFang SC','Microsoft YaHei',system-ui;color:#eef2ff;padding:26px;}
h1{font-size:24px;margin:0 0 4px;font-weight:800;}.sub{color:#9aa6c4;margin:0 0 18px;font-size:14px;}
.row{display:flex;flex-direction:column;gap:16px;}
.cell{position:relative;}.cell img{width:100%;border-radius:10px;border:1px solid rgba(255,255,255,.12);display:block;}
.n{position:absolute;top:10px;left:10px;background:rgba(0,0,0,.6);color:#fff;font-size:13px;font-weight:700;padding:4px 12px;border-radius:7px;}
</style></head><body>
<h1>MD 转网页 PPT · 同一份内容 × 3 套风格模板（用户直接选）</h1>
<p class="sub">证明风格模板真的生效——配色/底色/气质各不相同，连浅色模板的深字也正常</p>
<div class="row">
${styles.map(([v,l])=>`<div class="cell"><span class="n">${l}（${v}）</span><img src="${b64('/tmp/styles/'+v+'.png')}"></div>`).join('')}
</div></body></html>`;
const p=await (await b.newContext({viewport:{width:1100,height:1400}})).newPage();
await p.setContent(html,{waitUntil:'load'});await p.waitForTimeout(700);
await p.screenshot({path:'/tmp/styles-montage.png',fullPage:true});
console.log('montage done');await b.close();
