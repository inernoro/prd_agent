import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as childProcess from 'node:child_process';
import { DockerEventMonitor } from '../../src/services/container-diagnostics.js';
import { InfraLifecycleWatcher } from '../../src/services/infra-lifecycle-watcher.js';
import { DockerObservationEventStream } from '../../src/services/docker-observation-event-stream.js';
import { ObservationStreamExecutor } from '../../src/services/observation-stream-executor.js';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import type { IShellExecutor } from '../../src/types.js';
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const pools: Array<{ close(): Promise<void> }> = [];
const listeners: Array<{ stop(): Promise<void> | void }> = [];
const dirs: string[] = []; const originalPath = process.env.PATH;
async function fixture(count = 2) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cds-event-stream-')); dirs.push(dir);
  const traceFile = path.join(dir, 'trace.jsonl');
  const script = `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(traceFile)},JSON.stringify({pid:process.pid,ppid:process.ppid,args})+'\\n');
const emit=(action,name,exitCode,time=101)=>JSON.stringify({Action:action,Type:'container',Actor:{ID:'owned-fixture',Attributes:{name,'cds.branch.id':'fixture','cds.profile.id':'api',exitCode}},time});
if(args.includes('overflow')) {process.stdout.write('x'.repeat(128*1024)+'\\n'+emit('start','valid-after-oversize','0')+'\\n');}
else if(args.includes('flap')) {process.stdout.write(emit('start','flap','0')+'\\n');setTimeout(()=>process.exit(0),20);}
else if(args.includes('label=cds.managed=true')) {
 process.stderr.write(emit('start','stderr-is-not-an-event','0')+'\\n');
 for(let i=0;i<3;i++)process.stdout.write(emit('die','cds-fixture-api-'+i,'0')+'\\n');
} else {process.stdout.write(emit('oom','cds-infra-fixture','137')+'\\n'+emit('die','cds-infra-fixture','137',102)+'\\n');}
setInterval(()=>{},1000);setTimeout(()=>process.exit(0),60000);
`;
  await writeFile(path.join(dir, 'docker'), script, { mode: 0o700 });
  process.env.PATH = `${dir}:${originalPath || ''}`;
  const streams = new ObservationStreamExecutor(count); pools.push(streams); await streams.start(); vi.clearAllMocks();
  const trace = async () => (await readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { streams, trace };
}
async function until(predicate: () => boolean): Promise<void> {
  for(let i=0;i<400;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}
  throw new Error('Event fixture did not become ready');
}
afterEach(async () => {
  await Promise.all(listeners.splice(0).map(x=>x.stop()));
  // 原实现对照只清理本测试实际返回的docker子进程，不扫描或杀共享进程。
  for(const result of vi.mocked(childProcess.spawn).mock.results) if(result.type==='return'&&result.value?.spawnfile==='docker') result.value.kill('SIGKILL');
  await Promise.all(pools.splice(0).map(x=>x.close()));
  await Promise.all(dirs.splice(0).map(x=>rm(x,{recursive:true,force:true})));
  if(originalPath===undefined)delete process.env.PATH;else process.env.PATH=originalPath;
  vi.clearAllMocks();
});

describe('Docker事件独立读取真实进程',()=>{
  it('两个实际监听不从Master启动，突发诊断按序且stderr不冒充事件，OOM关联保留',async()=>{
    const f=await fixture();const records:any[]=[];const seen:string[]=[];let active=0;let peak=0;
    const shell:IShellExecutor={exec:async(command)=>{
      if(command.startsWith('docker inspect')){active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,50));active--;}
      return {stdout:'',stderr:'',exitCode:1};
    }};
    const store={record:(record:unknown)=>records.push(record)};
    const monitor=new DockerEventMonitor(shell,store,async event=>{seen.push(event.containerName!);},f.streams);
    const infra=new InfraLifecycleWatcher({serverEventLogStore:store,streams:f.streams});listeners.push(monitor,infra);
    monitor.start();monitor.start();infra.start();infra.start();
    await until(()=>seen.length===3&&infra.getEvents().length>=2);
    const trace=await f.trace();
    if(process.env.CDS_EVENT_REFERENCE==='1') console.info(JSON.stringify({referenceTrace:trace,peakDiagnostics:peak}));
    expect(trace.every((x:any)=>x.ppid!==process.pid)).toBe(true);expect(trace).toHaveLength(2);
    expect(childProcess.spawn).not.toHaveBeenCalled();expect(peak).toBe(1);
    expect(seen).toEqual(['cds-fixture-api-0','cds-fixture-api-1','cds-fixture-api-2']);
    expect(records.some(r=>r.action==='monitor.warning'&&r.message.includes('stderr-is-not-an-event'))).toBe(true);
    expect(records.find(r=>r.action==='infra.lifecycle.die').message).toContain('cgroup OOM');
    await Promise.all([monitor.stop(),infra.stop()]);expect(f.streams.getStats().admitted).toBe(0);
  });
  it('实际超长未换行数据有界并丢弃整行，后续完整事件不被前缀污染',async()=>{
    const f=await fixture(1);const seen:string[]=[];const warnings:string[]=[];
    const stream=new DockerObservationEventStream(f.streams,['events','overflow'],line=>{seen.push(JSON.parse(line).Actor.Attributes.name);},reason=>warnings.push(reason));listeners.push(stream);stream.start();
    await until(()=>seen.length===1);expect(seen).toEqual(['valid-after-oversize']);
    expect(stream.getStats().overflowLines).toBe(1);expect(stream.getStats().bufferedBytes).toBeLessThanOrEqual(65536);
    expect(warnings.some(x=>x.includes('64KiB'))).toBe(true);await stream.stop();expect(f.streams.getStats().admitted).toBe(0);
  });
  it('实际流断开只重连一个，反复start与stop/start不叠加或留下定时器',async()=>{
    const f=await fixture(1);let seen=0;
    const stream=new DockerObservationEventStream(f.streams,['events','flap'],()=>{seen++;},()=>{},10);listeners.push(stream);
    stream.start();stream.start();await until(()=>seen>=2);expect(f.streams.getStats().admitted).toBeLessThanOrEqual(1);
    const stopping=stream.stop();stream.start();await stopping;await until(()=>seen>=3);
    await stream.stop();const count=(await f.trace()).length;await new Promise(r=>setTimeout(r,100));
    expect((await f.trace()).length).toBe(count);expect(f.streams.getStats().admitted).toBe(0);
  });
  it('实际stop取消所属健康诊断并等待消费收尾，不留下迟到状态同步',async()=>{
    const f=await fixture(1);const health=new IsolatedShellExecutor(new ShellExecutor(),{concurrency:1});pools.push(health);await health.start();
    const records:any[]=[];let synced=0;
    const shell:IShellExecutor={exec:(_command,options)=>health.exec('sleep 30',options)};
    const monitor=new DockerEventMonitor(shell,{record:r=>records.push(r)},()=>{synced++;},f.streams);listeners.push(monitor);monitor.start();
    await until(()=>health.getStats().active===1);await monitor.stop();
    expect(health.getStats().active).toBe(0);expect(f.streams.getStats().admitted).toBe(0);
    expect(synced).toBe(0);expect(records.filter(r=>r.action==='die')).toEqual([]);
  });
  it('实际持续流越过30秒有限查询默认期限，直到显式取消才结束',async()=>{
    const streams=new ObservationStreamExecutor(1);pools.push(streams);await streams.start();
    const ac=new AbortController();let ready=false;let failure:string|undefined;
    const running=streams.exec('echo continuous-ready; sleep 60',{timeout:0,signal:ac.signal,onData:()=>{ready=true;}}).catch(error=>{failure=error.code;});
    try{await until(()=>ready);await new Promise(r=>setTimeout(r,31_100));expect(failure).toBeUndefined();expect(streams.getStats().admitted).toBe(1);}
    finally{ac.abort();await running;}
    expect(failure).toBe('cancelled');expect(streams.getStats().admitted).toBe(0);
  },40_000);
});
