import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../src/server.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import { MemoryAuthStore } from '../../src/infra/auth-store/memory-store.js';
import { MonitorOnboardingService } from '../../src/services/monitor-onboarding.js';
import { createMonitorOnboardingRouter } from '../../src/routes/monitor-onboarding.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import type { CdsConfig } from '../../src/types.js';

const roots: string[] = [];
const DRAFT = { name: '人工确认的健康检查', kind: 'http', url: 'https://approval.example/healthz' };
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();await flushAllJsonStateStores();for(const dir of roots.splice(0))rmSync(dir,{recursive:true,force:true});});
function setup(){
  const dir=mkdtempSync(path.join(os.tmpdir(),'monitor-human-auth-'));roots.push(dir);
  const store=new StateService(path.join(dir,'state.json'),dir);store.load();
  return {dir,store,service:new MonitorOnboardingService({store})};
}
async function listen(app:express.Express){
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const call=async(method:string,url:string,headers:Record<string,string>={},body?:unknown)=>{
    const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as any,headers:response.headers};
  };
  return {call,close:async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}
function buildServer(dir:string,store:StateService,authStore:MemoryAuthStore){
  const shell=new MockShellExecutor();
  return createServer({stateService:store,worktreeService:new WorktreeService(shell,dir),shell,
    containerService:{} as never,bridgeService:{} as never,
    proxyService:{getProxyLog:()=>[],setOnProxyLog:()=>{},handleSwitchFromExpress:()=>{}} as never,
    config:{repoRoot:dir,worktreeBase:path.join(dir,'worktrees'),masterPort:9900,workerPort:5500,dockerNetwork:'test',portStart:10001,sharedEnv:{},jwt:{secret:'test-only',issuer:'test'},mode:'standalone',executorPort:9901,rootDomains:[]} as CdsConfig,
    authStore});
}

describe('监控提议只能由已验证的人类所有者确认',()=>{
  it.each(['github','basic'] as const)('%s 真实网关拒绝机器全局key四个owner接口，保留已验证人类cookie确认',async mode=>{
    vi.stubEnv('CDS_AUTH_MODE',mode);vi.stubEnv('CDS_USERNAME','monitor-owner');vi.stubEnv('CDS_PASSWORD','test-password-only');
    vi.stubEnv('CDS_GITHUB_CLIENT_ID','test-client');vi.stubEnv('CDS_GITHUB_CLIENT_SECRET','test-secret');vi.stubEnv('CDS_SSO_ENABLED','false');
    const {dir,store,service}=setup();const key='cdsg_monitor_auth_test_global';
    store.addGlobalAgentKey({id:'monitor-global',label:'test',scope:'rw',hash:createHash('sha256').update(key).digest('hex'),access:{projects:'all',canCreateProjects:true},createdAt:new Date().toISOString()});
    const authStore=new MemoryAuthStore();const user=await authStore.createLocalUser({username:'persisted-owner',passwordHash:'unused',passwordSalt:'unused',isSystemOwner:true});
    const session=await authStore.createSession({userId:user.id,ttlMs:60_000,userAgent:'test',ipAddress:'127.0.0.1'});
    const app=buildServer(dir,store,authStore);app.use('/api',createMonitorOnboardingRouter(service));const {call,close}=await listen(app);
    try{
      let cookie=`cds_gh_session=${session.token}`;
      if(mode==='basic'){
        const login=await call('POST','/api/login',{}, {username:'monitor-owner',password:'test-password-only'});expect(login.status).toBe(200);
        cookie=login.headers.get('set-cookie')!.split(';')[0];
      }
      const human={Cookie:cookie};const created=await call('POST','/api/uptime/onboarding',human,{});expect(created.status).toBe(201);
      const {id,token}=created.body;const agent={Authorization:`Bearer ${token}`};
      expect((await call('GET',`/api/uptime/onboarding-agent/${id}/instructions`,agent)).status).toBe(200);
      expect((await call('POST',`/api/uptime/onboarding-agent/${id}/proposals`,agent,{proposals:[DRAFT]})).status).toBe(202);
      const ownerView=await call('GET',`/api/uptime/onboarding/${id}`,human);expect(ownerView.status).toBe(200);const args={proposalIds:[ownerView.body.proposals[0].id]};
      const machine={'X-AI-Access-Key':key};
      const machineResults=[];
      for(const [method,url,body] of [['POST','/api/uptime/onboarding',{}],['GET',`/api/uptime/onboarding/${id}`,undefined],['POST',`/api/uptime/onboarding/${id}/confirm`,args],['DELETE',`/api/uptime/onboarding/${id}`,undefined]] as const){
        machineResults.push({method,path:url.includes('/confirm')?'confirm':url.endsWith('/onboarding')?'create':'session',status:(await call(method,url,machine,body)).status});
      }
      expect(machineResults).toEqual([{method:'POST',path:'create',status:403},{method:'GET',path:'session',status:403},{method:'POST',path:'confirm',status:403},{method:'DELETE',path:'session',status:403}]);
      expect(store.listUptimeMonitors()).toHaveLength(0);
      const saved=await call('POST',`/api/uptime/onboarding/${id}/confirm`,human,args);expect(saved.status).toBe(201);
      expect((await call('POST',`/api/uptime/onboarding/${id}/confirm`,human,args)).body).toEqual(saved.body);
      expect(store.listUptimeMonitors()).toHaveLength(1);expect(store.listUptimeMonitors()[0].createdByKind).toBe('human');
      expect((await call('DELETE',`/api/uptime/onboarding/${id}`,human)).status).toBe(200);
    }finally{await close();}
  });
  it('无认证模式也不隐含人工所有者身份',async()=>{
    vi.stubEnv('CDS_AUTH_MODE','disabled');vi.stubEnv('CDS_USERNAME','');vi.stubEnv('CDS_PASSWORD','');vi.stubEnv('CDS_SSO_ENABLED','false');
    const {dir,store,service}=setup();const s=service.create() as {id:string;token:string};service.submit(s.id,s.token,{proposals:[DRAFT]});const args={proposalIds:(service.view(s.id).proposals as Array<{id:string}>).map(p=>p.id)};
    const app=buildServer(dir,store,new MemoryAuthStore());app.use('/api',createMonitorOnboardingRouter(service));const {call,close}=await listen(app);
    try{for(const [method,url,body] of [['POST','/api/uptime/onboarding',{}],['GET',`/api/uptime/onboarding/${s.id}`,undefined],['DELETE',`/api/uptime/onboarding/${s.id}`,undefined],['POST',`/api/uptime/onboarding/${s.id}/confirm`,args]] as const)expect((await call(method,url,{},body)).status).toBe(403);expect(store.listUptimeMonitors()).toHaveLength(0);}finally{await close();}
  });
  it.each([
    ['bare-owner',{cdsUser:{isSystemOwner:true,authProvider:'local'}}],
    ['sso-owner',{cdsUser:{isSystemOwner:true,authProvider:'sso'},cdsSession:{id:'verified-sso'}}],
    ['project-machine',{cdsProjectKey:{projectId:'p',keyId:'k'},_aiSession:{id:'project'}}],
    ['user-api-machine',{cdsPrincipal:{principalId:'owner',credentialId:'user-key'},_aiSession:{id:'user-key'}}],
  ] as const)('%s 的身份对象不能代替已验证人工所有者',async(_name,stamp)=>{
    const {store,service}=setup();const s=service.create() as {id:string;token:string};service.submit(s.id,s.token,{proposals:[DRAFT]});const args={proposalIds:(service.view(s.id).proposals as Array<{id:string}>).map(p=>p.id)};
    const app=express();app.use(express.json());app.use((req,_res,next)=>{Object.assign(req,stamp);next();});app.use('/api',createMonitorOnboardingRouter(service));const {call,close}=await listen(app);
    try{for(const [method,url,body] of [['POST','/api/uptime/onboarding',{}],['GET',`/api/uptime/onboarding/${s.id}`,undefined],['DELETE',`/api/uptime/onboarding/${s.id}`,undefined],['POST',`/api/uptime/onboarding/${s.id}/confirm`,args]] as const)expect((await call(method,url,{},body)).status).toBe(403);expect(store.listUptimeMonitors()).toHaveLength(0);}finally{await close();}
  });
});
