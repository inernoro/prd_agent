/** Browser geometry and interaction regression. Fixtures are diagnostic, not production acceptance. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { startViteDevServer } from './lib/vite-dev-server.mjs';
import { resolveFixture, isEventStream, FIXTURE_PROJECT_ID } from './fixtures/mobile-layout-fixtures.mjs';
const server=process.argv[2]?null:await startViteDevServer();
const base=process.argv[2]||server.url;
let browser,checks=0;
try {
 browser=await chromium.launch({executablePath:process.env.CDS_CHROMIUM_PATH||(fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox']});
 const context=await browser.newContext();
 await context.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(isEventStream(path))return route.fulfill({contentType:'text/event-stream',body:': fixture\n\n'});
  let body=resolveFixture(path)??{};
  if(path==='/api/branches')body={...body,branches:body.branches.map((branch,index)=>{
   if(index)return branch;
   const services={...branch.services,worker:{...branch.services.api},jobs:{...branch.services.api}};
   return {...branch,services:Object.fromEntries(Object.entries(services).map(([key,value],index)=>[key,{...value,profileId:key,hostPort:8080+index}]))};
  })};
  if(/\/git-log$/.test(path))body={commits:Array.from({length:6},(_,index)=>({hash:'a'.repeat(32)+String(index).padStart(8,'0'),subject:'合成提交 '+index,author:'fixture',date:'2026-11-17T00:00:00Z'}))};
  return route.fulfill({json:body});
 });
 const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function bounded(selector){
  await page.waitForFunction(selector=>{
   const el=document.querySelector(selector);if(!el||getComputedStyle(el).visibility==='hidden')return false;
   const r=el.getBoundingClientRect(),v=visualViewport;
   const left=v?.offsetLeft??0,top=v?.offsetTop??0,right=left+(v?.width??innerWidth),bottom=top+(v?.height??innerHeight);
   return r.width>0&&r.height>0&&r.left>=left+7&&r.right<=right-7&&r.top>=top+7&&r.bottom<=bottom-7;
  },selector,{timeout:10000});
  const hit=await page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.left+r.width/2,r.top+Math.min(r.height/2,20)));});
  assert.ok(hit,'floating content remains hit-testable outside clipping ancestor');checks++;
 }
 async function mount(kind,edge='bottom'){
  await page.goto(`${base}/project-list`);await page.getByLabel('项目排序',{exact:true}).waitFor();
  await page.evaluate(async ({kind,edge})=>{
   const {default:R}=await import('/node_modules/.vite/deps/react.js');
   const {default:D}=await import('/node_modules/.vite/deps/react-dom_client.js');
   const {AnchoredPopover}=await import('/src/components/ui/anchored-popover.tsx');
   const {DropdownMenu,DropdownItem}=await import('/src/components/ui/dropdown-menu.tsx');
   const {ConfirmAction}=await import('/src/components/ui/confirm-action.tsx');
   const {BranchSearchDropdown}=await import('/src/components/branch/BranchSearchDropdown.tsx');
   document.getElementById('root').style.display='none';
   const host=document.createElement('div');document.body.append(host);
   function Probe(){
    const anchor=R.useRef(null),[open,setOpen]=R.useState(false),[rows,setRows]=R.useState(3),[query,setQuery]=R.useState(''),[feedback,setFeedback]=R.useState('');
    const picked=value=>{setFeedback(value);setOpen(false);};
    const trigger=R.createElement('button',{type:'button'},'打开控件');
    const tracked=Array.from({length:20},(_,i)=>({id:String(i),branch:`tracked-${i}`}));
    const remote=Array.from({length:30},(_,i)=>({name:`remote-${i}`,subject:'长分支说明'.repeat(8)}));
    return R.createElement(R.Fragment,null,R.createElement('output',{'data-feedback':'',style:{position:'fixed',top:0,right:0}},feedback),
     R.createElement('div',{ref:anchor,style:{position:'fixed',[edge]:0,right:0,width:Math.min(innerWidth-20,320),height:45,overflow:'hidden'}},
      kind==='branch'?R.createElement('input',{'aria-label':'测试分支',role:'combobox',value:query,onFocus:()=>setOpen(true),onChange:e=>setQuery(e.target.value)}):
      kind==='menu'?R.createElement(DropdownMenu,{width:1800,trigger},Array.from({length:30},(_,i)=>R.createElement(DropdownItem,{key:i,onSelect:()=>picked(`item-${i}`)},`菜单项 ${i}`))):
      kind==='confirm'?R.createElement(ConfirmAction,{trigger,title:'确认测试',onConfirm:()=>picked('confirmed')}):
      R.createElement('button',{onClick:()=>setOpen(true)},'打开控件'),
      kind==='branch'&&open?R.createElement(BranchSearchDropdown,{id:'probe-branch-options',anchorRef:anchor,onDismiss:()=>setOpen(false),query,tracked,remote,remoteLoading:false,trackedByName:new Map(),actions:{},onPickTracked:b=>picked(b.branch),onPickRemote:b=>picked(b.name),onForceFetchRemote:()=>{}}):null,
      kind==='growth'&&open?R.createElement(AnchoredPopover,{open,anchorRef:anchor,widthRem:20,onDismiss:()=>setOpen(false),role:'menu','aria-label':'增长菜单',className:'z-[300] border bg-background p-2'},
       R.createElement('button',{onClick:()=>setTimeout(()=>setRows(80),30)},'增长内容'),
       Array.from({length:rows},(_,i)=>R.createElement('button',{key:i,role:'menuitem',style:{display:'block',width:'100%'}},`异步内容 ${i} `+'长标题'.repeat(12)))):null));
   }
   D.createRoot(host).render(R.createElement(Probe));
  },{kind,edge});
  if(kind==='branch')await page.getByLabel('测试分支',{exact:true}).focus();else await page.getByRole('button',{name:'打开控件',exact:true}).click();
 }
 for(const {width,height,theme,scale,edge} of [
  {width:375,height:300,theme:'light',scale:'80',edge:'bottom'},
  {width:375,height:844,theme:'dark',scale:'100',edge:'top'},
  {width:1440,height:400,theme:'light',scale:'100',edge:'bottom'},
  {width:1440,height:900,theme:'dark',scale:'85',edge:'top'},
 ]){
  await page.setViewportSize({width,height});
  for(const kind of ['branch','menu','confirm','growth']){
   await mount(kind,edge);
   await page.evaluate(({theme,scale})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.uiScale=scale;},{theme,scale});
   const selector=kind==='confirm'?'[aria-label="确认测试"]':'[data-cds-anchored-popover]';
   await bounded(selector);
   if(kind==='branch'){
    await page.getByLabel('测试分支',{exact:true}).evaluate(el=>el.parentElement.style.width='100px');
    await page.waitForFunction(()=>{const el=document.querySelector('[data-cds-anchored-popover]');return el&&Math.abs(el.getBoundingClientRect().width-Math.min(innerWidth-16,20*parseFloat(getComputedStyle(document.documentElement).fontSize)))<1;});checks++;
    await page.getByLabel('测试分支',{exact:true}).fill('remote-29');
    await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('[data-feedback]').textContent==='remote-29');checks++;
   } else if(kind==='growth'){
    await page.getByRole('button',{name:'增长内容',exact:true}).click();
    await page.getByRole('menuitem').last().waitFor({state:'attached'});await page.waitForFunction(()=>document.querySelectorAll('[role="menuitem"]').length===80);
    await bounded(selector);
    const before=await page.locator(selector).evaluate(el=>{el.scrollTop=el.scrollHeight;return el.scrollTop;});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.ok(before>0);assert.ok(await page.locator(selector).evaluate((el,before)=>el.scrollTop>=before-1,before));checks++;
    await page.setViewportSize({width:232,height:220});await bounded(selector);
    await page.setViewportSize({width,height});await bounded(selector);
    await page.waitForFunction(selector=>{const el=document.querySelector(selector);return el&&Math.abs(el.getBoundingClientRect().width-Math.min(innerWidth-16,20*parseFloat(getComputedStyle(document.documentElement).fontSize)))<1;},selector,{timeout:10000});checks++;
   } else if(kind==='menu'){
    await page.keyboard.press('Escape');
    const trigger=page.getByRole('button',{name:'打开控件',exact:true});await trigger.focus();await page.keyboard.press('ArrowDown');
    await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='menuitem');
    await page.keyboard.press('End');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('[data-feedback]').textContent==='item-29');checks++;
   }
   await page.keyboard.press('Escape');
  }
 }
 // Keyboard-like viewport reduction and pinch/pan offsets, simulated explicitly.
 await page.setViewportSize({width:375,height:844});await mount('growth','bottom');
 await page.evaluate(()=>{
  const viewport=new EventTarget();Object.assign(viewport,{width:innerWidth,height:innerHeight,offsetLeft:0,offsetTop:0});
  Object.defineProperty(window,'visualViewport',{configurable:true,value:viewport});
 });
 // Re-open so listeners subscribe to the simulated VisualViewport.
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'打开控件',exact:true}).click();
 await page.evaluate(()=>{Object.assign(visualViewport,{width:260,height:150,offsetLeft:20,offsetTop:40});visualViewport.dispatchEvent(new Event('resize'));});
 await bounded('[data-cds-anchored-popover]');checks++;
 await page.evaluate(()=>{Object.assign(visualViewport,{height:8});visualViewport.dispatchEvent(new Event('resize'));});
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-cds-anchored-popover]')).visibility==='hidden');checks++;
 // Real page integrations: same components in their actual parent DOM and dismissal paths.
 for(const width of [375,1440]){
  await page.setViewportSize({width,height:600});await page.goto(`${base}/project-list`);await page.getByLabel('项目排序',{exact:true}).waitFor();
  await page.locator('summary[aria-label="切换 CDS 实例"]').click();await bounded('[data-cds-anchored-popover]');await page.keyboard.press('Escape');
  if(width===375)await page.getByRole('button',{name:'打开导航菜单',exact:true}).click();
  await page.locator(width===375?'.cds-mobile-drawer.is-open .cds-account-trigger':'.cds-account-trigger').filter({visible:true}).first().click();await bounded('[aria-label="用户设置"]');await page.keyboard.press('Escape');
  if(width===375)await page.keyboard.press('Escape');
  if(width===375){await page.getByRole('button',{name:'更多操作',exact:true}).click();await bounded('.cds-topbar-sheet');await page.keyboard.press('Escape');}
  await page.goto(`${base}/cds-settings#maintenance`);
  const input=page.locator('#cds-update-target-branch');await input.waitFor();await input.focus();await input.fill('fixture');
  await page.getByRole('listbox').waitFor();await input.evaluate(el=>{el.parentElement.style.overflow='hidden';el.scrollIntoView({block:'end'});});
  await bounded('#cds-update-branch-options');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await page.keyboard.press('Escape');
  await page.goto(`${base}/branches/${FIXTURE_PROJECT_ID}`);
  await page.locator('[data-branch-card-id]').first().waitFor();
  const history=page.getByRole('button',{name:/提交历史$/}).first();
  await history.click();await bounded('[data-cds-anchored-popover]');await page.keyboard.press('Escape');
  const addTag=page.getByTitle('添加标签',{exact:true}).first();
  await page.locator('[data-branch-card-id]').first().hover();await addTag.click();await bounded('[aria-label="添加标签"]');
  await page.getByPlaceholder('输入标签名称').fill('仅供布局验证');await page.keyboard.press('Escape');
  await page.getByPlaceholder('输入标签名称').waitFor({state:'hidden'});checks++;
  const ports=page.locator('button[title^="还有 "]').first();
  assert.ok(await ports.count(),'fixture must expose the folded port menu');
  {await ports.click();await bounded('[data-cds-anchored-popover]');await page.getByRole('menu',{name:'全部服务端口'}).getByRole('menuitem').first().focus();assert.ok(await page.getByRole('menu',{name:'全部服务端口'}).isVisible());await page.keyboard.press('Escape');checks++;}
 }
 assert.deepEqual(errors,[],'no browser runtime errors');
 console.log(`PASS ${checks} floating geometry and interaction checks (including simulated VisualViewport; offline fixtures)`);
}finally{await browser?.close();server?.stop();}
