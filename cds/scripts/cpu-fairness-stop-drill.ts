import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { StateService } from '../src/services/state.js';
import { ContainerService } from '../src/services/container.js';
import { ShellExecutor } from '../src/services/shell-executor.js';
import { DeploymentPhaseBudget } from '../src/services/deployment-phase-budget.js';
import { acquireBuildSlot, setMaxConcurrentBuildsProvider, setBuildGateHostLoadProvider, buildGateStatus } from '../src/services/build-gate.js';
import type { Project, CdsConfig, BranchEntry } from '../src/types.js';

assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(os.platform(), 'linux');
assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/);
const owner = `cds-cpu-${randomBytes(8).toString('hex')}`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), owner));
const fixtureImage = `${owner}:fixture`;
const output = path.resolve('cpu-fairness-output'); await fs.mkdir(output, { recursive: true });
const names: string[] = []; const ids = new Set<string>(); const observations: any[] = [];
const report: any = { head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  githubRunId: process.env.GITHUB_RUN_ID, owner, startedAt: new Date().toISOString(), verdict: 'failed',
  scope: 'three original StateService projects and owned real Docker/HTTP executions; bounded startup and durable fixture recovery, not full production peak or historical data-integrity proof',
  physicalPressureInjected: false, startupLoadSampleInjected: true, checks: [], releases: [] };
function docker(args: string[], timeout = 30000): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function owned(name: string): any {
  assert.ok(names.includes(name) || ids.has(name));
  const v = JSON.parse(docker(['inspect', '--type', 'container', name]))[0];
  assert.equal(v.Config.Labels['cds.acceptance.owner'], owner);
  assert.equal(v.HostConfig.Memory, 134217728); assert.equal(v.HostConfig.NanoCpus, 250000000);
  return v;
}
const shell = new ShellExecutor();
const container = new ContainerService({ exec: async (command, options) => {
  assert.ok(command.startsWith('docker '));
  const refs = command.match(/\bcds-cpu-[a-f0-9]{16}-[a-z0-9-]+\b/g) || [];
  assert.ok(refs.length > 0); for (const ref of refs) assert.ok(names.includes(ref));
  return shell.exec(command, options);
} }, { repoRoot: root, worktreeBase: root, masterPort: 0, dockerNetwork: 'bridge', sharedEnv: {},
  jwt: { secret: 'owned-private-fixture', issuer: owner } } as CdsConfig, undefined, { record: record => observations.push(record) });
const state = new StateService(path.join(root, 'state.json')); state.load();
for (const key of ['a', 'b', 'c']) {
  state.addProject({ id: `${owner}-${key}`, name: `Owned ${key}`, slug: `${owner}-${key}`, createdAt: new Date().toISOString(),
    repoUrl: `https://example.invalid/${owner}-${key}.git`, buildProfiles: [] } as unknown as Project);
  state.addBranch({ id: `${owner}-${key}`, projectId: `${owner}-${key}`, branch: 'owned-acceptance', worktreePath: root,
    status: 'idle', createdAt: new Date().toISOString(), services: {} } as BranchEntry);
}
async function port(): Promise<number> {
  const server = http.createServer(); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(r => server.close(() => r())); return address.port;
}
const program = `const fs=require('fs'),http=require('http');const file='/data/records.json';let rows=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{};function save(){const fd=fs.openSync(file,'w');fs.writeFileSync(fd,JSON.stringify(rows));fs.fsyncSync(fd);fs.closeSync(fd);}http.createServer((q,r)=>{const u=new URL(q.url,'http://owned');if(q.method==='POST'){const id=u.searchParams.get('id');if(u.searchParams.get('pending')!=='1'){if(!rows[id])rows[id]={id,project:process.env.FIXTURE_PROJECT};save();}r.statusCode=u.searchParams.get('pending')==='1'?202:200;}r.setHeader('content-type','application/json');r.end(JSON.stringify({project:process.env.FIXTURE_PROJECT,version:process.env.FIXTURE_HEAD,rows}));}).listen(3000,'0.0.0.0');process.on('SIGTERM',()=>{if(process.env.FIXTURE_MODE==='forced')return;save();process.exit(process.env.FIXTURE_MODE==='term143'?143:0);});`;
async function launch(key: string, suffix: string, mode = 'normal'): Promise<{ name: string; id: string; port: number }> {
  const name = `${owner}-${key}-${suffix}`, p = await port(); names.push(name);
  const data = path.join(root, key); await fs.mkdir(data, { recursive: true });
  const id = docker(['run', '-d', '--name', name, '--label', `cds.acceptance.owner=${owner}`, '--label', `cds.project.id=${owner}-${key}`,
    '--memory', '128m', '--cpus', '.25', '--pids-limit', '64', '--stop-timeout', '1',
    '-v', `${data}:/data`, '-p', `127.0.0.1:${p}:3000`, '-e', `FIXTURE_PROJECT=${owner}-${key}`, '-e', `FIXTURE_MODE=${mode}`, '-e', `FIXTURE_HEAD=${report.head}`, fixtureImage]); ids.add(id); owned(id);
  const runtime = { name, id, port: p }; const body = await read(runtime); assert.equal(body.version, report.head);
  assert.equal(owned(id).Image, report.fixtureImageId);
  const branch = state.getBranch(`${owner}-${key}`)!;
  branch.services[suffix] = { profileId: suffix, containerName: name, containerId: id, hostPort: p, status: 'running', creationIssued: true };
  state.save([{ kind: 'branches', id: branch.id }]); return runtime;
}
async function read(runtime: { port: number }, query = '', method = 'GET'): Promise<any> {
  const deadline = Date.now() + 15000;
  while (true) {
    try { const response = await fetch(`http://127.0.0.1:${runtime.port}/${query}`, { method, signal: AbortSignal.timeout(1500) });
      assert.ok(response.ok); return await response.json();
    } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(r => setTimeout(r, 100)); }
  }
}
function releaseRecord(phase: string, eligible: string[], order: string[], project: string): void {
  report.releases.push({ phase, round: order.length, at: new Date().toISOString(), eligibleProjects: eligible, project,
    productAndMemoryConditions: 'exact owned CI image ID/OCI revision/amd64 and 8192MiB logical capacity', taskSequence: order.length });
}
try {
  docker(['info']); docker(['pull', 'node:22-alpine'], 120000);
  await fs.writeFile(path.join(root, 'server.cjs'), program);
  await fs.writeFile(path.join(root, 'Dockerfile'), `FROM node:22-alpine\nLABEL org.opencontainers.image.revision=${report.head}\nCOPY server.cjs /fixture/server.cjs\nCMD ["node","/fixture/server.cjs"]\n`);
  docker(['build', '-t', fixtureImage, root], 120000);
  const image = JSON.parse(docker(['image', 'inspect', fixtureImage]))[0];
  assert.equal(image.Config.Labels['org.opencontainers.image.revision'], report.head);
  assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, 'amd64'); report.fixtureImageId = image.Id;
  delete process.env.CDS_MAX_CONCURRENT_BUILDS; setMaxConcurrentBuildsProvider(() => 1);
  setBuildGateHostLoadProvider(() => ({ load1: 0, cores: os.availableParallelism() }));
  for (const phase of ['compile', 'pull', 'start'] as const) {
    const budget = new DeploymentPhaseBudget(() => 8192, { pull: 1, start: 1 });
    const order: string[] = [], actual: any[] = [];
    const initial = phase === 'compile' ? await acquireBuildSlot({ holder: { projectId: `${owner}-a` } })
      : await budget.acquire(phase, { projectId: `${owner}-a` });
    const initialRuntime = await launch('a', `${phase}-initial`);
    const list = [...Array(4).fill('a'), ...Array(4).fill('b'), ...Array(2).fill('c')];
    const laterJobs: Promise<void>[] = []; let lateAdded = false;
    const run = async (key: string, index: number): Promise<void> => {
      const projectId = `${owner}-${key}`;
      const release = phase === 'compile' ? (await acquireBuildSlot({ holder: { projectId, branchId: projectId, profileId: 'owned' } })).release
        : await budget.acquire(phase, { projectId, branchId: projectId, profileId: 'owned' });
      const began = Date.now(); order.push(key);
      if (key === 'b' && !lateAdded) { lateAdded = true; laterJobs.push(run('a', 100), run('a', 101)); }
      // Late requests from the busy project remain behind still-eligible other projects.
      const runtime = await launch(key, `${phase}-${index}`); const body = await read(runtime);
      assert.equal(body.project, projectId); actual.push({ projectId, actualCid: runtime.id, actualVersion: body.version, bodyProject: body.project, startedAt: new Date(began).toISOString() });
      await container.stop(runtime.name, 'owned-fairness-retirement', { projectId, branchId: projectId, kind: 'cds-stop' });
      const waitingProjects = phase === 'compile' ? buildGateStatus().waiters.map(w => w.projectId!)
        : budget.snapshot()[phase].queued.map(w => w.projectId!);
      releaseRecord(phase, [...new Set(waitingProjects)], order, key);
      release();
    };
    const jobs = list.map((key: string, index) => run(key, index));
    releaseRecord(phase, ['a', 'b', 'c'].map(key => `${owner}-${key}`), [], 'a');
    await container.stop(initialRuntime.name, 'owned-initial-release', { projectId: `${owner}-a`, kind: 'cds-stop' });
    typeof initial === 'function' ? initial() : initial.release(); await Promise.all(jobs); await Promise.all(laterJobs);
    assert.ok(order.indexOf('c') < 3); assert.deepEqual(order.slice(0, 3).sort(), ['a', 'b', 'c']);
    report.checks.push({ case: `three-project-${phase}`, order, actualExecutions: actual, currentQualifiedProjectBound: 3 });
  }
  const budget = new DeploymentPhaseBudget(() => 8192); setBuildGateHostLoadProvider(() => ({ load1: os.availableParallelism(), cores: os.availableParallelism() }));
  const first = await budget.acquire('start', { projectId: `${owner}-a` }, { reservationKey: 'warming-a' }); first();
  let admitted = false; const queuedAt = Date.now(); const next = budget.acquire('start', { projectId: `${owner}-b` }, { reservationKey: 'warming-b' }).then(release => { admitted = true; return release; });
  await new Promise(r => setTimeout(r, 100)); assert.equal(admitted, false); assert.equal(budget.snapshot().start.queued[0].reason, 'cpu-startup-capacity');
  assert.equal(buildGateStatus().active, 0); const restoredAt = Date.now(); budget.releaseMemory('warming-a'); const granted = await next;
  const actual = await launch('b', 'capacity-restored'); assert.equal((await read(actual)).project, `${owner}-b`);
  assert.ok(Date.now() - restoredAt < 60000); granted(); budget.releaseMemory('warming-b');
  report.checks.push({ case: 'cpu-startup-wait-and-recovery', queuedMs: Date.now() - queuedAt, actualCid: actual.id, actualHttp: true,
    startReplyRetainedReservation: true, compileActiveWhileWaiting: 0, recoveryMs: Date.now() - restoredAt });
  for (const mode of ['forced', 'term143']) {
    const runtime = await launch('c', `durable-${mode}`, mode);
    assert.ok((await read(runtime, '?id=confirmed', 'POST')).rows.confirmed);
    const before = await fs.readFile(path.join(root, 'c', 'records.json'), 'utf8');
    if (mode === 'forced') await read(runtime, '?id=unconfirmed&pending=1', 'POST');
    await container.stop(runtime.name, 'owned-durable-stop', { projectId: `${owner}-c`, branchId: `${owner}-c`, kind: 'cds-stop-idle' });
    const stopped = owned(runtime.id); assert.equal(stopped.State.Running, false); assert.equal(stopped.State.OOMKilled, false);
    assert.equal(stopped.State.ExitCode, mode === 'forced' ? 137 : 143);
    const completed = observations.find(event => event.action === 'container.stop.completed' && event.containerName === runtime.name);
    assert.ok(completed); assert.equal(completed.details.dataIntegrity, 'unverified');
    if (mode === 'forced') { assert.equal(completed.severity, 'warn'); assert.equal(completed.details.shutdownOutcome, 'forced-exit'); }
    const after = await fs.readFile(path.join(root, 'c', 'records.json'), 'utf8'); assert.equal(after, before);
    docker(['start', runtime.id]); const restored = await read(runtime); assert.ok(restored.rows.confirmed); assert.equal(restored.rows.unconfirmed, undefined);
    await read(runtime, '?id=confirmed', 'POST'); assert.equal(await fs.readFile(path.join(root, 'c', 'records.json'), 'utf8'), before);
    report.checks.push({ case: `durable-${mode}`, actualCid: runtime.id, actualExit: stopped.State.ExitCode,
      acknowledgedRecordRetained: true, unacknowledgedNotClaimed: true, replayDeduplicated: true, fixtureOnly: true });
  }
  await state.flush(); assert.equal(state.getProjects().filter(p => p.id.startsWith(owner)).length, 3); report.verdict = 'passed';
} catch (error) { report.error = String(error); throw error; }
finally {
  for (const name of names) { try { const v = owned(name); docker(['rm', '-f', v.Id]); } catch (error) { report.cleanupError = String(error); } }
  report.remainingOwned = docker(['ps', '-a', '--filter', `label=cds.acceptance.owner=${owner}`, '--format', '{{.ID}}']);
  if (report.remainingOwned || report.cleanupError) report.verdict = 'failed';
  setBuildGateHostLoadProvider(null); setMaxConcurrentBuildsProvider(null);
  await state.flush(); await fs.rm(root, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)+'\n');
  assert.equal(report.verdict, 'passed');
}
