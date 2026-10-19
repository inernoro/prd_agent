import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabasePassService, databasePassClientIp } from '../../src/services/database-pass.js';
import { postgresPassStartup } from '../../src/services/database-pass-gateway.js';

const mocks=vi.hoisted(()=>({account:vi.fn(),gateway:vi.fn(),close:vi.fn(),activate:vi.fn()}));
vi.mock('../../src/services/database-pass-accounts.js',()=>({changeDatabasePassAccount:mocks.account}));
vi.mock('../../src/services/database-pass-gateway.js',async original=>({...await original<object>(),openDatabasePassGateway:mocks.gateway}));
vi.mock('../../src/services/resource-tcp-access.js',()=>({resourceTcpAccessConfig:()=>({enabled:true,host:'192.0.2.20',bindIp:'127.0.0.1'})}));

describe('数据库通行证：权限、审计、复制与到期回收',()=>{
  let dir:string;
  const scope={projectId:'qa',branchId:'qa-main',resourceId:'infra:pg'};
  const target=async()=>({runtime:'postgres' as const,port:12345,database:'qa_items',adminUser:'admin',adminPassword:'not-exported'});
  beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'cds-pass-'));vi.stubEnv('CDS_DATABASE_PASS_ENABLED','1');vi.stubEnv('CDS_SECRET_KEY','test-key-for-encrypted-pass-storage');vi.stubEnv('CDS_PREVIEW_INSTANCE','0');mocks.account.mockReset().mockResolvedValue(undefined);mocks.close.mockReset();mocks.activate.mockReset();mocks.gateway.mockReset().mockResolvedValue({port:43210,activate:mocks.activate,close:mocks.close});});
  afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();fs.rmSync(dir,{recursive:true,force:true});});
  it('默认30分钟、每证独立账号、加密落盘；复制不提前放行',async()=>{
    const service=new DatabasePassService(dir,target);
    const first=await service.prepare(scope,'human:one',['192.0.2.10/32']);
    const second=await service.prepare(scope,'human:one',['192.0.2.10/32']);
    expect(first.ttlMinutes).toBe(30);expect(first.username).not.toBe(second.username);
    const credential=await service.credentials(first.id,'human:one',scope);
    expect(credential.password.length).toBeGreaterThan(24);expect(credential.port).toBeGreaterThan(0);expect(credential.tlsRequired).toBe(true);
    expect(fs.readFileSync(path.join(dir,'passes.json'),'utf8')).not.toContain(credential.password);
    expect(fs.readFileSync(path.join(dir,'audit.jsonl'),'utf8')).not.toContain(credential.password);
    expect(mocks.gateway).toHaveBeenCalledTimes(2);expect(mocks.activate).not.toHaveBeenCalled();expect(first).not.toHaveProperty('secret');
    await service.revoke(first.id,'human:one',scope);await service.revoke(second.id,'human:one',scope);
  });
  it('放行使用复制的原地址；单次期限从激活开始，并回收账号',async()=>{
    const service=new DatabasePassService(dir,target),pass=await service.prepare(scope,'one',['192.0.2.10/32'],1);
    const activated=await service.activate(pass.id,'one',scope);
    expect(mocks.gateway.mock.calls[0][0]).toMatchObject({port:0,startInactive:true});expect(activated.port).toBe(pass.port);expect(mocks.activate).toHaveBeenCalledOnce();
    expect(Date.parse(activated.expiresAt)-Date.parse(activated.activatedAt!)).toBe(60000);
    await service.revoke(pass.id,'one',scope);
    expect(mocks.close).toHaveBeenCalled();expect(mocks.account.mock.calls.at(-1)?.[2]).toBe(false);
    await expect(service.credentials(pass.id,'one',scope)).rejects.toThrow('失效');
  });
  it('新证书轮换不会改变已复制通行证的CA或重新绑定端口',async()=>{
    const service=new DatabasePassService(dir,target),first=await service.prepare(scope,'one',['192.0.2.10/32']);
    const before=await service.credentials(first.id,'one',scope);
    fs.rmSync(path.join(dir,'tls'),{recursive:true});
    const second=await service.prepare(scope,'one',['192.0.2.10/32']);
    const after=await service.credentials(first.id,'one',scope);
    expect(after.tlsCa).toBe(before.tlsCa);expect(after.port).toBe(before.port);
    expect((await service.credentials(second.id,'one',scope)).tlsCa).not.toBe(before.tlsCa);
    await service.activate(first.id,'one',scope);expect(mocks.gateway).toHaveBeenCalledTimes(2);
    await service.revoke(first.id,'one',scope);await service.revoke(second.id,'one',scope);
  });
  it('审计尾行不完整仍可列出现有通行证、显示警告并撤销；原始坏行保留',async()=>{
    const service=new DatabasePassService(dir,target),pass=await service.prepare(scope,'one',['192.0.2.10/32']);
    await service.activate(pass.id,'one',scope);
    fs.appendFileSync(path.join(dir,'audit.jsonl'),'\u007b"event":"torn');
    expect((await service.list(scope,'one'))[0].id).toBe(pass.id);
    expect(await service.events(scope,'one')).toContainEqual(expect.objectContaining({event:'audit-record-damaged'}));
    expect((await service.revoke(pass.id,'one',scope)).status).toBe('revoked');
    expect(await service.events(scope,'one')).toContainEqual(expect.objectContaining({event:'account-reclaimed'}));
    expect(fs.readFileSync(path.join(dir,'audit.jsonl'),'utf8')).toContain('\u007b"event":"torn\n');
  });
  it('签发记录损坏时停止新签发，不覆盖原始记录或影响控制面启动',async()=>{
    fs.writeFileSync(path.join(dir,'passes.json'),'{broken');
    const service=new DatabasePassService(dir,target);
    expect(service.capability().enabled).toBe(false);
    await expect(service.prepare(scope,'one',['192.0.2.10/32'])).rejects.toThrow('无法读取');
    expect(fs.readFileSync(path.join(dir,'passes.json'),'utf8')).toBe('{broken');
    expect(mocks.account).not.toHaveBeenCalled();
  });
  it('签发期间撤销等待账号创建收尾，不会在撤销后复活准备状态',async()=>{
    const service=new DatabasePassService(dir,target);
    let finish:()=>void=()=>{},started:()=>void=()=>{};
    const creating=new Promise<void>(resolve=>{started=resolve;});
    mocks.account.mockImplementation(async(_target,_account,create)=>{if(create){started();await new Promise<void>(resolve=>{finish=resolve;});}});
    const preparation=service.prepare(scope,'one',['192.0.2.10/32']);await creating;
    const pending=(await service.list(scope,'one'))[0];expect(pending.status).toBe('preparing');
    const revocation=service.revoke(pending.id,'one',scope);finish();
    await preparation;expect((await revocation).status).toBe('revoked');
    expect((await service.list(scope,'one'))[0].status).toBe('revoked');
    expect(mocks.account.mock.calls.map(call=>call[2])).toEqual([true,false]);
    expect(mocks.activate).not.toHaveBeenCalled();
  });
  it('撤销与放行并发时，撤销等待放行完成并关闭刚建立的入口',async()=>{
    const service=new DatabasePassService(dir,target),pass=await service.prepare(scope,'one',['192.0.2.10/32']);
    const activation=service.activate(pass.id,'one',scope);
    const revocation=service.revoke(pass.id,'one',scope);
    await activation;expect((await revocation).status).toBe('revoked');
    expect(mocks.close).toHaveBeenCalledOnce();expect(mocks.account.mock.calls.at(-1)?.[2]).toBe(false);
    await expect(service.activate(pass.id,'one',scope)).rejects.toThrow('失效');
  });
  it('不能跨用户、跨项目、跨资源取凭据或放行',async()=>{
    const service=new DatabasePassService(dir,target),pass=await service.prepare(scope,'one',['192.0.2.10/32']);
    await expect(service.credentials(pass.id,'two',scope)).rejects.toThrow('不属于');
    await expect(service.activate(pass.id,'one',{...scope,projectId:'other'})).rejects.toThrow('不属于');
    await expect(service.revoke(pass.id,'one',{...scope,resourceId:'infra:mysql'})).rejects.toThrow('不属于');
    expect(await service.list(scope,'two')).toEqual([]);await service.revoke(pass.id,'one',scope);
  });
  it('到期关闭现有连接并回收账号；期限不能靠重新读取或重启延长',async()=>{
    const service=new DatabasePassService(dir,target),pass=await service.prepare(scope,'one',['192.0.2.10/32'],1);
    const active=await service.activate(pass.id,'one',scope);
    vi.spyOn(Date,'now').mockReturnValue(Date.parse(active.expiresAt)+1);
    const listed=await service.list(scope,'one');expect(listed[0].status).toBe('expired');expect(listed[0].expiresAt).toBe(active.expiresAt);
    expect(mocks.close).toHaveBeenCalled();expect(mocks.account.mock.calls.at(-1)?.[2]).toBe(false);
    await expect(service.activate(pass.id,'one',scope)).rejects.toThrow('失效');
  });
  it('不允许缺少白名单、全网、超30分钟或未加密签发',async()=>{
    const service=new DatabasePassService(dir,target);
    for(const rules of [[],['0.0.0.0/0'],['example.com/32'],['192.0.2.10/32/1']])await expect(service.prepare(scope,'one',rules)).rejects.toThrow();
    await expect(service.prepare(scope,'one',['192.0.2.10/32'],31)).rejects.toThrow();
    vi.stubEnv('CDS_SECRET_KEY','');await expect(service.prepare(scope,'one',['192.0.2.10/32'])).rejects.toThrow();expect(mocks.account).not.toHaveBeenCalled();
  });
  it('账号创建前审计失败，不开放网络；创建后存储失败仍尝试回收',async()=>{
    const service=new DatabasePassService(dir,target);
    fs.mkdirSync(path.join(dir,'audit.jsonl'));
    await expect(service.prepare(scope,'one',['192.0.2.10/32'])).rejects.toThrow('入口未放行');
    expect(mocks.account.mock.calls.some(c=>c[2]===true)).toBe(false);expect(mocks.gateway).not.toHaveBeenCalled();
    fs.rmSync(path.join(dir,'audit.jsonl'),{recursive:true});
    mocks.account.mockImplementation(async(_target,_account,create)=>{if(create)fs.mkdirSync(path.join(dir,'passes.json.tmp'));});
    await expect(service.prepare(scope,'one',['192.0.2.10/32'])).rejects.toThrow();
    expect(mocks.account.mock.calls.at(-1)?.[2]).toBe(false);expect(mocks.activate).not.toHaveBeenCalled();expect(mocks.close).toHaveBeenCalled();
  });
  it('控制面重启不自动重开旧证；清理失败状态不冒充回收成功',async()=>{
    const service=new DatabasePassService(dir,target),pass=await service.prepare(scope,'one',['192.0.2.10/32']);
    const recovered=new DatabasePassService(dir,target);expect((await recovered.list(scope,'one'))[0].status).toBe('revoked');expect(mocks.activate).not.toHaveBeenCalled();
    mocks.account.mockResolvedValue(undefined);const fresh=await service.prepare(scope,'one',['192.0.2.10/32']);await service.activate(fresh.id,'one',scope);
    mocks.account.mockRejectedValue(new Error('offline'));const revoked=await service.revoke(fresh.id,'one',scope);expect(revoked.status).toBe('cleanup-failed');expect(mocks.close).toHaveBeenCalled();
    expect(pass.id).not.toBe(fresh.id);
  });
});

describe('真实来源与PostgreSQL目标绑定',()=>{
  it('直连不信任伪造转发头；本地代理优先采用实际LAN来源',()=>{
    expect(databasePassClientIp({socket:{remoteAddress:'192.0.2.10'},headers:{'cf-connecting-ip':'192.0.2.20'}})).toBe('192.0.2.10');
    expect(databasePassClientIp({socket:{remoteAddress:'127.0.0.1'},headers:{'x-real-ip':'192.0.2.10','cf-connecting-ip':'192.0.2.20'}})).toBe('192.0.2.10');
  });
  it('PostgreSQL startup必须同时绑定目标库与临时账号，禁止重复字段',()=>{
    const packet=(fields:string[])=>{const values=Buffer.from(fields.join('\0')+'\0\0');const head=Buffer.alloc(8);head.writeUInt32BE(values.length+8);head.writeUInt32BE(196608,4);return Buffer.concat([head,values]);};
    expect(postgresPassStartup(packet(['user','temp','database','qa']),'qa','temp')).toBe(true);
    expect(postgresPassStartup(packet(['user','temp','database','other']),'qa','temp')).toBe(false);
    expect(postgresPassStartup(packet(['user','root','database','qa']),'qa','temp')).toBe(false);
    expect(postgresPassStartup(packet(['user','temp','user','root','database','qa']),'qa','temp')).toBe(false);
  });
});
