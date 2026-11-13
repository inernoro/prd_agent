/** Local browser regression against production report routes and React pages.
 * Run: pnpm --dir cds exec tsx scripts/report-reading-regression.mjs
 * Ancillary console APIs use controlled fixtures; this is not a deployed acceptance claim.
 */
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { createHash } from 'node:crypto';
import { buildWidgetScript } from '../src/widget-script.ts';
import { dockReportWidget, REPORT_WIDGET_DOCK_STYLE } from '../src/shared/report-widget-dock.ts';
import { StateService } from '../src/services/state.ts';
import { createReportsRouter, createPublicReportShareRouter } from '../src/routes/reports.ts';
import { flushAllJsonStateStores } from '../src/infra/state-store/json-backing-store.ts';
const cds = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.REPORT_SCREENSHOT_DIR || path.join(os.tmpdir(), 'cds-report-reading-regression'));
await fs.mkdir(output, { recursive:true });
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-reading-browser-'));
const previousCache = process.env.CDS_CACHE_BASE;
process.env.CDS_CACHE_BASE = path.join(data, 'cache');
const state = new StateService(path.join(data, 'state.json')); state.load();
const originalContent = await fs.readFile(path.join(cds,'tests/fixtures/report-reading.md'),'utf8');
const title='CDS 与 LLMGW 诊断报告固定样本：长标题及完整内容验收';
const app=express(); let failNextRaw=false;
app.get('/api/reports/:id/raw',(_req,res,next)=>{if(!failNextRaw)return next();res.status(503).json({message:'报告服务暂时不可用，请重试'})});
app.get('/api/reports/assets/fixture.svg',(_req,res)=>res.type('image/svg+xml').sendFile(path.join(cds,'tests/fixtures/report-evidence.svg')));
app.use('/api',createReportsRouter({stateService:state}));app.use('/r',createPublicReportShareRouter({stateService:state}));
app.get('/api/auth/status',(_req,res)=>res.json({enabled:false,mode:'disabled',user:{username:'fixture-reader',isSystemOwner:true}}));
app.get('/api/projects',(_req,res)=>res.json({projects:[]}));app.get('/api/branches',(_req,res)=>res.json({branches:[]}));
app.get('/api/*',(_req,res)=>res.json({connections:[],requests:[],items:[],presets:[],profiles:[],projects:[],branches:[],count:0}));
assert((await fs.stat(path.join(cds,'web/dist/index.html'))).isFile(),'Build cds/web before running this regression');
app.get('/report-reading/evidence/',(_req,res)=>res.type('html').send('<!doctype html><h1>固定样本链接目标</h1><p>链接访问成功</p>'));
app.use(express.static(path.join(cds,'web/dist')));app.get('*',(_req,res)=>res.sendFile(path.join(cds,'web/dist/index.html')));
const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
// Bind only the sample link origin to the real local HTTP target for deterministic navigation.
const content=originalContent.replaceAll('https://example.com/',base+'/report-reading/evidence/');
const meta = state.createAcceptanceReport({ title, format:'md', content, projectId:null, branchId:null });
state.enableReportShare(meta.id);
const authored = state.createAcceptanceReport({title:'HTML '+title,format:'html',content:'<!doctype html><html><head><style>body{font-family:system-ui;background:#fffdf8;color:#211d18;margin:0;padding:16px}main{max-width:70rem;margin:auto}</style></head><body><main>'+marked.parse(content)+'<p>AUTHORED-HTML-END</p></main></body></html>',projectId:null,branchId:null});state.enableReportShare(authored.id);
const browser=await chromium.launch({headless:true,proxy:process.env.HTTPS_PROXY?{server:process.env.HTTPS_PROXY,bypass:'localhost,127.0.0.1'}:undefined});const results=[];
try {
for(const format of process.env.REPORT_DOCK_ONLY?[]:['md','html'])for(const mobile of [false,true])for(const theme of ['light','dark']){
 const selectedTitle=format==='md'?title:'HTML '+title;
 const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile,colorScheme:theme});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${base}/`);await page.getByRole('button',{name:'Enter Console',exact:true}).first().click();
 if(mobile)await page.getByRole('button',{name:'打开导航菜单',exact:true}).click();
 const nav=page.getByRole('link',{name:'验收报告',exact:true});await nav.filter({visible:true}).first().click();
 await page.getByText(selectedTitle,{exact:true}).click();
 const frame=page.frameLocator('iframe');await frame.locator('[data-report-diagram] svg').nth(1).waitFor();
 assert.equal(await frame.locator('[data-report-diagram] svg').count(),2);
 assert.equal(await frame.locator('td').count(),16);assert.equal(await frame.getByRole('img',{name:'可用证据图',exact:true}).evaluate(img=>img.naturalWidth),640);
 const inText=await frame.locator('body').innerText();assert(inText.includes('LAST-COLUMN-LLMGW'));assert(inText.includes('REQUEST-CODE-END'));assert(inText.includes('READING-END'));
 const width=await frame.locator('body').evaluate(b=>({document:b.ownerDocument.documentElement.scrollWidth,viewport:b.ownerDocument.documentElement.clientWidth}));assert(width.document<=width.viewport+1,JSON.stringify(width));
 const table=frame.getByRole('region',{name:'完整表格，可左右滚动'});await table.evaluate(e=>e.scrollLeft=e.scrollWidth);assert((await table.evaluate(e=>e.scrollLeft))>0);
 await frame.getByText('跳到末尾',{exact:true}).click();await frame.getByText(/READING-END：/).scrollIntoViewIfNeeded();
 await page.screenshot({path:`${output}/cds-${format}-${mobile?'mobile':'desktop'}-${theme}-end.png`});
 const report=await (await page.request.get(`${base}/api/reports`)).json();const selected=report.reports.find(r=>r.format===format);
 await page.getByRole('button',{name:'返回报告首页',exact:true}).click();await page.getByText('报告台账',{exact:true}).waitFor();
 const share=await context.newPage();await share.goto(`${base}/`);await share.goto(`${base}/r/${selected.shareToken}?theme=${theme}`);
 const shared=share.frameLocator('iframe');await shared.locator('[data-report-diagram] svg').nth(1).waitFor();
 assert.equal(await shared.locator('td').count(),16);assert.equal(await shared.locator('[data-report-diagram] svg').count(),2);
 for(const marker of ['LAST-COLUMN-LLMGW','REQUEST-CODE-END','READING-END'])assert((await shared.locator('body').innerText()).includes(marker));
 await share.screenshot({path:`${output}/share-${format}-${mobile?'mobile':'desktop'}-${theme}-top.png`});
 const link=shared.getByRole('link',{name:/http:\/\/127\.0\.0\.1/});await link.scrollIntoViewIfNeeded();const popupEvent=context.waitForEvent('page');await link.click();const popup=await popupEvent;await popup.waitForLoadState('domcontentloaded');await popup.getByRole('heading',{name:'固定样本链接目标',exact:true}).waitFor();assert(popup.url().startsWith(base+'/report-reading/evidence'));await popup.close();
 const broken=shared.locator('.report-recovery').filter({hasText:'缺失截图应说明原因'});await broken.getByRole('button',{name:'重新加载图片',exact:true}).click();await broken.waitFor();
 await shared.getByRole('button',{name:'重新渲染图表',exact:true}).click();await shared.getByText(/图表未能渲染/).waitFor();
 await shared.getByText(/READING-END：/).scrollIntoViewIfNeeded();await share.screenshot({path:`${output}/share-${format}-${mobile?'mobile':'desktop'}-${theme}-end.png`});
 // Theme changes must replace the current entry, so Back returns to the actual origin page.
 await share.getByRole('link',{name:theme==='dark'?'浅色主题':'深色主题',exact:true}).click();
 await share.frameLocator('iframe').locator('[data-report-diagram] svg').nth(1).waitFor();
 await share.getByRole('button',{name:'返回',exact:true}).click();await share.waitForURL(base+'/');
 assert.deepEqual(errors,[]);results.push({format,mobile,theme,width,svg:2,cells:16,return:true,link:true,imageRetry:true,diagramRetry:true,errors});await context.close();
}

 // Parent preview widgets may be older than this branch. Exercise the actual IIFE when supplied.
 const widgetScript=process.env.REPORT_WIDGET_SCRIPT ? await fs.readFile(process.env.REPORT_WIDGET_SCRIPT,'utf8')
   : buildWidgetScript('report-widget-fixture','fixture/report','a'.repeat(40)).replace(/^\s*<script data-cds-widget>/,'').replace(/<\/script>\s*$/,'');
 const widgetBranch=/var BRANCH_ID='([^']+)'/.exec(widgetScript)?.[1];
 assert(widgetBranch,'Widget fixture must use a real production IIFE');
 for(const host of ['station','share'])for(const withWidget of [false,true]){
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  if(withWidget){
   await context.route('**/_cds/api/**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(route.request().url().endsWith('/branches')
     ?{tabTitleEnabled:false,branches:[{id:widgetBranch,status:'running',runningCommitSha:'a'.repeat(40),tags:[]}]}
     :{profiles:[]})}));
   await context.addInitScript({content:`if(window===window.top){window.EventSource=class extends EventTarget{close(){}};addEventListener('DOMContentLoaded',()=>{${widgetScript}\n},{once:true});}`});
  }
  const page=await context.newPage();await page.goto(base+'/');
  let originalWidget;
  if(host==='station'){
   await page.getByRole('button',{name:'Enter Console',exact:true}).first().click();
   await page.getByRole('button',{name:'打开导航菜单',exact:true}).click();
   await page.getByRole('link',{name:'验收报告',exact:true}).filter({visible:true}).first().click();
   if(withWidget)originalWidget=await page.locator('#cds-widget').evaluate(el=>({style:el.getAttribute('style'),placement:el.getAttribute('data-cds-placement')}));
   await page.getByText(title,{exact:true}).click();
  }else await page.goto(`${base}/r/${state.getAcceptanceReport(meta.id).shareToken}`);
  const frame=page.frameLocator('iframe');await frame.locator('[data-report-diagram] svg').nth(1).waitFor();
  assert.equal(await frame.locator('#cds-widget').count(),0,'父实例注入只存在于宿主页，不能把测试入口注入正文iframe');
  const slot=page.locator('[data-report-widget-slot]');
  if(withWidget)await slot.locator('#cds-widget').waitFor();else assert.equal(await slot.evaluate(el=>getComputedStyle(el).display),'none');
  await frame.getByText(/READING-END：/).scrollIntoViewIfNeeded();
  const terminal=await frame.getByText(/READING-END：/).boundingBox();
  let docked,expanded,closed;
  if(withWidget){
   docked=await slot.locator('#cds-widget').boundingBox();
   const reader=await page.locator('iframe').boundingBox();
   assert(!(docked.x<reader.x+reader.width&&docked.x+docked.width>reader.x&&docked.y<reader.y+reader.height&&docked.y+docked.height>reader.y),'默认入口不能覆盖正文iframe的任何区域');
   assert(!(docked.x<terminal.x+terminal.width&&docked.x+docked.width>terminal.x&&docked.y<terminal.y+terminal.height&&docked.y+docked.height>terminal.y),'停靠入口不能覆盖报告终点');
   assert.equal(await slot.locator('#cds-widget').evaluate(el=>getComputedStyle(el).position),'relative');
   const target=await slot.locator('#cds-widget button').first().boundingBox();assert(target.width>=44&&target.height>=44);
   await page.screenshot({path:`${output}/dock-${host}-mobile-end.png`});
   const compact=page.locator('#cds-widget [data-action="expand-compact"]');
   if(await compact.count())await compact.click();
   if(!await page.locator('#cds-widget .cds-panel').count())await page.locator('#cds-widget [data-action="toggle"]').click();
   await page.locator('#cds-widget .cds-panel').waitFor();
   assert.equal(await page.locator('#cds-widget').evaluate(el=>getComputedStyle(el).position),'fixed');
   expanded=await page.locator('#cds-widget').boundingBox();const close=await page.locator('#cds-widget [data-action="close-panel"]').boundingBox();
   assert(close.width>=44&&close.height>=44&&close.x>=0&&close.y>=0&&close.x+close.width<=390&&close.y+close.height<=844);
   await page.screenshot({path:`${output}/dock-${host}-mobile-expanded.png`});
   await page.locator('#cds-widget [data-action="close-panel"]').click();
   await page.waitForFunction(()=>getComputedStyle(document.querySelector('#cds-widget')).position==='relative');
   closed=await slot.locator('#cds-widget').boundingBox();
   const restoredReader=await page.locator('iframe').boundingBox();
   assert(closed.y+closed.height<=restoredReader.y,'关闭诊断面板后入口重新停靠正文上方');
  }
  if(host==='station'){
   await page.getByRole('button',{name:'返回报告首页',exact:true}).click();await page.getByText('报告台账',{exact:true}).waitFor();
   if(withWidget){
    assert.equal(await page.locator('#cds-widget').evaluate(el=>el.parentElement===document.body),true);
    assert.equal(await page.locator('#cds-widget').evaluate(el=>getComputedStyle(el).position),'fixed');
    await page.getByText(title,{exact:true}).click();await page.locator('[data-report-widget-slot]>#cds-widget').waitFor();
    const compact=page.locator('#cds-widget [data-action="expand-compact"]');if(await compact.count())await compact.click();
    if(!await page.locator('#cds-widget .cds-panel').count())await page.locator('#cds-widget [data-action="toggle"]').click();
    await page.locator('#cds-widget [data-action="dismiss"]').click();
    await page.getByRole('button',{name:'返回报告首页',exact:true}).click();await page.getByText('报告台账',{exact:true}).waitFor();
    assert.equal(await page.locator('#cds-widget').count(),0,'用户主动关闭的入口不能被cleanup复活');
   }
  }else{await page.getByRole('button',{name:'返回',exact:true}).click();await page.waitForURL(base+'/');}
  results.push({widgetDock:{host,withWidget,terminal,docked,expanded,closed,originalWidget,returned:true,widgetScriptSha256:createHash('sha256').update(widgetScript).digest('hex')}});
  await context.close();
 }

 // Freeze the dock lifecycle independently of the running widget's own resize/avoidance timers.
 const lifecycle=await browser.newPage({viewport:{width:390,height:844}});
 await lifecycle.setContent(`<!doctype html><style>${REPORT_WIDGET_DOCK_STYLE}</style><div id="origin"><span id="before"></span><div id="cds-widget" data-cds-placement="clear" style="position:fixed;left:33px;bottom:42px;width:44px;height:44px"></div><span id="after"></span></div><div data-report-widget-slot></div>`);
 await lifecycle.addScriptTag({content:`window.mountReportDock=(${dockReportWidget.toString()});`});
 const restored=await lifecycle.evaluate(()=>{
  const slot=document.querySelector('[data-report-widget-slot]'),widget=document.querySelector('#cds-widget');
  const original={style:widget.getAttribute('style'),placement:widget.getAttribute('data-cds-placement')};
  const cleanup=window.mountReportDock(slot);const mounted=widget.parentNode===slot;
  widget.style.left='999px';widget.setAttribute('data-cds-placement','blocked');slot.remove();cleanup();
  return {mounted,original,restored:{style:widget.getAttribute('style'),placement:widget.getAttribute('data-cds-placement')},order:[...document.querySelector('#origin').children].map(el=>el.id),markers:[...document.querySelector('#origin').childNodes].filter(node=>node.nodeType===8).length};
 });
 assert.equal(restored.mounted,true);assert.deepEqual(restored.restored,restored.original);assert.deepEqual(restored.order,['before','cds-widget','after']);assert.equal(restored.markers,0);
 const dismissed=await lifecycle.evaluate(()=>{
  const slot=document.createElement('div');slot.setAttribute('data-report-widget-slot','');document.body.append(slot);
  const cleanup=window.mountReportDock(slot);document.querySelector('#cds-widget').remove();cleanup();return !document.querySelector('#cds-widget');
 });assert.equal(dismissed,true);
 results.push({widgetDockLifecycle:{detachedSlotRestoresNode:true,inlineStyleAndPlacementRestored:true,siblingOrderRestored:true,dismissedNotRevived:true}});await lifecycle.close();

 if(!process.env.REPORT_DOCK_ONLY){
 const context=await browser.newContext();const page=await context.newPage();
 await page.goto(base+'/');await page.getByRole('button',{name:'Enter Console',exact:true}).first().click();await page.getByRole('link',{name:'验收报告',exact:true}).filter({visible:true}).first().click();
 failNextRaw=true;await page.getByText(title,{exact:true}).click();await page.getByRole('button',{name:'重新加载报告',exact:true}).waitFor();failNextRaw=false;await page.getByRole('button',{name:'重新加载报告',exact:true}).click();await page.frameLocator('iframe').locator('[data-report-diagram] svg').nth(1).waitFor();
 const shared=state.listAcceptanceReports(null).find(report=>report.format==='md');
 let block=true;await context.route('**/report-assets/mermaid.min.js',route=>block?route.abort():route.continue());
 await page.goto(`${base}/r/${shared.shareToken}`);const frame=page.frameLocator('iframe');await frame.getByText(/图表未能渲染/).first().waitFor();block=false;
 await frame.getByRole('button',{name:'重新渲染图表',exact:true}).first().click();await frame.locator('[data-report-diagram] svg').first().waitFor();
 await page.screenshot({path:path.join(output,'diagram-load-recovery.png')});
 const missing=await context.newPage();await missing.goto(base+'/r/invalid-token');await missing.getByRole('button',{name:'重新加载',exact:true}).waitFor();assert((await missing.frameLocator('iframe').locator('body').innerText()).includes('链接不存在或已失效'));
 results.push({failureRecovery:{rawLoad:true,diagramLibraryLoad:true,revokedShare:true}});await context.close();
 }
 await fs.writeFile(path.join(output,'browser-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
} finally {
 await browser.close();await new Promise(resolve=>server.close(resolve));await flushAllJsonStateStores();await fs.rm(data,{recursive:true,force:true});
 if(previousCache===undefined)delete process.env.CDS_CACHE_BASE;else process.env.CDS_CACHE_BASE=previousCache;
}
