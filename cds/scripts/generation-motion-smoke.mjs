/** Local fixture QA: no real model calls; artificial latency exists only in this script. */
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const out=process.env.CDS_MOTION_EVIDENCE || '/tmp/cds-generation-motion';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true});
let delay=1800,fail=false,member=false,chunkDelay=1200;const errors=[],unknown=new Set();
const context=await browser.newContext({viewport:{width:1360,height:900}});
await context.addInitScript(()=>{
 Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>location.search.includes('fixture-low-perf')?2:8});Object.defineProperty(navigator,'deviceMemory',{get:()=>location.search.includes('fixture-low-perf')?2:8});
 window.__motionTrace=[];
 const sample=()=>{
  const card=document.querySelector('article a[href^="/branches/"]')?.closest('article')||document.querySelector('[data-branch-card-id]');
  const ids=[...document.querySelectorAll('.t-gen')].map(el=>el.dataset.generationRun);
  const pending=document.querySelector('[aria-busy="true"] article');
  const rect=el=>{if(!el)return null;const r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height];};
  if(window.__motionTrace.length<3000)window.__motionTrace.push({ready:!!card,ids,opacity:card?.style.opacity??'',clip:card?.style.clipPath??'',pending:!!pending,rect:rect(card||pending),layer:rect(document.querySelector('.t-gen'))});
  requestAnimationFrame(sample);
 };
 requestAnimationFrame(sample);
});
// The first route chunk is deliberately slow: its overlay must survive into data loading.
await context.route(/\/assets\/ProjectListPage-[^/]+\.js$/,async route=>{await new Promise(r=>setTimeout(r,chunkDelay));await route.continue();});
await context.route('**/api/**',async route=>{
 const pathname=new URL(route.request().url()).pathname.replace(/^\/_cds/,'');
 if(isEventStream(pathname))return route.fulfill({contentType:'text/event-stream',body:': fixture\n\n'});
 if(pathname==='/api/auth/status')await new Promise(r=>setTimeout(r,900));
 if(pathname==='/api/projects'||pathname==='/api/projects/fixture-project')await new Promise(r=>setTimeout(r,delay));
 if(fail&&pathname==='/api/projects')return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'fixture: 请求失败，可刷新重试'})});
 let body=resolveFixture(pathname);if(body===null)unknown.add(pathname);
 if(member&&pathname==='/api/auth/status')body={...body,user:{...body.user,isSystemOwner:false}};
 if(member&&pathname==='/api/projects')body={...body,canManageProjects:false};
 await route.fulfill({contentType:'application/json',body:JSON.stringify(body??{})});
});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
const geometry=async(selector)=>{
 // Clicking a project can leave the pointer over the first branch card. Measure layout,
 // rather than the intentional hover lift, after its finite transition settles.
 await page.mouse.move(0,0);
 return page.locator(selector).first().evaluate(async el=>{
  await Promise.allSettled(el.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished));
  const rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  return {card:rect(el),header:rect(el.querySelector('header')),footer:rect(el.querySelector('footer'))};
 });
};
const geometryResults=[];
const sameGeometry=(label,before,after)=>{
 for(const part of ['card','header','footer']){
  assert.equal(Boolean(before[part]),Boolean(after[part]),label+' '+part);
  if(before[part])for(const axis of ['x','y','width','height'])assert(Math.abs(before[part][axis]-after[part][axis])<=1,`${label} ${part}.${axis}: ${before[part][axis]} -> ${after[part][axis]}`);
 }
 geometryResults.push({label,before,after});
};
const noReadyOverlay=async()=>{
 const trace=await page.evaluate(()=>window.__motionTrace);
 assert.deepEqual(trace.filter(f=>f.ready&&f.opacity!==''&&Number(f.opacity)<.99&&f.ids.length===0),[],'a hidden real card must always retain its original overlay');
};
const layerIds=()=>page.locator('.t-gen').evaluateAll(es=>es.map(e=>e.dataset.generationRun));
const sameOverlay=async(before,label)=>{
 const after=await layerIds();
 if(!after.length){const trace=await page.evaluate(()=>window.__motionTrace);console.log('HANDOFF_TRACE',JSON.stringify(trace.filter((f,i)=>!i||f.ready!==trace[i-1].ready||f.ids.join()!==trace[i-1].ids.join()).slice(-14)));}
 assert(after.length>0,label+' retains the waiting overlay');
 assert(after.every(id=>before.includes(id)),label+' must not cancel and recreate its overlay');
 const real=page.locator('[data-generation-boundary] article').first();
 assert((await real.evaluate(el=>el.style.clipPath)).startsWith('inset('),label+' starts the native reveal mask');
};
const base=process.argv[2] || 'http://127.0.0.1:8858';
if (!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(base)) throw new Error('Fixture smoke only runs against an explicit local server');
await page.goto(base+'/project-list');
await page.waitForSelector('[data-generation-boundary]');
await page.waitForSelector('.t-gen',{timeout:5000});
await page.waitForTimeout(450);
assert.equal(await page.locator('.t-gen').count(),6);
const projectLayerIds=await layerIds();
const projectLayerNode=await page.locator('.t-gen').first().elementHandle();
const projectBefore=await geometry('[aria-busy="true"] .cds-card-grid article');
await page.getByRole('textbox',{name:'Git 仓库 URL',exact:true}).waitFor({state:'visible'});
assert(await page.getByRole('textbox',{name:'Git 仓库 URL',exact:true}).isDisabled());
await page.screenshot({path:out+'/projects-light-building.png'});
await page.waitForFunction(()=>document.querySelector('[data-generation-boundary]')&&!document.querySelector('[aria-label="加载项目列表"]'));
await sameOverlay(projectLayerIds,'project chunk -> data -> ready');
assert(await projectLayerNode.evaluate(el=>el.isConnected),'project retains the exact same DOM overlay');
await page.screenshot({path:out+'/projects-native-scan.png'});
await page.waitForTimeout(850);assert.equal(await page.locator('.t-gen').count(),0);
assert.equal(await page.locator('[data-generation-boundary] article').count(),1);
sameGeometry('projects desktop',projectBefore,await geometry('[data-generation-boundary] article'));
assert(await page.getByRole('textbox',{name:'Git 仓库 URL',exact:true}).isEnabled());
await noReadyOverlay();
await page.screenshot({path:out+'/projects-light-ready.png'});
await page.getByRole('button',{name:'刷新项目列表',exact:true}).click();
await page.waitForTimeout(200);assert.equal(await page.locator('.t-gen').count(),0);assert.equal(await page.locator('[data-generation-boundary] article').count(),1);
console.log('PASS slow projects -> real cards; existing-data refresh retains content');
// Navigate through actual project card.
await page.locator('[data-generation-boundary] article a[href="/branches/fixture-project"]').first().click();
await page.waitForSelector('.t-gen');await page.waitForTimeout(400);
const branchLayerIds=await layerIds();
const branchLayerNode=await page.locator('.t-gen').first().elementHandle();
const branchBefore=await geometry('[aria-busy="true"] .cds-branch-card-grid article');
await page.screenshot({path:out+'/branches-light-building.png'});
await page.waitForSelector('[data-branch-card-id]');await sameOverlay(branchLayerIds,'branch loading -> ready');assert(await branchLayerNode.evaluate(el=>el.isConnected),'branch retains the exact same DOM overlay');
await page.screenshot({path:out+'/branches-native-scan.png'});await page.waitForTimeout(850);assert.equal(await page.locator('.t-gen').count(),0);
sameGeometry('branches desktop with tags',branchBefore,await geometry('[data-branch-card-id]'));
await noReadyOverlay();
await page.screenshot({path:out+'/branches-light-ready.png'});
console.log('PASS project card -> branch list -> real branch data; same-overlay native scan, no blank frame');
// Theme and mobile.
await page.getByRole('button',{name:'切换到黑天主题',exact:true}).click();
await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
await page.goto(base+'/project-list');await page.waitForSelector('.t-gen');await page.waitForTimeout(400);await page.screenshot({path:out+'/projects-dark-building.png'});await page.waitForTimeout(900);
await page.setViewportSize({width:390,height:844});await page.reload();await page.waitForSelector('.t-gen');await page.waitForTimeout(350);
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:out+'/projects-dark-mobile-building.png'});
const mobileProjectBefore=await geometry('[aria-busy="true"] .cds-card-grid article');
await page.waitForSelector('[data-generation-boundary] article a[href="/branches/fixture-project"]');
sameGeometry('projects dark390',mobileProjectBefore,await geometry('[data-generation-boundary] article'));
await noReadyOverlay();await page.waitForTimeout(850);assert.equal(await page.locator('.t-gen').count(),0);
await page.goto(base+'/branches/fixture-project');await page.waitForSelector('.t-gen');
const mobileBranchBefore=await geometry('[aria-busy="true"] .cds-branch-card-grid article');
await page.screenshot({path:out+'/branches-dark-mobile-building.png'});
await page.waitForSelector('[data-branch-card-id]');
sameGeometry('branches dark390 with tags',mobileBranchBefore,await geometry('[data-branch-card-id]'));
await noReadyOverlay();
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
await page.screenshot({path:out+'/branches-dark-mobile-ready.png'});
console.log('PASS dark/light and 390px without horizontal overflow');
// Reduced motion.
await page.emulateMedia({reducedMotion:'reduce'});await page.goto(base+'/project-list');await page.waitForTimeout(450);assert.equal(await page.locator('.t-gen').count(),0);await page.waitForTimeout(1400);
console.log('PASS reduced motion uses skeleton');
// Rapid switch and cancellation on scroll/resize.
await page.emulateMedia({reducedMotion:'no-preference'});await page.setViewportSize({width:1360,height:900});delay=1800;
await page.reload();await page.waitForSelector('.t-gen');await page.evaluate(()=>window.dispatchEvent(new Event('resize')));assert.equal(await page.locator('.t-gen').count(),0);
await page.goto(base+'/branches/fixture-project');await page.waitForSelector('.t-gen');
const staleLayers=await layerIds();
await page.getByRole('link',{name:'项目',exact:true}).click();await page.waitForTimeout(50);
assert((await layerIds()).every(id=>!staleLayers.includes(id)),'SPA navigation removes the previous route overlays');
await page.waitForSelector('article a[href="/branches/fixture-project"]');await page.waitForTimeout(850);
assert.equal(await page.locator('.t-gen').count(),0);
console.log('PASS resize/rapid switch/reopen clean up body overlays');
// Slow server status + error.
delay=7200;await page.reload();await page.getByText('正在等待服务器返回列表数据。').waitFor({timeout:9000});assert(await page.getByRole('button',{name:'重新加载',exact:true}).isVisible());await page.waitForTimeout(1500);
fail=true;delay=600;await page.reload();await page.getByText(/fixture: 请求失败/).waitFor({timeout:10000});assert.equal(await page.locator('.t-gen').count(),0);await page.screenshot({path:out+'/projects-error.png'});
fail=false;delay=10;await page.getByRole('button',{name:'刷新项目列表',exact:true}).click();await page.waitForTimeout(900);assert.equal(await page.locator('.t-gen').count(),0);assert.equal(await page.locator('[data-generation-boundary] article').count(),1);
chunkDelay=0;await page.reload();await page.waitForSelector('article a[href="/branches/fixture-project"]');await page.waitForTimeout(160);
assert.equal(await page.locator('.t-gen').count(),0);await noReadyOverlay();
console.log('PASS long wait status; failed response; retry; fast response without artificial chunk latency');
// Member loading/ready states never expose the owner creator row.
member=true;delay=1200;await page.setViewportSize({width:390,height:844});await page.reload();await page.waitForSelector('.t-gen');
const memberBefore=await geometry('[aria-busy="true"] .cds-card-grid article');
assert.equal(await page.locator('#topbar-git-repo-url').count(),0);
await page.waitForSelector('[data-generation-boundary] article a[href="/branches/fixture-project"]');
sameGeometry('projects member390',memberBefore,await geometry('[data-generation-boundary] article'));
assert.equal(await page.locator('#topbar-git-repo-url').count(),0);await noReadyOverlay();
console.log('PASS owner creator disabled during loading; member never gets creator row');
await page.goto(base+'/project-list?fixture-low-perf=1');await page.waitForTimeout(450);
assert.equal(await page.locator('.t-gen').count(),0);
await page.waitForSelector('article a[href="/branches/fixture-project"]');await noReadyOverlay();
console.log('PASS low-performance device uses the light skeleton');
await fs.writeFile(out+'/geometry.json',JSON.stringify(geometryResults,null,2));
assert.deepEqual(errors,[]);console.log('GEOMETRY',geometryResults.map(x=>x.label));console.log('PAGE_ERRORS',errors,'UNREGISTERED_FIXTURES',[...unknown]);
await browser.close();
