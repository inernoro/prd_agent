import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { HostCapacitySamplingService } from '../../src/services/host-capacity-sampling.js';
import { HostCapacityObservationService } from '../../src/services/host-capacity-observation.js';
import { StateService } from '../../src/services/state.js';
const dirs: string[] = [], stops: Array<()=>void> = [];
afterEach(async()=>{stops.splice(0).forEach(s=>s());vi.useRealTimers();await Promise.all(dirs.splice(0).map(d=>fs.rm(d,{recursive:true,force:true})));});
async function fixture(extra: Record<string,any> = {}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'capacity-sampler-'));dirs.push(root);
  const source=path.join(root,'source');await fs.mkdir(source);
  const observation=new HostCapacityObservationService({publish:vi.fn()});observation.start();
  const persist=vi.fn(async()=>{}),run=vi.fn(async(_argv:string[],_signal:AbortSignal)=>3);
  const service=new HostCapacitySamplingService({enabled:false,external:false,stateDir:path.join(root,'private-history'),roots:{cache:source},observation,persist,run,...extra});
  stops.push(()=>{service.stop();observation.stop();});
  return {root,source,service,observation,persist,run};
}
async function settle(check:()=>void){for(let n=0;n<2000;n++){try{check();return;}catch{await new Promise(r=>setImmediate(r));}}check();}
it('defaults off and persists explicit opt-in before running any command; disabling remains unknown',async()=>{
  let release!:()=>void;const wait=new Promise<void>(r=>release=r);const persist=vi.fn(()=>wait);
  const f=await fixture({persist});f.service.start();expect(f.run).not.toHaveBeenCalled();expect(f.service.getStatus().enabled).toBe(false);
  const enabling=f.service.setEnabled(true);expect(f.run).not.toHaveBeenCalled();expect(f.service.getStatus().enabled).toBe(false);
  release();await enabling;await settle(()=>expect(f.run).toHaveBeenCalledOnce());
  await f.service.setEnabled(false);expect(f.service.getStatus().enabled).toBe(false);expect(f.observation.getSnapshot().status).toBe('unknown');
});
it('rejects external producer conflicts and failed persistence without launching a sampler',async()=>{
  const external=await fixture({external:true});await expect(external.service.setEnabled(true)).rejects.toThrow('external-report-configured');expect(external.persist).not.toHaveBeenCalled();
  const failed=await fixture({persist:async()=>{throw Error('disk');}});await expect(failed.service.setEnabled(true)).rejects.toThrow('disk');expect(failed.run).not.toHaveBeenCalled();expect(failed.service.getStatus().enabled).toBe(false);
});
it('cancels an in-flight run and late completion cannot restart timers; bounded retries never overlap',async()=>{
  let release!:(n:number)=>void;const wait=new Promise<number>(r=>release=r);const run=vi.fn((_argv:string[],_signal:AbortSignal)=>wait);
  const f=await fixture({enabled:true,run});vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});f.service.start();
  await settle(()=>expect(run).toHaveBeenCalledOnce());expect(()=>f.service.requestSample()).toThrow('sampling-unavailable');
  const signal=run.mock.calls[0]?.[1] as AbortSignal;expect(signal.aborted).toBe(false);
  f.service.stop();expect(signal.aborted).toBe(true);release(0);await settle(()=>expect(f.service.getStatus().running).toBe(false));
  await vi.advanceTimersByTimeAsync(8*3600_000);expect(run).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
});
it('collects real allocated source bytes with the unchanged packaged collector and keeps content hash intact',async()=>{
  const f=await fixture({run:undefined});const file=path.join(f.source,'payload.bin');await fs.writeFile(file,Buffer.alloc(16*1024*1024,73));
  const hash=()=>fs.readFile(file).then(b=>createHash('sha256').update(b).digest('hex'));const before=await hash();
  await f.service.setEnabled(true);await vi.waitFor(()=>expect(f.service.getStatus().running).toBe(false));
  await vi.waitFor(()=>expect(f.observation.getSnapshot().sampledAt).not.toBeNull());
  const snapshot=f.observation.getSnapshot();expect(snapshot.status).toBe('unknown');
  const expected=Number(execFileSync('du',['-sx','--block-size=1','--',f.source],{encoding:'utf8'}).split(/\s/)[0]);
  expect(snapshot.report?.sources.cache.bytes).toBe(expected);expect(expected).toBeGreaterThanOrEqual(16*1024*1024);
  expect(await hash()).toBe(before);const hist=JSON.parse(await fs.readFile(path.join(f.root,'private-history','history.json'),'utf8'));expect(hist.samples).toHaveLength(1);expect(hist.host).toBe(os.hostname());
  expect((await fs.readdir(path.join(f.root,'private-history'))).sort()).toEqual(['history.json','latest.json','lock']);
  expect((await fs.stat(path.join(f.root,'private-history','latest.json'))).size).toBeLessThan(4*1024*1024);
});
it('uses fixed read-only argv without a shell and refuses an overlapping history or unreadable source',async()=>{
  const f=await fixture();await f.service.setEnabled(true);await settle(()=>expect(f.run).toHaveBeenCalledOnce());
  const args=f.run.mock.calls[0]?.[0] as string[];expect(args.slice(1)).toEqual(['--state-dir',path.join(f.root,'private-history'),'--source','cache='+await fs.realpath(f.source)]);expect(args.join(' ')).not.toMatch(/prune|remove|delete/);
  const overlap=await fixture();const bad=new HostCapacitySamplingService({enabled:true,external:false,stateDir:path.join(overlap.source,'history'),roots:{cache:overlap.source},observation:overlap.observation,persist:async()=>{},run:overlap.run});stops.push(()=>bad.stop());bad.start();await settle(()=>expect(bad.getStatus().outcome).toBe('unknown'));expect(overlap.run).not.toHaveBeenCalled();
});
it('exposes a process failure immediately as unknown and refuses to reuse a formerly normal report',async()=>{
  const f=await fixture({run:async()=>{throw Error('python unavailable');}});await f.service.setEnabled(true);await settle(()=>expect(f.service.getStatus().outcome).toBe('unknown'));expect(f.observation.getSnapshot()).toMatchObject({status:'unknown',sampledAt:null});
  expect(f.observation.getSnapshot().reason).toContain('容量采集失败');
});
it('persists the owner choice across actual state reloads and retains a single source-of-truth script entry',async()=>{
  const f=await fixture();const file=path.join(f.root,'state.json');const state=new StateService(file);state.load();expect(state.getHostCapacitySamplingEnabled()).toBe(false);state.setHostCapacitySamplingEnabled(true);await state.flush();const restored=new StateService(file);restored.load();expect(restored.getHostCapacitySamplingEnabled()).toBe(true);
  const actual=new URL('../../../scripts/host-capacity.py',import.meta.url);
  expect(await fs.readFile(actual,'utf8')).toBe(await fs.readFile(new URL('../../src/services/host-capacity-probe.py',import.meta.url),'utf8'));
  expect((await fs.lstat(actual)).isSymbolicLink()).toBe(true);
});

it('does not let an old normal report, including an accepted future timestamp, hide a later sampler failure',async()=>{
  const f=await fixture();const state=path.join(f.root,'private-history');await fs.mkdir(state,{mode:0o700});
  const trend={deltaBytes:0,bytesPerDay:0,windowSeconds:3600};
  const normal={version:1,at:Date.now()/1000+30,host:os.hostname(),status:'ok',alerts:[],sources:{cache:{path:f.source,device:'1',bytes:4096,...trend}},filesystems:{'1':{totalBytes:100000000000,usedBytes:10000000000,availableBytes:90000000000,totalInodes:10000,availableInodes:9000,usedPercent:10,inodeUsedPercent:10,daysToFull:null,daysToReserve:null,...trend}},policy:{warningPercent:75,criticalPercent:90,reserveBytes:6*1024**3,horizonDays:7,maxSamples:192}};
  const file=path.join(state,'latest.json');await fs.writeFile(file,JSON.stringify(normal),{mode:0o600});
  f.observation.configure(file,os.hostname());await vi.waitFor(()=>expect(f.observation.getSnapshot().status).toBe('ok'));
  f.observation.markUnavailable('采样进程失败，风险未知');expect(f.observation.getSnapshot().status).toBe('unknown');
  await f.observation.refresh();await vi.waitFor(()=>expect(f.observation.getSnapshot().sampledAt).toBeNull());
  expect(f.observation.getSnapshot().status).toBe('unknown');expect(JSON.parse(await fs.readFile(file,'utf8')).status).toBe('ok');
});
