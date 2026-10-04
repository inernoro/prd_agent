import { describe, expect, it, vi } from 'vitest';
import { parseAlarmIdentity, identityForAlarm } from '../../src/services/alarm-identity.js';
import { renderAlarmMessage, type AlarmChannelConfig, type AlarmEvent } from '../../src/services/alarm-route.js';
import { sendAlarm } from '../../src/services/alarm-dispatch.js';
import { buildNotificationPayload } from '../../src/services/map-notifier.js';
import { StateService } from '../../src/services/state.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAlarmChannelRoutes } from '../../src/routes/alarm-channels.js';
import { AlarmLedger } from '../../src/services/alarm-channel.js';
import type { Router, Request, Response } from 'express';

const settings = parseAlarmIdentity({instance:{name:'示例检查方',environment:'测试'},targets:{'monitor@peer':{id:'sample-peer',name:'示例目标',environment:'演示'}}});
const event: AlarmEvent = {kind:'business-down',targetId:'monitor@peer',projectId:'cds-self-monitor',targetName:'入口检查',message:'请求未完成',detectedAt:new Date(0).toISOString(),consecutiveFailures:3,identity:identityForAlarm(settings,'monitor@peer')};

describe('通知实例身份', () => {
  it('项目凭据不能读写身份；管理员保存后能读回，改名保留 ID', () => {
    const handlers: Record<string, (req: Request, res: Response) => void> = {};
    const router = Object.fromEntries(['get','put','post','delete'].map(method => [method, (route: string, handler: typeof handlers[string]) => { handlers[`${method} ${route}`] = handler; }])) as unknown as Router;
    let saved = settings;
    registerAlarmChannelRoutes(router, { list: () => [], upsert: () => {}, remove: () => false, ledger: new AlarmLedger(), getIdentity: () => saved, setIdentity: value => { saved = value; } });
    const invoke = (method: string, req: object) => {
      const result = {status: 200, body: {} as any};
      const res = {status: (value: number) => {result.status=value;return res;},json: (value: unknown) => {result.body=value;}};
      handlers[`${method} /cds-system/alarm-identity`](req as Request,res as unknown as Response);
      return result;
    };
    for (const method of ['get','put']) expect(invoke(method,{cdsProjectKey:{projectId:'sample'},body:{instance:{name:'非法覆盖',environment:'测试'}}}).status).toBe(403);
    expect(saved).toEqual(settings);
    expect(invoke('put',{body:{instance:{name:'合法改名',environment:'演示'}}}).status).toBe(200);
    expect(invoke('get',{}).body.identity.instance).toEqual({...settings.instance,name:'合法改名',environment:'演示'});
    expect(invoke('put',{body:{instance:{name:'',environment:'演示'}}}).status).toBe(400);
  });
  it('改名不改变自身 ID，不推断主机名，拒绝地址和秘密字段混入', () => {
    const updated = parseAlarmIdentity({instance:{name:'新名称',environment:'演示',token:'private'}},settings);
    expect(updated.instance.id).toBe(settings.instance.id);
    expect(JSON.stringify(updated)).not.toContain('private');
    expect(()=>parseAlarmIdentity({instance:{name:'https://example.invalid',environment:'测试'}})).toThrow();
  });
  it('真实持久化后重启仍保持身份', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cds-identity-'));
    try {
      const file=path.join(dir,'state.json');
      const state=new StateService(file,dir);state.load();state.setAlarmIdentity(settings);
      await (state.getBackingStore() as {flush():Promise<void>}).flush();
      const reloaded=new StateService(file,dir);reloaded.load();
      expect(reloaded.getAlarmIdentity()).toEqual(settings);
      await (reloaded.getBackingStore() as {flush():Promise<void>}).flush();
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('故障和恢复都说明检查方与故障对象，分组保持一致', () => {
    const down=renderAlarmMessage(event),up=renderAlarmMessage({...event,kind:'business-recovered'});
    expect(down.title).toContain('示例目标');expect(down.body).toContain('检查方：示例检查方');
    expect(up.body).toContain('故障对象：示例目标');expect(up.group).toBe(down.group);
  });
  it('MAP 跨实例相同目标与时刻不会碰撞去重键', () => {
    const alert={...event,type:'uptime.target.down' as const,targetId:event.targetId!};
    const a=buildNotificationPayload(alert),b=buildNotificationPayload({...alert,identity:{...event.identity!,observer:{...settings.instance,id:'another-instance'}}});
    expect(a.dedupKey).not.toBe(b.dedupKey);expect(a.title).toContain('示例目标');
  });
  it('实际 Bark 传输使用对象分组与身份文案', async () => {
    const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}',{status:200}));
    try {
      const result=await sendAlarm({id:'sample',name:'测试',kind:'bark',enabled:true,projects:[],events:['business-down'],bark:{key:'fixture-only'},createdAt:0,updatedAt:0} as AlarmChannelConfig,event);
      expect(result.ok).toBe(true);const url=new URL(String(fetch.mock.calls[0][0]));
      expect(decodeURIComponent(url.pathname)).toContain('检查方：示例检查方');
      expect(url.searchParams.get('group')).toContain('sample-peer');
    } finally {fetch.mockRestore();}
  });
});
