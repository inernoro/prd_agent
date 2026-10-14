/** Local fixture QA: no real model calls; artificial latency exists only in this script. */
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const out=process.env.CDS_MOTION_EVIDENCE || '/tmp/cds-generation-motion';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
let delay=1000,fail=false;const errors=[],unknown=new Set();
const context=await browser.newContext({viewport:{width:1360,height:900}});
await context.addInitScript(()=>{Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>8});Object.defineProperty(navigator,'deviceMemory',{get:()=>8});});
await context.route('**/api/**',async route=>{
 const pathname=new URL(route.request().url()).pathname.replace(/^\/_cds/,'');
 if(isEventStream(pathname))return route.fulfill({contentType:'text/event-stream',body:': fixture\n\n'});
 if(pathname==='/api/projects'||pathname==='/api/projects/fixture-project')await new Promise(r=>setTimeout(r,delay));
 if(fail&&pathname==='/api/projects')return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'fixture: 请求失败，可刷新重试'})});
 const body=resolveFixture(pathname);if(body===null)unknown.add(pathname);
 await route.fulfill({contentType:'application/json',body:JSON.stringify(body??{})});
});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
const base=process.argv[2] || 'http://127.0.0.1:8858';
if (!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(base)) throw new Error('Fixture smoke only runs against an explicit local server');
await page.goto(base+'/project-list');
await page.waitForSelector('[data-generation-boundary]');
await page.waitForSelector('.t-gen',{timeout:5000});
await page.waitForTimeout(450);
assert.equal(await page.locator('.t-gen').count(),2);
await page.screenshot({path:out+'/projects-light-building.png'});
await page.waitForFunction(()=>document.querySelector('[data-generation-boundary]')&&!document.querySelector('[aria-label="加载项目列表"]'));
await page.waitForTimeout(250);assert.equal(await page.locator('.t-gen').count(),0);
assert.equal(await page.locator('[data-generation-boundary] article').count(),1);
await page.screenshot({path:out+'/projects-light-ready.png'});
await page.getByRole('button',{name:'刷新项目列表',exact:true}).click();
await page.waitForTimeout(200);assert.equal(await page.locator('.t-gen').count(),0);assert.equal(await page.locator('[data-generation-boundary] article').count(),1);
console.log('PASS slow projects -> real cards; existing-data refresh retains content');
// Navigate through actual project card.
await page.locator('[data-generation-boundary] article a[href="/branches/fixture-project"]').first().click();
await page.waitForSelector('.t-gen');await page.waitForTimeout(400);
await page.screenshot({path:out+'/branches-light-building.png'});
await page.waitForSelector('[data-branch-card-id]');await page.waitForTimeout(300);assert.equal(await page.locator('.t-gen').count(),0);
await page.screenshot({path:out+'/branches-light-ready.png'});
console.log('PASS project card -> branch list -> real branch data');
// Theme and mobile.
await page.getByRole('button',{name:'切换到黑天主题',exact:true}).click();
await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
await page.goto(base+'/project-list');await page.waitForSelector('.t-gen');await page.waitForTimeout(400);await page.screenshot({path:out+'/projects-dark-building.png'});await page.waitForTimeout(900);
await page.setViewportSize({width:390,height:844});await page.reload();await page.waitForSelector('.t-gen');await page.waitForTimeout(350);
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:out+'/projects-dark-mobile-building.png'});
await page.waitForTimeout(1200);assert.equal(await page.locator('.t-gen').count(),0);
console.log('PASS dark/light and 390px without horizontal overflow');
// Reduced motion.
await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await page.waitForTimeout(450);assert.equal(await page.locator('.t-gen').count(),0);await page.waitForTimeout(1400);
console.log('PASS reduced motion uses skeleton');
// Rapid switch and cancellation on scroll/resize.
await page.emulateMedia({reducedMotion:'no-preference'});await page.setViewportSize({width:1360,height:900});delay=1800;
await page.reload();await page.waitForSelector('.t-gen');await page.evaluate(()=>window.dispatchEvent(new Event('resize')));assert.equal(await page.locator('.t-gen').count(),0);
await page.goto(base+'/branches/fixture-project');await page.waitForSelector('.t-gen');await page.goto(base+'/project-list');await page.waitForTimeout(50);assert.equal(await page.locator('.t-gen').count(),0);await page.waitForTimeout(2200);assert.equal(await page.locator('.t-gen').count(),0);
console.log('PASS resize/rapid switch/reopen clean up body overlays');
// Slow server status + error.
delay=7200;await page.reload();await page.getByText('正在等待服务器返回列表数据。').waitFor({timeout:9000});assert(await page.getByRole('button',{name:'重新加载',exact:true}).isVisible());await page.waitForTimeout(1500);
fail=true;delay=600;await page.reload();await page.getByText(/fixture: 请求失败/).waitFor({timeout:10000});assert.equal(await page.locator('.t-gen').count(),0);await page.screenshot({path:out+'/projects-error.png'});
fail=false;delay=10;await page.getByRole('button',{name:'刷新项目列表',exact:true}).click();await page.waitForTimeout(900);assert.equal(await page.locator('.t-gen').count(),0);assert.equal(await page.locator('[data-generation-boundary] article').count(),1);
console.log('PASS long wait status; failed response; retry; fast response');
assert.deepEqual(errors,[]);console.log('PAGE_ERRORS',errors,'UNREGISTERED_FIXTURES',[...unknown]);
await browser.close();
