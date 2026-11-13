/** 仅使用临时状态、回环 HTTP 和拒绝发布的端口。不会读取线上任务或外部凭据。 */
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { StateService } from '../src/services/state.js';
import { ScheduledJobService, type ScheduledJobReleasePort } from '../src/services/scheduled-job-service.js';
import { createScheduledJobsRouter } from '../src/routes/scheduled-jobs.js';
import { createReportsRouter } from '../src/routes/reports.js';
import type { ScheduledJob } from '../src/types.js';

const rejectRelease = async (): Promise<never> => { throw Error('隔离演练禁止生产发布'); };
const release: ScheduledJobReleasePort = { isTargetBusy: () => ({ busy: false }), preflight: rejectRelease, startRelease: rejectRelease, startRollback: rejectRelease, getRun: () => undefined };
const arg = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? '' : process.argv[index + 1] || ''; };

async function worker() {
  const dir = arg('--dir'), dependency = arg('--dependency');
  assert.ok(path.basename(dir).startsWith('cds-automation-drill-'));
  assert.equal(new URL(dependency).hostname, '127.0.0.1');
  const state = new StateService(path.join(dir, 'state.json'), dir); state.load();
  const events: unknown[] = [];
  const service = new ScheduledJobService({ stateService: state, config: { repoRoot: dir, masterPort: 9900 }, release,
    shell: { exec: rejectRelease }, publishEvent: (type, data) => { events.push({ type, data }); } });
  const newJob = (id: string, endpoint: string, extra: Partial<ScheduledJob> = {}) => {
    const now = new Date().toISOString();
    const job: ScheduledJob = { id, projectId: 'isolated', name: id, enabled: true, schedule: { type: 'interval', intervalMinutes: 60 },
      target: { type: 'http', method: 'POST', url: `${dependency}/${endpoint}` }, timeoutSeconds: 2, retryCount: 5,
      concurrencyPolicy: 'skip', createdAt: now, updatedAt: now, nextRunAt: now, ...extra };
    state.upsertScheduledJob(job); return job;
  };
  if (arg('--worker') === 'accept') {
    state.addProject({ id: 'isolated', name: '隔离演练', slug: 'isolated', kind: 'git', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const job = newJob('report', 'paid', { timeoutSeconds: 60, completion: { type: 'reports', minCount: 1, allowedVerdicts: ['pass'] } });
    await service.runJob(job.id, 'schedule', { scheduledFor: job.nextRunAt! });
    throw Error('父进程应在执行结果返回前强制终止子进程');
  }
  await service.tick();
  const interrupted = state.listScheduledJobRuns({ jobId: 'report' })[0]; assert.equal(interrupted.failureKind, 'interrupted');
  const app = express(); app.use(express.json());
  app.use('/api', createScheduledJobsRouter({ stateService: state, scheduledJobService: service, assertProjectAccess: () => null }));
  app.use('/api', createReportsRouter({ stateService: state }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  process.send!({ ready: true, port: (server.address() as any).port, runId: interrupted.id, scheduledFor: interrupted.scheduledFor });
  process.on('message', async (message: any) => {
    try {
      if (message.command === 'verify') {
        const replay = await service.runJob('report', 'schedule', { scheduledFor: interrupted.scheduledFor }); assert.equal(replay.status, 'success');
        const delivery = newJob('delivery', 'publish');
        const [a, b] = await Promise.all([service.runJob(delivery.id, 'schedule', { scheduledFor: delivery.nextRunAt! }), service.runJob(delivery.id, 'schedule', { scheduledFor: delivery.nextRunAt! })]);
        assert.equal(a.id, b.id); assert.equal(a.status, 'success');
        const missed = newJob('missed', 'paid', { nextRunAt: new Date(Date.now() - 300_000).toISOString() });
        newJob('paused', 'paid', { enabled: false, nextRunAt: missed.nextRunAt });
        await service.tick(); assert.equal(state.getScheduledJob('missed')!.lastScheduledRun?.failureKind, 'missed');
        const failed = newJob('failed', 'unavailable'); const result = await service.runJob(failed.id, 'schedule', { scheduledFor: failed.nextRunAt! });
        assert.equal(result.failureKind, 'execution');
        const timeout = newJob('timeout', 'hang', { timeoutSeconds: 1 });
        const timed = await service.runJob(timeout.id, 'schedule', { scheduledFor: timeout.nextRunAt! }); assert.equal(timed.failureKind, 'timeout');
        const noReport = newJob('no-report', 'accepted', { timeoutSeconds: 1, completion: { type: 'reports', minCount: 1 } });
        const missing = await service.runJob(noReport.id, 'schedule', { scheduledFor: noReport.nextRunAt! }); assert.equal(missing.failureKind, 'artifact-invalid');
        await state.flush();
        process.send!({ verified: true, artifacts: replay.artifacts, events: events.length,
          states: Object.fromEntries(state.listScheduledJobs().map(j => [j.id, service.health(j).state])) });
      }
    } catch (err) { process.send!({ error: (err as Error).stack }); }
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-automation-drill-'));
  const counts = { paid: 0, publish: 0, unavailable: 0, hang: 0, accepted: 0 };
  const children: ChildProcess[] = [];
  let paid!: () => void; const paidReached = new Promise<void>(resolve => { paid = resolve; });
  const external = http.createServer((req, res) => {
    const endpoint = req.url!.slice(1) as keyof typeof counts; assert.ok(endpoint in counts); counts[endpoint]++;
    if (endpoint === 'paid') {
      // 真正收到副作用请求时，磁盘上的批次与调度游标已经确认落盘。
      const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      assert.equal(persisted.scheduledJobRuns[0].status, 'running'); paid(); return;
    }
    if (endpoint === 'hang') return;
    res.writeHead(endpoint === 'unavailable' ? 503 : 202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ accepted: true }));
  });
  await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve));
  const dependency = `http://127.0.0.1:${(external.address() as any).port}`;
  const launch = (mode: string) => {
    const child = fork(fileURLToPath(import.meta.url), ['--worker', mode, '--dir', dir, '--dependency', dependency], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // 不继承 CDS、MAP、AI、对象存储或通知凭据。
      env: { PATH: process.env.PATH, NODE_ENV: 'test', LANG: 'C.UTF-8' },
    }); children.push(child); child.stderr?.on('data', chunk => process.stderr.write(chunk)); return child;
  };
  const message = (child: ChildProcess, key: string) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`演练等待 ${key} 超时`)), 20_000);
    const listener = (value: any) => { if (value.error || value[key]) { clearTimeout(timer); child.off('message', listener); value.error ? reject(Error(value.error)) : resolve(value); } };
    child.on('message', listener); child.once('exit', code => { clearTimeout(timer); reject(Error(`子进程提前退出 ${code}`)); });
  });
  try {
    const first = launch('accept');
    let paidTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([paidReached, new Promise((_, reject) => { paidTimer = setTimeout(() => reject(Error('付费调用未到达')), 20_000); })]); }
    finally { if (paidTimer) clearTimeout(paidTimer); }
    const exited = new Promise(resolve => first.once('exit', (code, signal) => resolve({ code, signal })));
    first.kill('SIGKILL'); const crash = await exited;
    const second = launch('recover'); const ready = await message(second, 'ready');
    const base = `http://127.0.0.1:${ready.port}`;
    const request = async (endpoint: string, body: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`${base}/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const data = await res.json(); assert.equal(res.ok, true, JSON.stringify(data)); return data;
    };
    const report = await request('reports', { title: '隔离产物', format: 'md', projectId: 'isolated', content: '# 生成结果\n验证通过', verdict: 'pass' }, { 'X-CDS-Job-Run-Id': ready.runId });
    const recovered = await request('scheduled-jobs/report/recover', { runId: ready.runId });
    assert.equal(recovered.run.status, 'success'); assert.equal(recovered.run.artifacts[0].reportId, report.report.id);
    const verified = message(second, 'verified'); second.send({ command: 'verify' }); const evidence = await verified;
    assert.deepEqual(counts, { paid: 1, publish: 1, unavailable: 1, hang: 1, accepted: 1 });
    const output = arg('--output') || path.resolve('..', 'work', 'scheduled-job-drill', 'report.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const result = { verdict: 'pass', at: new Date().toISOString(), isolation: 'temporary JSON state + loopback HTTP + credential-free child processes', crash,
      checks: ['durable-before-side-effect', 'SIGKILL-and-restart', 'verify-only-recovery', 'duplicate-occurrence', 'missed-run', 'paused-remains-paused', 'external-503-no-retry', 'timeout', 'missing-report'], counts, ...evidence };
    fs.writeFileSync(output, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  } finally {
    for (const child of children) if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise(resolve => child.once('exit', resolve))));
    external.closeAllConnections(); await new Promise<void>(resolve => external.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true });
  }
}
if (process.argv.includes('--worker')) void worker().catch(err => { console.error(err); process.exit(1); });
else void main().catch(err => { console.error(err); process.exitCode = 1; });
