import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertConfirmationKeyboard } from './confirmation-focus-smoke.mjs';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';

/** Deterministic UI only: every API is intercepted, no real authorization or account write. */
export async function verifySettingsManagement(browser, base, out, {baseline=false}={}) {
  await fs.mkdir(out,{recursive:true});
  const context=await browser.newContext({viewport:{width:1440,height:940}});
  let failReset=true;
  let failMe=false, failTrust=false, failForwarding=false, createRejected=true,createGate,releaseCreate;
  const users=[{id:'fixture-owner',username:'fixture-owner',name:'合成所有者',authProvider:'local',isSystemOwner:true,status:'active',createdAt:'2026-11-15',lastLoginAt:null},{id:'fixture-member',username:'fixture-member',name:'合成成员',authProvider:'local',isSystemOwner:false,status:'active',createdAt:'2026-11-15',lastLoginAt:null}];
  const connections=[{id:'fixture-map',name:'合成MAP连接',partnerName:'合成MAP',partnerKind:'map',partnerBaseUrl:'https://map.example.invalid',status:'active',scopes:['bug-report'],createdAt:'2026-11-15'}];
  const writes=[],errors=[],results=[];
  await context.route('**/api/**',async route=>{
    const request=route.request(),p=new URL(request.url()).pathname.replace(/^\/_cds/,''), method=request.method();
    if(isEventStream(p)||p==='/api/activity-stream')return route.fulfill({contentType:'text/event-stream',body:': synthetic fixture\n\n'});
    if(method!=='GET')writes.push({method,path:p});
    if(p==='/api/client-events')return route.fulfill({json:{ok:true}});
    if(p==='/api/auth/status')return route.fulfill({json:{authenticated:true,enabled:true,user:{id:'fixture-owner',authProvider:'local',username:'fixture-owner',isSystemOwner:true}}});
    if(p.startsWith('/api/auth/users/')&&method==='PATCH')return route.fulfill(failReset?{status:500,json:{error:'合成重置回包未知'}}:{json:{user:users.find(user=>user.id===decodeURIComponent(p.split('/').at(-1)))}});
    if(p==='/api/identity/connections')return route.fulfill({json:{users:[],requests:[],unclaimed:[]}});
    if(p==='/api/me')return route.fulfill(failMe?{status:500,json:{error:'合成身份读取失败'}}:{json:{user:users[0]}});
    if(p==='/api/auth/users'&&method==='GET')return route.fulfill({json:{users}});
    if(p==='/api/auth/users'&&method==='POST'){
      if(createGate)await createGate;
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
  async function point(text){return page.getByText(text,{exact:true}).filter({visible:true}).first().evaluate(e=>{const r=e.getBoundingClientRect();return {top:r.top,height:r.height,viewport:innerHeight};});}
  try{
    await open('users');await page.getByText('fixture-member',{exact:true}).filter({visible:true}).waitFor();
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
      createRejected=false;createGate=new Promise(resolve=>releaseCreate=resolve);
      await dialog.getByRole('button',{name:'创建账号',exact:true}).click();
      assert(await dialog.getByRole('textbox',{name:'用户名',exact:true}).isDisabled());assert(await dialog.getByLabel('初始密码（至少8位）',{exact:true}).isDisabled());
      releaseCreate();createGate=null;results.push({case:'slow-create-protects-submitted-input',pass:true});
      await dialog.waitFor({state:'hidden'});await page.getByText('fixture-created',{exact:true}).filter({visible:true}).waitFor();
      assert.equal(await page.getByRole('tab',{name:'用户管理',exact:true}).getAttribute('data-state'),'active');
      results.push({case:'create-on-demand-reject-retains-draft-success-returns-list',pass:true});
      failMe=true;await page.reload();
      await page.getByText(/当前身份读取失败/).waitFor();
      assert.equal(await page.getByText(/当前账号通过外部身份提供方登录/).count(),0);
      failMe=false;await page.getByRole('button',{name:'重试读取身份',exact:true}).click();await page.getByText('fixture-member',{exact:true}).filter({visible:true}).waitFor();
      results.push({case:'unknown-identity-never-becomes-external-account',pass:true});
      for(const theme of ['dark','light']){
        await page.setViewportSize({width:390,height:940});await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;document.documentElement.classList.toggle('dark',theme==='dark');},theme);
        const member=page.locator('[data-user-card="fixture-member"]');await member.waitFor();
        for(const label of ['项目授权','重置密码','禁用']){const box=await member.getByRole('button',{name:label,exact:true}).boundingBox();assert(box.x>=0&&box.x+box.width<=390&&box.height>=40,`成员动作${label}未达到可见热区`);}
        if(theme==='dark')await assertConfirmationKeyboard(page,member.getByRole('button',{name:'禁用',exact:true}),/fixture-member/);
        const directory=page.getByRole('combobox',{name:'CDS 系统设置目录',exact:true});await directory.waitFor();assert.equal(await directory.inputValue(),'users');const directoryBox=await directory.boundingBox();assert(directoryBox.x>=0&&directoryBox.x+directoryBox.width<=390&&directoryBox.height>=40);
        await page.screenshot({path:path.join(out,`users-${theme}-390.png`)});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await page.getByRole('button',{name:'创建账号',exact:true}).click();await page.getByRole('dialog').waitFor();
        const dialog=page.getByRole('dialog');
        await dialog.evaluate(async element=>{
          let previous='',stable=0;
          for(let frame=0;frame<180;frame++){
            await new Promise(resolve=>requestAnimationFrame(resolve));
            const r=element.getBoundingClientRect(),box=[r.left,r.top,r.right,r.bottom].join(':');
            stable=box===previous&&getComputedStyle(element).opacity==='1'&&r.left>=0&&r.right<=innerWidth?stable+1:0;previous=box;
            if(stable>=4)return;
          }
          throw Error('Dialog did not settle within the viewport');
        });
        const bounds=await dialog.boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=390,`dialog ${theme} overflow ${JSON.stringify(bounds)}`);
        assert(await dialog.getByRole('heading',{name:'创建本地账号'}).isVisible());
        assert(await dialog.getByRole('button',{name:'创建账号',exact:true}).isVisible());assert(await dialog.getByRole('button',{name:'关闭',exact:true}).isVisible());
        for(let tab=0;tab<8;tab++){await page.keyboard.press('Tab');assert(await dialog.evaluate(element=>element.contains(document.activeElement)),'Dialog focus left to background');}
        await page.screenshot({path:path.join(out,`users-create-${theme}-390.png`)});await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
        results.push({case:`stable-create-dialog-${theme}-390-bounds-focus`,pass:true,bounds});
      }
    }
    if(!baseline){
      const member=page.locator('[data-user-card="fixture-member"]');await member.getByRole('button',{name:'重置密码',exact:true}).click();let reset=page.getByRole('dialog');await reset.getByLabel('重置后的新密码',{exact:true}).fill('synthetic-new-password');await reset.getByRole('button',{name:'保存新密码',exact:true}).click();await reset.getByRole('alert').filter({hasText:'密码重置结果未确认'}).waitFor();const count=writes.filter(item=>item.method==='PATCH').length;await page.keyboard.press('Escape');await reset.waitFor({state:'detached'});
      await open('overview');await open('users');await member.waitFor();await member.getByRole('button',{name:'重置密码',exact:true}).click();reset=page.getByRole('dialog');await reset.getByText(/上次密码重置结果未确认/).waitFor();assert(await reset.getByRole('button',{name:'保存新密码',exact:true}).isDisabled());assert.equal(writes.filter(item=>item.method==='PATCH').length,count);await page.keyboard.press('Escape');await reset.waitFor({state:'detached'});
      const other=page.locator('[data-user-card="fixture-created"]');await other.getByRole('button',{name:'重置密码',exact:true}).click();reset=page.getByRole('dialog');assert(!(await reset.getByRole('button',{name:'保存新密码',exact:true}).isDisabled()));assert.equal(await reset.getByLabel('重置后的新密码',{exact:true}).inputValue(),'');await page.keyboard.press('Escape');await reset.waitFor({state:'detached'});
      await member.getByRole('button',{name:'重置密码',exact:true}).click();reset=page.getByRole('dialog');await reset.getByRole('button',{name:'已由成员核对，准备新的重置',exact:true}).click();assert.equal(writes.filter(item=>item.method==='PATCH').length,count);await reset.getByText(/原请求的结果仍未确认/).waitFor();failReset=false;await reset.getByLabel('重置后的新密码',{exact:true}).fill('synthetic-new-intent');await reset.getByRole('button',{name:'保存新密码',exact:true}).click();await reset.waitFor({state:'detached'});assert.equal(writes.filter(item=>item.method==='PATCH').length,count+1);results.push({case:'reset-unknown-survives-close-reopen-scoped-by-user-explicit-new-intent-only',pass:true});
    }
    await page.setViewportSize({width:1440,height:940});
    await open('connections');await page.getByText('合成MAP连接',{exact:true}).filter({visible:true}).waitFor();
    results.push({case:'authorized-connection-records-first',firstData:await point('合成MAP连接')});
    await page.screenshot({path:path.join(out,'connections-desktop.png')});
    if(!baseline){
      const first={...connections[0]};connections.splice(0,connections.length,...Array.from({length:9},(_,i)=>({...first,id:`fixture-map-${i}`,name:`合成连接 ${i}：长期使用的跨项目自动化与缺陷转发连接`,partnerBaseUrl:`https://map.example.invalid/very-long-path/${'fixture-'.repeat(8)}${i}`,scopes:['bug-report','project:configuration:read','long-scope:permission:description']})));
      await page.reload();await page.getByText('合成连接 8：长期使用的跨项目自动化与缺陷转发连接',{exact:true}).filter({visible:true}).waitFor();
      const verify=page.getByRole('button',{name:'验证缺陷转发',exact:true});const verifyBounds=await verify.boundingBox();assert(verifyBounds.y>=0&&verifyBounds.y+verifyBounds.height<=940);
      assert.equal(await page.getByText('长期有效',{exact:true}).first().evaluate(e=>getComputedStyle(e).whiteSpace),'nowrap');
      await page.screenshot({path:path.join(out,'connections-many-desktop.png')});
      await page.setViewportSize({width:390,height:940});
      const firstCard=page.locator('[data-connection-card="fixture-map-0"]');await firstCard.waitFor();
      const revoke=firstCard.getByRole('button',{name:'撤销连接 fixture-map-0',exact:true}),remove=firstCard.getByRole('button',{name:'删除连接 fixture-map-0',exact:true});
      for(const button of [revoke,remove]){const box=await button.boundingBox();assert(box.x>=0&&box.x+box.width<=390&&box.height>=40,'核心连接操作缺少可见热区');}
      await firstCard.getByText('完整连接地址',{exact:true}).click();await firstCard.locator('details code').waitFor();
      assert((await firstCard.locator('details code').innerText()).includes('very-long-path'));
      await firstCard.getByText('完整连接地址',{exact:true}).click();
      await page.getByRole('textbox',{name:'搜索连接',exact:true}).fill('合成连接 8');
      const target=page.locator('[data-connection-card="fixture-map-8"]');await target.waitFor();assert.equal(await page.locator('[data-connection-card]').count(),1);
      const targetAction=target.getByRole('button',{name:'撤销连接 fixture-map-8',exact:true});const actionBox=await targetAction.boundingBox();assert(actionBox.x>=0&&actionBox.x+actionBox.width<=390);
      await assertConfirmationKeyboard(page,targetAction,/fixture-map-8/);
      await page.getByRole('textbox',{name:'搜索连接',exact:true}).fill('');
      await page.screenshot({path:path.join(out,'connections-many-390.png')});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert(await verify.isVisible());
      results.push({case:'mobile-object-actions-address-and-search-stay-reachable',pass:true,actionBox});
      await page.setViewportSize({width:1440,height:940});results.push({case:'long-nine-connections-keep-verification-visible-and-badges-unwrapped',pass:true,verifyBounds});
      failTrust=true;await page.reload();await page.getByText('MAP 授权状态未确认',{exact:true}).waitFor();
      await page.getByText('已授权',{exact:true}).waitFor();
      assert.equal(await page.getByText('未确认',{exact:true}).count(),1);
      failTrust=false;await page.getByRole('button',{name:'重新读取状态',exact:true}).click();await page.getByText('合成连接 0：长期使用的跨项目自动化与缺陷转发连接',{exact:true}).filter({visible:true}).waitFor();
      failForwarding=true;await page.reload();await page.getByText('MAP 授权状态未确认',{exact:true}).waitFor();
      await page.getByText('已授权',{exact:true}).waitFor();assert.equal(await page.getByText('未确认',{exact:true}).count(),1);
      results.push({case:'independent-permission-state-failure-stays-unknown',pass:true});
    }
    assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(out,'results.json'),JSON.stringify({provenance:'deterministic-fixture',baseline,results,writes,errors},null,2));
    return results;
  }catch(error){await page.screenshot({path:path.join(out,'failure.png')});await fs.writeFile(path.join(out,'failure.txt'),`${error.stack}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`);throw error;}finally{releaseCreate?.();await context.close();}
}
