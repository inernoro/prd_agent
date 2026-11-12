import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const base=process.env.SCALE_BASE_URL||'http://localhost:8010';
if(!['localhost','127.0.0.1'].includes(new URL(base).hostname))throw Error('Only local isolated fixtures are allowed');
await fs.mkdir('work/evidence',{recursive:true});
await fs.rm('work/ui-audit.json',{force:true});
const browser=await chromium.launch({...(process.env.SCALE_CHROME_PATH?{executablePath:process.env.SCALE_CHROME_PATH}:{}),headless:true,args:['--no-sandbox','--disable-gpu']});
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
let page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(base);
await page.getByText('登录 / 注册',{exact:true}).click();
await page.getByPlaceholder('admin',{exact:true}).fill('scale_admin');
await page.locator('input[type=password]').fill('ScaleIsolated2026pass');
await page.getByRole('button',{name:'进入控制台',exact:true}).click();
await page.getByRole('button',{name:'打开用户菜单',exact:true}).waitFor();
const results=[];
async function enter(n){
 const drawer=page.getByRole('button',{name:'打开导航菜单',exact:true});
 if(await drawer.isVisible() && await page.getByText('知识库',{exact:true}).filter({visible:true}).count()===0) await drawer.click();
 await page.getByText('知识库',{exact:true}).filter({visible:true}).first().click();
 await page.getByText(`规模验证 ${n}`,{exact:true}).waitFor();
 await page.waitForTimeout(400);
 const tour=page.getByRole('button',{name:'我已学会',exact:true});if(await tour.isVisible())await tour.click();
 await page.getByText(`规模验证 ${n}`,{exact:true}).click();
 await page.locator('[data-entry-id]').first().waitFor();
 await page.waitForTimeout(900);
}
async function collectVisible(seen){
 const ids=await page.locator('[data-entry-id]').evaluateAll(els=>els.map(e=>e.getAttribute('data-entry-id')));
 assert.equal(ids.length,new Set(ids).size,'duplicate rows in current browser view');
 for(const id of ids)seen.add(id);
}
async function next(scope){const button=page.getByRole('button',{name:`${scope}下一页条目`,exact:true});
 if(!await button.count()||await button.isDisabled())return false;
 await button.click();await page.waitForTimeout(40);return true;
}
async function exhaustBrowse(n){
 const seen=new Set();let pages=0;
 do{
  await collectVisible(seen);pages++;
  for(const f of [0,1,2]){
   const folder=page.locator(`[data-entry-id="scale-${n}-${String(f).padStart(5,'0')}"]`);
   if(!await folder.count())continue;
   const child=page.locator(`[data-entry-id="scale-${n}-${String(f===0?10:f===1?4:5).padStart(5,'0')}"]`);
   if(!await child.count())await folder.click();
   do{await collectVisible(seen);}while(await next(`目录 ${f}`));
  }
 }while(await next('目录'));
 assert.equal(seen.size,n+4,`browse completeness ${n}`);
 return {reachable:seen.size,rootPages:pages};
}
async function search(q){await page.getByPlaceholder('搜索标题或内容…').fill(q);await page.waitForFunction(()=>document.querySelector('input[placeholder="搜索标题或内容…"]')?.getAttribute('aria-busy')==='false');}
for(const mode of ['dark','light']){
 await page.setViewportSize({width:1440,height:1000});
 await page.goto(base);
 await page.getByRole('button',{name:'打开用户菜单',exact:true}).click();
 await page.getByRole('menuitemradio',{name:mode==='dark'?'黑夜':'白天',exact:true}).click();
 await page.keyboard.press('Escape');
 await page.waitForFunction(mode=>(document.documentElement.getAttribute('data-theme')==='light'?'light':'dark')===mode,mode);
 for(const width of [1440,375]){
  await page.setViewportSize({width,height:width===375?812:1000});
  for(const n of [200,1000,5000]){
   await page.close();
   page=await context.newPage();
   page.on('pageerror',e=>errors.push(e.message));
   await page.setViewportSize({width,height:width===375?812:1000});
   await page.goto(base);
   await context.tracing.start({screenshots:false,snapshots:true,sources:false});
   await enter(n);
   const prefix=`work/evidence/final-${mode}-${width}-${n}`;
   await page.screenshot({path:`${prefix}-browse.png`});
   const browse=await exhaustBrowse(n);
   await search('共同关键词');
   const hits=new Set();let pages=0;
   do{await collectVisible(hits);pages++;}while(await next('目录'));
   assert.equal(hits.size,n,`search completeness ${n}`);
   await page.screenshot({path:`${prefix}-search.png`});
   await search(`唯一尾部检索${n+3}`);
   const id=`scale-${n}-${String(n+3).padStart(5,'0')}`;
   await page.locator(`[data-entry-id="${id}"]`).click();
   await page.locator('p').filter({hasText:`唯一尾部检索${n+3}`}).first().waitFor();
   await page.locator('p').filter({hasText:`唯一尾部检索${n+3}`}).first().hover();
   await page.mouse.wheel(0,10000);
   await page.waitForTimeout(150);
   const tailVisible=await page.evaluate(term=>{const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;while((node=w.nextNode())){const at=node.textContent.indexOf(term);if(at<0)continue;const r=document.createRange();r.setStart(node,at);r.setEnd(node,at+term.length);const rect=r.getBoundingClientRect();return rect.top>=40&&rect.bottom<=innerHeight-40;}return false;},`唯一尾部检索${n+3}`);
   assert(tailVisible,'tail keyword must be visible after scrolling');
   await page.screenshot({path:`${prefix}-open.png`});
   const overflow=await page.evaluate(()=>({width:innerWidth,body:document.documentElement.scrollWidth}));
   assert(overflow.body<=overflow.width+1,'horizontal overflow');
   const row={mode,width,n,browse,search:{reachable:hits.size,pages},tailOpened:true,tailVisible,overflow};
   console.log(JSON.stringify(row));results.push(row);
   await context.tracing.stop({path:`${prefix}-trace.zip`});
   await fs.writeFile('work/ui-audit.json',JSON.stringify({results,errors},null,2));
  }
 }
}
assert.deepEqual(errors,[]);
await browser.close();
