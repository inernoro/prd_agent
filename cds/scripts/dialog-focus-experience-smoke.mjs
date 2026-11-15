import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const arg=(n,d)=>{const i=process.argv.indexOf(n);return i<0?d:process.argv[i+1]};
const root=arg('--source',path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')),out=arg('--out','/tmp/cds-dialog-focus');fs.mkdirSync(out,{recursive:true});
const {startViteDevServer}=await import(pathToFileURL(root+'/cds/scripts/lib/vite-dev-server.mjs'));
const {resolveFixture}=await import(pathToFileURL(root+'/cds/scripts/fixtures/mobile-layout-fixtures.mjs'));
const hash=()=>createHash('sha256').update(execFileSync('git',['diff','HEAD','--','cds/web/src'],{cwd:root})).digest('hex');
const provenance={kind:'deterministic-fixture',sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDiffSha256:hash(),scriptSha256:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex')};
const results=[],server=await startViteDevServer();let browser;
try{
 browser=await chromium.launch({executablePath:process.env.PW_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox']});
 for(const width of [1440,390])for(const theme of ['light','dark']){
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'}),page=await context.newPage();
  await context.addInitScript(theme=>{localStorage.setItem('cds_theme',theme);window.EventSource=class{constructor(){}addEventListener(){}removeEventListener(){}close(){}}},theme);
  await context.route('**/api/**',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(resolveFixture(new URL(route.request().url()).pathname.replace(/^\/_cds/,''))??{})}));
  const check=(pass,name,measurement)=>{results.push({width,theme,name,pass:!!pass,...(measurement?{measurement}:{})});if(!pass)process.exitCode=1};
  const settleFocus=async(locator,name)=>{
   let focused=false;for(let i=0;i<24;i++){focused=await locator.evaluate(e=>e===document.activeElement);if(focused)break;await page.waitForTimeout(50)}
   check(focused,name,await page.evaluate(()=>({tag:document.activeElement?.tagName,id:document.activeElement?.id,text:document.activeElement?.textContent?.trim().slice(0,60)})));
  };
  try{
   const ready=async title=>{const dialog=page.getByRole('dialog',{name:title,exact:true});await dialog.waitFor();for(let i=0;i<30;i++){if(await dialog.evaluate(e=>e.contains(document.activeElement)))break;await page.waitForTimeout(50)}await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))};
   await page.goto(server.url+'/hello',{waitUntil:'domcontentloaded'});const trigger=page.getByRole('button',{name:'打开演示弹窗',exact:true});await trigger.waitFor();await trigger.focus();await page.keyboard.press('Enter');await ready('统一弹窗骨架');await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'统一弹窗骨架'}).waitFor({state:'hidden'});await settleFocus(trigger,'现有Hello DialogTrigger关闭后回原入口');
   // Mount a test-only React consumer of the actual loaded module; no product route/page is added.
   await page.evaluate(async()=>{
    const urls=performance.getEntriesByType('resource').map(e=>e.name);
    const react=urls.find(u=>/\/react\.js\?/.test(u)),dom=urls.find(u=>/\/react-dom_client\.js\?/.test(u)),dialog=urls.find(u=>u.includes('/src/components/ui/dialog.tsx'));
    if(!react||!dom||!dialog)throw Error('fixture没有找到已加载React/Dialog模块，不能另造替身');
    const RM=await import(react),D=await import(dialog),DM=await import(dom),R=RM.default??RM,RD=DM.default??DM,h=R.createElement;if(typeof h!=='function'||typeof RD.createRoot!=='function')throw Error('fixture模块interop不完整，未执行Dialog判据');
    function Harness(){
     const [manual,setManual]=R.useState(false),[inner,setInner]=R.useState(false),[custom,setCustom]=R.useState(false),[newFocus,setNewFocus]=R.useState(false);
     const content=(title,props,...children)=>h(D.DialogContent,props,h(D.DialogTitle,null,title),h(D.DialogDescription,null,'独立焦点测试，不执行业务操作。'),...children);
     return h(R.Fragment,null,
      h('button',{id:'manual-open',onClick:()=>setManual(true)},'手动打开'),h(D.Dialog,{open:manual,onOpenChange:setManual},content('手动弹窗',{},h('input',{'aria-label':'手动输入'}))),
      h(D.Dialog,null,h(D.DialogTrigger,{id:'outer-open'},'外层打开'),content('外层弹窗',{},h('input',{'aria-label':'外层首项'}),h('button',{id:'inner-open',onClick:()=>setInner(true)},'打开内层'),h(D.Dialog,{open:inner,onOpenChange:setInner},content('内层弹窗',{},h('input',{'aria-label':'内层输入'}))))),
      h('button',{id:'custom-open',onClick:()=>setCustom(true)},'自定义回焦'),h('button',{id:'custom-destination'},'指定去向'),h(D.Dialog,{open:custom,onOpenChange:setCustom},content('自定义弹窗',{onCloseAutoFocus:e=>{e.preventDefault();document.getElementById('custom-destination').focus()}},h('input',{'aria-label':'自定义输入'}))),
      h('button',{id:'new-focus-open',onClick:()=>setNewFocus(true)},'关闭时已有新焦点'),h('button',{id:'new-destination'},'新页面焦点'),h(D.Dialog,{open:newFocus,onOpenChange:setNewFocus},content('新去向弹窗',{onCloseAutoFocus:()=>document.getElementById('new-destination').focus()},h('input',{'aria-label':'新去向输入'})))
     );
    }
    const mount=document.createElement('div');mount.id='dialog-focus-fixture';Object.assign(mount.style,{position:'fixed',inset:'0',zIndex:'20',background:'hsl(var(--background))',padding:'1rem',display:'flex',gap:'1rem',flexWrap:'wrap',alignContent:'start'});document.body.append(mount);RD.createRoot(mount).render(h(Harness));
   });
   const enter=async(id,title)=>{const button=page.locator('#'+id);await button.focus();await page.keyboard.press('Enter');await ready(title)};
   const close=async title=>{await page.keyboard.press('Escape');await page.getByRole('dialog',{name:title,exact:true}).waitFor({state:'hidden'})};
   await enter('manual-open','手动弹窗');await close('手动弹窗');await settleFocus(page.locator('#manual-open'),'手动无DialogTrigger关闭后回原入口');
   await enter('outer-open','外层弹窗');await enter('inner-open','内层弹窗');await close('内层弹窗');await settleFocus(page.locator('#inner-open'),'嵌套最上层关闭回父弹窗入口');check(await page.getByRole('dialog',{name:'外层弹窗',exact:true}).isVisible(),'关闭内层不关闭父弹窗');await close('外层弹窗');await settleFocus(page.locator('#outer-open'),'父弹窗关闭回页面入口');
   await enter('custom-open','自定义弹窗');await close('自定义弹窗');await settleFocus(page.locator('#custom-destination'),'尊重调用方preventDefault和自定义去向');
   await enter('new-focus-open','新去向弹窗');await close('新去向弹窗');await settleFocus(page.locator('#new-destination'),'调用方已放置新焦点时不抢回旧点');
   await page.screenshot({path:out+`/focus-${width}-${theme}.png`});
  }catch(error){results.push({width,theme,name:'流程完成',pass:false,error:String(error)});process.exitCode=1}finally{await context.close()}
 }
 results.push({name:'取证源码稳定',pass:hash()===provenance.sourceDiffSha256});if(hash()!==provenance.sourceDiffSha256)process.exitCode=1;
}finally{fs.writeFileSync(out+'/results.json',JSON.stringify({provenance,results},null,2));console.log(JSON.stringify(results));await browser?.close();server.stop()}
