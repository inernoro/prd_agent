import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire } from 'node:module';

/** Shared confirmation behavior, exercised by actual product consumers as well as the scope fixture. */
export async function assertConfirmationKeyboard(page, trigger, expectedObject) {
  await trigger.focus(); await page.keyboard.press('Enter');
  const dialog=page.locator('[role="dialog"]:has([data-confirm-cancel])');await dialog.waitFor();
  if(expectedObject)await dialog.getByText(expectedObject).first().waitFor();
  await page.waitForFunction(()=>document.querySelector('[role="dialog"] [data-confirm-cancel]')===document.activeElement,{},{timeout:3000}).catch(async error=>{throw Error(`${error.message}; active=${await page.evaluate(()=>document.activeElement?.outerHTML)}`)});
  for(let i=0;i<8;i++){await page.keyboard.press(i%3===0?'Shift+Tab':'Tab');assert(await dialog.evaluate(element=>element.contains(document.activeElement)),'确认焦点逃到背景');}
  await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
  assert(await trigger.evaluate(element=>element===document.activeElement),'Esc没有返回触发者');
  await page.keyboard.press('Enter');await dialog.waitFor();await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'detached'});
  assert(await trigger.evaluate(element=>element===document.activeElement),'取消没有返回触发者');
}

/** Controlled component fixture. It proves scope/focus only and is never a live product flow. */
export async function verifyConfirmationScope(browser,sourceRoot,out){
  await fs.mkdir(out,{recursive:true});
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cds-confirmation-focus-'));
  const require=createRequire(realpathSync(path.join(sourceRoot,'cds/web/node_modules/vite/package.json')));
  const {build}=require('esbuild');
  const entry=path.join(temp,'scope.tsx');
  await fs.writeFile(entry,`import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConfirmAction} from '@/components/ui/confirm-action';
import {ConsoleAuthContext} from '@/lib/consoleAuthContext';
const confirmations=[];let actorVersion=1;
function ScopeFixture(){const [actor,setActor]=useState({enabled:true,user:{username:'same-name',isSystemOwner:true}});const [target,setTarget]=useState('object-a');const[blocked,setBlocked]=useState(false),[triggerBlocked,setTriggerBlocked]=useState(false),[pending,setPending]=useState(false);
window.confirmationFixture={confirmations,switchActor(){actorVersion++;setActor({enabled:true,user:{username:'same-name',isSystemOwner:true}})},switchTarget(){setTarget('object-b')},setBlocked,setTriggerBlocked,setPending};
return <ConsoleAuthContext.Provider value={{status:actor,pending:false,retry(){}}}><button id="before">背景按钮</button><ConfirmAction disabled={blocked} pending={pending} scopeKey={target} title="确认同名对象操作？" description={<span>对象编号：{target}</span>} confirmLabel="执行测试动作" onConfirm={()=>confirmations.push({actorVersion,target})} trigger={<button id="trigger" disabled={triggerBlocked}>打开确认</button>} /><button id="after">后续背景按钮</button></ConsoleAuthContext.Provider>}
createRoot(document.getElementById('root')).render(<ScopeFixture/>);`);
  await build({entryPoints:[entry],outfile:path.join(temp,'scope.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(sourceRoot,'cds/web/node_modules')],alias:{'@':path.join(sourceRoot,'cds/web/src')},define:{'process.env.NODE_ENV':'"production"'}});
  await fs.writeFile(path.join(temp,'index.html'),'<!doctype html><meta charset="utf-8"><title>Deterministic confirmation scope fixture</title><style>body{font:1rem sans-serif}button{padding:.5rem;margin:.25rem}[role=dialog]{position:fixed;width:18rem;max-width:calc(100vw - 1rem);background:white;color:#222;border:1px solid #888;padding:.75rem;box-sizing:border-box}</style><div id="root"></div><script src="/scope.js"></script>');
  const server=http.createServer(async(req,res)=>{const file=req.url==='/scope.js'?'scope.js':'index.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/html');res.end(await fs.readFile(path.join(temp,file)));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const context=await browser.newContext({viewport:{width:390,height:840}});const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const results=[];
  try{
    await page.goto(`http://127.0.0.1:${server.address().port}`);const trigger=page.locator('#trigger');await trigger.waitFor();
    await assertConfirmationKeyboard(page,trigger,/object-a/);results.push({case:'safe-initial-focus-tab-trap-escape-cancel-restore',pass:true});
    await trigger.click();await page.getByRole('dialog').waitFor();await page.evaluate(()=>window.confirmationFixture.switchActor());await page.getByRole('dialog').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.confirmationFixture.confirmations.length),0);results.push({case:'same-name-identity-refresh-invalidates-open-confirmation',pass:true});
    await trigger.click();await page.getByRole('dialog').waitFor();await page.evaluate(()=>window.confirmationFixture.switchTarget());await page.getByRole('dialog').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>window.confirmationFixture.confirmations.length),0);results.push({case:'async-target-change-invalidates-open-confirmation',pass:true});
    await trigger.click();await page.getByRole('dialog').getByText(/object-b/).waitFor();await page.getByRole('button',{name:'执行测试动作',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.confirmationFixture.confirmations),[{actorVersion:2,target:'object-b'}]);results.push({case:'fresh-confirmation-executes-current-object-once',pass:true});
    for(const flag of ['setBlocked','setTriggerBlocked','setPending']){await trigger.click();await page.getByRole('dialog').waitFor();await page.evaluate(flag=>window.confirmationFixture[flag](true),flag);await page.getByRole('dialog').waitFor({state:'detached'});await page.evaluate(flag=>window.confirmationFixture[flag](false),flag);assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.evaluate(()=>window.confirmationFixture.confirmations.length),1);results.push({case:`open-${flag}-closes-and-reenable-needs-new-confirmation`,pass:true});}
    assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'scope-results.json'),JSON.stringify({provenance:'deterministic-fixture',results,errors},null,2));return results;
  }finally{await context.close();await new Promise(resolve=>server.close(resolve));await fs.rm(temp,{recursive:true,force:true});}
}

/** Non-settings consumer regression: open/cancel a branch deletion, never perform deletion. */
export async function verifyBranchConfirmationKeyboard(browser,base,out){
  const {resolveFixture,isEventStream}=await import('./fixtures/mobile-layout-fixtures.mjs');
  await fs.mkdir(out,{recursive:true});const context=await browser.newContext({viewport:{width:1440,height:940}});const errors=[],writes=[];
  await context.route('**/api/**',async route=>{
    const request=route.request(),p=new URL(request.url()).pathname.replace(/^\/_cds/,'');
    if(p==='/api/client-events')return route.fulfill({json:{ok:true}});
    if(isEventStream(p)||p==='/api/activity-stream')return route.fulfill({contentType:'text/event-stream',body:': deterministic fixture\n\n'});
    if(request.method()!=='GET'){writes.push({method:request.method(),path:p});return route.fulfill({status:409,json:{error:'fixture does not permit mutations'}});}
    return route.fulfill({json:resolveFixture(p)??{}});
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(`${base}/branches/fixture-project`);const trigger=page.getByRole('button',{name:'删除分支',exact:true}).first();await trigger.waitFor();
    await assertConfirmationKeyboard(page,trigger,/CDS|分支/);assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
    const result={provenance:'deterministic-fixture',case:'branch-delete-consumer-keyboard-cancel-without-write',pass:true,writes,errors};await fs.writeFile(path.join(out,'branch-results.json'),JSON.stringify(result,null,2));return result;
  }catch(error){await page.screenshot({path:path.join(out,'branch-failure.png')});await fs.writeFile(path.join(out,'branch-failure.txt'),`${error.stack}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`);throw error;}finally{await context.close();}
}

/** Actual replica-plan consumer inside the existing modal primitive. Reads and cancellation are synthetic. */
export async function verifyNestedReplicaConfirmation(browser,sourceRoot,out){
  await fs.mkdir(out,{recursive:true});const temp=await fs.mkdtemp(path.join(os.tmpdir(),'cds-nested-confirm-'));
  const require=createRequire(realpathSync(path.join(sourceRoot,'cds/web/node_modules/vite/package.json')));const {build}=require('esbuild');
  const entry=path.join(temp,'nested.tsx');let planId='plan-a';const writes=[];
  await fs.writeFile(entry,`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {Dialog,DialogContent,DialogTitle} from '@/components/ui/dialog';import {ReplicaSetPanel} from '@/components/branch/ReplicaSetPanel';
import {ConsoleAuthContext} from '@/lib/consoleAuthContext';
const actor={enabled:true,user:{id:'fixture-actor',username:'fixture-actor',isSystemOwner:true}};
function Fixture(){const[open,setOpen]=useState(false);return <ConsoleAuthContext.Provider value={{status:actor,pending:false,retry(){}}}><button id="open-parent" onClick={()=>setOpen(true)}>打开分支工作区</button><Dialog open={open} onOpenChange={setOpen}><DialogContent aria-describedby={undefined}><DialogTitle>合成分支副本工作区</DialogTitle><ReplicaSetPanel branchId="fixture-branch"/></DialogContent></Dialog></ConsoleAuthContext.Provider>};createRoot(document.getElementById('root')).render(<Fixture/>);`);
  await build({entryPoints:[entry],outfile:path.join(temp,'nested.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(sourceRoot,'cds/web/node_modules')],alias:{'@':path.join(sourceRoot,'cds/web/src')},define:{'process.env.NODE_ENV':'"production"'}});
  await fs.writeFile(path.join(temp,'index.html'),'<!doctype html><meta charset="utf-8"><title>Deterministic nested replica fixture</title><style>body{font:1rem sans-serif}button{padding:.5rem;margin:.25rem}[role=dialog]{position:fixed;top:10%;left:5%;width:90%;max-height:80vh;overflow:auto;background:white;color:#222;border:1px solid #888;padding:.75rem;box-sizing:border-box}[role=dialog]:not(:has([data-confirm-cancel])){transform:translate(-50%,-50%);max-width:calc(100vw - 1rem)}[role=dialog]:has([data-confirm-cancel]){width:18rem;max-width:calc(100vw - 1rem)}</style><div id="root"></div><script src="/nested.js"></script>');
  const server=http.createServer(async(req,res)=>{const p=new URL(req.url,'http://fixture').pathname;
    if(p.startsWith('/api/')){res.setHeader('Content-Type','application/json');if(req.method!=='GET'){writes.push({method:req.method,path:p});res.statusCode=409;return res.end(JSON.stringify({error:'No mutations allowed in nested fixture'}));}
      if(p.endsWith('/replica-plans'))return res.end(JSON.stringify({plans:[{id:planId,status:'running',onFailure:'stop',steps:[],createdAt:'2026-11-15T00:00:00Z'}]}));
      return res.end(JSON.stringify({replicaSets:{},candidates:{},memberLimit:4,graph:{nodes:[],edges:[],layers:[]}}));}
    const file=p==='/nested.js'?'nested.js':'index.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/html');res.end(await fs.readFile(path.join(temp,file)));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const context=await browser.newContext({viewport:{width:390,height:840}});const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try{await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#open-parent').click();const parent=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'合成分支副本工作区'})});await parent.waitFor();
    const trigger=parent.getByRole('button',{name:'取消剩余',exact:true});await trigger.waitFor();await assertConfirmationKeyboard(page,trigger,'取消剩余步骤');assert(await parent.isVisible(),'Esc错误关闭底层工作区');
    await trigger.click();const confirmation=page.locator('[role="dialog"]:has([data-confirm-cancel])');await confirmation.waitFor();planId='plan-b';await confirmation.waitFor({state:'detached',timeout:7000});assert(await parent.isVisible());assert.deepEqual(writes,[]);
    await trigger.click();await confirmation.waitFor();await page.keyboard.press('Escape');await confirmation.waitFor({state:'detached'});assert(await parent.isVisible());
    await page.keyboard.press('Escape');await parent.waitFor({state:'detached'});assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
    const result={provenance:'deterministic-fixture-actual-ReplicaSetPanel-in-Dialog',case:'nested-focus-escape-top-only-return-and-polled-plan-replacement',pass:true,writes,errors};await fs.writeFile(path.join(out,'nested-results.json'),JSON.stringify(result,null,2));return result;
  }catch(error){await page.screenshot({path:path.join(out,'nested-failure.png')});await fs.writeFile(path.join(out,'nested-failure.txt'),`${error.stack}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`);throw error;}finally{await context.close();await new Promise(resolve=>server.close(resolve));await fs.rm(temp,{recursive:true,force:true});}
}
