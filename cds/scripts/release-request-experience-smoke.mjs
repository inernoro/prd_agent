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
 let account='account-a',releasePreflight,preflightSeen=false,posts=[],records=[],lookupFailure=false,refuseBeforeStart=true,batchPosts=[];
 let simulateForce=false;
 let preflightCommitOverride;
 const sha='a'.repeat(40);let branchSha=sha;const projects=[{id:'project-a',name:'项目A',cloneStatus:'ready'},{id:'project-b',name:'项目B',cloneStatus:'ready'}];
 const run=extra=>({releaseId:'run-a',projectId:'project-a',targetId:'target-project-a',branchId:'branch-project-a',commitSha:sha,status:'success',startedAt:'2026-11-15T10:00:00Z',finishedAt:'2026-11-15T10:01:00Z',logs:[{seq:1,at:'2026-11-15T10:01:00Z',level:'info',message:'本次任务记录已接受'}],...extra});
 const batch=(project,status)=>({id:'batch-'+status,projectId:project,versionId:'version-a',reportId:'report-a',branchId:'branch-'+project,branchName:'main-'+project,commitSha:sha,status,createdAt:'2026-11-15T10:00:00Z',updatedAt:'2026-11-15T10:01:00Z',targets:[{targetId:'target-'+project,targetName:'测试环境-'+project,status,runId:'batch-run-a',previousReleaseId:'before-a',attempts:[]},{targetId:'second-'+project,targetName:'第二环境-'+project,status,runId:'batch-run-b',previousReleaseId:'before-b',attempts:[]}]});

 const interceptApi=async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname.replace(/^\/_cds/,''),method=req.method();let data;
  if(p==='/api/auth/status')data={authenticated:!!account,enabled:true,mode:'github',activeProvider:account==='github-account-a'?'github':'local',logoutEndpoint:'/api/auth/logout',postLogoutRedirect:'/login?redirect='+encodeURIComponent('/release-console?project=project-a'),user:account?{id:'stable-'+account,authProvider:account==='github-account-a'?'github':'local',name:account,username:account==='github-account-a'?null:account,githubLogin:account==='github-account-a'?'account-a':null,isSystemOwner:true}:null};
  else if(p==='/api/me')return route.fulfill({status:account?200:401,contentType:'application/json',body:JSON.stringify({user:account?{username:account}:null})});
  else if(p==='/api/auth/logout'){account=null;data={success:true};}
  else if(p.startsWith('/api/auth/github/login')){account='github-account-a';return route.fulfill({status:302,headers:{location:server.url+'/release-console?project=project-a'},body:''});}
  else if(p==='/api/auth/login'){account=req.postDataJSON().username;data={success:true};}
  else if(p==='/api/auth/public-status')data={mode:'github',loginMethods:{local:true,github:true,sso:false},sso:{enabled:false}};
  else if(p==='/api/auth/bootstrap-status')data={needsBootstrap:false};
  else if(p==='/api/projects')data={projects};
  else if(p==='/api/branches'){const project=url.searchParams.get('project');data={branches:[{id:'branch-'+project,projectId:project,branch:'main-'+project,commitSha:branchSha,previewUrl:'https://fixture.example.invalid',status:'running',services:{}},{id:'branch-second-'+project,projectId:project,branch:'second-'+project,commitSha:'b'.repeat(40),status:'running',previewUrl:'https://fixture-second.example.invalid',services:{}}]};}
  else if(p==='/api/releases/batches/accepted-versions')data={versions:[{versionId:'version-a',reportId:'report-a',reportTitle:'真实路径合成验收依据',branchId:'branch-project-a',branchName:'main-project-a',commitSha:sha,createdAt:'2026-11-15T10:00:00Z'}]};
  else if(method!=='GET'&&p.startsWith('/api/releases/batches')){batchPosts.push({path:p,body:req.postDataJSON()});return route.fulfill({status:503,json:{error:'fixture intercepted unexpected batch write'}});}
  else if(p==='/api/releases/batches'){const project=url.searchParams.get('projectId');data={batches:['ready','failed'].map(status=>batch(project,status))};}
  else if(/^\/api\/releases\/batches\/batch-(ready|failed)$/.test(p))data={batch:batch('project-'+(new URL(req.headers().referer||server.url).searchParams.get('project')==='project-b'?'b':'a'),p.endsWith('ready')?'ready':'failed')};
  else if(/^\/api\/releases\/runs\/(batch-run-[ab]|before-[ab])$/.test(p))data={run:run({releaseId:p.split('/').at(-1),targetId:p.endsWith('b')?'second-project-a':'target-project-a',commitSha:sha,logs:[]})};
  else if(p==='/api/releases/center'){const project=url.searchParams.get('project');data={rows:['target-','second-'].map((prefix,index)=>({target:{id:prefix+project,projectId:project,name:(index?'第二环境-':'测试环境-')+project,type:'site',isEnabled:true,environment:'staging'},currentVersion:'',currentCommit:'',healthStatus:'unknown',canRollback:false})),runs:[],environments:[]};}
  else if(p.endsWith('/preflight')){
   if(!preflightSeen){preflightSeen=true;await new Promise(resolve=>releasePreflight=resolve);}
   const commitSha=preflightCommitOverride ?? (p.includes('branch-second-')?'b'.repeat(40):branchSha);
   const checks=[{id:'health',label:'上线地址现状',status:'warn',message:'已有故障，允许提交发布，部署后复查。',blocking:false}];
   if(simulateForce) checks.push({id:'branch',label:'分支部署成功',status:'fail',message:'源预览暂停，普通发布被阻断。',blocking:true});
   data={ok:!simulateForce,forceAvailable:simulateForce,preflightId:'checked-'+commitSha.slice(0,8),artifact:{commitSha},checks};
  }
  else if(method==='POST'&&p.endsWith('/runs')){
   const requestId=req.headers()['x-cds-request-id'];
   const body=req.postDataJSON();
   posts.push({path:p,body,requestId});
   if(simulateForce){
    data={run:run({requestId,branchId:p.split('/').at(-2),commitSha:body.expectedCommitSha,status:'failed',forceReason:body.forceReason,
     autoRestoreStartedAt:'2026-11-15T10:00:30Z',autoRestoredAt:'2026-11-15T10:01:00Z'})};
   }else if(refuseBeforeStart){
    return route.fulfill({status:409,json:{error:'版本已前进，服务明确拒绝本次发布',releaseOutcome:'not-started',requestId}});
   }else{
    return route.fulfill({status:503,contentType:'application/json',body:'{"error":"响应中断，服务端结果待核对"}'});
   }
  }
  else if(p==='/api/releases/runs'){if(lookupFailure)return route.fulfill({status:503,contentType:'application/json',body:'{"error":"记录读取暂不可用"}'});data={runs:records};}
  else data=resolveFixture(p)??{};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 };
 await context.route('**/api/**',interceptApi);
 await page.goto(server.url+'/release-console?project=project-a');
 await page.getByRole('region',{name:'批次发布',exact:true}).waitFor();
 assert(new URL(page.url()).searchParams.get('target')===null,'正常入口保留默认批次模式，不被逐目标自动选择抢走');
 await page.getByRole('link',{name:'逐目标发布',exact:true}).click();await page.getByRole('button',{name:'开始发布',exact:true}).waitFor();await page.getByRole('button',{name:/测试环境-project-a/}).click();
 const preflightButton=()=>page.getByRole('button',{name:/^(发布前检查|重新检查)$/});
 const checkRelease=async()=>{
  await preflightButton().click();
  await page.getByText('发布前检查结果',{exact:true}).waitFor();
 };
 assert(await page.getByRole('button',{name:'开始发布',exact:true}).isDisabled(),'未预检时不能提交发布');
 await preflightButton().click();
 while(!preflightSeen)await page.waitForTimeout(20);
 const projectB=page.getByRole('button',{name:/项目B/});
 await page.screenshot({path:out+'/preflight-locked.png'});
 assert(await projectB.isDisabled(),'预检期间项目选择锁定，不悄悄发布旧对象');
 assert(await page.getByLabel('当前项目',{exact:true}).isDisabled(),'预检期间顶部项目选择也锁定');
 const pendingUrl=page.url(),batchLink=page.getByRole('link',{name:'批次发布',exact:true});
 assert(await batchLink.getAttribute('aria-disabled')==='true','预检期间两种发布方式均明确不可切换');
 await batchLink.click({force:true});assert(page.url()===pendingUrl&&posts.length===0,'预检期间点击批次导航不切换视图或发送旧对象命令');assert(await page.getByLabel('要发布的版本').isDisabled(),'预检期间来源版本锁定');releasePreflight();
 await page.getByText('已有故障，允许提交发布，部署后复查。',{exact:false}).waitFor();
 assert(posts.length===0,'旧故障告警可见，预检本身不提交发布');
 await page.getByRole('button',{name:'开始发布',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'发布请求被拒绝，未创建任务'}).waitFor();
 assert(posts.length===1&&await page.getByLabel('结果未确认的发布请求').count()===0,'明确写前拒绝不留下永久未知锁');
 assert(await page.getByRole('button',{name:'开始发布',exact:true}).isEnabled(),'明确拒绝后可核对版本重新选择并主动发起，未自动重POST');
 await page.screenshot({path:out+'/confirmed-rejection-1440.png'});
 branchSha='c'.repeat(40);await page.getByRole('button',{name:'刷新',exact:true}).click();
 await page.waitForFunction(expected=>document.querySelector('[aria-label="要发布的版本"]')?.textContent?.includes(expected),branchSha.slice(0,7));
 assert((await page.getByLabel('要发布的版本').innerText()).includes(branchSha.slice(0,7)),'写前拒绝后刷新同时重新读取来源分支，显示最新SHA');
 assert(await page.getByRole('button',{name:'开始发布',exact:true}).isDisabled(),'分支提交变化后需要重新预检');
 refuseBeforeStart=false;
 await checkRelease();
 await page.getByRole('button',{name:'开始发布',exact:true}).click();
 await page.getByRole('region',{name:'结果未确认的发布请求'}).waitFor().catch(async()=>page.getByLabel('结果未确认的发布请求').waitFor());
 await page.getByText('尚未找到本次请求，不能确认是否已执行。请保留编号并稍后再次核对。',{exact:true}).waitFor();
 assert(posts.length===2&&posts[1].body.expectedCommitSha===branchSha&&!!posts[1].requestId,'只发送一次带原完整版本及请求编号的发布命令');
 assert(await page.getByRole('button',{name:'等待核对结果',exact:true}).isDisabled(),'POST结果未知且查无记录时不开放重复发布');
 await page.screenshot({path:out+'/unknown-1440.png'});await page.setViewportSize({width:390,height:900});await page.screenshot({path:out+'/unknown-390.png'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'手机未知结果入口与原对象无整页横溢');await page.setViewportSize({width:1440,height:900});assert(await page.getByText('未开始',{exact:true}).count()===0&&await page.getByText('这个环境还没有发布过',{exact:false}).count()===0&&!(await page.getByRole('button',{name:/测试环境-project-a/}).innerText()).includes('未发布')&&await page.getByText('这个项目还没有发布记录。',{exact:true}).count()===0&&await page.getByText('发布通道空闲',{exact:true}).count()===0&&await page.getByText('当前项目暂无进行中记录',{exact:true}).count()===0,'未知写入不呈现尚未开始或从未发布的旧结论');assert(await page.getByLabel('要发布的版本').count()===0&&(await page.getByLabel('原请求来源版本').innerText()).includes(posts[1].body.expectedCommitSha.slice(0,12)),'两个分支下未知结果以只读事实固定原请求来源');branchSha='d'.repeat(40);await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForTimeout(150);assert((await page.getByLabel('原请求来源版本').innerText()).includes(posts[1].body.expectedCommitSha.slice(0,12))&&!(await page.getByLabel('原请求来源版本').innerText()).includes(branchSha.slice(0,12)),'同分支在未知期间前进，刷新仍呈现原请求SHA');const requestId=posts[1].requestId;
 // 同页新增批次入口不能绕过同目标的原未知请求；只读与其他目标继续可用。
 await page.getByRole('link',{name:'批次发布',exact:true}).click();await page.getByRole('region',{name:'批次发布',exact:true}).waitFor();
 await page.screenshot({path:out+'/batch-unknown-lock-1440.png'});
 assert(await page.getByRole('checkbox',{name:/测试环境-project-a/}).isDisabled(),'未知请求目标不能通过新建批次再次选择');
 assert(await page.getByRole('checkbox',{name:/第二环境-project-a/}).isEnabled(),'未知请求不锁住其他发布目标');
 await page.getByRole('button',{name:'历史批次',exact:true}).click();await page.getByLabel('批次记录',{exact:true}).selectOption('batch-ready');
 assert(await page.getByRole('button',{name:'确认发布到 2 个目标',exact:true}).isDisabled(),'已有ready批次包含待核对目标时不能启动');
 assert(await page.getByRole('button',{name:'核对实际运行版本',exact:true}).isEnabled()&&await page.getByRole('button',{name:'取消批次',exact:true}).isEnabled(),'未知请求仍保留批次读取与必要取消入口');
 await page.getByLabel('批次记录',{exact:true}).selectOption('batch-failed');
 const lockedTarget=page.getByRole('list',{name:'各目标发布结果'}).locator('li').filter({has:page.getByRole('heading',{name:'测试环境-project-a',exact:true})});
 const otherTarget=page.getByRole('list',{name:'各目标发布结果'}).locator('li').filter({has:page.getByRole('heading',{name:'第二环境-project-a',exact:true})});
 assert(await lockedTarget.getByRole('button',{name:'仅重试此目标',exact:true}).isDisabled()&&await lockedTarget.getByRole('button',{name:'恢复原版本',exact:true}).isDisabled(),'历史失败批次的同目标重试与回滚也遵守原请求锁');
 assert(await lockedTarget.getByRole('button',{name:'发布日志',exact:true}).isEnabled()&&await otherTarget.getByRole('button',{name:'仅重试此目标',exact:true}).isEnabled(),'锁定目标日志与其他目标重试仍可达');
 assert(batchPosts.length===0,'批次兼容核验未发送额外写命令');
 assert(await page.getByText('更新批次状态失败：',{exact:false}).count()===0,'已有ready与failed批次完整回读，无夹具详情错误');
 await page.getByRole('link',{name:'逐目标发布',exact:true}).click();await page.getByRole('button',{name:'等待核对结果',exact:true}).waitFor();

 // 真正的站内离页/返回：不靠重载才清状态。
 await page.locator('a[href$="/project-list"]').first().click();await page.waitForURL(u=>u.pathname.endsWith('/project-list'));await page.goBack();await page.getByLabel('结果未确认的发布请求').waitFor();assert(posts.length===2,'同账号离页返回仍保留未确认编号且没有重发');
 records=[run({requestId:'old-history',commitSha:posts[1].body.expectedCommitSha})];await page.getByRole('button',{name:'核对状态',exact:true}).click();await page.getByText('尚未找到本次请求，不能确认是否已执行。请保留编号并稍后再次核对。',{exact:true}).waitFor();assert(await page.getByRole('button',{name:'等待核对结果',exact:true}).isDisabled(),'相同目标和SHA的旧历史不能解锁本次未知命令');
 records=[run({requestId,commitSha:posts[1].body.expectedCommitSha}),run({requestId,releaseId:'duplicate',commitSha:posts[1].body.expectedCommitSha})];await page.getByRole('button',{name:'核对状态',exact:true}).click();await page.getByText('找到多个同编号任务，不能自动选中。请在原目标记录核对。',{exact:true}).waitFor();assert(await page.getByRole('button',{name:'查看本次结果',exact:true}).count()===0,'多匹配保持歧义，不自动选第一条');
 lookupFailure=true;await page.getByRole('button',{name:'核对状态',exact:true}).click();await page.getByText('核对失败：',{exact:false}).waitFor();assert(posts.length===2,'写结果未知与读取失败分别呈现，不重发命令');lookupFailure=false;
 await page.getByRole('button',{name:'用户设置：account-a',exact:true}).click();await page.getByRole('menuitem',{name:'退出登录',exact:true}).click();await page.getByPlaceholder('操作员用户名').waitFor();
 await page.getByPlaceholder('操作员用户名').fill('account-b');await page.getByPlaceholder('密码',{exact:true}).fill('fixture-only-password');await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL(u=>u.pathname.endsWith('/release-console'));await page.getByRole('link',{name:'逐目标发布',exact:true}).click();await page.getByRole('button',{name:'开始发布',exact:true}).waitFor();
 assert(await page.getByLabel('结果未确认的发布请求').count()===0,'同tab退出A登录B不会读取A保留请求');
 await checkRelease();
 assert(await page.getByRole('button',{name:'开始发布',exact:true}).isEnabled(),'B不被A浏览器请求状态冒充自己的任务');
 await page.getByRole('button',{name:'用户设置：account-b',exact:true}).click();await page.getByRole('menuitem',{name:'退出登录',exact:true}).click();await page.getByPlaceholder('操作员用户名').waitFor();await page.getByRole('link',{name:'使用 GitHub 登录',exact:true}).click();await page.getByRole('button',{name:'用户设置：github-account-a',exact:true}).waitFor();assert(await page.getByLabel('结果未确认的发布请求').count()===0,'全局github模式下同名GitHub主体不读取本地A请求');await page.getByRole('button',{name:'用户设置：github-account-a',exact:true}).click();await page.getByRole('menuitem',{name:'退出登录',exact:true}).click();await page.getByPlaceholder('操作员用户名').waitFor();await page.getByPlaceholder('操作员用户名').fill('account-a');await page.getByPlaceholder('密码',{exact:true}).fill('fixture-only-password');await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByLabel('结果未确认的发布请求').waitFor();assert(posts.length===2,'重新登录A恢复原编号，不重新POST');
 assert(await page.getByRole('link',{name:'批次发布',exact:true}).getAttribute('aria-current')==='page','重新登录正常默认批次入口仍显示待核对的原请求');
 records=[run({requestId,commitSha:posts[1].body.expectedCommitSha})];
 await page.getByRole('button',{name:'核对状态',exact:true}).click();await page.getByRole('button',{name:'查看本次结果',exact:true}).waitFor();
 assert(await page.getByRole('checkbox',{name:/测试环境-project-a/}).isDisabled(),'找到原任务但尚未显式查看前，批次同目标仍保持原请求锁');
 await page.getByLabel('当前项目',{exact:true}).selectOption('project-b');await page.getByRole('region',{name:'批次发布',exact:true}).waitFor();
 await page.getByRole('button',{name:'历史批次',exact:true}).click();await page.getByLabel('批次记录',{exact:true}).selectOption('batch-failed');
 assert(new URL(page.url()).searchParams.has('batch')&&new URL(page.url()).searchParams.get('batchView')==='history','先正常进入当前项目历史批次，恢复前确有批次上下文');
 await page.getByRole('button',{name:'核对状态',exact:true}).click();await page.getByRole('button',{name:'查看本次结果',exact:true}).waitFor();
 assert(await page.getByLabel('当前项目',{exact:true}).inputValue()==='project-b','批次模式中正向核对不会抢走当前项目');
 await page.screenshot({path:out+'/batch-unknown-1440.png'});
 await page.getByRole('button',{name:'查看本次结果',exact:true}).click();await page.getByText('本次任务记录已接受',{exact:true}).waitFor();
 const recoveredParams=new URL(page.url()).searchParams;
 assert(await page.getByLabel('当前项目',{exact:true}).inputValue()==='project-a'&&recoveredParams.get('mode')==='single'&&recoveredParams.get('target')==='target-project-a','批次模式显式恢复进入原项目与逐目标结果');
 assert(!recoveredParams.has('batch')&&!recoveredParams.has('batchView')&&!recoveredParams.has('intent'),'恢复结果清理批次与旧意图参数');
 await page.getByRole('button',{name:'发布所选版本',exact:true}).waitFor();assert(true,'恢复原任务后新来源版本不再被称为再发原版');await page.setViewportSize({width:390,height:900});await page.screenshot({path:out+'/recovered-390.png'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'手机恢复结果无整页横向溢出');await page.setViewportSize({width:1440,height:900});branchSha='';await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByText('来源版本未确认，请刷新分支后再发布。',{exact:true}).waitFor();assert(await page.getByRole('button',{name:'发布所选版本',exact:true}).isDisabled(),'缺少下一次来源完整版本时禁写且说明恢复入口');await page.setViewportSize({width:390,height:900});await page.screenshot({path:out+'/missing-source-390.png'});assert(posts.length===2,'整条恢复路径从未自动重发');assert(hash()===provenance.sourceDiffSha256,'取证源码稳定');

 await page.setViewportSize({width:1440,height:900});
 preflightCommitOverride='d'.repeat(40);
 await checkRelease();
 await page.getByText('来源版本待确认',{exact:true}).waitFor();
 assert(await page.getByRole('alert').filter({hasText:'检查到的版本已变化'}).count()===0,'来源版本从未确认时仍可预检，状态不误报版本变化');
 assert(await page.getByRole('button',{name:'发布所选版本',exact:true}).isDisabled(),'预检里的版本不能替代工作台确认的来源');
 preflightCommitOverride=undefined;
 simulateForce=true;
 await page.getByLabel('要发布的版本').selectOption('branch-second-project-a');
 await checkRelease();
 await page.getByText('源预览暂停，普通发布被阻断。',{exact:false}).waitFor();
 const forceButton=page.getByRole('button',{name:'强制发布',exact:true});
 assert(await forceButton.isDisabled(),'未填写原因时不能强制发布');
 await page.getByLabel('强制发布原因').fill('  修复已知网关故障  ');
 await forceButton.click();
 assert(posts.length===2,'首击强制发布只展示目标并要求二次确认');
 await page.getByRole('button',{name:'确认强制发布到 测试环境-project-a',exact:true}).click();
 await page.getByText('已恢复发布前的运行版本，公网复验通过。',{exact:true}).waitFor();
 assert(posts.length===3&&posts[2].body.forceReason==='修复已知网关故障'&&posts[2].body.expectedCommitSha==='b'.repeat(40)&&posts[2].body.preflightId==='checked-bbbbbbbb','强制发布携带理由、同一预检回执和锁定版本');
 assert(await page.getByText('强制发布 · 修复已知网关故障',{exact:true}).isVisible(),'强制原因和恢复结果显示在同一记录');
 await page.screenshot({path:out+'/force-restored-1440.png'});
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await mobile.route('**/api/**',interceptApi);
 const mobilePage=await mobile.newPage();
 await mobilePage.goto(server.url+'/release-console?project=project-a&mode=single');
 const mobileBranch=mobilePage.getByLabel('要发布的版本');
 await mobileBranch.selectOption('branch-second-project-a');
 await mobilePage.getByRole('button',{name:'发布前检查',exact:true}).tap();
 await mobilePage.getByText('源预览暂停，普通发布被阻断。',{exact:false}).waitFor();
 assert(await mobilePage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'触控移动端预检结果无整页横向溢出');
 await mobilePage.screenshot({path:out+'/force-preflight-390.png'});
}catch(error){results.push({name:'流程完成',pass:false,error:String(error)});const failedPage=browser?.contexts()[0]?.pages()[0];if(failedPage){await failedPage.screenshot({path:out+'/failure.png'}).catch(()=>{});fs.writeFileSync(out+'/failure.txt',failedPage.url()+'\n'+await failedPage.locator('body').innerText().catch(()=>''));}process.exitCode=1}finally{fs.writeFileSync(out+'/results.json',JSON.stringify({provenance,results},null,2));console.log(JSON.stringify(results));await browser?.close();server.stop()}
