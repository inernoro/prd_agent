// 本地固定样本浏览器回归。先在 prd-admin 启动 pnpm dev；真实服务验收另行执行。
// REPORT_TEST_URL / REPORT_SCREENSHOT_DIR / CHROMIUM_PATH 可指定服务、证据目录与浏览器。
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
let playwright;
for (const candidate of [process.env.PWPATH, 'playwright', '../../cds/node_modules/playwright'].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch { /* 尝试仓库已有浏览器依赖 */ }
}
if (!playwright) throw new Error('请安装 cds 浏览器测试依赖，或通过 PWPATH 指定 Playwright。');
const { chromium } = playwright;
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
const out = process.env.REPORT_SCREENSHOT_DIR || path.join(os.tmpdir(), 'admin-report-reading-regression');
const baseUrl = (process.env.REPORT_TEST_URL || 'http://localhost:8000').replace(/\/$/, '');
await fs.mkdir(out, { recursive: true });
const longUrl = 'https://example.com/reports/' + 'long-path-'.repeat(20) + '?source=llmgw';
const content = '# 日报、周报、月度总结和验收报告：长标题与宽内容固定样本完整阅读验证\n\n' +
'| 项目 | 环境 | 负责人 | 指标 | 诊断结论 | 完整恢复方式 |\n| --- | --- | --- | --- | --- | --- |\n| CDS | 测试 | 作者甲 | 123.45 | 全部正文保留 | 重新加载后继续 |\n| LLMGW | 诊断 | 作者乙 | 678.90 | 最后一个单元格 | 返回报告入口 |\n\n' +
'```typescript\nconst url = "' + longUrl + '";\nconsole.log(url);\n```\n\n' +
'```mermaid\nflowchart LR\n  A[自动生成] --> B[站内完整阅读]\n  B --> C[分享阅读]\n  C --> D[手机返回]\n```\n\n' +
'```mermaid\ntimeline\n  title 诊断时间线\n  2026-11-12 : 开始诊断 : 阅读完整\n```\n\n' +
'[' + longUrl + '](' + longUrl + ')\n\n![成功图片](https://example.com/evidence.svg)\n\n![缺失图片](https://example.com/missing.png)\n\n' +
'```mermaid\nflowchart LR\n  invalid {{{\n```\n\n' +
Array.from({length:12},(_,i)=>'## 正文章节 '+(i+1)+'\n\n完整段落：报告没有删除内容，也没有截断表格。诊断结论与下一步始终保留。').join('\n\n') + '\n\nREPORT-END-完整文末';
const data = { team:{id:'fixed',name:'CDS 与 LLMGW 报告完整性固定样本',leaderName:'测试作者'},weekYear:2026,weekNumber:46,periodStart:'2026-11-09',periodEnd:'2026-11-15',stats:{totalMembers:1,submittedCount:1,pendingCount:0},items:[{reportId:'fixed',userId:'test',userName:'固定样本作者',status:'submitted',sections:[{title:'完整报告',items:[{content,source:'manual'}]},{title:'结构化宽表及历史额外列',templateSection:{title:'结构表',inputType:'table',tableColumns:['项目','结论'],isRequired:false,sortOrder:0},items:[{content:'镜像',source:'manual',cells:['CDS','通过','额外列内容始终保留']}]},{title:'独立证据图片',items:[{content:'附件完整性',source:'manual',imageUrls:['https://example.com/evidence.svg']}]}],weekYear:2026,weekNumber:46}],summary:null,shareInfo:{createdBy:'test',createdByName:'测试作者',createdAt:'2026-11-12',isTeamMember:true}};
const browser = await chromium.launch({...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),headless:true,args:['--no-sandbox']});
const results=[];
try {
for(const width of [1440,390]) for(const theme of ['light','dark']) {
 const page=await browser.newPage({viewport:{width,height:900},isMobile:width===390,hasTouch:width===390});
 let fail=false;
 await page.route('**/api/report-agent/shares/view/*', route=>route.fulfill({json:fail?{success:false,error:{code:'NETWORK_ERROR',message:'网络请求失败'}}:{success:true,data}}));
 await page.context().route('https://example.com/reports/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>报告外部链接可访问</h1>'}));
 await page.route('https://example.com/evidence.svg',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="900" height="220"><rect width="900" height="220" fill="#3564a6"/><text x="30" y="100" fill="white" font-size="30">Report evidence image</text></svg>'}));
 await page.route('https://example.com/missing.png',route=>route.fulfill({status:404,body:'missing'}));
 await page.goto(`${baseUrl}/scripts/fixtures/report-reading.html`);
 await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
 await page.getByRole('link',{name:'打开固定样本分享报告'}).click();
 await page.getByText('REPORT-END-完整文末').waitFor({state:'attached',timeout:60000});
 await page.locator('.mermaid-render svg').nth(1).waitFor({state:'attached',timeout:60000});
 await page.getByText(/图表渲染失败/).waitFor({state:'attached'});
 assert.equal(await page.locator('td').count(),15);
 assert.ok(await page.getByText('最后一个单元格',{exact:true}).count());
 assert.ok(await page.getByText('额外列内容始终保留',{exact:true}).count());
 assert.equal(await page.locator('.mermaid-render svg').count(),2);
 const widths=await page.evaluate(()=>({viewport:innerWidth,body:document.body.scrollWidth,doc:document.documentElement.scrollWidth}));
 assert.ok(widths.doc<=width+1,JSON.stringify(widths));
 const region=page.getByRole('region',{name:'报告表格，可横向滚动查看全部列'}).first();
 const tableScroll=await region.evaluate(el=>{el.scrollLeft=el.scrollWidth;return{left:el.scrollLeft,width:el.clientWidth,content:el.scrollWidth};});
 if(width===390) assert.ok(tableScroll.left>0,JSON.stringify(tableScroll));
 const external=page.getByRole('link',{name:longUrl});
 assert.equal(await external.getAttribute('href'),longUrl);assert.equal(await external.getAttribute('target'),'_blank');
 const popupEvent=page.waitForEvent('popup'); await external.click(); const popup=await popupEvent; await popup.getByRole('heading',{name:'报告外部链接可访问'}).waitFor(); await popup.close();
 assert.ok(await page.getByText(/图片加载失败：缺失图片/).count());
 await page.getByRole('button',{name:'重新加载图片',exact:true}).click();
 await page.getByText(/图片加载失败：缺失图片/).waitFor({state:'attached'});
 await page.evaluate(()=>{const outline=document.createElement('div');outline.id='test-outline';outline.textContent='固定样本：真实共享渲染组件';Object.assign(outline.style,{position:'fixed',top:'4px',right:'4px',border:'2px solid #c53030',color:'#c53030',background:'Canvas',padding:'4px',zIndex:'20000',fontSize:'12px'});document.body.append(outline);});
 await page.getByRole('region',{name:'报告正文',exact:true}).evaluate(el=>el.scrollTop=0);
 await page.screenshot({path:`${out}/share-${width}-${theme}-top.png`});
 await page.getByText('REPORT-END-完整文末').scrollIntoViewIfNeeded();
 await page.screenshot({path:`${out}/share-${width}-${theme}-end.png`});
 await page.getByRole('button',{name:'返回上一页'}).click();
 assert.ok(await page.getByRole('link',{name:'打开固定样本分享报告'}).isVisible());
 fail=true;await page.getByRole('link',{name:'打开固定样本分享报告'}).click();
 await page.getByText('网络请求失败',{exact:true}).waitFor();
 fail=false;await page.getByRole('button',{name:'重新加载',exact:true}).click();
 await page.getByText('REPORT-END-完整文末').waitFor({state:'attached'});
 results.push({width,theme,pass:true,tableScroll,widths,svgCount:2,checks:['all-content','flowchart','timeline','parse-error-source','image-retry','error-retry','scroll-to-end','back','external-link-target']});
 await page.close();
}
} finally { await browser.close(); }
await fs.writeFile(`${out}/browser-results.json`,JSON.stringify({mode:'local-real-component-with-fixed-api-fixture',results},null,2));
console.log(JSON.stringify(results,null,2));
