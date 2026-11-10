import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateService } from '../../src/services/state.js';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import { MonitorOnboardingService, OnboardingError } from '../../src/services/monitor-onboarding.js';
import { createMonitorOnboardingRouter } from '../../src/routes/monitor-onboarding.js';
import { isMonitorOnboardingAgentRoute } from '../../src/shared/monitor-onboarding.js';
import { createGithubAuthMiddleware } from '../../src/middleware/github-auth.js';

const roots: string[] = [];
const DRAFT = { name: '订单服务 · 健康检查', kind: 'http', url: 'https://orders.example/healthz', expectedStatus: '200-299' };
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-onboarding-')); roots.push(dir);
  const file = path.join(dir, 'state.json'); const store = new StateService(file, dir); store.load();
  let now = 1_800_000_000_000;
  const service = new MonitorOnboardingService({ store, now: () => now,
    getNotifications: () => store.getMonitorNotifications(), setNotifications: s => store.setMonitorNotifications(s), listChannelIds: () => ['phone'],
  });
  const create = () => service.create() as {id:string;token:string;expiresAt:number};
  return { file, store, service, create, advance: (ms: number) => {now += ms;} };
}
afterEach(async () => { vi.restoreAllMocks(); await flushAllJsonStateStores(); for (const dir of roots.splice(0)) rmSync(dir, {recursive:true,force:true}); });

describe('真实只读监控提议与用户确认', () => {
  it('令牌仅创建时返回，读取说明和提交草案不执行检查或创建监控', () => {
    const {store,service,create}=setup();const s=create();
    expect(s.token).toMatch(/^cdsmon_/);expect(JSON.stringify(service.view(s.id))).not.toContain(s.token);
    expect(service.instructions(s.id,s.token,'订单智能体')).toMatchObject({scope:'propose-only'});
    service.submit(s.id,s.token,{agentName:'订单智能体',proposals:[DRAFT]});
    expect(store.listUptimeMonitors()).toEqual([]);
    expect(service.view(s.id)).toMatchObject({status:'proposed',agentName:'订单智能体',timeline:[{kind:'created'},{kind:'connected'},{kind:'instructions-read'},{kind:'proposals-submitted'}]});
    expect(JSON.stringify(service.view(s.id))).not.toContain(s.token);
  });
  it('错误凭据、跨会话、过期、撤销和重启后的旧令牌不能提交', () => {
    const {store,service,create,advance}=setup();const a=create(),b=create();
    for(const [id,token] of [[a.id,b.token],[a.id,'invalid'],['0'.repeat(32),a.token]])expect(()=>service.submit(id,token,{proposals:[DRAFT]})).toThrow(OnboardingError);
    service.revoke(a.id);expect(()=>service.instructions(a.id,a.token)).toThrow(/令牌无效/);
    advance(24*3_600_000+1);expect(()=>service.submit(b.id,b.token,{proposals:[DRAFT]})).toThrow(/令牌无效/);
    expect(()=>new MonitorOnboardingService({store}).submit(b.id,b.token,{proposals:[DRAFT]})).toThrow(/令牌无效/);
    expect(store.listUptimeMonitors()).toHaveLength(0);
  });
  it.each([
    {...DRAFT,kind:'functional',requestMethod:'POST'}, {...DRAFT,method:'POST'}, {...DRAFT,headers:{Authorization:'secret'}},
    {...DRAFT,projectId:'foreign'}, {...DRAFT,url:'https://user:password@orders.example/healthz'},
    {...DRAFT,url:'https://orders.example/healthz?token=secret'}, {...DRAFT,url:'file:///etc/passwd'},
  ])('拒绝写操作、跨项目字段和带凭据的提议 %j', draft => {
    const {service,create,store}=setup();const s=create();expect(()=>service.submit(s.id,s.token,{proposals:[draft]})).toThrow(OnboardingError);expect(store.listUptimeMonitors()).toEqual([]);
  });
  it('严格限制大小和项数，拒绝将会话令牌写入草案', () => {
    const {service,create}=setup();const s=create();
    for(const input of [{proposals:Array(21).fill(DRAFT)},{proposals:[{...DRAFT,name:'x'.repeat(70_000)}]},{proposals:[{...DRAFT,name:s.token}]}])expect(()=>service.submit(s.id,s.token,input)).toThrow(OnboardingError);
    service.instructions(s.id,s.token,s.token);expect(JSON.stringify(service.view(s.id))).not.toContain(s.token);
  });
  it('真实持久化且冷读仍存在，完成令牌失效，重复确认不重复建项', async () => {
    const {service,create,store,file}=setup();const s=create();service.submit(s.id,s.token,{proposals:[DRAFT,{...DRAFT,name:'库存服务',url:'https://stock.example/healthz'}]});
    const proposals=service.view(s.id).proposals as Array<{id:string}>;
    const selection={proposalIds:proposals.map(p=>p.id),channelIds:[]};
    const a=await service.confirm(s.id,selection);expect(a.monitors).toHaveLength(2);expect(store.listUptimeMonitors()).toHaveLength(2);
    const b=await service.confirm(s.id,selection);expect(b).toEqual(a);expect(store.listUptimeMonitors()).toHaveLength(2);
    const cold=new StateService(file,path.dirname(file));cold.load();expect(cold.listUptimeMonitors().map(m=>m.name).sort()).toEqual(['库存服务',DRAFT.name].sort());
    for(const target of a.targetIds)expect(cold.getMonitorNotifications().overrides?.[target]).toEqual([]);
    expect(()=>service.instructions(s.id,s.token)).toThrow(/令牌无效/);
    expect(()=>service.confirm(s.id,{proposalIds:[proposals[0].id]})).toThrow(/无法确认/);
  });
  it('提交后的草案不能被晚到消息替换，确认只接受本会话选中项', async () => {
    const {service,create,store}=setup();const a=create(),b=create();service.submit(a.id,a.token,{proposals:[DRAFT]});service.submit(b.id,b.token,{proposals:[DRAFT]});
    const pa=service.view(a.id).proposals as Array<{id:string}>;const pb=service.view(b.id).proposals as Array<{id:string}>;
    expect(()=>service.submit(a.id,a.token,{proposals:[{...DRAFT,name:'晚到消息'}]})).toThrow(/已提交/);
    expect(()=>service.confirm(a.id,{proposalIds:[pb[0].id]})).toThrow(/不属于/);
    expect(()=>service.confirm(a.id,{proposalIds:[pa[0].id],channelIds:['deleted']})).toThrow(/已不存在/);
    expect(store.listUptimeMonitors()).toHaveLength(0);await service.confirm(a.id,{proposalIds:[pa[0].id]});expect(store.listUptimeMonitors()[0].name).toBe(DRAFT.name);
  });
  it('已完成确认的重放保持同结果，不受后来通道删除影响', async () => {
    const {store}=setup();let known=['phone'];const service=new MonitorOnboardingService({store,getNotifications:()=>store.getMonitorNotifications(),setNotifications:s=>store.setMonitorNotifications(s),listChannelIds:()=>known});
    const s=service.create() as {id:string;token:string};service.submit(s.id,s.token,{proposals:[DRAFT]});const p=service.view(s.id).proposals as Array<{id:string}>;
    const args={proposalIds:[p[0].id],channelIds:['phone']};const result=await service.confirm(s.id,args);known=[];
    expect(await service.confirm(s.id,args)).toEqual(result);expect(store.listUptimeMonitors()).toHaveLength(1);
  });
  it('拒绝同批重复提议，已有监控标记且不能再次确认', async () => {
    const {service,create,store}=setup();const first=create();
    expect(()=>service.submit(first.id,first.token,{proposals:[DRAFT,{...DRAFT,name:'同一探针另一名称'}]})).toThrow(/重复监控/);
    service.submit(first.id,first.token,{proposals:[DRAFT]});const p=service.view(first.id).proposals as Array<{id:string}>;
    const saved=await service.confirm(first.id,{proposalIds:[p[0].id]});const next=create();
    service.submit(next.id,next.token,{proposals:[{...DRAFT,name:'重新命名'}]});const existing=service.view(next.id).proposals as Array<{id:string;existingMonitorId?:string}>;
    expect(existing[0].existingMonitorId).toBe(saved.monitors[0].id);
    expect(()=>service.confirm(next.id,{proposalIds:[existing[0].id]})).toThrow(/已在订阅中/);expect(store.listUptimeMonitors()).toHaveLength(1);
  });
  it('跨会话晚到确认重新核对探针，不重复追加相同检查', async () => {
    const {service,create,store}=setup();const a=create(),b=create();
    service.submit(a.id,a.token,{proposals:[DRAFT]});service.submit(b.id,b.token,{proposals:[{...DRAFT,name:'另一个会话'}]});
    const pa=service.view(a.id).proposals as Array<{id:string}>,pb=service.view(b.id).proposals as Array<{id:string}>;
    await service.confirm(a.id,{proposalIds:[pa[0].id]});expect(()=>service.confirm(b.id,{proposalIds:[pb[0].id]})).toThrow(/已在订阅中/);
    expect(store.listUptimeMonitors()).toHaveLength(1);
  });
  it('并发相同确认只保存一次，不同选择与撤销不覆盖在途确认', async () => {
    const {service,create,store}=setup();const s=create();service.submit(s.id,s.token,{proposals:[DRAFT]});const p=service.view(s.id).proposals as Array<{id:string}>;
    let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});const original=store.flush.bind(store);vi.spyOn(store,'flush').mockImplementationOnce(()=>pending);
    const args={proposalIds:[p[0].id]};const a=service.confirm(s.id,args);const b=service.confirm(s.id,args);
    expect(()=>service.revoke(s.id)).toThrow(/正在保存/);expect(()=>service.confirm(s.id,{...args,channelIds:[]})).toThrow(/另一组/);
    expect(()=>service.submit(s.id,s.token,{proposals:[DRAFT]})).toThrow(/令牌无效/);
    release();expect(await a).toEqual(await b);await original();expect(store.listUptimeMonitors()).toHaveLength(1);
  });
  it('保存失败回滚本次监控，但保留其他服务同时更新的通知设置', async () => {
    const {service,create,store}=setup();store.setMonitorNotifications({defaultChannelIds:['phone'],overrides:{other:['phone']},mutedUntil:{other:123}});
    const s=create();service.submit(s.id,s.token,{proposals:[DRAFT]});const proposals=service.view(s.id).proposals as Array<{id:string}>;
    vi.spyOn(store,'flush').mockImplementationOnce(async()=>{store.setMonitorNotifications({...store.getMonitorNotifications(),defaultChannelIds:[],acknowledgedAt:{other:456}});throw Error('disk unavailable');});
    await expect(service.confirm(s.id,{proposalIds:[proposals[0].id],channelIds:[]})).rejects.toThrow(/未保留本次追加/);
    expect(store.listUptimeMonitors()).toEqual([]);expect(store.getMonitorNotifications()).toMatchObject({defaultChannelIds:[],overrides:{other:['phone']},acknowledgedAt:{other:456},mutedUntil:{other:123}});
    expect(service.view(s.id).status).toBe('proposed');await service.confirm(s.id,{proposalIds:[proposals[0].id]});expect(store.listUptimeMonitors()).toHaveLength(1);
  });
});

describe('HTTP 网关与会话凭据隔离', () => {
  it('提议令牌不能访问owner接口或其他系统API，非owner用户与项目key被拒', async () => {
    const {service}=setup();const app=express();app.use(express.json());
    app.use(createGithubAuthMiddleware({authService:{validateSession:async(token:string)=>token==='owner'?{user:{isSystemOwner:true},session:{}}:token==='member'?{user:{isSystemOwner:false},session:{}}:null} as never,
      isPublicRequest:req=>isMonitorOnboardingAgentRoute(req.method,req.path),
      resolveAgentKey:req=>{if(req.headers['x-ai-access-key']==='project'){(req as unknown as {cdsProjectKey:unknown}).cdsProjectKey={projectId:'p'};return {id:'project'};}return null;}}));
    app.use('/api',createMonitorOnboardingRouter(service));app.get('/api/uptime/summary',(_q,r)=>r.json({private:true}));
    const server=app.listen(0);await new Promise<void>(r=>server.once('listening',r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    const call=async(method:string,url:string,headers:Record<string,string>={},body?:unknown)=>{const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as any};};
    try{
      const owner={Cookie:'cds_gh_session=owner'},member={Cookie:'cds_gh_session=member'};
      expect((await call('POST','/api/uptime/onboarding',member,{})).status).toBe(403);expect((await call('POST','/api/uptime/onboarding',{'X-AI-Access-Key':'project'},{})).status).toBe(403);
      const created=await call('POST','/api/uptime/onboarding',owner,{});expect(created.status).toBe(201);const {id,token}=created.body;
      const bearer={Authorization:`Bearer ${token}`};expect((await call('GET',`/api/uptime/onboarding-agent/${id}/instructions`,bearer)).status).toBe(200);
      expect((await call('POST',`/api/uptime/onboarding-agent/${id}/proposals`,bearer,{proposals:[DRAFT]})).status).toBe(202);
      for(const [method,url] of [['GET',`/api/uptime/onboarding/${id}`],['POST',`/api/uptime/onboarding/${id}/confirm`],['GET','/api/uptime/summary'],['DELETE',`/api/uptime/onboarding/${id}`]])expect((await call(method,url,bearer,method==='POST'?{}:undefined)).status).toBe(401);
      const view=await call('GET',`/api/uptime/onboarding/${id}`,owner);expect(JSON.stringify(view.body)).not.toContain(token);expect(view.body.proposals).toHaveLength(1);
      const result=await call('POST',`/api/uptime/onboarding/${id}/confirm`,owner,{proposalIds:[view.body.proposals[0].id]});expect(result.status).toBe(201);
      expect((await call('POST',`/api/uptime/onboarding-agent/${id}/proposals`,bearer,{proposals:[DRAFT]})).status).toBe(401);
    }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  });
  it.each([
    ['GET',`/api/uptime/onboarding-agent/${'a'.repeat(32)}/instructions`,true],['POST',`/api/uptime/onboarding-agent/${'a'.repeat(32)}/proposals`,true],
    ['POST',`/api/uptime/onboarding-agent/${'a'.repeat(32)}/instructions`,false],['GET',`/api/uptime/onboarding-agent/${'a'.repeat(32)}/proposals`,false],
    ['GET',`/api/uptime/onboarding-agent/${'a'.repeat(32)}/instructions/other`,false],['POST',`/api/uptime/onboarding/${'a'.repeat(32)}/confirm`,false],
  ])('公有路径仅匹配精确method/path %s %s',(method,url,expected)=>expect(isMonitorOnboardingAgentRoute(method as string,url as string)).toBe(expected));
});
