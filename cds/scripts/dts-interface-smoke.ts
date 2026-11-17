/** Isolated native regression, not a published acceptance report. A normal login follows the visible project-tools entry. */
import fs from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createClient } from 'redis';
import { chromium } from 'playwright';
import { Client } from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { withDtsSql } from '../src/services/dts-sql.js';
import type { DtsConnection } from '../src/shared/dts.js';
const folder=process.env.DTS_DRILL_DIRECTORY;if(!folder?.startsWith('/tmp/'))throw new Error('Explicit disposable directory required');
const c=JSON.parse(await fs.readFile(folder+'/interface-context.json','utf8')),credentials=JSON.parse(await fs.readFile(c.workspace+'/.cds/credentials.json','utf8'));
const env={...process.env,CDS_HOST:c.origin,CDS_PROJECT_ID:c.projectId,CDS_PROJECT_KEY:credentials.projectKey,AI_ACCESS_KEY:'',CDS_AI_ACCESS_KEY:''};
const sqlUri=(kind:string)=>kind==='mysql'?'mysql://root:dts_disposable_1117@127.0.0.1:18891':'postgres://postgres:dts_disposable_1117@127.0.0.1:18892';
async function rabbit(route:string,body?:unknown){const r=await fetch('http://127.0.0.1:18893/api/'+route,{method:body?'PUT':'GET',headers:{authorization:'Basic '+Buffer.from('dts_qa:dts_disposable_1117').toString('base64'),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.ok(r.ok,'disposable RabbitMQ operation');const text=await r.text();return text?JSON.parse(text):null;}
async function record(kind:string,channel:string,verify=false,key=channel+'-'+kind+'-'+Date.now()){
 if(kind==='mongo'){const db=new MongoClient('mongodb://127.0.0.1:'+(verify?'18882':'18881'));await db.connect();try{const rows=db.db('dts_interfaces_qa_v2').collection('accounts');if(verify)assert.equal((await rows.findOne({_id:key as never}))?.name,key);else await rows.insertOne({_id:key,name:key,revision:1} as never);}finally{await db.close();}}
 else if(kind==='mysql'||kind==='postgres'){await withDtsSql({kind,database:verify?'dts_target':'dts_source'} as DtsConnection,sqlUri(kind),async db=>{if(verify){const rows=await db.query('SELECT name FROM cds_dts_qa_records WHERE _id='+(kind==='mysql'?'?':'$1'),[key]);assert.equal(rows[0]?.name,key);}else await db.query('INSERT INTO cds_dts_qa_records (_id,name,revision) VALUES '+(kind==='mysql'?'(?,?,?)':'($1,$2,$3)'),[key,key,1]);});}
 else if(kind==='redis'){const db=createClient({url:'redis://127.0.0.1:'+(process.env.DTS_REDIS_DRILL_PORT||'18883')+'/'+(verify?'3':'2')});await db.connect();try{if(verify)assert.equal(await db.get('dtsqa:'+key),key);else await db.set('dtsqa:'+key,key,{PX:300000});}finally{db.destroy();}}
 else if(kind==='rabbitmq'){if(verify)assert.equal((await rabbit('queues/dts_target/webqa.'+key)).durable,true);else await rabbit('queues/dts_source/webqa.'+key,{durable:true,auto_delete:false,arguments:{'x-queue-type':'classic'}});}
 return key;
}
async function cli(...args:string[]){const r=await promisify(execFile)('python3',[fileURLToPath(new URL('../../.claude/skills/cds/cli/cdscli.py',import.meta.url)),'dts',...args],{cwd:c.workspace,env,timeout:60000});return JSON.parse(r.stdout).data;}
const mcp=new Client({name:'native-five-connectors',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../mcp/src/server.mjs',import.meta.url)),'--dts'],cwd:c.workspace,env,stderr:'pipe'});
const results:unknown[]=[];
const parse=(r:{isError?:boolean;content:unknown})=>{assert.ok(!r.isError,'MCP native request failed');return JSON.parse((r.content as {text:string}[])[0].text);};
async function waitRun(id:string,channel:string){for(let i=0;i<90;i++){const r=channel==='mcp'?parse(await mcp.callTool({name:'cds_dts_runs',arguments:{runId:id}})).run:(await cli('get',id)).run;if(['completed','failed','cancelled'].includes(r.status))return r;await new Promise(r=>setTimeout(r,1000));}throw new Error('Native interface job did not settle');}
try{
 await mcp.connect(transport);assert.equal((await mcp.listTools()).tools.length,6);
 for(const [kind,pair]of Object.entries(c.pairs) as [string,{sourceId:string;targetId:string}][]){
  for(const channel of ['mcp','cli']){
   const key=await record(kind,channel);
   const p=channel==='mcp'?parse(await mcp.callTool({name:'cds_dts_plan',arguments:{...pair,mode:'append-only'}})).plan:(await cli('plan','--source',pair.sourceId,'--target',pair.targetId)).plan;
   assert.ok(p.insertCount>=1);const args={planId:p.id,idempotencyKey:'interface:'+channel+':'+p.id};
   const r=channel==='mcp'?parse(await mcp.callTool({name:'cds_dts_start',arguments:args})).run:(await cli('start','--plan',p.id,'--idempotency-key',args.idempotencyKey)).run;
   const done=await waitRun(r.id,channel);assert.equal(done.status,'completed',kind+' '+channel+': '+done.message);await record(kind,channel,true,key);
   results.push({kind,channel,runId:done.id,appliedCount:done.appliedCount,independentTargetCheck:true});console.log('PASS',kind,channel,'native job and target record');
  }
 }
}finally{await mcp.close();}
const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(c.origin+'/login');await page.getByPlaceholder('操作员用户名').fill('dts_qa');await page.locator('input[type=password]').fill('dts_disposable_interface_password');await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByRole('button',{name:'新建 / 自动化菜单',exact:true}).waitFor({timeout:60000});await page.getByRole('button',{name:'新建 / 自动化菜单',exact:true}).click();await page.getByRole('menuitem',{name:'数据同步',exact:true}).click();
 await page.getByRole('heading',{name:'数据同步',exact:true}).waitFor();await page.getByLabel('所属项目',{exact:true}).selectOption(c.projectId);
 for(const [kind,pair]of Object.entries(c.pairs) as [string,{sourceId:string;targetId:string}][]){
  const key=await record(kind,'web');await page.getByLabel('源环境',{exact:true}).selectOption(pair.sourceId);await page.getByLabel('目标环境',{exact:true}).selectOption(pair.targetId);
  await page.getByRole('button',{name:'比较差异',exact:true}).click();await page.getByLabel('比较结果',{exact:true}).waitFor();
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/dts/runs'&&r.request().method()==='POST');await page.getByRole('button',{name:'按此差异同步',exact:true}).click();const accepted=await response;assert.equal(accepted.status(),202);const id=(await accepted.json()).run.id;
  const row=page.locator(`[data-dts-run-id="${id}"]`);await row.getByText('同步与目标数据核对均已完成',{exact:true}).waitFor({timeout:90000});await record(kind,'web',true,key);await row.scrollIntoViewIfNeeded();await page.screenshot({path:folder+'/interface-'+kind+'-desktop.png'});
  results.push({kind,channel:'web',runId:id,independentTargetCheck:true});console.log('PASS',kind,'visible project-tools path → native write → exact task and target verification');
 }
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:folder+'/interface-narrow.png'});assert.deepEqual(errors,[]);
 const viewer=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),reader=await viewer.newPage();reader.on('pageerror',e=>errors.push(e.message));
 try{
  await reader.goto(c.origin+'/login');await reader.getByPlaceholder('操作员用户名').fill('dts_viewer');await reader.locator('input[type=password]').fill('dts_disposable_viewer_password');await reader.getByRole('button',{name:'登录',exact:true}).click();
  await reader.getByRole('button',{name:'更多操作',exact:true}).click();await reader.getByRole('button',{name:'数据同步',exact:true}).click();await reader.getByRole('heading',{name:'数据同步',exact:true}).waitFor();await reader.getByLabel('所属项目',{exact:true}).selectOption(c.projectId);await reader.getByRole('heading',{name:'同步任务',exact:true}).waitFor();
  const caps=await reader.request.get(c.origin+'/api/dts/capabilities?projectId='+c.projectId);assert.equal(caps.status(),200);assert.equal((await caps.json()).executeAllowed,false);
  assert.equal(await reader.getByRole('button',{name:'比较差异',exact:true}).isDisabled(),true);
  assert.equal((await reader.request.post(c.origin+'/api/dts/plans',{data:{projectId:c.projectId,...c.pairs.mongo,mode:'append-only'}})).status(),403);
  assert.equal(await reader.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await reader.screenshot({path:folder+'/interface-member-mobile.png'});
 }finally{await viewer.close();}
 assert.deepEqual(errors,[]);console.log('PASS ordinary member mobile login → visible DTS entry → own-project status; native write remains denied');
 await fs.writeFile(folder+'/five-interface-results.json',JSON.stringify({scope:'isolated native functional regression; not published acceptance',results,memberReadOnly:true,pageErrors:errors},null,2));
}finally{await browser.close();}
