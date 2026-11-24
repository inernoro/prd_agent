/** Runs only inside the explicitly bounded container created by reclaim-heatpool-drill. */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { SchedulerService } from '../src/services/scheduler.js';
import { schedulerResourcePressure } from '../src/services/scheduler-pressure.js';
import { diskGuard } from '../src/services/disk-guard.js';
import { setDeploymentPhaseHostUsage } from '../src/services/deployment-phase-budget.js';
import type { StateService } from '../src/services/state.js';
import type { BranchEntry } from '../src/types.js';

const readNumber = (file: string) => Number(fs.readFileSync(file, 'utf8').trim());
const observedMemoryLimit = readNumber('/sys/fs/cgroup/memory.max');
const memoryIsolated = observedMemoryLimit === 3 * 1024 ** 3;
if (process.env.CDS_ISOLATED_PRESSURE_DRILL !== '1'
  || fs.statfsSync('/pressure').type !== 0x01021994 || fs.statfsSync('/pressure').blocks * fs.statfsSync('/pressure').bsize > 65 * 1024 ** 2) {
  throw new Error('Private 64MiB tmpfs required; no pressure generated');
}
if (memoryIsolated) process.env.CDS_HOST_MEMORY_BUDGET_MB = '3072';
else delete process.env.CDS_HOST_MEMORY_BUDGET_MB;
const now = Date.now();
const branch: BranchEntry = { id: 'isolated-pressure-app', projectId: 'fixture', branch: 'feature', status: 'running', heatState: 'hot',
  worktreePath: '/data', services: { app: { profileId: 'app', containerName: 'app', hostPort: 1, status: 'running' } },
  createdAt: new Date(now - 3600000).toISOString(), lastAccessedAt: new Date(now - 1800000).toISOString() };
const state = { getBranch: () => branch, getAllBranches: () => [branch], getProject: () => undefined,
  getDefaultBranchFor: () => null, getReleaseBatches: () => [], save: () => {} } as unknown as StateService;
const scheduler = new SchedulerService(state, { enabled: true, maxHotBranches: 25, idleTTLSeconds: 60, tickIntervalSeconds: 60, pinnedBranches: [] });
let server = http.createServer((_req, res) => res.end('alive'));
const listen = () => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const close = () => new Promise<void>(resolve => server.close(() => resolve()));
await listen(); fs.writeFileSync('/data/proof', 'persistent-fixture-data');
scheduler.setRuntimePresenceProvider(() => new Set(server.listening ? ['app'] : []));
scheduler.setCoolFn(async () => { await close(); branch.status = 'idle'; branch.services.app.status = 'stopped'; });
const reading = (point: string) => { const s = fs.statfsSync(point); return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize }; };
diskGuard.setProbe(() => reading('/'));
const samples: unknown[] = [];
scheduler.setResourcePressureProvider(async () => {
  setDeploymentPhaseHostUsage(readNumber('/sys/fs/cgroup/memory.current') / 1048576, Date.now(), 10000);
  return schedulerResourcePressure();
});
async function sample(stage: string) {
  diskGuard.refreshNow(); await scheduler.tick();
  samples.push({ stage, at: new Date().toISOString(), pressure: scheduler.getSnapshot().resourcePressure,
    listening: server.listening, cgroupUsedBytes: readNumber('/sys/fs/cgroup/memory.current'),
    load: os.loadavg()[0], cores: os.availableParallelism(), disk: diskGuard.get(), minimumFreeBytes: diskGuard.minimumAvailableBytes() });
  if (fs.readFileSync('/data/proof', 'utf8') !== 'persistent-fixture-data') throw new Error('Fixture data changed');
}
await sample('actual-baseline');
const actualBaselineAmple = scheduler.getSnapshot().resourcePressure === 'ample';
if (server.listening !== actualBaselineAmple) throw new Error('Actual baseline protection failed: ' + JSON.stringify(samples));
if (!server.listening) {
  server = http.createServer((_req, res) => res.end('alive')); await listen(); branch.status = 'running'; branch.services.app.status = 'running'; branch.heatState = 'hot';
}
// Bound the allocation to 1.2GiB inside the verified 3GiB cgroup. Never stress the host's global memory pool.
let memory: Buffer | undefined;
const memoryCanTest = memoryIsolated && actualBaselineAmple;
if (memoryCanTest) {
  memory = Buffer.alloc(1200 * 1024 ** 2, 1);
  await sample('actual-cgroup-memory-pressure');
  if (scheduler.getSnapshot().resourcePressure !== 'pressure' || server.listening) throw new Error('Actual memory protection did not cool the idle app');
  server = http.createServer((_req, res) => res.end('alive')); await listen(); branch.status = 'running'; branch.services.app.status = 'running'; branch.heatState = 'hot';
}
// 60MiB on a private 64MiB mount gives real filesystem pressure without touching a host mount.
fs.writeFileSync('/pressure/owned-fill', Buffer.alloc(60 * 1024 ** 2, 1));
diskGuard.setProbe(() => [reading('/'), reading('/pressure')]);
await sample('actual-private-disk-freeze');
if (diskGuard.get().tier !== 'freeze' || !diskGuard.blockReasonForDeploy() || server.listening) throw new Error('Actual disk freeze/cooling failed');
if (memory && memory[0] !== 1) throw new Error('Allocation did not remain resident');
scheduler.stop();
console.log('PRESSURE_PROOF=' + JSON.stringify({ samples, actualBaselineAmple, dataPreserved: true, actualDiskPressure: true, actualMemoryPressure: memoryCanTest,
  memoryNotRunReason: memoryCanTest ? null : !memoryIsolated ? 'requested 3GiB cgroup not visible; observed ' + observedMemoryLimit + ' bytes; no memory pressure generated' : 'baseline already under other actual pressure; memory attribution unverified', cpuStressNotRun: true }));
