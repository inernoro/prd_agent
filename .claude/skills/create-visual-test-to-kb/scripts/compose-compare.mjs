import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');
const fs=require('fs');
const b=await chromium.launch({headless:true,args:['--no-sandbox']});
const b64=(p)=>{try{return 'data:image/png;base64,'+fs.readFileSync(p).toString('base64');}catch(e){return '';}};
const before=b64('/tmp/acc_mdppt4/06-result-html-ppt.png'); // blank/orbs only
const after=b64('/tmp/acc_mdppt6/06-result-html-ppt.png');  // fixed cover
const html=`<html><head><meta charset=utf8><style>
body{margin:0;background:#0b0f1c;font-family:'PingFang SC','Microsoft YaHei',system-ui;color:#eef2ff;padding:28px;}
h1{font-size:26px;margin:0 0 6px;font-weight:800;} .sub{color:#9aa6c4;margin:0 0 22px;font-size:14px;}
.row{display:flex;gap:22px;} .col{flex:1;}
.tag{display:inline-block;padding:5px 12px;border-radius:999px;font-size:13px;font-weight:700;margin-bottom:10px;}
.bad{background:#3b1d1d;color:#ff8a8a;border:1px solid #5a2a2a;} .good{background:#15301f;color:#7ee2a8;border:1px solid #2a5a3c;}
img{width:100%;border-radius:12px;border:1px solid rgba(255,255,255,.1);display:block;}
.cap{color:#9aa6c4;font-size:13px;margin-top:10px;line-height:1.5;}
</style></head><body>
<h1>MD 转网页 PPT · 修复前 / 修复后对比</h1>
<p class="sub">同一份内容、同一个引擎，预览渲染效果对照</p>
<div class="row">
 <div class="col"><span class="tag bad">修复前（坏）</span><img src="${before}"><div class="cap">整页空白、只剩背景光晕——正文被装饰光晕的布局 bug 挤出可视区（标题 y=800，视口 720）。用户看到的就是『不像 PPT』。</div></div>
 <div class="col"><span class="tag good">修复后（好）</span><img src="${after}"><div class="cap">封面正常：KEYNOTE PRESENTATION 小标签 + 大标题 + 副标题 + 标签 chip + 背景光晕。深色 Keynote 风。</div></div>
</div></body></html>`;
const p=await (await b.newContext({viewport:{width:1500,height:760}})).newPage();
await p.setContent(html,{waitUntil:'load'});await p.waitForTimeout(800);
await p.screenshot({path:'/tmp/compare-before-after.png'});
console.log('composed', before?'before-ok':'before-MISSING', after?'after-ok':'after-MISSING');
await b.close();
