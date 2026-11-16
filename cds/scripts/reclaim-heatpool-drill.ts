/** Isolated native Docker drill. Never runs without an exact daemon/root match.
 * Example: pnpm --dir cds exec tsx scripts/reclaim-heatpool-drill.ts
 * --expected-daemon-name <name> --expected-docker-root <root> --baseline-ref <sha> --out <outside-repo.json>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import ts from 'typescript';
import { SchedulerService } from '../src/services/scheduler.js';
import { StateService } from '../src/services/state.js';
import { JanitorService, defaultImageDocker } from '../src/services/janitor.js';
import { resolveBranchProtection } from '../src/services/branch-protection.js';
import { resolvePreviewActivity } from '../src/forwarder/preview-activity.js';
import { releaseBatchProtectsInputs } from '../src/domain/release-batch.js';
import { serviceRuntimeRefs } from '../src/services/service-runtime.js';
import { createBranchPin } from '../src/services/branch-pin.js';
import { flushAllJsonStateStores } from '../src/infra/state-store/json-backing-store.js';
import { acquireDockerSlot, releaseDockerSlot } from '../tests/helpers/docker-container.js';
import type { BranchEntry, SchedulerConfig } from '../src/types.js';

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const required = ['--expected-daemon-name', '--expected-docker-root', '--baseline-ref', '--out'];
if (required.some(name => !process.argv.includes(name))) throw new Error('Required: ' + required.join(' '));
const baseline = arg('--baseline-ref');
if (!/^[a-f0-9]{7,40}$/.test(baseline)) throw new Error('Baseline must be a commit SHA');
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const info = JSON.parse(docker('info', '--format', '{{json .}}'));
if (info.Name !== arg('--expected-daemon-name') || info.DockerRootDir !== arg('--expected-docker-root')) throw new Error('Daemon/root mismatch; no fixtures created');
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const out = path.resolve(arg('--out'));
if (out.startsWith(repo + path.sep)) throw new Error('Evidence must be outside the checkout');
docker('image', 'inspect', 'alpine:3.21'); // No implicit pull or unrelated infrastructure.
const prefix = 'cds-governance-drill-' + randomUUID().slice(0, 8);
const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const objects = { containers: [] as string[], volumes: [] as string[], tags: [] as string[] };
const startedAt = new Date().toISOString();
const sourceHashes: Record<string, string> = {};
function original(file: string) {
  const source = execFileSync('git', ['show', `${baseline}:cds/src/services/${file}.ts`], { encoding: 'utf8' });
  sourceHashes[file] = createHash('sha256').update(source).digest('hex');
  const exports: Record<string, any> = {};
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports, console, Date, performance, setInterval, clearInterval,
    require: (id: string) => {
      if (id.endsWith('branch-protection.js')) return baselineProtection;
      if (id.endsWith('release-batch.js')) return { releaseBatchProtectsInputs };
      if (id.endsWith('preview-activity.js')) return { resolvePreviewActivity };
      if (id.endsWith('service-runtime.js')) return { serviceRuntimeRefs };
      throw new Error('Unexpected baseline dependency: ' + id);
    } });
  return exports;
}
const oldPlanner = original('image-retention').computeImageRetentionPlan;
const baselineProtection = original('branch-protection');
const OldScheduler = original('scheduler').SchedulerService as typeof SchedulerService;
function newState(name: string) { const state = new StateService(path.join(root, name + '.json')); state.load(); return state; }
function available() {
  const lines = docker('run', '--rm', '--label', `cds.drill=${prefix}`, '--log-driver', 'none', '--mount', `type=bind,source=${info.DockerRootDir},target=/disk,readonly`, 'alpine:3.21', 'df', '-Pk', '/disk').split('\n');
  const fields = lines.at(-1)!.trim().split(/\s+/); const value = Number(fields[3]) * 1024;
  if (!Number.isFinite(value)) throw new Error('Filesystem available bytes unknown');
  return value;
}

async function artifacts(optimized: boolean) {
  const state = newState('images-' + optimized), repository = `${prefix}-${optimized ? 'after' : 'before'}`;
  state.addBranch({ id: 'branch', projectId: 'fixture', branch: 'fixture', services: {}, status: 'idle', worktreePath: root, createdAt: startedAt });
  const tag = (n: number) => repository + ':sha-' + n.toString(16).padStart(40, '0');
  const versions: Array<{ image: string; branchId: string; profileId: string; createdAt: string }> = [];
  const held: string[] = [], samples: unknown[] = []; let produced = 0, removed = 0, attempts = 0;
  function produce() {
    const n = ++produced, file = path.join(root, 'artifact');
    fs.writeFileSync(file, Buffer.alloc(256 * 1024, n));
    const tar = path.join(root, 'artifact.tar'); execFileSync('tar', ['-cf', tar, '-C', root, 'artifact']);
    const image = tag(n); docker('import', '--change', `LABEL cds.drill=${prefix}`, tar, image); objects.tags.push(image);
    const createdAt = new Date(Date.UTC(2026, 10, 16, 0, n)).toISOString();
    versions.push({ image, branchId: 'branch', profileId: 'app', createdAt });
    state.addDeploymentVersion({ id: 'v' + n, projectId: 'fixture', branchId: 'branch', commitSha: n.toString(16).padStart(40, '0'),
      configHash: 'fixture', createdByRunId: 'fixture', createdAt, migrations: [], capabilities: [],
      profiles: [{ profileId: 'app', name: 'app', artifactImage: image, artifactKind: 'prebuilt-image', reusable: true, containerPort: 80 }] });
    return image;
  }
  const before = available();
  for (let n = 0; n < 12; n++) produce();
  for (const n of [1, 2]) {
    const id = JSON.parse(docker('image', 'inspect', tag(n)))[0].Id;
    const name = `${repository}-stopped-${n}`;
    const cid = docker('create', '--name', name, '--label', `cds.drill=${prefix}`, '--entrypoint', '/bin/true', id);
    objects.containers.push(cid); held.push(id);
  }
  const adapters = { ...defaultImageDocker, removeImage: async (image: string, protectedNow?: () => boolean) => {
    attempts++; const result = await defaultImageDocker.removeImage(image, protectedNow); if (!result) removed++; return result;
  } };
  const janitor = new JanitorService(state, { enabled: false, worktreeTTLDays: 7, diskWarnPercent: 80, sweepIntervalSeconds: 3600,
    dockerPrune: false, orphanWorktrees: false, imageKeepGenerations: 2, imageMaxRemovalsPerSweep: 3 }, root,
    undefined, () => ({ totalBytes: 1000, freeBytes: 900 }), undefined, adapters);
  for (let round = 0; round < 8; round++) {
    const repeated = [2, 5].includes(round); if (!repeated) produce();
    if (optimized) await janitor.sweep();
    else {
      const plan = oldPlanner({ ledger: versions, hostImages: await adapters.listImages(),
        inUseImages: docker('ps', '-a', '--format', '{{.Image}}').split('\n'), keepGenerations: 2, maxRemovals: 3 });
      for (const image of plan.remove) await adapters.removeImage(image);
    }
    const host = (await adapters.listImages()).filter(image => image.startsWith(repository + ':'));
    const reclaimable = host.filter(image => ![tag(1), tag(2), ...versions.slice(-2).map(v => v.image)].includes(image));
    samples.push({ round, at: new Date().toISOString(), residentImages: host.length, reclaimable: reclaimable.length, produced, removed, attempts, repeatedArtifact: repeated });
    console.log(`Artifact ${optimized ? 'after' : 'before'} round=${round} reclaimable=${reclaimable.length} removed=${removed}`);
    for (const id of held) if (JSON.parse(docker('image', 'inspect', id))[0].Id !== id) throw new Error('Stopped recovery image lost');
  }
  const after = available();
  return { samples, produced, removed, attempts, stoppedRecoveryImagesPreserved: held.length,
    filesystem: { beforeAvailableBytes: before, afterAvailableBytes: after, netAvailableBytesDelta: after - before,
      attribution: 'whole-daemon-filesystem delta including artifact creation and concurrent activity; not sum of logical image sizes' } };
}

async function runtime(optimized: boolean) {
  const state = newState('runtime-' + optimized); let now = Date.UTC(2026, 10, 16);
  const cfg: SchedulerConfig = { enabled: true, maxHotBranches: 25, idleTTLSeconds: 900, tickIntervalSeconds: 60, pinnedBranches: [] };
  const scheduler = new (optimized ? SchedulerService : OldScheduler)(state, cfg, { now: () => now });
  const names = new Set<string>(), byBranch = new Map<string, string>();
  const calls = { cooledServices: 0, cooledPlaceholders: 0, wakeServices: 0, failedRetries: 0 };
  scheduler.setRuntimePresenceProvider(() => names);
  if (optimized) scheduler.setResourcePressureProvider(() => 'ample');
  scheduler.setCoolFn(async id => {
    const b = state.getBranch(id)!, container = byBranch.get(id);
    if (container) { docker('stop', '-t', '1', container); names.delete(container); calls.cooledServices++; }
    else calls.cooledPlaceholders++;
    b.status = 'idle'; for (const s of Object.values(b.services)) s.status = 'stopped';
  });
  let failNext = false;
  scheduler.setWakeFn(async id => {
    if (failNext) { failNext = false; calls.failedRetries++; throw new Error('isolated retry injection'); }
    const cid = byBranch.get(id)!; docker('start', cid); names.add(cid); calls.wakeServices++;
    const b = state.getBranch(id)!; b.status = 'running'; b.services.app.status = 'running';
  });
  for (const branch of ['main', 'regular-a', 'regular-b', 'acceptance']) {
    const id = `${prefix}-${optimized ? 'after' : 'before'}-${branch}`;
    const volume = id + '-data'; docker('volume', 'create', '--label', `cds.drill=${prefix}`, volume); objects.volumes.push(volume);
    const cid = docker('run', '-d', '--read-only', '--log-driver', 'none', '--name', id, '--label', `cds.drill=${prefix}`,
      '--mount', `type=volume,source=${volume},target=/data`, 'alpine:3.21', 'sleep', '86400'); objects.containers.push(cid);
    docker('exec', cid, 'sh', '-c', 'printf fixture-data-integrity > /data/proof');
    names.add(cid); byBranch.set(id, cid);
    const b: BranchEntry = { id, branch, projectId: 'fixture', status: 'running', heatState: 'hot', worktreePath: root,
      services: { app: { profileId: 'app', containerName: cid, hostPort: 1, status: 'running' } }, createdAt: new Date(now).toISOString(), lastAccessedAt: new Date(now).toISOString() };
    if (branch === 'acceptance') { b.pinnedByUser = true; b.userPin = createBranchPin({ ttlSeconds: 60 }, {}, 'fixture-agent', now); }
    state.addBranch(b);
  }
  for (let n = 0; n < 24; n++) state.addBranch({ id: `${prefix}-empty-${n}`, projectId: 'fixture', branch: 'empty-' + n, status: 'idle', heatState: 'hot', services: {}, worktreePath: root, createdAt: new Date(now).toISOString() });
  const initialOccupancy = scheduler.getSnapshot().capacityUsage.current, samples: unknown[] = [];
  for (let round = 0; round < 12; round++) {
    now += 16 * 60000; await scheduler.tick();
    for (const id of byBranch.keys()) await scheduler.wake(id);
    if (round === 5) {
      const [id, cid] = [...byBranch.entries()][1]; docker('stop', '-t', '1', cid); names.delete(cid);
      const b = state.getBranch(id)!; b.status = 'idle'; b.heatState = 'cold'; b.services.app.status = 'stopped';
      failNext = true; try { await scheduler.wake(id); throw new Error('Failure injection missed'); } catch (e) { if (!(e as Error).message.includes('isolated retry')) throw e; }
      await scheduler.wake(id);
    }
    for (const cid of byBranch.values()) if (docker('exec', cid, 'cat', '/data/proof') !== 'fixture-data-integrity') throw new Error('Persistent fixture data changed');
    samples.push({ round, observedAt: new Date().toISOString(), logicalAt: new Date(now).toISOString(), capacity: scheduler.getSnapshot().capacityUsage.current, ...calls });
  }
  if (optimized) { scheduler.setResourcePressureProvider(() => 'pressure'); now += 16 * 60000; await scheduler.tick(); }
  const main = state.getAllBranches().find(b => b.branch === 'main')!;
  if (!names.has(byBranch.get(main.id)!)) throw new Error('Main branch was cooled');
  scheduler.stop();
  return { initialOccupancy, samples, afterPressure: { capacity: scheduler.getSnapshot().capacityUsage.current, ...calls },
    protectedMainPreserved: true, persistentDataIntegrity: true, acceleratedLogicalMinutes: 192,
    realObservation: 'actual native stop/start, image and volume operations; controlled ample/pressure inputs and accelerated idle clock, not physical ample-host observation, a real 192-minute soak or full CI deployment pipeline' };
}

function realPressure() {
  docker('image', 'inspect', 'node:22-bookworm-slim');
  const bundled = path.join(root, 'pressure.cjs');
  execFileSync(path.join(repo, 'cds/node_modules/.bin/esbuild'), [path.join(repo, 'cds/scripts/heatpool-pressure-probe.ts'),
    '--bundle', '--platform=node', '--format=esm', '--target=node22', '--outfile=' + bundled], { stdio: 'pipe', timeout: 30000 });
  const cid = docker('create', '--name', prefix + '-pressure', '--label', `cds.drill=${prefix}`, '--memory', '3g', '--cpus', '1', '--pids-limit', '128',
    '--tmpfs', '/pressure:size=64m', '--tmpfs', '/data:size=16m', '-e', 'CDS_ISOLATED_PRESSURE_DRILL=1', 'node:22-bookworm-slim',
    'node', '--max-old-space-size=128', '/probe.mjs');
  objects.containers.push(cid); docker('cp', bundled, cid + ':/probe.mjs');
  const output = docker('start', '-a', cid);
  const proof = output.split('\n').find(line => line.startsWith('PRESSURE_PROOF='));
  if (!proof || docker('inspect', '--format', '{{.State.ExitCode}}', cid) !== '0') throw new Error('Native pressure probe did not pass');
  return JSON.parse(proof.slice('PRESSURE_PROOF='.length));
}

acquireDockerSlot(prefix);
let result: unknown;
try {
  console.log('Starting isolated before/after artifact and runtime observations');
  const beforeImages = await artifacts(false), afterImages = await artifacts(true);
  if ((afterImages.samples.at(-1) as any).reclaimable !== 0 || (beforeImages.samples.at(-1) as any).reclaimable <= 0) throw new Error('Backlog comparison failed');
  const beforeRuntime = await runtime(false), afterRuntime = await runtime(true);
  const actualPressure = realPressure();
  if ((afterRuntime.samples.at(-1) as any).cooledServices !== 0 || (beforeRuntime.samples.at(-1) as any).cooledServices <= 0) throw new Error('Unnecessary cooling comparison failed');
  if (afterRuntime.afterPressure.cooledServices < 3) throw new Error('Pressure cooling/temporary expiry failed');
  const currentSources = Object.fromEntries(['scheduler', 'branch-protection', 'branch-pin', 'janitor', 'container-image-references', 'image-retention']
    .map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(repo, 'cds/src/services', file + '.ts'))).digest('hex')]));
  result = { startedAt, endedAt: new Date().toISOString(), baseline, sourceHashes, currentSources, daemon: { name: info.Name, root: info.DockerRootDir }, beforeImages, afterImages, beforeRuntime, afterRuntime, actualPressure, verdict: actualPressure.actualMemoryPressure ? 'pass' : 'conditional' };
} finally {
  for (const id of objects.containers.reverse()) {
    const row = JSON.parse(docker('container', 'inspect', id))[0];
    if (row.Config.Labels['cds.drill'] !== prefix) throw new Error('Fixture cleanup ownership mismatch');
    docker('rm', '-f', id);
  }
  for (const tag of objects.tags.reverse()) {
    let row; try { row = JSON.parse(docker('image', 'inspect', tag))[0]; } catch { continue; }
    if (row.Config?.Labels?.['cds.drill'] !== prefix) throw new Error('Image alias ownership changed; retained');
    docker('image', 'rm', '--no-prune', tag);
  }
  for (const volume of objects.volumes) {
    if (JSON.parse(docker('volume', 'inspect', volume))[0].Labels['cds.drill'] !== prefix) throw new Error('Volume ownership mismatch');
    docker('volume', 'rm', volume);
  }
  await flushAllJsonStateStores(); fs.rmSync(root, { recursive: true, force: true }); releaseDockerSlot();
}
fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log('Drill checks completed; inspect verdict and unverified conditions in evidence=' + out);
