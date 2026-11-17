import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const arg=(n,d)=>{const i=process.argv.indexOf(n);return i<0?d:process.argv[i+1]};
const root=arg('--source',path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')),out=arg('--out','/tmp/cds-read-experience');fs.mkdirSync(out,{recursive:true});
const {startViteDevServer}=await import(pathToFileURL(root+'/cds/scripts/lib/vite-dev-server.mjs'));
const {resolveFixture}=await import(pathToFileURL(root+'/cds/scripts/fixtures/mobile-layout-fixtures.mjs'));
const hash=()=>createHash('sha256').update(execFileSync('git',['diff','HEAD','--','cds/web/src'],{cwd:root})).digest('hex');
const FIXED_NOW=Date.parse('2026-11-15T10:00:00Z');
const provenance={kind:'deterministic-fixture',sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDiffSha256:hash(),scriptSha256:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex')};
const results=[],server=await startViteDevServer();let browser;
try{
 browser=await chromium.launch({executablePath:process.env.PW_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox']});
 for(const width of arg('--widths','1440,390').split(',').map(Number))for(const theme of arg('--themes','light,dark').split(','))for(const family of arg('--families','tasks,public,overview,status').split(',')){
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'}),page=await context.newPage();
  const label=`${family}-${width}-${theme}`;console.log('scenario '+label);page.setDefaultTimeout(10000);
  const check=(pass,name)=>{results.push({family,width,theme,name,pass:!!pass});if(!pass)throw Error(name)};
  await context.addInitScript(({theme,fixedNow})=>{const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){if(args.length)super(...args);else super(window.__fixtureNow??fixedNow)}static now(){return window.__fixtureNow??fixedNow}};localStorage.setItem('cds_theme',theme);window.EventSource=class{readyState=1;constructor(){setTimeout(()=>this.onopen?.({}),0)}addEventListener(){}removeEventListener(){}close(){}};const original=setInterval;window.setInterval=(fn,ms,...args)=>ms===30000?original(()=>{if(window.__pollFast)fn(...args)},200):original(fn,ms,...args)},{theme,fixedNow:FIXED_NOW});
  // The public token uses direct application navigation. No production or remote data.
  let mode=family==='tasks'?'fail':'good',version='V2',reads=0,releaseOld;
  const jobs=v=>({jobs:(resolveFixture('/api/scheduled-jobs').jobs).map(job=>({...job,lastRunAt:new Date(FIXED_NOW-(job.id==='fixture-job-normal'?54000000:job.id==='fixture-job-attention'?1800000:2400000)+500).toISOString(),nextRunAt:new Date(FIXED_NOW+(job.id==='fixture-job-normal'?32400000:job.id==='fixture-job-attention'?1800000:1200000)).toISOString(),nextRuns:[new Date(FIXED_NOW+(job.id==='fixture-job-normal'?32400000:job.id==='fixture-job-attention'?1800000:1200000)).toISOString()],name:job.id==='fixture-job-normal'?'巡检任务'+v:job.name}))});
  const graph=v=>({generatedAt:'2026-11-15T10:00:00Z',summary:{errors:0,warnings:0,infos:0},projects:Array.from({length:3},(_,i)=>({projectId:i?'fixture-project-'+i:'fixture-project',slug:i?'样例系统-'+i:'synthetic-business-integration-service-platform-development',name:i?'合成项目'+i:'项目'+v+'：覆盖订单、支付、库存和通知的跨团队业务工作区',branch:{id:i?'b'+i:'b0',name:i?'main':'feature/payment-reconciliation-and-multi-tenant-observability-workspace',status:'running'},branchCount:24,counts:{services:12,sites:3,apis:6,webs:2,workers:4},lint:{errors:0,warnings:0,infos:0},headline:i?'服务关系已确认':'本项目服务关系已确认，当前代表分支包括多个应用与共享基础设施；这是合成长事实，用于确保卡片自然换行后仍不覆盖后续项目。',findings:[],edges:[],inboundEdges:0}))});
  const summary=v=>{const now=FIXED_NOW;return{enabled:true,generatedAt:now,intervalSeconds:30,timeoutMs:5000,failureThreshold:2,firstDataEtaSeconds:30,lastCycleAt:now,overall:{total:1,up:1,down:0,paused:0,unknown:0,ok:true},targets:[{id:'t1',subscribed:true,overviewIncluded:true,source:'custom',name:'支付可用性'+v,projectId:'fixture-project',projectName:'业务'+v,branchId:'b0',profileId:'api',probeKind:'http',probeUrl:'https://fixture.example.invalid/health',status:'up',lastSample:{t:now,up:true,ms:25,code:200},availability24h:1,availability7d:1,avgLatencyMs24h:25,sampleCount24h:20,buckets:[],openIncidentSince:null,statusSince:now,incidentCount:0,probeDescription:'业务接口检查',intervalSeconds:30,timeoutMs:5000,observeMode:'active',environment:'production',environmentLabel:'生产',measured:true}]}};
  await context.route('**/api/**',async route=>{
   const u=new URL(route.request().url()),p=u.pathname.replace(/^\/_cds/,''),matches=family==='tasks'?p==='/api/scheduled-jobs':family==='overview'?p==='/api/overview/topology':family==='status'?p==='/api/uptime/summary':p.startsWith('/api/public/status/');let data;
   if(p==='/api/auth/status')data={authenticated:true,enabled:true,mode:'github',activeProvider:'github',user:{id:'fixture-owner',authProvider:'github',githubLogin:'fixture-owner',name:'布局冒烟',isSystemOwner:true}};
   else if(matches){reads++;const captured=mode==='hold'?'V1':version;
    if(mode==='hold')await new Promise(resolve=>releaseOld=resolve);
    else if(mode==='fail')return route.fulfill({status:503,contentType:'application/json',body:'{"error":"读取接口暂不可用"}'});
    if(family==='public'){if(p.endsWith('/token-b'))return route.fulfill({status:404,contentType:'application/json',body:'{}'});data={title:'公开样例',headline:'已知快照中的业务正常',status:'ok',items:[{name:'支付接口',status:'ok',days:[{day:'2026-11-15',status:'ok'}]}],updatedAt:Date.parse('2026-11-15T09:55:00Z'),refreshHintSeconds:30};}
    else data=family==='tasks'?(mode==='empty'?{jobs:[]}:jobs(captured)):family==='overview'?graph(captured):summary(captured);
   }else if(p.endsWith('/service-graph'))data={branchId:'b0',projectId:'fixture-project',branch:'main',status:'running',graph:{nodes:[{id:'service:api',rawId:'api',name:'支付 API',kind:'service',role:'api'},{id:'service:web',rawId:'web',name:'业务 Web',kind:'service',role:'web'}],edges:[],layers:[['service:api','service:web']],sites:[],internal:['service:api','service:web']},lint:{findings:[],summary:{errors:0,warnings:0,infos:0}},references:[]};
   else if(p==='/api/scheduled-jobs/runs')data={runs:mode==='empty'?[]:resolveFixture(p).runs.map((run,i)=>({...run,queuedAt:new Date(FIXED_NOW-(run.jobId==='fixture-job-normal'?54000000:run.jobId==='fixture-job-soon'?2400000:i===0?1800000:5400000)).toISOString(),startedAt:new Date(FIXED_NOW-(run.jobId==='fixture-job-normal'?54000000:run.jobId==='fixture-job-soon'?2400000:i===0?1800000:5400000)+500).toISOString(),finishedAt:new Date(FIXED_NOW-(run.jobId==='fixture-job-normal'?54000000:run.jobId==='fixture-job-soon'?2400000:i===0?1800000:5400000)+4200).toISOString()}))};
   else if(p==='/api/uptime/incidents')data={incidents:[]};
   else data=resolveFixture(p)??{};
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  try{
   const target=family==='tasks'?'/task-schedule?project=fixture-project&job=fixture-job-normal':family==='public'?'/s/token-a':family==='overview'?'/overview':'/status';
   await page.goto(server.url+target,{waitUntil:'domcontentloaded',timeout:30000});while(!reads)await page.waitForTimeout(20);await page.waitForTimeout(180);
   const clickAction=async(name)=>{let button=page.getByRole('button',{name,exact:true}).first();if(!await button.isVisible()){await page.getByRole('button',{name:'更多操作',exact:true}).click();button=page.getByRole('button',{name,exact:true}).first()}await button.click();const more=page.getByRole('button',{name:'更多操作',exact:true});if(await more.count()&&await more.getAttribute('aria-expanded')==='true')await page.keyboard.press('Escape')};const refresh=async()=>{const retry=page.getByRole('button',{name:'重试读取',exact:true});if(await retry.count()&&await retry.isVisible())await retry.click();else await clickAction('刷新')};
   if(family==='tasks'){
    await page.getByText('读取接口暂不可用',{exact:false}).first().waitFor();await page.screenshot({path:out+'/'+label+'-first-error.png'});
    check(await page.getByText('这个项目还没有定时任务',{exact:true}).count()===0,'首次读取失败不声称没有任务');
    check(await page.getByRole('button',{name:/^(新建|新建任务)$/}).count()===0,'未确认数据时不引导创建替代读取');
    mode='good';await page.getByRole('button',{name:'重试读取',exact:true}).click();await page.getByText('巡检任务V2',{exact:true}).first().waitFor();
    check(new URL(page.url()).searchParams.get('job')==='fixture-job-normal','错误恢复保留任务选择');
   }else if(family==='public'){
    await page.getByText('已知快照中的业务正常',{exact:true}).waitFor();mode='fail';await refresh();await page.waitForTimeout(150);await page.screenshot({path:out+'/'+label+'-refresh-error.png'});
    check(await page.getByRole('alert').count()>0,'公开旧绿快照在刷新失败时明确标记');check(await page.getByText('上次成功读取的状态：已知快照中的业务正常',{exact:true}).isVisible(),'读取失败主状态明确为旧业务快照');
    mode='good';await refresh();await page.waitForTimeout(150);check(await page.getByRole('alert').count()===0,'成功重新读取后解除读取失败状态');
    await page.evaluate(()=>{history.pushState({idx:1},'','/s/token-b');dispatchEvent(new PopStateEvent('popstate'))});await page.getByText('这个状态页不存在或已关闭',{exact:true}).waitFor();check(await page.getByText('已知快照中的业务正常',{exact:true}).count()===0,'同Router切换无效token不保留上一公开状态');
    continue;
   }else if(family==='overview'){
    await page.getByText('项目V2',{exact:false}).first().waitFor();
    const canvas=page.getByTestId('overview-page').locator(':scope > div').first();const measure=await canvas.evaluate(e=>{const c=e.getBoundingClientRect(),nodes=[...e.querySelectorAll('[data-project]')],node=nodes[0],link=e.querySelector('a');const rects=nodes.map(n=>n.getBoundingClientRect()),n=node?.getBoundingClientRect(),a=link?.getBoundingClientRect();return{cardCount:nodes.length,cardLocalOverflow:nodes.some(n=>n.scrollWidth>n.clientWidth+1),cardOverlap:rects.some((a,i)=>rects.slice(i+1).some(b=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)),canvasWidth:c.width,firstDataY:n?.top,firstCardWithinViewport:n?n.left>=c.left&&n.right<=c.right:false,firstDataVisibleWidth:n?Math.max(0,Math.min(c.right,n.right)-Math.max(c.left,n.left)):0,coreHorizontalScroll:a?Math.max(0,a.right-c.right,c.left-a.left):0}});results.push({family,width,theme,name:'真实画布几何',pass:true,measurement:measure});
    if(width===390)check(measure.firstCardWithinViewport,'窄屏首卡标题事实与操作完整位于初始画布范围内');
    check(!measure.cardLocalOverflow&&!measure.cardOverlap,'长项目长分支多事实卡无局部溢出或前后遮挡');
    const lastNodeAction=canvas.getByRole('link',{name:'查看分支',exact:true}).last();await lastNodeAction.focus();check(await lastNodeAction.evaluate(e=>{const region=e.closest('[role=region]'),a=e.getBoundingClientRect(),b=region.getBoundingClientRect();return document.activeElement===e&&a.top>=b.top&&a.bottom<=b.bottom+1}),'键盘能进入末项目操作且画布滚动不遮挡');await canvas.evaluate(e=>{e.scrollTop=0;e.scrollLeft=0});
    check(await canvas.count()>0&&await canvas.evaluate(e=>e.getBoundingClientRect().width)>300,'窄屏画布仍可读且没有被固定侧栏挤空');
    await clickAction('只看问题');await page.getByText('当前问题筛选没有匹配的项目。',{exact:true}).waitFor();await page.getByRole('button',{name:'显示全部项目',exact:true}).click();
    check(await page.getByText('项目V2',{exact:false}).first().isVisible(),'无匹配可恢复全部项目');
   }else await page.getByText('支付可用性V2',{exact:false}).first().waitFor();
   if(family==='status'&&width===1440&&arg('--editor','no')==='yes'){await page.goto(server.url+'/status?view=owner',{waitUntil:'domcontentloaded'});const add=page.getByRole('button',{name:'添加监控',exact:true});await add.waitFor();await add.focus();await page.keyboard.press('Enter');const editor=page.getByRole('dialog',{name:'添加监控',exact:true});await editor.waitFor();await page.locator('#mon-url').waitFor();await page.waitForTimeout(250);await page.keyboard.press('Escape');await editor.waitFor({state:'hidden'});await page.waitForTimeout(1500);check(await add.evaluate(e=>e===document.activeElement),'真实监控autoFocus编辑器只打开取消后回入口');await page.goto(server.url+'/status',{waitUntil:'domcontentloaded'});await page.getByText('支付可用性V2',{exact:false}).first().waitFor();}
   mode='fail';await refresh();await page.waitForTimeout(170);await page.screenshot({path:out+'/'+label+'-last-good.png'});
   const content=family==='tasks'?'巡检任务V2':family==='overview'?'项目V2':'支付可用性V2';
   check(await page.getByText(content,{exact:false}).first().isVisible(),'刷新失败保留有效快照与当前任务');
   check(await page.getByText('刷新失败',{exact:false}).count()>0||await page.getByText('任务读取失败',{exact:false}).count()>0,'保留快照时就近显示读取失败');
   if(family==='tasks')check(await page.getByText('上次记录：',{exact:false}).count()>0,'任务核心摘要标明上次记录');if(family==='overview')check(await page.getByText('上次体检未发现错误与警告；最新结果尚未确认。',{exact:true}).count()>0,'无问题结论不冒充最新体检');if(family==='status'){check(await page.getByText('上次概览',{exact:true}).count()>0&&await page.getByText('当前没有需要处理的异常',{exact:true}).count()===0,'监控核心结论保留旧快照范围');await page.evaluate(now=>{window.__fixtureNow=now+600000;dispatchEvent(new Event('focus'))},FIXED_NOW);await page.waitForFunction(()=>[...document.querySelectorAll('button[title]')].some(e=>e.title.startsWith('支付可用性V2 · 待确认')));const title=await page.getByRole('button',{name:/支付可用性V2/}).first().getAttribute('title');check(title?.includes('· 待确认')&&!title?.includes('· 异常'),'读取失败与后台恢复时样本按真实时钟老化为待确认而非业务down');await page.screenshot({path:out+'/'+label+'-aged-failure.png'});await page.evaluate(now=>{window.__fixtureNow=now;dispatchEvent(new Event('focus'))},FIXED_NOW);}
   mode='hold';await refresh();while(!releaseOld)await page.waitForTimeout(20);mode='good';version='V2';await page.evaluate(()=>window.__pollFast=true);await page.waitForTimeout(300);await page.evaluate(()=>window.__pollFast=false);releaseOld();await page.waitForTimeout(150);
   check(await page.getByText(content,{exact:false}).first().isVisible()&&await page.getByText(family==='tasks'?'巡检任务V1':family==='overview'?'项目V1':'支付可用性V1',{exact:false}).count()===0,'慢旧读取不能覆盖较新快照');
   await page.screenshot({path:out+'/'+label+'-ready.png'});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'整页没有横向溢出');
   if(family==='tasks'){mode='empty';await refresh();await page.getByText('这个项目还没有定时任务',{exact:true}).waitFor();check(await page.getByText('尚未确认是否存在任务。',{exact:false}).count()===0,'真实空列表不沿用读取失败状态');const create=page.getByRole('button',{name:'新建',exact:true});await create.focus();await page.keyboard.press('Enter');await page.getByRole('dialog',{name:'新建任务',exact:true}).waitFor();await page.screenshot({path:out+'/'+label+'-empty-create.png'});await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'新建任务',exact:true}).waitFor({state:'hidden'});try{await page.waitForFunction(()=>document.activeElement instanceof HTMLButtonElement&&document.activeElement.textContent.trim()==='新建',undefined,{timeout:1500})}catch{}results.push({family,width,theme,name:'新建预览关闭后的稳定焦点',pass:true,measurement:await page.evaluate(()=>({tag:document.activeElement?.tagName,text:document.activeElement?.textContent?.trim().slice(0,50)}))});check(await create.evaluate(e=>e===document.activeElement),'真空态键盘进入新建预览后Escape回到入口，无写入');}
   if(family==='overview'){await page.getByRole('link',{name:'打开关系图',exact:true}).first().click();await page.waitForURL(u=>u.pathname.includes('/branch-relations/b0'));await page.getByText('支付 API',{exact:true}).first().waitFor();await page.getByText('业务 Web',{exact:true}).first().waitFor();check(true,'画布节点实际进入对应分支关系并读到两个合成服务对象');}
  }catch(error){console.log(label+' failed '+String(error));results.push({family,width,theme,name:'流程完成',pass:false,error:String(error)});await page.screenshot({path:out+'/'+label+'-failed.png'});process.exitCode=1}finally{await context.close()}
 }
 results.push({name:'取证源码稳定',pass:hash()===provenance.sourceDiffSha256});if(hash()!==provenance.sourceDiffSha256)process.exitCode=1;
}finally{fs.writeFileSync(out+'/results.json',JSON.stringify({provenance,results},null,2));console.log(JSON.stringify(results));await browser?.close();server.stop()}
