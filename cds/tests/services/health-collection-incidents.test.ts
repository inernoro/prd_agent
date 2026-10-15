import { afterEach, expect, it, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UptimeMonitorService, uptimeConfigFromEnv } from '../../src/services/uptime-monitor.js';
import { sendAlarm, independentIncidentUrl } from '../../src/services/alarm-dispatch.js';
import { renderAlarmMessage, type AlarmEvent, type AlarmChannelConfig } from '../../src/services/alarm-route.js';
import { parseAlarmIdentity, identityForAlarm } from '../../src/services/alarm-identity.js';
import type { UptimeCustomMonitor } from '../../src/types.js';

afterEach(() => vi.unstubAllGlobals());
const defs = (url: string) => Array.from({length:5}, (_,i) => ({id:`metric-${i}`,name:`业务检查 ${i}`,projectId:'business',kind:'health-json',url,
  enabled:true,intervalSeconds:60,timeoutMs:1000,environment:'production',healthComponentId:`m${i}`,healthField:'observedValue',healthOp:'eq',healthValue:'0',createdAt:'',updatedAt:''} as UptimeCustomMonitor));

it('真实 HTTP：五项共同失败仅投递一次、重启不重报、无数据留证且不虚增失败率、稳定恢复仅一次', async () => {
  let failed=true,calls=0,now=1_000_000;
  const pushes: URL[]=[];
  const server=http.createServer((req,res)=>{
    if(req.url!.startsWith('/health')){calls++;res.statusCode=failed?503:200;res.end(JSON.stringify({checks:Object.fromEntries(Array.from({length:5},(_,i)=>[`m${i}`,{observedValue:0}]))}));}
    else {pushes.push(new URL(req.url!,'http://fixture'));res.end('{}');}
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cds-incident-'));
  const channel: AlarmChannelConfig={id:'test',name:'测试',kind:'bark',enabled:true,projects:[],events:['business-down','business-recovered'],bark:{serverUrl:base,key:'fixture'},createdAt:0,updatedAt:0};
  const identity=identityForAlarm(parseAlarmIdentity({instance:{name:'检查 A',environment:'测试',iconUrl:'https://static.example/observer-a.png'}}));
  const pending: Promise<unknown>[]=[];
  let service: UptimeMonitorService;
  const create=()=>new UptimeMonitorService({state:{getAllBranches:()=>[],getUptimeMonitors:()=>defs(base+'/health')},
    config:{...uptimeConfigFromEnv(dir),storePath:path.join(dir,'uptime.json'),failureThreshold:3},now:()=>now,
    onAlert:(type,data)=>{ const event:AlarmEvent={...data,identity,kind:type==='uptime.target.down'?'business-down':'business-recovered'};
      pending.push(sendAlarm(channel,event).then(r=>{if(r.ok&&type==='uptime.target.down')return service.markAlarmDelivered(data.targetId,channel.id,data.detectedAt);})); }});
  const cycle=async()=>{await service.runCycle();await Promise.all(pending);now+=60_000;};
  try{
    service=create();for(let i=0;i<4;i++)await cycle();await service.flush();
    expect(calls).toBe(4);expect(pushes).toHaveLength(1);
    expect(decodeURIComponent(pushes[0].pathname)).toContain('5 项检查');
    expect(decodeURIComponent(pushes[0].pathname)).toContain('尚未确认业务中断');
    expect(pushes[0].searchParams.get('icon')).toBe('https://static.example/observer-a.png');
    const member=service.getRecord('monitor@metric-0')!;
    expect(member.samples).toHaveLength(4);expect(member.samples.every(s=>s.noData)).toBe(true);
    expect(service.getSummary().targets.find(t=>t.id===member.id)?.availability24h).toBeNull();
    service=create();await service.load();await cycle();expect(pushes).toHaveLength(1);
    failed=false;for(let i=0;i<12;i++)await cycle();expect(pushes).toHaveLength(2);
    expect(decodeURIComponent(pushes[1].pathname)).toContain('已稳定恢复');
    expect(pushes[1].searchParams.get('level')).toBe('passive');
  }finally{await service!.flush();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));fs.rmSync(dir,{recursive:true,force:true});}
});

it('项目、环境及请求策略不同不合并，真实指标失败仍单独建立事件',async()=>{
  let now=1_000_000;
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({checks:{m0:{observedValue:1},m1:{observedValue:0},m2:{observedValue:0},m3:{observedValue:0},m4:{observedValue:0}}}))));
  const monitors=defs('https://example.test/health');
  monitors.push({...monitors[0],id:'other-project',projectId:'other'}, {...monitors[0],id:'other-env',environment:'staging'});
  const alerts=vi.fn();const service=new UptimeMonitorService({state:{getAllBranches:()=>[],getUptimeMonitors:()=>monitors},config:{...uptimeConfigFromEnv('/tmp'),storePath:'',failureThreshold:3},now:()=>now,onAlert:alerts});
  for(let i=0;i<3;i++){await service.runCycle();now+=60_000;}
  expect(alerts).toHaveBeenCalledTimes(3);expect(alerts.mock.calls.every(c=>c[1].assessment==='check-failed')).toBe(true);
  expect(service.getSummary().targets.filter(t=>t.collectionMembers)).toHaveLength(3);
  expect(service.getRecord('monitor@metric-0')?.lastSample?.finding).toBe('当前读数 1，应等于 0。');
});

it('通知上下文只保留在 URL 片段，不进入托管请求或公开快照；头像拒绝带凭据的地址',()=>{
  const event={kind:'business-down',projectId:'business',targetId:'monitor@test',targetName:'示例业务',assessment:'observation-unavailable',affectedChecks:5,detectedAt:new Date(0).toISOString(),consecutiveFailures:3,message:'private upstream URL'} as AlarmEvent;
  const url=new URL(independentIncidentUrl({incidentPageUrl:'https://static.example/#feed=https%3A%2F%2Fstatus.example%2Fpublic.json'} as AlarmChannelConfig,event)!);
  expect(url.search).not.toContain('示例业务');expect(decodeURIComponent(url.hash)).not.toContain('private upstream');
  expect(JSON.parse(new URLSearchParams(url.hash.slice(1)).get('notice')!).count).toBe(5);
  expect(renderAlarmMessage(event).body).not.toContain('用户现在用不了');
  expect(()=>parseAlarmIdentity({instance:{name:'A',environment:'测试',iconUrl:'https://static.example/a.png?token=private'}})).toThrow();
});
