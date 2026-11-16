import { afterAll, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
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
  const restored=await settle(await call('POST',rollbackRoute,{targetReleaseId:baseline.releaseId,authorizationId:rollbackId}));
  expect(restored.commitSha).toBe(credentials.main); expect(restored.governance.action).toBe('rollback');
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
