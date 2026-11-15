import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {resolveFixture,isEventStream} from './fixtures/mobile-layout-fixtures.mjs';

/** Deterministic settings-state fixtures; every API and all credential writes terminate here. */
export async function verifySettingsTrust(browser,base,out,{baseline=false}={}){
  await fs.mkdir(out,{recursive:true});const context=await browser.newContext({viewport:{width:1440,height:940}});
  let mongoHealthy;
  let failSsoWrite=false,ssoReadOverride=null,whitelistReadOverride=null,identityReadOverride=null,identityIssueFailure=false,identityStatusFailure=false;
  let failSso=0,managedSso=false,ssoGate,releaseSso,wrappedMe=false,whitelist=['alpha-org'],failWhitelist=false,whitelistReadFailure=false;
  let sso={enabled:false,providerId:'fixture-sso',label:'合成企业登录',authorizationUrl:'https://sso.example.invalid/authorize',tokenUrl:'https://sso.example.invalid/token',clientId:'fixture-console',hasClientSecret:true,managedByEnvironment:false,defaultRedirect:'/project-list'};
  const rows=['alpha','beta'].map((suffix,index)=>({principal:{id:`principal-${suffix}`,name:'guest',kind:'human',status:'active',createdAt:`2026-11-${10+index}T00:00:00Z`,createdBy:`fixture-creator-${suffix}`},activeCredentials:[],retiredCredentials:[],grants:[]}));
  const results=[],writes=[],errors=[];
  await context.route('**/api/**',async route=>{
    const request=route.request(),p=new URL(request.url()).pathname.replace(/^\/_cds/,''),method=request.method();
    if(isEventStream(p)||p==='/api/activity-stream')return route.fulfill({contentType:'text/event-stream',body:': deterministic fixture\n\n'});
    if(p==='/api/client-events')return route.fulfill({json:{ok:true}});
    if(method!=='GET')writes.push({method,path:p,keys:Object.keys(request.postDataJSON()||{})});
    if(p==='/api/auth/status')return route.fulfill({json:{enabled:true,authenticated:true,mode:'basic',user:{id:'fixture-owner',authProvider:'local',username:'fixture-owner',name:'合成所有者',isSystemOwner:true}}});
    if(p==='/api/me')return route.fulfill({json:wrappedMe?{user:{id:'fixture-owner',username:'fixture-owner',name:'合成所有者'}}:{username:'fixture-owner'}});
    if(p==='/api/storage-mode')return route.fulfill({json:{kind:'mongo-split',mode:'mongo-split',mongoDb:'fixture-db',splitCollections:[],...(typeof mongoHealthy==='boolean'?{mongoHealthy}:{}),startupEnv:{},envFile:{exists:true,path:'/fixture/.cds.env'}}});
    if(p==='/api/cluster/status')return route.fulfill({json:{effectiveRole:'standalone',mode:'standalone',remoteExecutorCount:0}});
    if(p==='/api/auth/sso/config'){
      if(method==='GET')return route.fulfill(failSso?{status:failSso,json:{error:failSso===403?'合成权限拒绝':'合成SSO读取失败'}}:{json:{...(ssoReadOverride??sso),managedByEnvironment:managedSso}});
      if(ssoGate)await ssoGate;sso={...sso,...request.postDataJSON(),hasClientSecret:true};delete sso.clientSecret;return route.fulfill(failSsoWrite?{status:500,json:{error:'合成SSO写结果未知'}}:{json:sso});
    }
    if(p==='/api/cds-system/github/app-whitelist'){
      if(method==='GET')return route.fulfill(whitelistReadFailure?{status:500,json:{error:'合成名单读取失败'}}:{json:{allowedOwners:whitelistReadOverride??whitelist,ownerSuggestions:[{owner:'beta-org',count:2,blockedCount:1,linked:false}]}});
      whitelist=request.postDataJSON().allowedOwners;
      return route.fulfill(failWhitelist?{status:500,json:{error:'合成写入结果未确认'}}:{json:{allowedOwners:whitelist}});
    }
    if(p==='/api/identity/overview')return route.fulfill({json:{rows:identityReadOverride??rows,unclaimed:[],archivedCount:0}});
    if(p.startsWith('/api/identity/principals/')&&p.endsWith('/status')&&method==='POST'){const id=p.split('/').at(-2),row=rows.find(row=>row.principal.id===id);assert(row);identityReadOverride=structuredClone(rows);row.principal.status=request.postDataJSON().status;return route.fulfill(identityStatusFailure?{status:500,json:{error:'合成主体写结果未知'}}:{json:{ok:true}});}
    if(p==='/api/identity/user-credentials'&&method==='POST'){
      const input=request.postDataJSON(),row=rows.find(row=>row.principal.id===input.principalId);
      assert(row,'fixture only permits explicit existing principal');if(identityIssueFailure)identityReadOverride=structuredClone(rows);const credential={id:row.activeCredentials.length?'fixture-credential-beta-extra':'fixture-credential-beta',kind:'user',status:'active',createdAt:'2026-11-15T00:00:00Z'};row.activeCredentials.push(credential);
      if(identityIssueFailure)return route.fulfill({status:500,json:{error:'合成签发回包未知'}});return route.fulfill({status:201,json:{principal:row.principal,credential,plaintext:'cdsu_SYNTHETIC_ONLY_NOT_A_VALID_SECRET',reach:'合成凭证仅供状态机测试，无实际权限。'}});
    }
    if(method!=='GET')throw Error(`Unplanned fixture mutation ${method} ${p}`);
    return route.fulfill({json:resolveFixture(p)??{}});
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const open=async tab=>{await page.goto(`${base}/cds-settings#${tab}`);await page.locator('[role="tabpanel"][data-state="active"]').waitFor();};
  const point=async locator=>locator.evaluate(element=>{const r=element.getBoundingClientRect();return {top:r.top,height:r.height,viewport:innerHeight};});
  try{
    await open('overview');await page.getByText('fixture-db',{exact:true}).waitFor();
    const ready=await page.getByText('Mongo split 已就绪',{exact:true}).count()>0;
    results.push({case:'undefined-health-is-not-ready',pass:!ready});if(!baseline)assert(!ready);
    await page.screenshot({path:path.join(out,'overview-unknown.png')});
    if(!baseline){wrappedMe=true;await page.reload();await page.getByText('fixture-owner',{exact:true}).waitFor();results.push({case:'nested-current-user-contract-renders',pass:true});}
    await open('storage');await page.getByText('fixture-db',{exact:true}).first().waitFor();
    const falseMode=await page.getByText(/当前不是 mongo-split/).count()>0;results.push({case:'empty-collections-do-not-claim-wrong-storage-mode',pass:!falseMode});if(!baseline)assert(!falseMode);
    await page.screenshot({path:path.join(out,'storage-unknown.png')});
    if(!baseline){await page.getByText('未提供连接地址',{exact:true}).waitFor();assert.equal(await page.getByText('未连接',{exact:true}).count(),0);mongoHealthy=true;await page.getByRole('button',{name:'重新读取',exact:true}).click();await page.getByText('Mongo split 连接正常',{exact:true}).waitFor();await page.getByText('未提供连接地址',{exact:true}).waitFor();mongoHealthy=undefined;results.push({case:'undisclosed-uri-never-claims-disconnected-for-unknown-or-healthy-connection',pass:true});}
    await open('auth');const provider=page.getByRole('textbox',{name:'提供方标识',exact:true});await provider.waitFor();results.push({case:'sso-first-config-field',position:await point(provider)});await page.screenshot({path:path.join(out,'auth-default.png')});
    failSso=500;await page.reload();await page.getByText(baseline?'当前会话无权读取 SSO 配置。':/SSO 配置读取失败/).waitFor();
    const inventedDenial=await page.getByText(/无权读取 SSO 配置/).count()>0;results.push({case:'read-error-does-not-invent-permission-denial',pass:!inventedDenial});if(!baseline)assert(!inventedDenial);await page.screenshot({path:path.join(out,'auth-read-error.png')});
    if(!baseline){
      failSso=403;await page.getByRole('button',{name:'重新读取 SSO 配置',exact:true}).click();await page.getByText('当前会话无权读取 SSO 配置，请联系系统所有者。',{exact:true}).waitFor();
      failSso=0;await page.getByRole('button',{name:'重新读取 SSO 配置',exact:true}).click();await provider.waitFor();await provider.fill('fixture-edited');
      ssoGate=new Promise(resolve=>releaseSso=resolve);await page.getByRole('button',{name:'保存 SSO 配置',exact:true}).click();assert(await provider.isDisabled());releaseSso();ssoGate=null;
      await page.getByText('配置已保存并立即生效',{exact:true}).waitFor();assert.equal(await provider.inputValue(),'fixture-edited');
      ssoReadOverride=structuredClone(sso);failSsoWrite=true;await provider.fill('  fixture-unknown-write  ');await page.getByRole('textbox',{name:'登录后默认页面',exact:true}).fill('');await page.getByRole('button',{name:'保存 SSO 配置',exact:true}).click();await page.getByText(/保存结果未确认，请先重新读取核对/).waitFor();await page.getByRole('button',{name:'重新读取核对',exact:true}).click();await page.getByRole('button',{name:'已核对配置与登录，准备新修改',exact:true}).waitFor();assert(await page.getByRole('button',{name:'保存 SSO 配置',exact:true}).isDisabled());ssoReadOverride=null;await page.getByRole('button',{name:'重新读取核对',exact:true}).click();await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='保存 SSO 配置')?.disabled);failSsoWrite=false;results.push({case:'sso-old-get-does-not-resolve-unknown-matching-read-does',pass:true});
      const secretField=page.getByLabel('客户端密钥',{exact:true});await secretField.fill('SECRET_SYNTHETIC_ONLY_SSO');failSsoWrite=true;const ssoWrites=writes.filter(write=>write.path==='/api/auth/sso/config').length;await page.getByRole('button',{name:'保存 SSO 配置',exact:true}).click();await page.getByText(/保存结果未确认，请先重新读取核对/).waitFor();await open('overview');await open('auth');await page.getByRole('button',{name:'已核对配置与登录，准备新修改',exact:true}).waitFor();assert(await page.getByRole('button',{name:'保存 SSO 配置',exact:true}).isDisabled());assert.equal(await secretField.inputValue(),'SECRET_SYNTHETIC_ONLY_SSO');assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('SECRET_SYNTHETIC_ONLY_SSO')||JSON.stringify(sessionStorage).includes('SECRET_SYNTHETIC_ONLY_SSO')),false);await page.getByRole('button',{name:'已核对配置与登录，准备新修改',exact:true}).click();assert.equal(writes.filter(write=>write.path==='/api/auth/sso/config').length,ssoWrites+1);failSsoWrite=false;results.push({case:'sso-secret-unknown-and-draft-survive-real-tabs-not-disk-explicit-preparation-no-post',pass:true});
      managedSso=true;await page.getByRole('button',{name:'重新读取核对',exact:true}).click();await page.getByText(/当前配置由 CDS_SSO_/).waitFor();assert(await provider.isDisabled());assert(await page.getByRole('button',{name:'保存 SSO 配置',exact:true}).isDisabled());
      results.push({case:'sso-denied-slow-save-and-environment-readonly-are-distinct',pass:true});
    }
    await open('github-whitelist');await page.getByRole('button',{name:'移除 alpha-org',exact:true}).waitFor();results.push({case:'whitelist-first-effective-object',position:await point(page.getByRole('button',{name:'移除 alpha-org',exact:true}))});await page.screenshot({path:path.join(out,'whitelist-default.png')});
    await page.getByRole('button',{name:'移除 alpha-org',exact:true}).click();const falseGate=await page.getByText('兼容放行',{exact:true}).count()>0;
    results.push({case:'draft-removal-does-not-change-effective-gate-display',pass:!falseGate});if(!baseline)assert(!falseGate);
    await page.getByRole('button',{name:baseline?'刷新日志候选':'重新读取名单与日志',exact:true}).click();
    if(baseline)await page.getByRole('button',{name:'移除 alpha-org',exact:true}).waitFor();else await page.getByText('尚未允许任何组织',{exact:true}).waitFor();
    const kept=await page.getByRole('button',{name:'移除 alpha-org',exact:true}).count()===0;results.push({case:'refresh-keeps-whitelist-draft',pass:kept});
    if(!baseline){
      assert(kept);await page.getByRole('textbox',{name:'添加 GitHub owner 或组织'}).fill('beta-org');failWhitelist=true;
      whitelistReadOverride=structuredClone(whitelist);await page.getByRole('button',{name:'保存白名单',exact:true}).click();await page.getByRole('alert').filter({hasText:'保存结果未确认'}).waitFor();assert(await page.getByRole('button',{name:'保存白名单',exact:true}).isDisabled());
      await open('overview');await open('github-whitelist');await page.getByRole('alert').filter({hasText:'保存结果未确认'}).waitFor();assert.equal(await page.getByRole('textbox',{name:'添加 GitHub owner 或组织'}).inputValue(),'beta-org');results.push({case:'whitelist-unknown-and-typed-draft-survive-real-tab-roundtrip',pass:true});
      failWhitelist=false;await page.getByRole('button',{name:'重新读取名单与日志',exact:true}).click();await page.getByRole('alert').filter({hasText:'保存结果未确认'}).waitFor();assert(await page.getByRole('button',{name:'保存白名单',exact:true}).isDisabled());whitelistReadOverride=null;await page.getByRole('button',{name:'重新读取名单与日志',exact:true}).click();await page.getByText('已保存门禁：',{exact:false}).waitFor();
      assert.equal(await page.getByRole('textbox',{name:'添加 GitHub owner 或组织'}).inputValue(),'beta-org');results.push({case:'unknown-whitelist-write-readback-without-losing-pending-input',pass:true});
    }
    await open('identity');await page.getByText('guest',{exact:true}).first().waitFor();const idsVisible=await page.getByText('principal-alpha',{exact:true}).count()>0&&await page.getByText('principal-beta',{exact:true}).count()>0;
    results.push({case:'same-name-principals-have-unique-object-clues',pass:idsVisible});await page.screenshot({path:path.join(out,'identity-default.png')});
    if(!baseline){
      assert(idsVisible);const beta=page.locator('[data-principal-id="principal-beta"]');await beta.getByRole('button',{name:'为 principal-beta 补签凭证',exact:true}).click();await page.getByRole('dialog').getByText(/principal-beta/).waitFor();await page.getByRole('button',{name:'确认补签',exact:true}).click();
      const plaintext=page.getByRole('textbox',{name:'一次性凭证明文',exact:true});await plaintext.waitFor();const originalPlaintext=await plaintext.inputValue();await open('overview');await open('identity');await plaintext.waitFor();assert.equal(await plaintext.inputValue(),originalPlaintext);assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('SYNTHETIC_ONLY')||JSON.stringify(sessionStorage).includes('SYNTHETIC_ONLY')),false);results.push({case:'identity-unsaved-plaintext-survives-real-tab-roundtrip-without-storage',pass:true});await plaintext.focus();assert(await plaintext.evaluate(element=>element.selectionStart===0&&element.selectionEnd===element.value.length));
      await page.getByText(/主体编号：principal-beta · 凭证编号：fixture-credential-beta/).waitFor();
      assert(await page.locator('[data-principal-id="principal-alpha"]').getByRole('button',{name:'为 principal-alpha 补签凭证',exact:true}).isDisabled());
      await page.screenshot({path:path.join(out,'identity-synthetic-receipt.png')});await page.getByRole('button',{name:'我已存好',exact:true}).click();
      results.push({case:'issuance-result-belongs-to-confirmed-principal-and-cannot-be-overwritten',pass:true});
      identityIssueFailure=true;const issueCount=writes.filter(write=>write.path==='/api/identity/user-credentials').length;await beta.getByRole('button',{name:'为 principal-beta 补签凭证',exact:true}).click();await page.getByRole('button',{name:'确认补签',exact:true}).click();await page.getByRole('alert').filter({hasText:'签发结果未确认'}).waitFor();await open('overview');await open('identity');await page.getByRole('alert').filter({hasText:'签发结果未确认'}).waitFor();results.push({case:'identity-unknown-issuance-survives-real-tab-roundtrip',pass:true});await page.getByRole('button',{name:'重新读取',exact:true}).click();await page.getByRole('button',{name:'已核对并处理，准备新的签发',exact:true}).waitFor();assert(await beta.getByRole('button',{name:'为 principal-beta 补签凭证',exact:true}).isDisabled());assert.equal(writes.filter(write=>write.path==='/api/identity/user-credentials').length,issueCount+1);identityReadOverride=null;await page.getByRole('button',{name:'重新读取',exact:true}).click();assert(await beta.getByRole('button',{name:'为 principal-beta 补签凭证',exact:true}).isDisabled());await page.getByRole('button',{name:'已核对并处理，准备新的签发',exact:true}).click();assert.equal(writes.filter(write=>write.path==='/api/identity/user-credentials').length,issueCount+1);await page.getByRole('alert').filter({hasText:'原签发结果仍未确认'}).waitFor();identityIssueFailure=false;results.push({case:'identity-unknown-issuance-old-get-does-not-unlock-explicit-preparation-does-not-post',pass:true});
      identityStatusFailure=true;const alpha=page.locator('[data-principal-id="principal-alpha"]');await alpha.getByRole('button',{name:'停用',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'停用',exact:true}).click();await page.getByRole('alert').filter({hasText:'对象 principal-alpha 的变更结果未确认'}).waitFor();await page.getByRole('button',{name:'重新读取',exact:true}).click();await page.getByRole('alert').filter({hasText:'对象 principal-alpha 的变更结果未确认'}).waitFor();identityReadOverride=null;await page.getByRole('button',{name:'重新读取',exact:true}).click();await alpha.getByText('已停用',{exact:true}).waitFor();await alpha.getByText('主体已停用，名下凭证不可用于访问；授权记录保留。',{exact:true}).waitFor();assert.equal(await alpha.getByText(/可创建新项目/).count(),0);assert.equal(await page.getByRole('alert').filter({hasText:'对象 principal-alpha 的变更结果未确认'}).count(),0);results.push({case:'identity-status-old-get-does-not-resolve-same-object-target-state-does',pass:true});
      for(const theme of ['dark','light'])for(const tab of ['auth','github-whitelist','identity','overview','storage']){
        await page.setViewportSize({width:390,height:940});await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.documentElement.classList.toggle('dark',t==='dark');},theme);await open(tab);await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${tab} ${theme} overflow`);await page.screenshot({path:path.join(out,`${tab}-${theme}-390.png`)});
      }
    }
    assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'results.json'),JSON.stringify({provenance:'deterministic-fixture',baseline,results,writes,errors},null,2));return results;
  }catch(error){await page.screenshot({path:path.join(out,'failure.png')});await fs.writeFile(path.join(out,'failure.txt'),`${error.stack}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`);throw error;}finally{releaseSso?.();await context.close();}
}
