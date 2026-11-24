import { afterEach, describe, expect, it, vi } from 'vitest';
import { JanitorService, type JanitorSweepReport } from '../../src/services/janitor.js';
import { StateService } from '../../src/services/state.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
import * as sourceRetention from '../../src/services/deployment-source-retention.js';
import { NoticeLedgerService, startNoticeLedger } from '../../src/services/notice-ledger.js';

const services: JanitorService[] = [];
const subscriptions: Array<{stop(): void}> = [];
const roots: string[] = [];
const start = Date.parse('2026-01-01T00:00:00Z');
const MINUTE = 60_000, HOUR = 60 * MINUTE;

afterEach(async () => {
  services.splice(0).forEach(service => service.stop());
  subscriptions.splice(0).forEach(subscription => subscription.stop());
  vi.restoreAllMocks(); vi.useRealTimers();
  await flushAllJsonStateStores();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, {recursive:true,force:true})));
});

function report(removed: number, deferred: number): JanitorSweepReport {
  return { timestamp: new Date().toISOString(), removedBranches: [], skippedPinned: [], skippedProtected: [],
    skippedRemote: [], disk: { totalBytes: 1000, freeBytes: 500, usedPercent: 50 }, diskWarning: false,
    diskTier: 'ok', dockerPrune: null, imageRetention: null, orphanWorktrees: null,
    orphanInfraContainers: null, errors: [], deploymentSources: {
      scanned: removed + deferred, attempted: removed, removed: Array.from({length: removed}, (_, i) => `cache-${i}`),
      held: {}, failed: [], deferred,
    } };
}

function fixture(remove: () => JanitorSweepReport | Promise<JanitorSweepReport>) {
  vi.useFakeTimers(); vi.setSystemTime(start);
  const state = { getAllBranches: () => [], getProjects: () => [] } as unknown as StateService;
  const service = new JanitorService(state, { enabled: false, worktreeTTLDays: 7, diskWarnPercent: 80,
    sweepIntervalSeconds: 3600 }, '/isolated-model', { now: () => Date.now() }, () => null);
  services.push(service);
  const worker = vi.spyOn(service as unknown as {runSweep(reclaimOnly?: boolean): Promise<JanitorSweepReport>}, 'runSweep')
    .mockImplementation(async () => remove());
  return { service, worker };
}

describe('automatic reclamation catches bounded eligible backlog', () => {
  it('drains45 eligible sources before the next hourly tick, retaining the20-per-pass budget', async () => {
    let pending = 45;
    const {service, worker} = fixture(() => { const count = Math.min(20, pending); pending -= count; return report(count, pending); });
    service.start();
    await vi.advanceTimersByTimeAsync(150_000);
    expect(pending, 'hourly-only scheduling leaves25 eligible caches until next hour').toBe(0);
    expect(worker).toHaveBeenCalledTimes(3);
    expect(service.getSnapshot().lastSweep?.deploymentSources).toMatchObject({ removed: 5, deferred: 0 });
  });

  it('bounds eligible inventory across7 days at32 arrivals/hour instead of leaking12/hour', async () => {
    let pending = 0, maxAfterDrain = 0, removed = 0;
    const {service} = fixture(() => { const count = Math.min(20, pending); pending -= count; removed += count; return report(count, pending); });
    service.start();
    for (let hour = 0; hour < 24 * 7; hour++) {
      pending += 32;
      const due = start + (hour === 0 ? 30_000 : hour * HOUR);
      await vi.advanceTimersByTimeAsync(due - Date.now());
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      maxAfterDrain = Math.max(maxAfterDrain, pending);
    }
    expect(pending, 'old timer leaves2016 additional eligible objects after168 cycles').toBe(0);
    expect(maxAfterDrain).toBe(0);
    expect(removed).toBe(32 * 24 * 7);
  });

  it('caps follow-ups at5 per ordinary cycle and resumes only at next regular tick', async () => {
    const {service, worker} = fixture(() => report(20, 1000)); service.start();
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(worker).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(worker).toHaveBeenCalledTimes(7);
    service.stop(); await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(worker).toHaveBeenCalledTimes(7);
  });

  it('does not busy retry no-progress or manually invoked passes', async () => {
    const {service, worker} = fixture(() => report(0, 25)); service.start();
    await vi.advanceTimersByTimeAsync(HOUR - 1); expect(worker).toHaveBeenCalledTimes(1);
    service.stop(); worker.mockImplementation(async () => report(20, 25));
    await service.sweep(); await vi.advanceTimersByTimeAsync(HOUR);
    expect(worker).toHaveBeenCalledTimes(2);
  });

  it('cancels queued follow-ups and cannot rearm from an old in-flight generation', async () => {
    let release!: (value: JanitorSweepReport) => void;
    const delayed = new Promise<JanitorSweepReport>(resolve => { release = resolve; });
    const {service, worker} = fixture(() => delayed); service.start();
    await vi.advanceTimersByTimeAsync(30_000); service.stop(); service.start();
    release(report(20, 25)); await Promise.resolve(); await Promise.resolve();
    service.stop(); await vi.advanceTimersByTimeAsync(HOUR);
    expect(worker).toHaveBeenCalledTimes(1);
  });

  it('continuations skip branch TTL retirement and a manual full sweep still runs after them', async () => {
    let pass = 0, release!: (value: JanitorSweepReport) => void;
    const {service, worker} = fixture(() => ++pass === 1 ? report(20, 25) : new Promise(resolve => { release = resolve; }));
    service.start(); await vi.advanceTimersByTimeAsync(90_000);
    expect(worker.mock.calls.map(args => args[0])).toEqual([false, true]);
    const manual = service.sweep(); worker.mockImplementation(async () => report(0, 0));
    release(report(20, 5)); await manual;
    expect(worker.mock.calls.map(args => args[0])).toEqual([false, true, false]);
  });

  it('persists a stalled-capacity notice, deduplicates repeated state and records recovery', async () => {
    let current = report(0, 25);
    const {service} = fixture(() => current);
    const ledger = new NoticeLedgerService({storePath: ''});
    subscriptions.push(startNoticeLedger({ledger, outbound: null}));
    service.start(); await vi.advanceTimersByTimeAsync(30_000);
    const warning = ledger.list().find(row => row.eventType === 'capacity.risk');
    expect(warning?.body).toContain('25');
    expect(warning?.outbound?.status).toBe('skipped'); // no fake production delivery
    await service.sweep();
    expect(ledger.list().find(row => row.eventType === 'capacity.risk')?.occurrences).toBe(1);
    current = report(0, 0); await service.sweep();
    expect(ledger.list().find(row => row.eventType === 'capacity.recovered')).toBeTruthy();
  });

  it('alerts on missing disk observations and unchanged watermark, retaining errors locally', async () => {
    let current = report(0, 0); current.disk = null;
    const {service} = fixture(() => current);
    const ledger = new NoticeLedgerService({storePath: ''}); subscriptions.push(startNoticeLedger({ledger, outbound: null}));
    await service.sweep();
    expect(ledger.list().find(row => row.eventType === 'capacity.risk')?.body).toContain('未确认');
    current = report(0, 0); current.diskWarning = true; current.disk!.usedPercent = 82;
    await service.sweep();
    expect(ledger.list().find(row => row.eventType === 'capacity.risk')?.body).toContain('82%');
  });

  it('records an unexpected pass failure without scheduling a fast retry, then can recover', async () => {
    const {service, worker} = fixture(async () => { throw new Error('controlled scheduler failure'); });
    const ledger = new NoticeLedgerService({storePath: ''}); subscriptions.push(startNoticeLedger({ledger, outbound: null}));
    await expect(service.sweep()).rejects.toThrow('controlled scheduler failure');
    expect(ledger.list().find(row => row.eventType === 'capacity.risk')?.body).toContain('执行失败');
    worker.mockImplementation(async () => report(0, 0)); await service.sweep();
    expect(ledger.list().find(row => row.eventType === 'capacity.recovered')).toBeTruthy();
  });

  it('source-only success cannot erase the last full image failure or announce overall recovery', async () => {
    let current = report(20, 5);
    current.imageRetention = {removed:[],failed:[{image:'owned:old',error:'controlled image failure'}],held:[],deferred:0,keepGenerations:5};
    current.errors = ['controlled image failure'];
    const {service} = fixture(() => current);
    const ledger = new NoticeLedgerService({storePath: ''}); subscriptions.push(startNoticeLedger({ledger,outbound:null}));
    service.start(); await vi.advanceTimersByTimeAsync(30_000);
    current = report(5, 0); await vi.advanceTimersByTimeAsync(MINUTE);
    expect(service.getSnapshot().lastSweep?.capacity?.reasons).toContain('reclaim-failed');
    expect(service.getSnapshot().lastFullSweep?.imageRetention?.failureSamples).toEqual(['owned:old: controlled image failure']);
    expect(ledger.list().some(row => row.eventType === 'capacity.recovered')).toBe(false);
    current = report(0, 0); await service.sweep();
    expect(ledger.list().some(row => row.eventType === 'capacity.recovered')).toBe(true);
  });

  it('the real source-only path skips Docker/orphan/TTL work, while a full request still executes them', async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'capacity-reclaim-path-')); roots.push(root);
    const state=new StateService(path.join(root,'state.json'));
    state.addBranch({id:'feature',projectId:'default',branch:'feature',services:{},status:'idle',createdAt:'2020-01-01T00:00:00Z'} as any);
    const prune=vi.fn(async()=>({ran:true,reclaimed:[],errors:[]}));
    const images={listImages:vi.fn(async()=>[]),listInUseImages:vi.fn(async()=>[]),removeImage:vi.fn(async()=>null)};
    const files={listWorktreeDirs:vi.fn(async()=>({dirs:[],unreadable:[]})),listMountedHostPaths:vi.fn(async()=>[]),
      removeDir:vi.fn(async()=>null),statDirMtimeMs:vi.fn(async()=>null)};
    const service=new JanitorService(state,{enabled:true,worktreeTTLDays:7,diskWarnPercent:80,sweepIntervalSeconds:3600},
      path.join(root,'absent-worktree-base'),undefined,()=>({totalBytes:1000,freeBytes:500}),prune,images,files);
    services.push(service);const retire=vi.fn(async()=>{});service.setRemoveFn(retire);
    await (service as unknown as {executeSweep(sourceOnly:boolean):Promise<JanitorSweepReport>}).executeSweep(true);
    expect(prune).not.toHaveBeenCalled();expect(images.listImages).not.toHaveBeenCalled();
    expect(files.listWorktreeDirs).not.toHaveBeenCalled();expect(retire).not.toHaveBeenCalled();
    await service.sweep();
    expect(prune).toHaveBeenCalledTimes(1);expect(images.listImages).toHaveBeenCalledTimes(1);
    expect(files.listWorktreeDirs).toHaveBeenCalledTimes(1);expect(retire).toHaveBeenCalledTimes(1);
  });

  it('an unconfirmed cleanup worker cannot be cleared by another successful path or timer restart', async () => {
    let current=report(20,5);current.deploymentSources!.cleanupUnconfirmed=true;
    const {service}=fixture(()=>current);const ledger=new NoticeLedgerService({storePath:''});
    subscriptions.push(startNoticeLedger({ledger,outbound:null}));
    service.start();await vi.advanceTimersByTimeAsync(30_000);
    current=report(5,0);await vi.advanceTimersByTimeAsync(MINUTE);
    service.stop();service.start();await service.sweep();
    expect(service.getSnapshot().lastSweep?.capacity?.reasons).toContain('source-cleanup-unconfirmed');
    expect(ledger.list().some(row=>row.eventType==='capacity.recovered')).toBe(false);
  });

  it('mixed thrown Docker and returned source failures require a full recheck before recovery', async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'capacity-mixed-failure-'));roots.push(root);
    const state=new StateService(path.join(root,'state.json'));
    let sources=report(19,6).deploymentSources!;sources.failed=[{path:'source-failed',error:'controlled EIO'}];sources.attempted=20;
    vi.spyOn(sourceRetention,'reclaimDeploymentSources').mockImplementation(async()=>sources);
    const prune=vi.fn(async():Promise<{ran:boolean;reclaimed:string[];errors:string[]}>=>{throw new Error('controlled thrown Docker failure');});
    const files={listWorktreeDirs:async()=>({dirs:[],unreadable:[]}),listMountedHostPaths:async()=>[],removeDir:async()=>null,statDirMtimeMs:async()=>null};
    const service=new JanitorService(state,{enabled:false,worktreeTTLDays:7,diskWarnPercent:80,sweepIntervalSeconds:3600,imageRetention:false},
      root,undefined,()=>({totalBytes:1000,freeBytes:500}),prune,undefined,files);
    services.push(service);const ledger=new NoticeLedgerService({storePath:''});subscriptions.push(startNoticeLedger({ledger,outbound:null}));
    const full=await service.sweep();expect(full.errors).toHaveLength(2);
    sources=report(6,0).deploymentSources!;
    await (service as unknown as {executeSweep(sourceOnly:boolean):Promise<JanitorSweepReport>}).executeSweep(true);
    expect(ledger.list().some(row=>row.eventType==='capacity.recovered'),'source success must not clear the thrown Docker failure').toBe(false);
    expect(service.getSnapshot().lastFullSweep?.errors).toBe(2);
    prune.mockImplementation(async()=>({ran:true,reclaimed:[],errors:[]}));sources=report(0,0).deploymentSources!;
    await service.sweep();expect(ledger.list().some(row=>row.eventType==='capacity.recovered')).toBe(true);
  });

  it('a successful partial batch cannot announce recovery while the failed source remains deferred', async () => {
    let current=report(19,25);current.deploymentSources!.attempted=20;
    current.deploymentSources!.failed=[{path:'failed-last',error:'controlled EIO'}];
    const {service}=fixture(()=>current);const ledger=new NoticeLedgerService({storePath:''});
    subscriptions.push(startNoticeLedger({ledger,outbound:null}));service.start();await vi.advanceTimersByTimeAsync(30_000);
    current=report(20,6);await vi.advanceTimersByTimeAsync(MINUTE);
    expect(ledger.list().some(row=>row.eventType==='capacity.recovered'),'failed path is still in the six deferred sources').toBe(false);
    current=report(6,0);current.deploymentSources!.removed[5]='failed-last';await vi.advanceTimersByTimeAsync(MINUTE);
    expect(ledger.list().some(row=>row.eventType==='capacity.recovered')).toBe(true);
  });
});
