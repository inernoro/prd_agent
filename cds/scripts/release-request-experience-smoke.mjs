import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const arg=(n,d)=>{const i=process.argv.indexOf(n);return i<0?d:process.argv[i+1]};
const root=arg('--source',path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')),out=arg('--out','/tmp/cds-release-request');fs.mkdirSync(out,{recursive:true});
const {startViteDevServer}=await import(pathToFileURL(root+'/cds/scripts/lib/vite-dev-server.mjs'));
const {resolveFixture}=await import(pathToFileURL(root+'/cds/scripts/fixtures/mobile-layout-fixtures.mjs'));
const hash=()=>createHash('sha256').update(execFileSync('git',['diff','HEAD','--','cds/web/src'],{cwd:root})).digest('hex');
const provenance={kind:'deterministic-fixture',sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDiffSha256:hash(),scriptSha256:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex')};
const results=[],assert=(condition,name)=>{results.push({name,pass:!!condition});if(!condition)throw Error(name)};
const server=await startViteDevServer();let browser;
try{
 browser=await chromium.launch({executablePath:process.env.PW_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'}),page=await context.newPage();
 await context.addInitScript(()=>{window.EventSource=class{readyState=1;constructor(){setTimeout(()=>this.onopen?.({}),0)}addEventListener(){}removeEventListener(){}close(){}}});
 let account='account-a',releasePreflight,preflightSeen=false,posts=[],records=[],lookupFailure=false;
 const sha='a'.repeat(40),projects=[{id:'project-a',name:'项目A',cloneStatus:'ready'},{id:'project-b',name:'项目B',cloneStatus:'ready'}];
 const run=extra=>({releaseId:'run-a',projectId:'project-a',targetId:'target-project-a',branchId:'branch-project-a',commitSha:sha,status:'success',startedAt:'2026-11-15T10:00:00Z',finishedAt:'2026-11-15T10:01:00Z',logs:[{seq:1,at:'2026-11-15T10:01:00Z',level:'info',message:'本次任务记录已接受'}],...extra});
 await context.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname.replace(/^\/_cds/,''),method=req.method();let data;
  if(p==='/api/auth/status')data={authenticated:!!account,enabled:true,mode:'local',logoutEndpoint:'/api/auth/logout',postLogoutRedirect:'/login?redirect='+encodeURIComponent('/release-console?project=project-a'),user:account?{name:account,username:account,isSystemOwner:true}:null};
  else if(p==='/api/me')return route.fulfill({status:account?200:401,contentType:'application/json',body:JSON.stringify({user:account?{username:account}:null})});
  else if(p==='/api/auth/logout'){account=null;data={success:true};}
  else if(p==='/api/auth/login'){account=req.postDataJSON().username;data={success:true};}
  else if(p==='/api/auth/public-status')data={mode:'local',loginMethods:{local:true,github:false,sso:false},sso:{enabled:false}};
  else if(p==='/api/auth/bootstrap-status')data={needsBootstrap:false};
  else if(p==='/api/projects')data={projects};
  else if(p==='/api/branches'){const project=url.searchParams.get('project');data={branches:[{id:'branch-'+project,projectId:project,branch:'main-'+project,commitSha:sha,previewUrl:'https://fixture.example.invalid',status:'running',services:{}},{id:'branch-second-'+project,projectId:project,branch:'second-'+project,commitSha:'b'.repeat(40),status:'running',previewUrl:'https://fixture-second.example.invalid',services:{}}]};}
  else if(p==='/api/releases/center'){const project=url.searchParams.get('project');data={rows:[{target:{id:'target-'+project,projectId:project,name:'测试环境-'+project,type:'site',isEnabled:true,environment:'staging'},currentVersion:'',currentCommit:'',healthStatus:'unknown',canRollback:false}],runs:[],environments:[]};}
  else if(p.endsWith('/preflight')){preflightSeen=true;await new Promise(resolve=>releasePreflight=resolve);data={checks:[]};}
  else if(method==='POST'&&p.endsWith('/runs')){posts.push({path:p,body:req.postDataJSON(),requestId:req.headers()['x-cds-request-id']});return route.fulfill({status:503,contentType:'application/json',body:'{"error":"响应中断，服务端结果待核对"}'});}
  else if(p==='/api/releases/runs'){if(lookupFailure)return route.fulfill({status:503,contentType:'application/json',body:'{"error":"记录读取暂不可用"}'});data={runs:records};}
  else data=resolveFixture(p)??{};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto(server.url+'/release-console?project=project-a');await page.getByRole('button',{name:'开始发布',exact:true}).waitFor();
 await page.getByRole('button',{name:'开始发布',exact:true}).click();await page.waitForFunction(()=>true);while(!preflightSeen)await page.waitForTimeout(20);
 const projectB=page.getByRole('button',{name:/项目B/});
 await page.screenshot({path:out+'/preflight-locked.png'});
 assert(await projectB.isDisabled(),'预检期间项目选择锁定，不悄悄发布旧对象');assert(await page.getByLabel('要发布的版本').isDisabled(),'预检期间来源版本锁定');releasePreflight();
 await page.getByRole('region',{name:'结果未确认的发布请求'}).waitFor().catch(async()=>page.getByLabel('结果未确认的发布请求').waitFor());
 await page.getByText('尚未找到本次请求，不能确认是否已执行。请保留编号并稍后再次核对。',{exact:true}).waitFor();
 assert(posts.length===1&&posts[0].body.expectedCommitSha===sha&&!!posts[0].requestId,'只发送一次带原完整版本及请求编号的发布命令');
 assert(await page.getByRole('button',{name:'等待核对结果',exact:true}).isDisabled(),'POST结果未知且查无记录时不开放重复发布');
 await page.screenshot({path:out+'/unknown-1440.png'});await page.setViewportSize({width:390,height:900});await page.screenshot({path:out+'/unknown-390.png'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'手机未知结果入口与原对象无整页横溢');await page.setViewportSize({width:1440,height:900});assert(await page.getByText('未开始',{exact:true}).count()===0&&await page.getByText('这个环境还没有发布过',{exact:false}).count()===0&&await page.getByText('未发布',{exact:false}).count()===0&&await page.getByText('这个项目还没有发布记录。',{exact:true}).count()===0&&await page.getByText('发布通道空闲',{exact:true}).count()===0&&await page.getByText('当前项目暂无进行中记录',{exact:true}).count()===0,'未知写入不呈现尚未开始或从未发布的旧结论');assert(await page.getByLabel('要发布的版本').isDisabled()&&await page.getByLabel('要发布的版本').inputValue()==='branch-project-a','两个分支下未知结果固定原请求来源，不能换成下一次草稿');const requestId=posts[0].requestId;
 // 真正的站内离页/返回：不靠重载才清状态。
 await page.locator('a[href$="/project-list"]').first().click();await page.waitForURL(u=>u.pathname.endsWith('/project-list'));await page.goBack();await page.getByLabel('结果未确认的发布请求').waitFor();assert(posts.length===1,'同账号离页返回仍保留未确认编号且没有重发');
 records=[run({requestId:'old-history'})];await page.getByRole('button',{name:'核对状态',exact:true}).click();await page.getByText('尚未找到本次请求，不能确认是否已执行。请保留编号并稍后再次核对。',{exact:true}).waitFor();assert(await page.getByRole('button',{name:'等待核对结果',exact:true}).isDisabled(),'相同目标和SHA的旧历史不能解锁本次未知命令');
 records=[run({requestId}),run({requestId,releaseId:'duplicate'})];await page.getByRole('button',{name:'核对状态',exact:true}).click();await page.getByText('找到多个同编号任务，不能自动选中。请在原目标记录核对。',{exact:true}).waitFor();assert(await page.getByRole('button',{name:'查看本次结果',exact:true}).count()===0,'多匹配保持歧义，不自动选第一条');
 lookupFailure=true;await page.getByRole('button',{name:'核对状态',exact:true}).click();await page.getByText('核对失败：',{exact:false}).waitFor();assert(posts.length===1,'写结果未知与读取失败分别呈现，不重发命令');lookupFailure=false;
 await page.getByRole('button',{name:'用户设置：account-a',exact:true}).click();await page.getByRole('menuitem',{name:'退出登录',exact:true}).click();await page.getByPlaceholder('操作员用户名').waitFor();
 await page.getByPlaceholder('操作员用户名').fill('account-b');await page.getByPlaceholder('密码',{exact:true}).fill('fixture-only-password');await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL(u=>u.pathname.endsWith('/release-console'));await page.getByRole('button',{name:'开始发布',exact:true}).waitFor();
 assert(await page.getByLabel('结果未确认的发布请求').count()===0,'同tab退出A登录B不会读取A保留请求');assert(await page.getByRole('button',{name:'开始发布',exact:true}).isEnabled(),'B不被A浏览器请求状态冒充自己的任务');
 await page.getByRole('button',{name:'用户设置：account-b',exact:true}).click();await page.getByRole('menuitem',{name:'退出登录',exact:true}).click();await page.getByPlaceholder('操作员用户名').waitFor();await page.getByPlaceholder('操作员用户名').fill('account-a');await page.getByPlaceholder('密码',{exact:true}).fill('fixture-only-password');await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByLabel('结果未确认的发布请求').waitFor();assert(posts.length===1,'重新登录A恢复原编号，不重新POST');
 records=[run({requestId})];await page.getByRole('button',{name:/项目B/}).click();await page.getByText('测试环境-project-b',{exact:true}).first().waitFor();await page.getByRole('button',{name:'核对状态',exact:true}).click();await page.getByRole('button',{name:'查看本次结果',exact:true}).waitFor();assert(await page.getByRole('button',{name:/项目B/}).getAttribute('aria-pressed')==='true','正向核对不会抢走用户当前项目');
 await page.getByRole('button',{name:'查看本次结果',exact:true}).click();await page.getByText('本次任务记录已接受',{exact:true}).waitFor();assert(await page.getByRole('button',{name:/项目A/}).getAttribute('aria-pressed')==='true','显式查看结果回到原对象并展示真实记录');
 await page.setViewportSize({width:390,height:900});await page.screenshot({path:out+'/recovered-390.png'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'手机恢复结果无整页横向溢出');assert(posts.length===1,'整条恢复路径从未自动重发');assert(hash()===provenance.sourceDiffSha256,'取证源码稳定');
}catch(error){results.push({name:'流程完成',pass:false,error:String(error)});process.exitCode=1}finally{fs.writeFileSync(out+'/results.json',JSON.stringify({provenance,results},null,2));console.log(JSON.stringify(results));await browser?.close();server.stop()}
