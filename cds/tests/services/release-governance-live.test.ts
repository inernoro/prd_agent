import { afterAll, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtime = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let processUnderTest: ChildProcess | undefined, root: string | undefined, buildRoot: string | undefined;
afterAll(async () => {
  if (processUnderTest && processUnderTest.exitCode === null) {
    const stopped = new Promise<void>(resolve => processUnderTest!.once('exit',() => resolve()));
    processUnderTest.kill('SIGTERM'); await stopped;
  }
  if (root) await fs.rm(root,{recursive:true,force:true});
  if (buildRoot) await fs.rm(buildRoot,{recursive:true,force:true});
});

it('正常认证、真实 Git 和 SSH 发布：独立审批、连续调试、越界、撤销和单次回滚全链路', async () => {
  // Compile the current source into an owned tree; an old local dist cannot make this test green.
  buildRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'cds-governance-build-')));
  const emittedRuntime=path.join(buildRoot,'runtime'); await fs.mkdir(emittedRuntime);
  execFileSync(process.execPath,[path.join(runtime,'scripts/build-dist-esbuild.mjs')],{env:{...process.env,OUT_DIR:path.join(emittedRuntime,'dist')},stdio:'pipe'});
  await fs.writeFile(path.join(emittedRuntime,'package.json'),'{"type":"module"}');
  await fs.symlink(path.join(runtime,'node_modules'),path.join(emittedRuntime,'node_modules'),'dir');
  const portProbe = http.createServer(); await new Promise<void>(resolve => portProbe.listen(0,'127.0.0.1',resolve));
  const port = (portProbe.address() as {port:number}).port; await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const metadata = new Promise<{ labRoot: string; credentialsPath: string }>((resolve,reject) => {
    let output = '';
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      CDS_LAB_RUNTIME: emittedRuntime, CDS_PORT: String(port), CDS_BIND_HOST: '127.0.0.1' };
    processUnderTest = spawn(process.execPath,[path.join(runtime,'scripts/release-governance-live-lab.mjs')],{env,stdio:['ignore','pipe','pipe']});
    processUnderTest.stdout!.on('data', chunk => {
      output += String(chunk);
      for (const line of output.split('\n')) if (line.startsWith('{"labRoot":')) { resolve(JSON.parse(line)); return; }
    });
    processUnderTest.stderr!.resume();
    processUnderTest.once('error',reject); processUnderTest.once('exit',code => reject(new Error(`隔离 CDS 提前结束 ${code}`)));
  });
  const meta = await metadata; root = meta.labRoot;
  const credentials = JSON.parse(await fs.readFile(meta.credentialsPath,'utf8'));
  const fixtureState=JSON.parse(await fs.readFile(path.join(root,'.cds/state.json'),'utf8'));
  const sshHost=Object.values(fixtureState.remoteHosts).find((host:any)=>host.id==='release-lab-ssh') as any;
  const {defaultReleaseSshExecutor}=await import(pathToFileURL(path.join(emittedRuntime,'dist/services/release-service.js')).href);
  const forbidden=path.join(root,'must-not-execute');let authenticated=false;
  await expect(defaultReleaseSshExecutor({host:sshHost,password:sshHost.sshPasswordEncrypted,
    command:`touch '${forbidden.replace(/'/g,"'\\''")}'`,signal:new AbortController().signal,onOutput:()=>{},
    beforeExec:()=>{authenticated=true;throw new Error('鉴权完成后批准已撤销');}})).rejects.toThrow('批准已撤销');
  expect(authenticated).toBe(true);
  await expect(fs.stat(forbidden)).rejects.toMatchObject({code:'ENOENT'});
  const controller=new AbortController();let commandStarted=false;
  const cancelled=defaultReleaseSshExecutor({host:sshHost,password:sshHost.sshPasswordEncrypted,
    command:'printf cds-abort-probe-ready; exec sleep 30 # cds-ignore-ssh-signals',signal:controller.signal,
    onOutput:(_level:string,text:string)=>{if(text.includes('cds-abort-probe-ready')){commandStarted=true;controller.abort(new Error('受控取消发布'));}}})
    .then(()=>({outcome:'unexpected-success'}),()=>({outcome:'cancelled'}));
  let deadline:ReturnType<typeof setTimeout> | undefined;
  const bounded=await Promise.race([cancelled,new Promise<{outcome:string}>(resolve=>{deadline=setTimeout(()=>resolve({outcome:'timeout'}),5000);})]);
  clearTimeout(deadline);expect(commandStarted).toBe(true);expect(bounded.outcome).toBe('cancelled');
  const base = `http://127.0.0.1:${port}`;
  async function call(method: string, route: string, body?: unknown, cookie?: string) {
    const response = await fetch(base+'/api'+route,{method,headers:{'Content-Type':'application/json',
      ...(cookie ? {Cookie:cookie} : {'X-AI-Access-Key':credentials.agentKey})},body:body === undefined ? undefined : JSON.stringify(body)});
    return {status:response.status,body:await response.json() as any,cookies:response.headers.getSetCookie()};
  }
  let ready = false;
  for(let i=0;i<600;i++) { try { const response=await call('GET','/releases/governance?projectId='+credentials.projectId); if(response.status===200){ready=true;break;} } catch {} await new Promise(r=>setTimeout(r,50)); }
  expect(ready).toBe(true);
  const login = await call('POST','/auth/login',{username:credentials.username,password:credentials.password});
  expect(login.status).toBe(200); const cookie=login.cookies.map(value=>value.split(';')[0]).join('; ');
  const target='/releases/targets/'+credentials.targetId;
  async function settle(result: Awaited<ReturnType<typeof call>>) {
    expect(result.status,JSON.stringify(result.body)).toBe(202); let run=result.body.run;
    for(let i=0;i<200&&!['success','failed','rollback_success','rollback_failed'].includes(run.status);i++) {
      await new Promise(r=>setTimeout(r,50)); run=(await call('GET','/releases/runs/'+run.releaseId)).body.run;
    }
    expect(['success','rollback_success'],run.errorMessage).toContain(run.status);
    expect(await fs.readFile(credentials.effects,'utf8')).toContain(run.releaseId+' '+run.commitSha); return run;
  }
  const publish = () => call('POST','/releases/branches/lab-debug/runs',{targetId:credentials.targetId,previewUrl:credentials.surfaceUrl+'preview/lab-debug'});
  const baseline=await settle(await call('POST','/releases/branches/lab-main/runs',{targetId:credentials.targetId,previewUrl:credentials.surfaceUrl+'preview/lab-main'}));
  const sameCommitHistory=await settle(await call('POST','/releases/branches/lab-main/runs',{targetId:credentials.targetId,previewUrl:credentials.surfaceUrl+'preview/lab-main'}));
  expect((await call('POST',target+'/governance/enable',{},cookie)).status).toBe(200);
  const request = await call('POST',target+'/authorizations',{branchId:'lab-debug',kind:'debug',allowedPaths:['allowed/'],expiresAt:new Date(Date.now()+3600000).toISOString(),reason:'自动回归真实发布链路的范围内连续调试'});
  expect(request.status).toBe(200); const id=request.body.authorization.id;
  expect((await publish()).status).toBe(409);
  expect((await call('POST','/releases/authorizations/'+id+'/approve',{reason:'执行凭据不能自批'})).status).toBe(403);
  expect((await call('POST','/releases/authorizations/'+id+'/approve',{reason:'独立测试账号核对范围后批准'},cookie)).status).toBe(200);
  const first=await settle(await publish()); expect(first.governance).toMatchObject({authorizationId:id,kind:'debug',requestedBy:'ai:key:release-lab-agent'});
  expect(first.governance.approvedBy).toMatch(/^user:/);
  const checkout=async (sha:string) => {
    const result=await call('POST','/branches/lab-debug/checkout/'+sha,{}); expect(result.status).toBe(200); expect(result.body.pinnedCommit).toBe(sha);
  };
  await checkout(credentials.second); const second=await settle(await publish()); expect(second.governance.authorizationId).toBe(id);
  const unchanged=await fs.readFile(credentials.effects,'utf8');
  for(const sha of [credentials.outside,credentials.reverted]) { await checkout(sha); expect((await publish()).status).toBe(409); expect(await fs.readFile(credentials.effects,'utf8')).toBe(unchanged); }
  const conflict=await call('POST',target+'/conflict-check',{branchId:'lab-conflict'}); expect(conflict.body.check).toMatchObject({status:'conflicts',conflicts:['allowed/app.txt']});
  expect((await call('POST','/releases/authorizations/'+id+'/revoke',{reason:'自动回归撤销窗口'})).status).toBe(200);
  await checkout(credentials.second); expect((await publish()).status).toBe(409); expect(await fs.readFile(credentials.effects,'utf8')).toBe(unchanged);
  const rollbackRoute='/releases/runs/'+second.releaseId+'/rollback';
  expect((await call('POST',rollbackRoute,{targetReleaseId:baseline.releaseId})).status).toBe(409);
  const rollback=await call('POST',target+'/authorizations',{branchId:'lab-main',kind:'single',action:'rollback',rollbackReleaseId:baseline.releaseId,expiresAt:new Date(Date.now()+3600000).toISOString(),reason:'单次回滚同一环境的已成功历史版本'});
  expect(rollback.status).toBe(200); const rollbackId=rollback.body.authorization.id;
  expect((await call('POST','/releases/authorizations/'+rollbackId+'/approve',{reason:'独立核对历史成功版本'},cookie)).status).toBe(200);
  const beforeWrongHistory=await fs.readFile(credentials.effects,'utf8');
  expect((await call('POST',rollbackRoute,{targetReleaseId:sameCommitHistory.releaseId,authorizationId:rollbackId})).status).toBe(409);
  expect(await fs.readFile(credentials.effects,'utf8')).toBe(beforeWrongHistory);
  const restored=await settle(await call('POST',rollbackRoute,{targetReleaseId:baseline.releaseId,authorizationId:rollbackId}));
  expect(restored.commitSha).toBe(credentials.main); expect(restored.governance.action).toBe('rollback');
  expect(restored.governance.rollbackReleaseId).toBe(baseline.releaseId);
  expect((await call('POST',rollbackRoute,{targetReleaseId:baseline.releaseId,authorizationId:rollbackId})).status).toBe(409);
  // Real wall clock expiry, after human approval; no altered clock or session stamp.
  const expiring=await call('POST',target+'/authorizations',{branchId:'lab-debug',kind:'debug',allowedPaths:['allowed/'],expiresAt:new Date(Date.now()+10000).toISOString(),reason:'实际有效期到期之后必须阻止再次调试发布'});
  expect(expiring.status).toBe(200); const expiryId=expiring.body.authorization.id;
  expect((await call('POST','/releases/authorizations/'+expiryId+'/approve',{reason:'独立核验短期窗口'},cookie)).status).toBe(200);
  const beforeExpiry=await fs.readFile(credentials.effects,'utf8'); await new Promise(r=>setTimeout(r,Math.max(0, Date.parse(expiring.body.authorization.expiresAt)-Date.now()+100)));
  expect((await publish()).status).toBe(409); expect(await fs.readFile(credentials.effects,'utf8')).toBe(beforeExpiry);
  const createdJob=await call('POST','/scheduled-jobs',{projectId:credentials.projectId,name:'隔离定时发布审批回归',enabled:false,
    schedule:{type:'manual'},target:{type:'release',targetId:credentials.targetId,source:{kind:'branch',branchId:'lab-debug'}},timeoutSeconds:60,retryCount:0});
  expect(createdJob.status).toBe(201); const jobId=createdJob.body.job.id;
  const runJob=()=>call('POST','/scheduled-jobs/'+jobId+'/run',{});
  expect((await runJob()).body.run.status).toBe('failed');
  expect(await fs.readFile(credentials.effects,'utf8')).toBe(beforeExpiry);
  const jobRequest=await call('POST',target+'/authorizations',{branchId:'lab-debug',kind:'single',scheduledJobId:jobId,
    expiresAt:new Date(Date.now()+3600000).toISOString(),reason:'限定真实定时任务执行已核验版本'});
  expect(jobRequest.status).toBe(200);const jobApprovalId=jobRequest.body.authorization.id;
  expect((await call('POST','/releases/authorizations/'+jobApprovalId+'/approve',{reason:'独立核对定时执行任务与版本'},cookie)).status).toBe(200);
  expect((await publish()).status).toBe(409); // The initiating key cannot borrow a job approval.
  const scheduled=await runJob();expect(scheduled.status).toBe(200);expect(scheduled.body.run.status,JSON.stringify(scheduled.body.run)).toBe('success');
  const afterJob=await call('GET','/releases/governance?projectId='+credentials.projectId);
  const accepted=afterJob.body.attempts.find((attempt:any)=>attempt.authorizationId===jobApprovalId&&attempt.result==='accepted');
  expect(accepted.operator).toBe('system:scheduled-job:'+jobId);
  expect(await fs.readFile(credentials.effects,'utf8')).toContain(accepted.releaseId+' '+credentials.second);
  const jobEffect=await fs.readFile(credentials.effects,'utf8');
  expect((await runJob()).body.run.status).toBe('failed');
  expect(await fs.readFile(credentials.effects,'utf8')).toBe(jobEffect);
  const audit=(await call('GET','/releases/governance?projectId='+credentials.projectId)).body;
  expect(audit.authorizations.find((a:any)=>a.id===id).decisions.map((d:any)=>d.action)).toEqual(['approved','revoked']);
  expect(audit.attempts.filter((a:any)=>a.result==='denied').length).toBeGreaterThanOrEqual(5);
},120000);

it('真实固定版本双目标批次：分支前进后批准已验收A并实际SSH发布A，不回退分支',async()=>{
  expect(root).toBeTruthy();expect(buildRoot).toBeTruthy();
  const load=async(name:string)=>import(pathToFileURL(path.join(buildRoot!,'runtime/dist/services',name+'.js')).href);
  const [{StateService},{ReleaseGovernanceService},{ReleaseGovernanceGit},{ReleaseService},{ReleaseBatchService}]=await Promise.all([load('state'),load('release-governance'),load('release-governance-git'),load('release-service'),load('release-batch-service')]);
  const fixture=JSON.parse(await fs.readFile(path.join(root!,'.cds/state.json'),'utf8'));
  const credentials=JSON.parse(await fs.readFile(path.join(root!,'.cds/lab-credentials.json'),'utf8'));
  const host=Object.values(fixture.remoteHosts).find((row:any)=>row.id==='release-lab-ssh') as any;
  const dir=path.join(root!,'fixed-batch-regression');await fs.mkdir(dir);const repo=path.join(root!,'project');
  const projectId='fixed-project',branchId='fixed-branch',actor='ai:key:fixed-batch',stamp=new Date().toISOString();
  const state=new StateService(path.join(dir,'state.json'),dir);state.load();
  const health=http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'healthy',commitSha:await fs.readFile(path.join(dir,req.url!.slice(1)),'utf8')}));});
  await new Promise<void>(resolve=>health.listen(0,'127.0.0.1',resolve));
  state.addProject({id:projectId,slug:projectId,name:'固定版本批次隔离回归',kind:'git',repoPath:repo,gitRepoUrl:path.join(root!,'origin.git'),gitDefaultBranch:'main',createdAt:stamp,updatedAt:stamp});
  state.addBranch({id:branchId,projectId,branch:'lab/debug',worktreePath:path.join(root!,'debug'),githubCommitSha:credentials.second,status:'running',services:{},createdAt:stamp});
  state.addRemoteHost({...host,id:'fixed-host'});
  for(const targetId of ['fixed-a','fixed-b']){
    await fs.writeFile(path.join(dir,targetId),credentials.main);
    const script=`#!/bin/sh\nset -eu\nif [ "$1" = check ]; then exit 0; fi\nprintf '%s' "$CDS_COMMIT_SHA" > '${dir}/${targetId}'\n`;
    state.upsertReleaseTarget({id:targetId,projectId,name:targetId,type:'ssh',isEnabled:true,createdAt:stamp,governance:{required:true},strategy:{mode:'managed-script',script},ssh:{host:'127.0.0.1',port:host.sshPort,user:'lab',privateKeyRef:'fixed-host',appPath:repo,healthcheckUrl:`http://127.0.0.1:${(health.address() as {port:number}).port}/${targetId}`}});
    state.addReleaseRun({releaseId:targetId+'-baseline',projectId,targetId,branchId,commitSha:credentials.main,status:'success',operator:actor,planId:projectId+':managed-script',startedAt:stamp,finishedAt:stamp,logs:[],seq:0,artifact:{type:'branch-preview',branchId,branchName:'lab/debug',commitSha:credentials.main}});
  }
  state.addDeploymentVersion({id:'fixed-accepted-a',projectId,branchId,commitSha:credentials.first,configHash:'fixture',profiles:[],migrations:[],capabilities:[],createdByRunId:'fixed-build-a',createdAt:stamp});
  const report=state.createAcceptanceReport({projectId,branchId,commitSha:credentials.first,verdict:'pass',reportType:'acceptance',title:'固定版本A隔离验收',content:'真实隔离验收',format:'md',createdAt:stamp});
  const git=new ReleaseGovernanceGit(()=>repo,()=> 'main',async(args:string[],cwd:string,isolated=false)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout:30000,env:{...process.env,GIT_TERMINAL_PROMPT:'0',...(isolated?{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}:{})}});return {stdout:r.stdout||'',exitCode:r.status};});
  const governance=new ReleaseGovernanceService(state,git),releases=new ReleaseService(state,{governance,verifyProjectCI:async(_branch:any,sha:string)=>({ok:sha===credentials.first,message:'隔离CI契约仅认可固定A，真实Git与SSH另行执行'})}),batches=new ReleaseBatchService(state,releases);
  try{
    const batch=await batches.create({projectId,versionId:'fixed-accepted-a',reportId:report.id,targetIds:['fixed-a','fixed-b'],idempotencyKey:'fixed-batch-create-1',operator:actor});
    expect((await batches.preflight(batch.id)).status).toBe('blocked');
    for(const targetId of ['fixed-a','fixed-b']){
      const pending=await governance.request({targetId,branchId,kind:'single',deploymentVersionId:'fixed-accepted-a',reason:'批次固定已验收A而分支已经前进B',actor,expiresAt:new Date(Date.now()+600000).toISOString()});
      expect(pending.candidateSha).toBe(credentials.first);await governance.decide(pending.id,'approved','user:fixed-reviewer:Reviewer','独立核对批次固定版本A');
    }
    const checked=await batches.preflight(batch.id);expect(checked.status,JSON.stringify(checked.targets.map((t:any)=>({id:t.targetId,checks:t.checks,error:t.error})))).toBe('ready');await batches.start(batch.id,'fixed-batch-start-1',undefined,false,actor);
    const deadline=Date.now()+45000;while(batches.get(batch.id).status==='running'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    expect(batches.get(batch.id).status).toBe('success');
    for(const targetId of ['fixed-a','fixed-b']){
      expect(await fs.readFile(path.join(dir,targetId),'utf8')).toBe(credentials.first);
      expect(state.getLatestSuccessfulReleaseRun(targetId)).toMatchObject({commitSha:credentials.first,governance:{deploymentVersionId:'fixed-accepted-a',approvedBy:'user:fixed-reviewer:Reviewer'}});
    }
    expect(state.getBranch(branchId).githubCommitSha).toBe(credentials.second);
  }finally{await state.flush();await new Promise<void>(resolve=>health.close(()=>resolve()));}
},90000);

it('真实 SSH 部署启动后批准到期且脚本失败，仍自动恢复上一成功版本',async()=>{
  expect(root).toBeTruthy();expect(buildRoot).toBeTruthy();
  const compiled=path.join(buildRoot!,'runtime/dist/services');
  const load=async(name:string)=>import(pathToFileURL(path.join(compiled,name+'.js')).href);
  const [{StateService},{ReleaseGovernanceService},{ReleaseGovernanceGit},{ReleaseService,defaultReleaseSshExecutor},{buildReleaseExecution}]
    =await Promise.all([load('state'),load('release-governance'),load('release-governance-git'),load('release-service'),load('release-strategy')]);
  const fixture=JSON.parse(await fs.readFile(path.join(root!,'.cds/state.json'),'utf8'));
  const credentials=JSON.parse(await fs.readFile(path.join(root!,'.cds/lab-credentials.json'),'utf8'));
  const host=Object.values(fixture.remoteHosts).find((row:any)=>row.id==='release-lab-ssh') as any;
  const dir=path.join(root!,'recovery-regression');await fs.mkdir(dir);
  const marker=path.join(dir,'version'),effects=path.join(dir,'effects');await fs.writeFile(marker,credentials.main);
  const health=http.createServer(async(_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'healthy',commitSha:await fs.readFile(marker,'utf8')}));});
  await new Promise<void>(resolve=>health.listen(0,'127.0.0.1',resolve));
  const state=new StateService(path.join(dir,'state.json'),dir);state.load();
  const projectId='recovery-project',targetId='recovery-target',branchId='recovery-branch',actor='ai:key:recovery-test';
  let now=Date.now();const stamp=new Date(now).toISOString();
  const repo=path.join(root!,'project');
  state.addProject({id:projectId,slug:projectId,name:'自动恢复回归',kind:'git',repoPath:repo,gitRepoUrl:path.join(root!,'origin.git'),gitDefaultBranch:'main',createdAt:stamp,updatedAt:stamp});
  state.addBranch({id:branchId,projectId,branch:'lab/debug',worktreePath:path.join(root!,'debug'),githubCommitSha:credentials.second,status:'running',services:{},createdAt:stamp});
  state.addRemoteHost({...host,id:'recovery-host'});
  const script=`#!/bin/sh\nset -eu\nif [ "$1" = check ]; then exit 0; fi\nprintf '%s' "$CDS_COMMIT_SHA" > '${marker}'\nif [ "$CDS_COMMIT_SHA" = '${credentials.second}' ]; then printf 'approval-expired-after-command-start\\n'; exit 17; fi\nprintf '%s %s\\n' "$CDS_RELEASE_ID" "$CDS_COMMIT_SHA" >> '${effects}'\n`;
  const target={id:targetId,projectId,name:'隔离自动恢复',type:'ssh',isEnabled:true,createdAt:stamp,governance:{required:true},strategy:{mode:'managed-script',script},ssh:{host:'127.0.0.1',port:host.sshPort,user:'lab',privateKeyRef:'recovery-host',appPath:repo,healthcheckUrl:`http://127.0.0.1:${(health.address() as {port:number}).port}/health`}};
  state.upsertReleaseTarget(target);
  const makeRun=(releaseId:string,commitSha:string,status:string)=>{
    const run:any={releaseId,projectId,targetId,branchId,commitSha,status,operator:actor,planId:projectId+':managed-script',startedAt:stamp,finishedAt:status==='success'?stamp:undefined,logs:[],seq:0,artifact:{type:'branch-preview',branchId,branchName:'lab/debug',commitSha,previewUrl:credentials.surfaceUrl}};
    const execution=buildReleaseExecution(target,run);run.executionSnapshot={mode:execution.mode,scriptSha256:execution.scriptSha256,scriptContent:execution.scriptContent,summary:execution.summary,strategy:target.strategy};return run;
  };
  state.addReleaseRun(makeRun('recovery-baseline',credentials.main,'success'));
  const git=new ReleaseGovernanceGit(()=>repo,()=> 'main',async(args:string[],cwd:string,isolated=false)=>{
    const result=spawnSync('git',args,{cwd,encoding:'utf8',timeout:30000,env:{...process.env,GIT_TERMINAL_PROMPT:'0',
      ...(isolated?{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}:{})}});
    return {stdout:result.stdout||'',exitCode:result.status};
  });
  const governance=new ReleaseGovernanceService(state,git,undefined,()=>new Date(now));
  try {
    const pending=await governance.request({targetId,branchId,kind:'single',reason:'实际执行失败后核验已批准恢复路径',actor,expiresAt:new Date(now+3600000).toISOString()});
    await governance.decide(pending.id,'approved','user:recovery-reviewer:Reviewer','独立批准此固定版本');
    const run=makeRun('recovery-failed',credentials.second,'queued');run.previousReleaseId='recovery-baseline';
    run.governance=await governance.authorize({runId:run.releaseId,projectId,targetId,branchId,commitSha:run.commitSha,operator:actor,action:'release',authorizationId:pending.id});
    state.addReleaseRun(run);await governance.accept(run);
    let expiredDuringExecution=false;
    const release=new ReleaseService(state,{governance,sshExecutor:(request:any)=>defaultReleaseSshExecutor({...request,onOutput:(level:string,text:string)=>{
      request.onOutput(level,text);if(text.includes('approval-expired-after-command-start')){now+=7200000;expiredDuringExecution=true;}
    }})});
    await expect(release.runRelease(run.releaseId)).rejects.toThrow();
    expect(expiredDuringExecution).toBe(true);
    expect(await fs.readFile(marker,'utf8')).toBe(credentials.main);
    expect(await fs.readFile(effects,'utf8')).toContain(run.releaseId+'-auto-restore '+credentials.main);
    expect(state.getReleaseRun(run.releaseId).autoRestoredAt).toBeTruthy();
    state.patchReleaseRun(run.releaseId,{status:'failed'});
  } finally {
    await state.flush();health.closeAllConnections();await new Promise<void>(resolve=>health.close(()=>resolve()));
  }
},30000);
