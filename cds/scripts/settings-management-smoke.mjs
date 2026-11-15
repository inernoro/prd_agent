import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

/** Deterministic UI only: every API is intercepted, no real authorization or account write. */
export async function verifySettingsManagement(browser, base, out, {baseline=false}={}) {
  await fs.mkdir(out,{recursive:true});
  const context=await browser.newContext({viewport:{width:1440,height:940}});
  let failMe=false, failTrust=false, failForwarding=false, createRejected=true;
  const users=[{id:'fixture-owner',username:'fixture-owner',name:'合成所有者',authProvider:'local',isSystemOwner:true,status:'active',createdAt:'2026-11-15',lastLoginAt:null},{id:'fixture-member',username:'fixture-member',name:'合成成员',authProvider:'local',isSystemOwner:false,status:'active',createdAt:'2026-11-15',lastLoginAt:null}];
  const connections=[{id:'fixture-map',name:'合成MAP连接',partnerName:'合成MAP',partnerKind:'map',partnerBaseUrl:'https://map.example.invalid',status:'active',scopes:['bug-report'],createdAt:'2026-11-15'}];
  const writes=[],errors=[],results=[];
  await context.route('**/api/**',async route=>{
    const request=route.request(),p=new URL(request.url()).pathname.replace(/^\/_cds/,''), method=request.method();
    if(isEventStream(p)||p==='/api/activity-stream')return route.fulfill({contentType:'text/event-stream',body:': synthetic fixture\n\n'});
    if(method!=='GET')writes.push({method,path:p});
    if(p==='/api/client-events')return route.fulfill({json:{ok:true}});
    if(p==='/api/identity/connections')return route.fulfill({json:{users:[],requests:[],unclaimed:[]}});
    if(p==='/api/me')return route.fulfill(failMe?{status:500,json:{error:'合成身份读取失败'}}:{json:{user:users[0]}});
    if(p==='/api/auth/users'&&method==='GET')return route.fulfill({json:{users}});
    if(p==='/api/auth/users'&&method==='POST'){
      if(createRejected)return route.fulfill({status:400,json:{error:'合成用户名已被使用'}});
      const input=request.postDataJSON(),user={...users[1],id:'fixture-created',username:input.username,name:input.name};users.push(user);return route.fulfill({json:{user}});
    }
    if(p==='/api/cds-system/connections')return route.fulfill(failTrust?{status:500,json:{error:'合成互联读取失败'}}:{json:{connections}});
    if(p==='/api/cds-system/integrations/bug-report')return route.fulfill(failForwarding?{status:500,json:{error:'合成转发读取失败'}}:{json:{configured:true,source:'system-settings',baseUrl:'https://map.example.invalid',tokenConfigured:true,secretStorage:'encrypted',authorizationUrl:'https://map.example.invalid/authorize'}});
    if(method!=='GET')throw new Error(`Unexpected fixture write ${method} ${p}`);
    return route.fulfill({json:resolveFixture(p)??{}});
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  async function open(tab){await page.goto(`${base}/cds-settings#${tab}`);await page.locator('[role="tabpanel"][data-state="active"]').waitFor();}
  async function point(text){return page.getByText(text,{exact:true}).first().evaluate(e=>{const r=e.getBoundingClientRect();return {top:r.top,height:r.height,viewport:innerHeight};});}
  try{
    await open('users');await page.getByText('fixture-member',{exact:true}).waitFor();
    results.push({case:'existing-users-first',firstData:await point('fixture-member')});
    await page.screenshot({path:path.join(out,'users-desktop.png')});
    if(!baseline){
      assert.equal(await page.getByRole('textbox',{name:'用户名',exact:true}).count(),0);
      await page.getByRole('button',{name:'创建账号',exact:true}).click();
      const dialog=page.getByRole('dialog');await dialog.waitFor();
      await dialog.getByRole('textbox',{name:'用户名',exact:true}).fill('fixture-created');
      await dialog.getByLabel('初始密码（至少8位）',{exact:true}).fill('synthetic-password');
      await dialog.getByRole('button',{name:'创建账号',exact:true}).click();
      await dialog.getByText(/合成用户名已被使用/).waitFor();
      assert.equal(await dialog.getByRole('textbox',{name:'用户名',exact:true}).inputValue(),'fixture-created');
      createRejected=false;await dialog.getByRole('button',{name:'创建账号',exact:true}).click();
      await dialog.waitFor({state:'hidden'});await page.getByText('fixture-created',{exact:true}).waitFor();
      assert.equal(await page.getByRole('tab',{name:'用户管理',exact:true}).getAttribute('data-state'),'active');
      results.push({case:'create-on-demand-reject-retains-draft-success-returns-list',pass:true});
      failMe=true;await page.reload();
      await page.getByText(/当前身份读取失败/).waitFor();
      assert.equal(await page.getByText(/当前账号通过外部身份提供方登录/).count(),0);
      failMe=false;await page.getByRole('button',{name:'重试读取身份',exact:true}).click();await page.getByText('fixture-member',{exact:true}).waitFor();
      results.push({case:'unknown-identity-never-becomes-external-account',pass:true});
      for(const theme of ['dark','light']){
        await page.setViewportSize({width:390,height:940});await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.classList.toggle('dark',theme==='dark');},theme);
        await page.screenshot({path:path.join(out,`users-${theme}-390.png`)});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await page.getByRole('button',{name:'创建账号',exact:true}).click();await page.getByRole('dialog').waitFor();await page.screenshot({path:path.join(out,`users-create-${theme}-390.png`)});await page.keyboard.press('Escape');
      }
    }
    await page.setViewportSize({width:1440,height:940});
    await open('connections');await page.getByText('合成MAP连接',{exact:true}).waitFor();
    results.push({case:'authorized-connection-records-first',firstData:await point('合成MAP连接')});
    await page.screenshot({path:path.join(out,'connections-desktop.png')});
    if(!baseline){
      failTrust=true;await page.reload();await page.getByText('MAP 授权状态未确认',{exact:true}).waitFor();
      assert.equal(await page.getByText('未确认',{exact:true}).count(),1);
      await page.getByText('已授权',{exact:true}).waitFor();
      failTrust=false;await page.getByRole('button',{name:'重新读取状态',exact:true}).click();await page.getByText('合成MAP连接',{exact:true}).waitFor();
      failForwarding=true;await page.reload();await page.getByText('MAP 授权状态未确认',{exact:true}).waitFor();
      assert.equal(await page.getByText('未确认',{exact:true}).count(),1);await page.getByText('已授权',{exact:true}).waitFor();
      results.push({case:'independent-permission-state-failure-stays-unknown',pass:true});
    }
    assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(out,'results.json'),JSON.stringify({provenance:'deterministic-fixture',baseline,results,writes,errors},null,2));
    return results;
  }catch(error){await page.screenshot({path:path.join(out,'failure.png')});await fs.writeFile(path.join(out,'failure.txt'),`${error.stack}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`);throw error;}finally{await context.close();}
}
