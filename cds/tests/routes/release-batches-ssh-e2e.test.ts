/**
 * Opt-in integration drill: real Express, ssh2/sshd, Git worktrees and two HTTP sites.
 * Run with CDS_BATCH_E2E=1 CDS_BATCH_E2E_SSH_KEY=<key> [CDS_BATCH_E2E_SSH_PORT=2222].
 * The remote user must be the current Unix user. No production hosts are contacted.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { sealToken } from '../../src/infra/secret-seal.js';
import { createReleasesRouter } from '../../src/routes/releases.js';
import { ReleaseService } from '../../src/services/release-service.js';
import { StateService } from '../../src/services/state.js';
import type { ReleaseTarget } from '../../src/types.js';

type BatchRow = { targetId: string; status: string; runId?: string; rollbackRunId?: string; observedCommitSha?: string; observationError?: string };
type Batch = { id: string; batchId?: string; status: string; commitSha: string; targets: BatchRow[] };
const enabled = process.env.CDS_BATCH_E2E === '1';
if (!enabled) console.warn('[release-batch-e2e] 未设置 CDS_BATCH_E2E=1，跳过真实 SSH 演练；不计为演练通过。');
const cleanups: Array<() => Promise<void>> = [];
function evidence(name: string, result: unknown): void {
  const dir = process.env.CDS_BATCH_E2E_EVIDENCE_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(result, null, 2) + '\n');
}

afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function waitFor<T>(read: () => Promise<T> | T, predicate: (value: T) => boolean, timeout = 60_000): Promise<T> {
  const until = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 60));
  } while (Date.now() < until);
  throw new Error(`真实演练等待超时: ${JSON.stringify(value!)}`);
}

async function fixture() {
  const key = process.env.CDS_BATCH_E2E_SSH_KEY;
  if (!key || !fs.existsSync(key)) throw new Error('CDS_BATCH_E2E=1 需要现有的隔离 sshd 私钥');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-batch-ssh-'));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.name', 'CDS isolated drill');
  git(source, 'config', 'user.email', 'cds-drill@example.test');
  const script = `#!/usr/bin/env bash
set -Eeuo pipefail
site=${JSON.stringify(root)}/sites/"$CDS_TARGET_ID"
mkdir -p "$site"
test "$(git rev-parse HEAD)" = "$CDS_COMMIT_SHA"
if [ "$1" = check ]; then exit 0; fi
printf '%s %s\\n' "$CDS_COMMIT_SHA" "$CDS_RELEASE_ID" >> "$site/attempts"
if [ -f "$site/hold" ]; then
  touch "$site/entered"
  for ((i=0;i<500;i++)); do [ -f "$site/hold" ] || break; sleep .1; done
fi
if [ -f "$site/fail" ] && grep -qx "$CDS_COMMIT_SHA" "$site/fail"; then echo 'isolated target failure' >&2; exit 17; fi
printf '%s' "$CDS_COMMIT_SHA" > "$site/running.next"
mv "$site/running.next" "$site/running"
`;
  fs.writeFileSync(path.join(source, 'cds-release.sh'), script);
  const commit = (text: string) => {
    fs.writeFileSync(path.join(source, 'version.txt'), text);
    git(source, 'add', '.'); git(source, 'commit', '-m', text);
    return git(source, 'rev-parse', 'HEAD');
  };
  const original = commit('original');
  const state = new StateService(path.join(root, 'state.json'), root); state.load();
  const now = new Date().toISOString();
  state.addProject({ id: 'batch-drill', slug: 'batch-drill', name: '双目标隔离演练', kind: 'git', gitRepoUrl: source, createdAt: now, updatedAt: now });
  state.addBranch({ id: 'batch-branch', projectId: 'batch-drill', branch: 'main', worktreePath: source, status: 'running', pinnedCommit: original, githubCommitSha: original, createdAt: now, services: {} });
  state.addRemoteHost({ id: 'batch-host', name: '仅本机 SSH', host: '127.0.0.1', sshPort: Number(process.env.CDS_BATCH_E2E_SSH_PORT || 2222), sshUser: os.userInfo().username, sshPrivateKeyEncrypted: sealToken(fs.readFileSync(key, 'utf8')), sshPrivateKeyFingerprint: 'isolated-e2e', tags: [], isEnabled: true, createdAt: now });
  const sites = new Map<string, { dir: string; origin: string; server: http.Server }>();
  for (const id of ['site-a', 'site-b']) {
    const dir = path.join(root, 'sites', id); fs.mkdirSync(dir, { recursive: true });
    const server = http.createServer((req, res) => {
      const sha = fs.existsSync(path.join(dir, 'running')) ? fs.readFileSync(path.join(dir, 'running'), 'utf8') : '';
      if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'healthy', commitSha: sha })); return; }
      if (req.url === '/entry.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(`window.DRILL_COMMIT=${JSON.stringify(sha)};`); return; }
      res.setHeader('Content-Type', 'text/html'); res.end(`<html><body><output>${sha}</output><script src="/entry.js"></script></body></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const repo = path.join(root, `${id}-repo`); execFileSync('git', ['clone', '--quiet', source, repo]);
    const target: ReleaseTarget = { id, projectId: 'batch-drill', name: `隔离目标 ${id}`, type: 'ssh', isEnabled: true, createdAt: now, strategy: { mode: 'project-script', scriptFile: 'cds-release.sh' }, ssh: { host: '127.0.0.1', port: Number(process.env.CDS_BATCH_E2E_SSH_PORT || 2222), user: os.userInfo().username, privateKeyRef: 'batch-host', appPath: repo, deployCommand: '', healthcheckUrl: `${origin}/health` } };
    state.upsertReleaseTarget(target); sites.set(id, { dir, origin, server });
  }
  // The fixture's independent CI oracle checks the exact immutable Git blob; SSH is never mocked.
  const ciShas: string[] = [];
  const release = new ReleaseService(state, { verifyProjectCI: async (branch, sha) => {
    expect(branch.branch).toBe('main'); ciShas.push(sha);
    git(source, 'cat-file', '-e', `${sha}:cds-release.sh`);
    const committed = git(source, 'show', `${sha}:cds-release.sh`);
    execFileSync('bash', ['-n'], { input: committed });
    return { ok: true, message: `隔离测试 CI oracle 已校验同提交 ${sha} 脚本` };
  }, heartbeatIntervalMs: 100 });
  const app = express(); app.use(express.json()); app.use('/api', createReleasesRouter({ stateService: state, releaseService: release, config: { worktreeBase: root, repoRoot: root } }));
  const api = http.createServer(app); await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/releases/batches`;
  cleanups.push(async () => {
    for (const site of sites.values()) fs.rmSync(path.join(site.dir, 'hold'), { force: true });
    await state.flush();
    await new Promise<void>(resolve => api.close(() => resolve()));
    for (const site of sites.values()) await new Promise<void>(resolve => site.server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const call = async (route: string, body?: unknown) => {
    const response = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    expect(response.ok, `${response.status}: ${JSON.stringify(data)}`).toBe(true);
    return data;
  };
  const accepted = (sha: string) => {
    const versionId = `ver-${sha}`;
    state.addDeploymentVersion({ id: versionId, projectId: 'batch-drill', branchId: 'batch-branch', commitSha: sha, configHash: sha, profiles: [], migrations: [], capabilities: [], createdByRunId: `build-${sha}`, createdAt: new Date().toISOString() });
    const report = state.createAcceptanceReport({ title: `发布验收 · 双目标演练 ${sha.slice(0, 8)} · 2026-11-12`, format: 'md', content: `已验收固定提交 ${sha}`, projectId: 'batch-drill', branchId: 'batch-branch', commitSha: sha, verdict: 'pass', reportType: 'acceptance', defectCounts: { p0: 0, p1: 0 } });
    return { versionId, reportId: report.id };
  };
  const create = async (sha: string) => {
    const acceptedVersion = accepted(sha);
    const request = { projectId: 'batch-drill', ...acceptedVersion, targetIds: ['site-a', 'site-b'], idempotencyKey: `create-${sha}` };
    const { batch } = await call('', request);
    expect((await call('', request)).batch.id).toBe(batch.id);
    return batch as Batch;
  };
  const read = async (id: string) => (await call(`/${id}`)).batch as Batch;
  const settle = (id: string) => waitFor(() => read(id), batch => !['draft', 'checking', 'ready', 'running'].includes(batch.status));
  const launch = async (batch: Batch) => {
    const checked = (await call(`/${batch.id}/preflight`, {})).batch as Batch;
    expect(checked.status, JSON.stringify(checked)).toBe('ready');
    await call(`/${batch.id}/start`, { idempotencyKey: `start-${batch.id}` });
  };
  const running = (id: string) => fs.readFileSync(path.join(sites.get(id)!.dir, 'running'), 'utf8');
  const attempts = (id: string, sha?: string) => {
    const file = path.join(sites.get(id)!.dir, 'attempts');
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
    return sha ? lines.filter(line => line.startsWith(sha + ' ')) : lines;
  };
  return { root, source, state, release, sites, original, commit, create, call, read, settle, launch, running, attempts, ciShas };
}

/** Start an independent CDS release HTTP process against the same durable fixture. */
async function worker(root: string): Promise<{ call: (route: string, body?: unknown) => Promise<{ batch: Batch }>; stop: () => Promise<void> }> {
  const originFile = path.join(root, 'worker-origin'); fs.rmSync(originFile, { force: true });
  const sourceFile = path.join(root, 'release-worker.mts');
  const moduleUrl = (relative: string) => new URL(relative, import.meta.url).href;
  fs.writeFileSync(sourceFile, `
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import express from ${JSON.stringify(moduleUrl('../../node_modules/express/index.js'))};
import { StateService } from ${JSON.stringify(moduleUrl('../../src/services/state.ts'))};
import { ReleaseService } from ${JSON.stringify(moduleUrl('../../src/services/release-service.ts'))};
import { createReleasesRouter } from ${JSON.stringify(moduleUrl('../../src/routes/releases.ts'))};
const root = ${JSON.stringify(root)};
const state = new StateService(root + '/state.json', root); state.load();
const release = new ReleaseService(state, { heartbeatIntervalMs: 100, verifyProjectCI: async (branch, sha) => {
  if (branch.branch !== 'main') throw new Error('fixture branch mismatch');
  execFileSync('git', ['-C', root + '/source', 'cat-file', '-e', sha + ':cds-release.sh']);
  return { ok: true, message: 'isolated local same-commit CI oracle ' + sha };
} });
const app = express(); app.use(express.json());
app.use('/api', createReleasesRouter({ stateService: state, releaseService: release, config: { worktreeBase: root, repoRoot: root } }));
const server = http.createServer(app);
server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(originFile)}, 'http://127.0.0.1:' + server.address().port + '/api/releases/batches'));
`);
  let stderr = '';
  const child: ChildProcess = spawn(process.execPath, ['--import', fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url)), sourceFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-3000); });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGKILL'); await done;
  };
  cleanups.push(stop);
  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`isolated API process exited: ${stderr}`);
    return fs.existsSync(originFile);
  }, Boolean, 15_000);
  const base = fs.readFileSync(originFile, 'utf8');
  const call = async (route: string, body?: unknown) => {
    const response = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    expect(response.ok, `${response.status}: ${JSON.stringify(data)}`).toBe(true);
    return data as { batch: Batch };
  };
  return { call, stop };
}

describe.skipIf(!enabled)('批次发布：真 SSH / Git / 双目标隔离演练', () => {
  it('分支前进仍发布固定SHA；保留部分成功；只重试失败目标；逐目标恢复并明确版本分歧与回滚失败', async () => {
    const f = await fixture();
    const baseline = await f.create(f.original); await f.launch(baseline);
    expect((await f.settle(baseline.id)).status).toBe('success');
    const sha = f.commit('accepted-second');
    Object.assign(f.state.getBranch('batch-branch')!, { pinnedCommit: sha, githubCommitSha: sha }); f.state.save();
    const batch = await f.create(sha);
    const first = f.sites.get('site-a')!.dir, second = f.sites.get('site-b')!.dir;
    fs.writeFileSync(path.join(first, 'hold'), ''); fs.writeFileSync(path.join(second, 'fail'), sha);
    await f.launch(batch);
    await waitFor(() => fs.existsSync(path.join(first, 'entered')), Boolean);
    const moved = f.commit('branch-advanced-during-batch');
    Object.assign(f.state.getBranch('batch-branch')!, { pinnedCommit: moved, githubCommitSha: moved, status: 'building' }); f.state.save();
    await f.call(`/${batch.id}/start`, { idempotencyKey: `start-${batch.id}` });
    fs.rmSync(path.join(first, 'hold'));
    const partial = await f.settle(batch.id);
    expect(partial.status).toBe('partial_success');
    expect(partial.targets.find(row => row.targetId === 'site-a')?.status).toBe('success');
    expect(partial.targets.find(row => row.targetId === 'site-b')?.status).toBe('failed');
    expect(f.running('site-a')).toBe(sha); expect(f.running('site-b')).toBe(f.original);
    expect(f.attempts('site-a', sha)).toHaveLength(1);
    fs.rmSync(path.join(second, 'fail'));
    const retryBody = { idempotencyKey: `retry-${batch.id}` };
    await Promise.all([f.call(`/${batch.id}/targets/site-b/retry`, retryBody), f.call(`/${batch.id}/targets/site-b/retry`, retryBody)]);
    const retried = await f.settle(batch.id);
    expect(retried.status).toBe('success');
    expect(f.running('site-a')).toBe(sha); expect(f.running('site-b')).toBe(sha);
    expect(f.attempts('site-a', sha)).toHaveLength(1); expect(f.attempts('site-b', sha)).toHaveLength(2);
    expect(f.ciShas).not.toContain(moved);
    for (const site of f.sites.values()) {
      const html = await (await fetch(site.origin)).text();
      expect(html).toContain(sha);
      expect(await (await fetch(site.origin + '/entry.js')).text()).toContain(sha);
    }
    const rollback = { idempotencyKey: `rollback-a-${batch.id}` };
    await Promise.all([f.call(`/${batch.id}/targets/site-a/rollback`, rollback), f.call(`/${batch.id}/targets/site-a/rollback`, rollback)]);
    const split = await f.settle(batch.id);
    expect(split.status).toBe('inconsistent'); expect(f.running('site-a')).toBe(f.original); expect(f.running('site-b')).toBe(sha);
    fs.writeFileSync(path.join(second, 'fail'), f.original);
    await f.call(`/${batch.id}/targets/site-b/rollback`, { idempotencyKey: `rollback-b-fail-${batch.id}` });
    expect((await f.settle(batch.id)).status).toBe('rollback_failed');
    expect(f.running('site-a')).toBe(f.original); expect(f.running('site-b')).toBe(sha);
    fs.rmSync(path.join(second, 'fail'));
    await f.call(`/${batch.id}/targets/site-b/rollback`, { idempotencyKey: `rollback-b-retry-${batch.id}` });
    expect((await f.settle(batch.id)).status).toBe('rolled_back');
    expect(f.running('site-a')).toBe(f.original); expect(f.running('site-b')).toBe(f.original);
    evidence('fixed-version-partial-retry-rollback', { batchId: batch.id, acceptedCommitSha: sha, branchMovedTo: moved, originalCommitSha: f.original, partial, retried, split, final: await f.read(batch.id), siteADeployAttemptsForAcceptedCommit: f.attempts('site-a', sha).length, siteBDeployAttemptsForAcceptedCommit: f.attempts('site-b', sha).length, ciShas: f.ciShas });
  }, 180_000);

  it('取消未完成批次后保留已成功目标，重复开始请求不能重放后续目标', async () => {
    const f = await fixture();
    const batch = await f.create(f.original);
    const second = f.sites.get('site-b')!.dir;
    fs.writeFileSync(path.join(second, 'hold'), '');
    await f.launch(batch);
    await waitFor(() => fs.existsSync(path.join(second, 'entered')), Boolean);
    expect(f.running('site-a')).toBe(f.original);
    await f.call(`/${batch.id}/cancel`, {});
    await f.call(`/${batch.id}/cancel`, {});
    await f.call(`/${batch.id}/start`, { idempotencyKey: `start-${batch.id}` });
    const cancelled = await f.read(batch.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.targets.find(row => row.targetId === 'site-a')?.status).toBe('success');
    fs.rmSync(path.join(second, 'hold'), { force: true });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(f.attempts('site-a')).toHaveLength(1); expect(f.attempts('site-b')).toHaveLength(1);
    expect((await f.read(batch.id)).status).toBe('cancelled');
    evidence('cancel-no-replay', { batch: await f.read(batch.id), siteAAttempts: f.attempts('site-a'), siteBAttempts: f.attempts('site-b') });
  }, 90_000);
  it('服务进程被杀后保留真实成功结果，重启只收敛中断并阻止重复请求重放', async () => {
    const f = await fixture();
    const batch = await f.create(f.original); await f.state.flush();
    const second = f.sites.get('site-b')!.dir;
    fs.writeFileSync(path.join(second, 'hold'), '');
    const firstProcess = await worker(f.root);
    expect((await firstProcess.call(`/${batch.id}/preflight`, {})).batch.status).toBe('ready');
    await firstProcess.call(`/${batch.id}/start`, { idempotencyKey: `start-${batch.id}` });
    await waitFor(() => fs.existsSync(path.join(second, 'entered')), Boolean);
    await waitFor(async () => (await firstProcess.call(`/${batch.id}`)).batch,
      batch => batch.targets.find(row => row.targetId === 'site-a')?.status === 'success');
    await firstProcess.stop();
    const restarted = await worker(f.root);
    const recovered = (await restarted.call(`/${batch.id}`)).batch;
    expect(recovered.status).toBe('interrupted');
    expect(recovered.targets.find(row => row.targetId === 'site-a')?.status).toBe('success');
    expect(recovered.targets.find(row => row.targetId === 'site-a')?.observedCommitSha).toBe(f.original);
    expect(recovered.targets.find(row => row.targetId === 'site-b')?.status).toBe('interrupted');
    await restarted.call(`/${batch.id}/start`, { idempotencyKey: `start-${batch.id}` });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(f.attempts('site-a')).toHaveLength(1); expect(f.attempts('site-b')).toHaveLength(1);
    expect((await restarted.call(`/${batch.id}`)).batch.status).toBe('interrupted');
    evidence('process-restart-no-replay', { recovered, afterRepeatedStart: (await restarted.call(`/${batch.id}`)).batch, siteAAttempts: f.attempts('site-a'), siteBAttempts: f.attempts('site-b') });
    fs.rmSync(path.join(second, 'hold'), { force: true });
    await restarted.stop();
  }, 90_000);

});
