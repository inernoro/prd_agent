import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const arg=(n,d)=>{const i=process.argv.indexOf(n);return i<0?d:process.argv[i+1]};
const root=arg('--source',path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')),out=arg('--out','/tmp/cds-agent-snapshot');fs.mkdirSync(out,{recursive:true});
const {startViteDevServer}=await import(pathToFileURL(root+'/cds/scripts/lib/vite-dev-server.mjs'));
const {resolveFixture}=await import(pathToFileURL(root+'/cds/scripts/fixtures/mobile-layout-fixtures.mjs'));
const hash=()=>createHash('sha256').update(execFileSync('git',['diff','HEAD','--','cds/web/src'],{cwd:root})).digest('hex');
const provenance={kind:'deterministic-fixture',sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceDiffSha256:hash(),scriptSha256:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex')};
const results=[];let browser;const server=await startViteDevServer();
const assert=(condition,name)=>{results.push({name,pass:!!condition});if(!condition)throw Error(name)};
try{
 browser=await chromium.launch({executablePath:process.env.PW_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'}),page=await context.newPage();
 await context.addInitScript(()=>{window.EventSource=class{readyState=1;constructor(){setTimeout(()=>this.onopen?.({}),0)}addEventListener(){}removeEventListener(){}close(){}}});
 let streamReads=0,failStream=true,eventCount=30,holdStream=false,releaseStream,failQuery=false;
 const tail='关键末尾：确认恢复成功';
 await context.route('**/api/**',async route=>{
 const u=new URL(route.request().url()),p=u.pathname.replace(/^\/_cds/,'');let data;
 if(p==='/api/auth/status')data={authenticated:true,enabled:true,user:{name:'维护者',isSystemOwner:true},approvalCapabilities:{operator:true,accessRequests:false}};
 else if(p.match(/\/agent-sessions\/.*\/stream$/)){
  streamReads++;if(failStream)return route.fulfill({status:503,contentType:'application/json',body:'{"error":"暂时不可用"}'});
  if(holdStream)await new Promise(resolve=>releaseStream=resolve);
  return route.fulfill({status:200,contentType:'text/event-stream',body:Array.from({length:eventCount},(_,i)=>'data: '+JSON.stringify({seq:i+1,type:'delta',payload:{text:i===0?'正文'.repeat(200)+tail:'事件-'+i},createdAt:'2026-11-15T10:00:00Z'})+'\n\n').join('')});
 }else if(p.endsWith('/agent-requests')){
  if(failQuery&&u.searchParams.has('q'))return route.fulfill({status:503,contentType:'application/json',body:'{"error":"筛选读取失败"}'});
  const project=p.split('/')[3];data={items:u.searchParams.has('q')?[]:[{sessionId:'session-'+project,projectId:project,title:'核对任务-'+project,clientUser:'观察者',clientApp:'调试器',runtime:'codex',model:'fixture',status:'running',createdAt:'2026-11-15T10:00:00Z',durationMs:1000,eventCount,requestPreview:'检查发布状态',responsePreview:'正在核对',live:true}],users:['观察者'],apps:['调试器'],liveCount:1,historyCount:0};
 }else data=resolveFixture(p)??{};
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto(server.url+'/agent-requests/fixture-project');await page.getByText('核对任务-fixture-project',{exact:true}).click();await page.getByRole('button',{name:'重试事件流',exact:true}).waitFor();
 assert(streamReads===1,'首次事件读取失败可见且没有伪空记录');failStream=false;
 await page.getByRole('button',{name:'重试事件流',exact:true}).click();await page.getByRole('button',{name:'刷新事件',exact:true}).waitFor();
 const region=page.getByRole('region',{name:'本次事件快照'});await region.waitFor();
 await region.locator('summary').click();assert(await region.getByText(tail,{exact:false}).last().isVisible(),'长事件末尾可按需展开');
 assert((await page.getByTestId('live-indicator').innerText()).includes('列表实时'),'列表连接不宣称事件持续实时');
 await region.evaluate(e=>e.scrollTop=110);const before=await region.evaluate(e=>e.scrollTop);holdStream=true;
 await page.getByRole('button',{name:'刷新事件',exact:true}).click();await page.getByRole('button',{name:'读取中',exact:true}).waitFor();
 assert(await page.getByRole('button',{name:'读取中',exact:true}).isDisabled(),'事件刷新期间不可重复读取');
 const reads=streamReads;await page.waitForTimeout(100);assert(streamReads===reads,'一次刷新只发一个事件请求');
 releaseStream();holdStream=false;await page.getByRole('button',{name:'刷新事件',exact:true}).waitFor();
 assert(await region.evaluate(e=>e.scrollTop)===before,'刷新快照保留手动阅读位置');
 eventCount=35;await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByText('有更新待刷新',{exact:true}).waitFor();assert(true,'列表事件增多明确提示旧快照');
 await page.screenshot({path:out+'/snapshot-ready.png'});
 failStream=true;await page.getByRole('button',{name:'刷新事件',exact:true}).click();await page.getByText('下方保留上次成功读取的快照。',{exact:false}).waitFor();assert(await region.isVisible(),'刷新失败保留并标记上次成功快照');
 await page.setViewportSize({width:390,height:900});await region.evaluate(e=>e.scrollTop=0);await page.screenshot({path:out+'/snapshot-error-390.png'});await region.locator('details[open] pre').evaluate(e=>{const range=document.createRange();const text=e.firstChild;range.setStart(text,text.length-12);range.setEnd(text,text.length);const r=range.getBoundingClientRect(),box=e.closest('[role=region]');box.scrollTop+=r.bottom-box.getBoundingClientRect().bottom+24});await page.screenshot({path:out+'/snapshot-tail-390.png'});assert(await region.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'窄屏展开事件局部无横溢');assert(await region.locator('details[open] pre').evaluate(e=>e.clientWidth>200),'窄屏完整事件保持可读文本列');await page.setViewportSize({width:1440,height:900});failQuery=true;await page.getByLabel('搜索 Agent 请求').fill('无匹配');await page.getByRole('alert').waitFor();assert(await page.getByText('核对任务-fixture-project',{exact:true}).count()===0,'新筛选失败不冒充旧范围结果');
 failQuery=false;await page.getByRole('button',{name:'重试读取',exact:true}).click();await page.getByRole('button',{name:'清除筛选',exact:true}).waitFor();await page.getByRole('button',{name:'清除筛选',exact:true}).click();await page.getByText('核对任务-fixture-project',{exact:true}).waitFor();assert(true,'无匹配可清除筛选恢复原范围');
 await page.goto(server.url+'/agent-requests/project-b');await page.getByText('核对任务-project-b',{exact:true}).waitFor();assert(await page.getByText('核对任务-fixture-project',{exact:true}).count()===0,'切换项目不残留前项目记录和事件');
 await page.setViewportSize({width:390,height:900});await page.screenshot({path:out+'/project-b-390.png'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'窄屏列表无整页横向溢出');
 assert(hash()===provenance.sourceDiffSha256,'取证期间源码稳定');
}catch(error){results.push({name:'流程完成',pass:false,error:String(error)});process.exitCode=1}finally{fs.writeFileSync(out+'/results.json',JSON.stringify({provenance,results},null,2));console.log(JSON.stringify(results));await browser?.close();server.stop()}
