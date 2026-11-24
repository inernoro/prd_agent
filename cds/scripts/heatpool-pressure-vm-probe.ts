/** Actual Linux memory/load pressure inside the owner-guarded, offline VM harness. */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SchedulerService } from '../src/services/scheduler.js';
import { schedulerResourcePressure } from '../src/services/scheduler-pressure.js';
import { buildLoadPressure } from '../src/services/build-gate.js';
import { deploymentHostAvailableMemoryMB } from '../src/services/deployment-phase-budget.js';
import { diskGuard } from '../src/services/disk-guard.js';
import type { BranchEntry } from '../src/types.js';
import type { StateService } from '../src/services/state.js';

if (process.env.CDS_VM_PRESSURE_DRILL !== '1'
  || fs.readFileSync('/sys/block/vda/serial', 'utf8').trim() !== 'codex-cow-fixture-01'
  || os.totalmem() < 3.5 * 1024 ** 3 || os.totalmem() > 4.1 * 1024 ** 3
  || os.availableParallelism() !== 2 || process.env.CDS_HOST_MEMORY_BUDGET_MB || process.env.CDS_BUILD_LOAD_FACTOR) {
  throw new Error('Private 4GiB/two-core guest with unchanged host protection required');
}
const samples: Array<Record<string, any>> = [], workers: ChildProcess[] = [];
const proof = Buffer.from('owned-pressure-fixture-data');
fs.writeFileSync('/data/proof', proof);
const hash = createHash('sha256').update(proof).digest('hex');
const server = () => http.createServer((_req, res) => res.end(fs.readFileSync('/data/proof')));
const main = server(); let app = server();
const listen = (value: http.Server) => new Promise<void>(resolve => value.listen(0, '127.0.0.1', resolve));
await listen(main); await listen(app);
const now = Date.now(), branches = ['main', 'eligible'].map(id => ({ id, branch: id === 'main' ? 'main' : 'feature',
  projectId: 'fixture', status: 'running', heatState: 'hot', worktreePath: '/data',
  services: { app: { profileId: 'app', containerName: id, status: 'running', hostPort: 1 } },
  createdAt: new Date(now - 7200000).toISOString(), lastAccessedAt: new Date(now - 3600000).toISOString(),
} as BranchEntry));
const state = { getBranch: (id: string) => branches.find(b => b.id === id), getAllBranches: () => branches,
  getProject: () => undefined, getDefaultBranchFor: () => null, getReleaseBatches: () => [], save: () => {},
} as unknown as StateService;
const scheduler = new SchedulerService(state, { enabled: true, maxHotBranches: 25, idleTTLSeconds: 60,
  tickIntervalSeconds: 60, pinnedBranches: [] });
scheduler.setRuntimePresenceProvider(() => new Set(['main', ...(app.listening ? ['eligible'] : [])]));
scheduler.setResourcePressureProvider(schedulerResourcePressure);
scheduler.setCoolFn(async id => {
  if (id !== 'eligible') throw new Error('Protected main selected for cooling');
  await new Promise<void>(resolve => app.close(() => resolve()));
  branches[1].status = 'idle'; branches[1].heatState = 'cold'; branches[1].services.app.status = 'stopped';
});
const reading = (point: string) => { const s = fs.statfsSync(point); return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize }; };
diskGuard.setProbe(() => reading('/'));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function sample(stage: string, tick = true) {
  diskGuard.refreshNow();
  await deploymentHostAvailableMemoryMB();
  if (tick) await scheduler.tick();
  const availableMB = await deploymentHostAvailableMemoryMB(), load = buildLoadPressure();
  const physicalAvailableMB = Number(/(?:^|\n)MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1]) / 1024;
  const row = { stage, at: new Date().toISOString(), availableMB, physicalAvailableMB, load, disk: diskGuard.get(),
    diskFreeBytes: diskGuard.minimumAvailableBytes(), pressure: await schedulerResourcePressure(),
    mainListening: main.listening, appListening: app.listening, dataSha256: createHash('sha256').update(fs.readFileSync('/data/proof')).digest('hex') };
  if (!main.listening || row.dataSha256 !== hash) throw new Error('Protected service/data changed');
  const address = main.address() as { port: number };
  if (await (await fetch(`http://127.0.0.1:${address.port}`)).text() !== proof.toString()) throw new Error('Protected main unreadable');
  samples.push(row); console.log('SAMPLE=' + JSON.stringify(row)); return row;
}
async function awaitAmple(stage: string) {
  const until = Date.now() + 180000;
  while (await schedulerResourcePressure() !== 'ample') {
    if (Date.now() > until) throw new Error('Guest never reached an independently ample baseline');
    await pause(2000);
  }
  return sample(stage);
}
async function restartApp() {
  app = server(); await listen(app); branches[1].status = 'running'; branches[1].heatState = 'hot'; branches[1].services.app.status = 'running';
}
let memory: Buffer | null = null;
try {
  await awaitAmple('actual-ample-baseline');
  if (!app.listening) throw new Error('Unnecessary cooling in ample guest');
  memory = Buffer.alloc(2200 * 1024 ** 2, 0x5a);
  const mem = await sample('actual-memory-pressure');
  if (mem.physicalAvailableMB >= 2048 || mem.load.ratio >= 0.7 || mem.pressure !== 'pressure' || mem.appListening || memory[0] !== 0x5a) throw new Error('Independent memory pressure not proved');
  memory = null; (globalThis as { gc?: () => void }).gc?.();
  await restartApp(); await awaitAmple('actual-memory-recovered');
  for (let i = 0; i < 4; i++) workers.push(spawn(process.execPath, ['-e', 'const end=Date.now()+100000;let v=0;while(Date.now()<end){v=Math.sin(v+1)}'], { stdio: 'ignore' }));
  const until = Date.now() + 90000;
  while (!buildLoadPressure().saturated) { if (Date.now() > until) throw new Error('Actual CPU saturation not reached'); await pause(2000); }
  const cpu = await sample('actual-cpu-pressure');
  if (cpu.physicalAvailableMB < 2048 || !cpu.load.saturated || cpu.pressure !== 'pressure' || cpu.appListening) throw new Error('Independent CPU pressure not proved');
  for (const worker of workers) worker.kill('SIGTERM');
  await Promise.all(workers.map(worker => worker.exitCode !== null || worker.signalCode !== null ? undefined : new Promise(resolve => worker.once('exit', resolve))));
  await restartApp();
  fs.writeFileSync('/pressure/owned-fill', Buffer.alloc(60 * 1024 ** 2, 1));
  diskGuard.setProbe(() => [reading('/'), reading('/pressure')]);
  const disk = await sample('actual-private-disk-freeze');
  if (disk.disk.tier !== 'freeze' || !diskGuard.blockReasonForDeploy() || disk.appListening) throw new Error('Actual disk deployment freeze not proved');
  console.log('DRILL_COMPLETE=' + JSON.stringify({ provenance: 'integration-live', pressureNumbersInjected: false,
    actualMemoryPressure: true, actualCpuPressure: true, actualDiskFreeze: true, ampleAvoidedCooling: true,
    mainAndDataPreserved: true, maxHotBranches: 25, samples,
    limitation: 'Short isolated Linux VM experiment; final disk cooling also sees residual CPU load; no production or full retention-window proof' }));
} finally {
  for (const worker of workers) if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
  scheduler.stop(); await new Promise<void>(resolve => main.close(() => resolve()));
  if (app.listening) await new Promise<void>(resolve => app.close(() => resolve()));
}
