import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ShellExecutor } from '../../src/services/shell-executor.js';
import { createBranchRouter } from '../../src/routes/branches.js';
import { createProjectMigrationRouter } from '../../src/routes/project-migration.js';
import type { BranchEntry, CdsConfig, ExecOptions, IShellExecutor } from '../../src/types.js';

let root: string, origin: string, author: string, repo: string, shaA: string;
let source: StateService, target: StateService, targetUrl: string, sourceUrl: string;
let servers: http.Server[], commands: string[], writes: string[];
let beforeCreate: (() => void) | undefined;
let createdReply: ((body: any) => any) | undefined;
let targetFingerprintReply: ((body: any) => any) | undefined;
let deployOutcome: 'success' | 'error' | 'false' | 'missing';
let deployedCommits: string[];
let useRealRuntimeGuard: boolean;
let worktree: WorktreeService;
const projectId = 'fixture';
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } }).trim();
}
function seed(state: StateService, branch: string, sha: string | undefined, status = 'running'): BranchEntry {
  const entry = { id: `fixture-${branch.replaceAll('/', '-')}`, projectId, branch, status,
    githubCommitSha: sha, services: {}, worktreePath: path.join(root, 'unused', branch), createdAt: new Date().toISOString() } as BranchEntry;
  state.addBranch(entry);
  return entry;
}
async function listen(app: express.Express): Promise<string> {
  // 共用 setup fixture 将无 host 的临时 listener 固定为 127.0.0.1。
  const server = await new Promise<http.Server>((resolve, reject) => { const s = app.listen(0, () => resolve(s)); s.once('error', reject); });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function appWithOwner(): express.Express {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).cdsUser = { username: 'fixture-owner', isSystemOwner: true, authProvider: 'local' };
    (req as any).cdsSession = { id: 'fixture-session' }; next();
  });
  return app;
}
async function reconcile(policy = 'catalog', extra: Record<string, unknown> = {}) {
  const response = await fetch(`${sourceUrl}/api/projects/${projectId}/migration/standby/reconcile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ peerId: 'fixture-peer', remoteProjectId: projectId, policy, dryRun: false, ...extra }),
  });
  return { status: response.status, body: await response.json() as any };
}
function advanceOrigin(): string {
  fs.writeFileSync(path.join(author, 'fixture.txt'), 'B\n'); git(author, 'add', '.');
  git(author, 'commit', '-m', 'fixture B'); git(author, 'push', 'origin', 'main');
  return git(author, 'rev-parse', 'HEAD');
}
beforeEach(async () => {
  vi.stubEnv('CDS_AI_ACCESS_KEY', ''); vi.stubEnv('AI_ACCESS_KEY', '');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-standby-local-'));
  servers = []; commands = []; writes = []; beforeCreate = undefined; createdReply = undefined; targetFingerprintReply = undefined;
  deployOutcome = 'success'; deployedCommits = []; useRealRuntimeGuard = false;
  origin = path.join(root, 'origin.git'); author = path.join(root, 'author'); repo = path.join(root, 'target');
  fs.mkdirSync(author); git(author, 'init', '-b', 'main'); git(author, 'config', 'user.name', 'Fixture');
  git(author, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(author, 'fixture.txt'), 'A\n'); git(author, 'add', '.'); git(author, 'commit', '-m', 'fixture A');
  git(root, 'clone', '--bare', author, origin); git(author, 'remote', 'add', 'origin', pathToFileURL(origin).href);
  git(root, 'clone', pathToFileURL(origin).href, repo); shaA = git(author, 'rev-parse', 'HEAD');
  source = new StateService(path.join(root, 'source-state.json')); source.load();
  target = new StateService(path.join(root, 'target-state.json')); target.load();
  for (const state of [source, target]) state.addProject({ id: projectId, slug: projectId, name: 'Synthetic only', kind: 'git',
    githubRepoFullName: 'fixture/standby', gitDefaultBranch: 'main', repoPath: repo, cloneStatus: 'ready',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const realShell = new ShellExecutor();
  const shell: IShellExecutor = { exec: async (command: string, options?: ExecOptions) => {
    if (!/^(git |mkdir -p |test -d |rm -rf )/.test(command) || /https?:|ssh:|docker|curl/.test(command)) throw new Error('Non-local command refused');
    if (options?.cwd && !options.cwd.startsWith(root + '/')) throw new Error('Non-fixture cwd refused');
    commands.push(command); return realShell.exec(command, options);
  } };
  worktree = new WorktreeService(shell);
  const targetApp = appWithOwner();
  targetApp.use((req, res, next) => {
    if (req.method !== 'GET') writes.push(req.path);
    if (req.path.endsWith('/migration/fingerprint') && targetFingerprintReply) {
      const send = res.json.bind(res); res.json = ((body: any) => send(targetFingerprintReply!(body))) as typeof res.json;
    }
    if (req.path === '/api/branches' && req.method === 'POST') {
      beforeCreate?.();
      if (createdReply) { const send = res.json.bind(res); res.json = ((body: any) => send(createdReply!(body))) as typeof res.json; }
    }
    next();
  });
  // Only these controlled handlers simulate runtime actions. No ContainerService or Docker is used.
  targetApp.post('/api/branches/:id/deploy', (req, res, next) => {
    if (useRealRuntimeGuard) { next(); return; }
    deployedCommits.push(req.body.commitSha);
    if (deployOutcome === 'success') target.getBranch(req.params.id)!.status = 'running';
    res.type('text/event-stream').send(deployOutcome === 'success' ? 'event: complete\ndata: {"ok":true}\n\n'
      : deployOutcome === 'error' ? 'event: error\ndata: {"message":"fixture failure"}\n\n'
      : deployOutcome === 'false' ? 'event: complete\ndata: {"ok":false}\n\n' : 'event: progress\ndata: {"ok":true}\n\n');
  });
  targetApp.post('/api/branches/:id/stop', (req, res, next) => { if (useRealRuntimeGuard) { next(); return; } target.getBranch(req.params.id)!.status = 'idle'; res.json({ ok: true }); });
  targetApp.use('/api', createProjectMigrationRouter({ stateService: target, authMode: 'basic', assertProjectAccess: () => null }));
  targetApp.use('/api', createBranchRouter({ stateService: target, worktreeService: worktree, shell,
    containerService: {} as any, config: { repoRoot: repo, worktreeBase: path.join(root, 'worktrees'), dockerNetwork: 'never-used',
      masterPort: 9900, portStart: 17000, sharedEnv: {} } as CdsConfig }));
  targetUrl = await listen(targetApp);
  source.addCdsPeer({ id: 'fixture-peer', name: 'loopback only', baseUrl: targetUrl, createdAt: new Date().toISOString() });
  const sourceApp = appWithOwner();
  sourceApp.use('/api', createProjectMigrationRouter({ stateService: source, authMode: 'basic', assertProjectAccess: () => null }));
  sourceUrl = await listen(sourceApp);
});
afterEach(async () => {
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await Promise.all([source.flush(), target.flush()]);
  fs.rmSync(root, { recursive: true, force: true }); expect(fs.existsSync(root)).toBe(false);
  expect(servers.every(server => !server.listening)).toBe(true); vi.unstubAllEnvs();
});

describe('three-policy real local Git / HTTP / State / fingerprint chain', () => {
  it('catalog records actual HEAD, persists it, and a second reconciliation is empty', async () => {
    seed(source, 'main', shaA);
    expect((await reconcile()).status).toBe(200);
    const entry = target.findBranchByProjectAndName(projectId, 'main')!;
    expect(git(entry.worktreePath, 'rev-parse', 'HEAD')).toBe(shaA);
    expect(entry.githubCommitSha).toBe(shaA);
    await target.flush(); const restored = new StateService(path.join(root, 'target-state.json')); restored.load();
    expect(restored.getBranch(entry.id)?.githubCommitSha).toBe(shaA);
    const again = await reconcile(); expect(again.body.result.planned).toEqual([]);
    expect(again.body.result.divergent).toEqual([]); expect(writes).toEqual(['/api/branches']);
  });
  it('rejects source A after origin advances to B without worktree or state orphan', async () => {
    seed(source, 'main', shaA); const shaB = advanceOrigin(); expect(shaB).not.toBe(shaA);
    const result = await reconcile(); expect(result.status).toBe(207); expect(result.body.result.created).toEqual([]);
    expect(result.body.result.failed).toHaveLength(1); expect(target.getAllBranches()).toEqual([]);
    expect(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });
  it('audit-only and warm-running dry-run make no state or Git writes', async () => {
    seed(source, 'main', shaA);
    source.updateProject(projectId, { standbyMirror: { peerId: 'fixture-peer', remoteProjectId: projectId, enabled: false,
      branchSyncPolicy: 'audit-only', autoFailover: false, intervalMinutes: 5, updatedAt: new Date().toISOString() } });
    await Promise.all([source.flush(), target.flush()]);
    const before = JSON.stringify([source.getState(), target.getState()]);
    expect((await reconcile('audit-only')).body.result.planned).toEqual([]);
    const warm = await reconcile('warm-running', { dryRun: true });
    expect(warm.body.result.planned.map((x: any) => x.kind)).toEqual(['create', 'deploy']);
    expect(JSON.stringify([source.getState(), target.getState()])).toBe(before);
    expect(commands).toEqual([]); expect(writes).toEqual([]);
  });
  it('catalog preserves divergent and target-only entries without reset/delete/start/stop', async () => {
    seed(source, 'main', shaA); seed(target, 'main', 'b'.repeat(40)); seed(target, 'local/debug', shaA);
    const before = JSON.stringify(target.getAllBranches()); const result = await reconcile();
    expect(result.body.result.divergent).toHaveLength(1); expect(result.body.result.created).toEqual([]);
    expect(JSON.stringify(target.getAllBranches())).toBe(before); expect(writes).toEqual([]); expect(commands).toEqual([]);
  });
  it('invalid target is rejected before creating anything', async () => {
    seed(source, 'main', shaA);
    expect((await reconcile('catalog', { remoteProjectId: 'not-a-project' })).status).toBe(502);
    expect(target.getAllBranches()).toEqual([]); expect(writes).toEqual([]); expect(commands).toEqual([]);
  });
  it('an older peer cannot silently ignore expectedCommit and create an unverified branch', async () => {
    seed(source, 'main', shaA); targetFingerprintReply = body => { delete body.capabilities; return body; };
    const result = await reconcile(); expect(result.status).toBe(207); expect(result.body.result.created).toEqual([]);
    expect(writes).toEqual([]); expect(commands).toEqual([]); expect(target.getAllBranches()).toEqual([]);
  });
  it('failed stale snapshot can retry after source is refreshed without duplicate directory', async () => {
    const entry = seed(source, 'main', shaA); const shaB = advanceOrigin();
    expect((await reconcile()).status).toBe(207); entry.githubCommitSha = shaB;
    const result = await reconcile(); expect(result.status).toBe(200); expect(result.body.result.created).toEqual(['main']);
    expect(target.getAllBranches()).toHaveLength(1);
    expect(git(target.getAllBranches()[0].worktreePath, 'rev-parse', 'HEAD')).toBe(shaB);
    expect((await reconcile()).body.result.planned).toEqual([]);
  });
  it('preserves an unregistered existing worktree directory rather than removing it', async () => {
    seed(source, 'main', shaA);
    const existing = WorktreeService.worktreePathFor(path.join(root, 'worktrees'), projectId, 'fixture-main');
    fs.mkdirSync(existing, { recursive: true }); fs.writeFileSync(path.join(existing, 'keep.txt'), 'existing work');
    expect((await reconcile()).status).toBe(207);
    expect(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8')).toBe('existing work');
    expect(target.getAllBranches()).toEqual([]); expect(commands.some(command => command.startsWith('rm -rf'))).toBe(false);
  });
  it('retains main source-free creation while verifying the remote commit', async () => {
    seed(source, 'main', shaA);
    target.addBuildProfile({ id: 'app', projectId, name: 'Synthetic prebuilt', dockerImage: 'node:22', command: 'unused',
      workDir: '.', containerPort: 8080, deployModes: { express: { prebuilt: true, dockerImage: 'fixture/never-start:sha-${CDS_COMMIT_SHA}' } } } as any);
    target.updateProject(projectId, { defaultDeployModes: { app: 'express' } });
    const result = await reconcile(); expect(result.status).toBe(200);
    const entry = target.findBranchByProjectAndName(projectId, 'main')!;
    expect(entry.githubCommitSha).toBe(shaA); expect(fs.existsSync(entry.worktreePath)).toBe(false);
    expect(commands.some(command => command.startsWith('git ls-remote'))).toBe(true);
    expect(commands.some(command => /git (fetch|worktree)/.test(command))).toBe(false);
  });
  it('a changed source snapshot between planning and action is rejected before writes', async () => {
    const entry = seed(source, 'main', shaA);
    targetFingerprintReply = body => { entry.githubCommitSha = 'b'.repeat(40); return body; };
    expect((await reconcile()).status).toBe(207);
    expect(writes).toEqual([]); expect(commands).toEqual([]); expect(target.getAllBranches()).toEqual([]);
  });
  it('missing source identity cannot create or warm a branch', async () => {
    seed(source, 'main', undefined);
    const result = await reconcile('warm-running');
    expect(result.body.result.created).toEqual([]); expect(result.body.result.deployed).toEqual([]);
    expect(writes).toEqual([]); expect(commands).toEqual([]); expect(target.getAllBranches()).toEqual([]);
  });
  it('two unknown commits never count as a matching identity for preheating', async () => {
    seed(source, 'main', undefined); seed(target, 'main', undefined, 'idle');
    const result = await reconcile('warm-running');
    expect(result.body.result.planned.map((action: any) => action.kind)).toEqual(['divergent']);
    expect(writes).toEqual([]); expect(commands).toEqual([]);
  });
  it('warm-running refuses an unverified create receipt before simulated deployment', async () => {
    seed(source, 'main', shaA); createdReply = body => ({ ...body, branch: { ...body.branch, githubCommitSha: 'f'.repeat(40) } });
    const result = await reconcile('warm-running');
    expect(result.status).toBe(207); expect(result.body.result.created).toEqual([]); expect(result.body.result.deployed).toEqual([]);
    expect(writes).toEqual(['/api/branches']);
  });
  it('warm-running uses controlled runtime mocks only for matching commits and preserves target-only', async () => {
    seed(source, 'main', shaA); seed(source, 'idle', shaA, 'idle');
    seed(target, 'idle', shaA, 'running'); seed(target, 'local/debug', shaA, 'running');
    const result = await reconcile('warm-running'); expect(result.status).toBe(200);
    expect(result.body.result.created).toEqual(['main']); expect(result.body.result.deployed).toEqual(['main']);
    expect(result.body.result.stopped).toEqual(['idle']);
    expect(deployedCommits).toEqual([shaA]);
    expect(target.findBranchByProjectAndName(projectId, 'local/debug')?.status).toBe('running');
    expect(commands.some(command => /docker/.test(command))).toBe(false);
  });
  it.each(['error', 'false', 'missing'] as const)('HTTP 200 with %s SSE outcome is not successful preheating', async outcome => {
    seed(source, 'main', shaA); deployOutcome = outcome;
    const result = await reconcile('warm-running'); expect(result.status).toBe(207);
    expect(result.body.result.deployed).toEqual([]);
    expect(result.body.result.failed).toEqual([expect.objectContaining({ name: 'main', action: 'deploy' })]);
    expect(deployedCommits).toEqual([shaA]); expect(target.getAllBranches()[0].status).toBe('idle');
  });
  it.each(['building', 'starting', 'restarting', 'error', 'unknown'])('source %s cannot mean stop even with a retained serving runtime', async status => {
    const entry = seed(source, 'main', shaA, status);
    entry.services = { app: { status: 'running', servingRuntime: { containerName: 'synthetic-retained-serving' } } } as any;
    seed(target, 'main', shaA, 'running');
    const result = await reconcile('warm-running');
    expect(result.body.result.stopped).toEqual([]); expect(result.body.result.deployed).toEqual([]);
    expect(writes).toEqual([]); expect(target.getAllBranches()[0].status).toBe('running');
  });
  it('source idle becoming running with the same SHA during the final target read cannot stop the target', async () => {
    const entry = seed(source, 'main', shaA, 'idle'); seed(target, 'main', shaA, 'running');
    let reads = 0; targetFingerprintReply = body => { if (++reads === 2) entry.status = 'running'; return body; };
    const result = await reconcile('warm-running');
    expect(result.body.result.stopped).toEqual([]); expect(writes).toEqual([]);
    expect(target.getAllBranches()[0].status).toBe('running');
  });
  it('a target pin B cannot be hidden by cached A or overwritten by source A preheating', async () => {
    seed(source, 'main', shaA); const entry = seed(target, 'main', shaA, 'idle'); entry.pinnedCommit = 'b'.repeat(40);
    const result = await reconcile('warm-running');
    expect(result.body.result.deployed).toEqual([]); expect(writes).toEqual([]);
    expect(entry.pinnedCommit).toBe('b'.repeat(40)); expect(result.body.result.divergent).toHaveLength(1);
  });
  it('matching manual target pin is preserved without automatic deploy clearing it', async () => {
    seed(source, 'main', shaA); const entry = seed(target, 'main', shaA, 'idle'); entry.pinnedCommit = shaA;
    const result = await reconcile('warm-running');
    expect(result.body.result.deployed).toEqual([]); expect(writes).toEqual([]); expect(entry.pinnedCommit).toBe(shaA);
  });
  it('a new target pin after the fingerprint response is rejected by the real deploy route before effects', async () => {
    seed(source, 'main', shaA); const entry = seed(target, 'main', shaA, 'idle'); useRealRuntimeGuard = true;
    let reads = 0; targetFingerprintReply = body => { if (++reads === 2) entry.pinnedCommit = shaA; return body; };
    const result = await reconcile('warm-running'); expect(result.status).toBe(207);
    expect(result.body.result.deployed).toEqual([]); expect(entry.pinnedCommit).toBe(shaA);
    expect(entry.status).toBe('idle'); expect(deployedCommits).toEqual([]); expect(commands).toEqual([]);
  });
  it.each(['building', 'sha-changed'])('the real stop route rejects a stale %s receiver snapshot before effects', async mutation => {
    const entry = seed(target, 'main', shaA, mutation === 'building' ? 'building' : 'running'); useRealRuntimeGuard = true;
    if (mutation === 'sha-changed') entry.githubCommitSha = 'b'.repeat(40);
    const response = await fetch(`${targetUrl}/api/branches/${entry.id}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ standbyExpected: { commitSha: shaA, status: 'running', pinnedCommit: null } }) });
    expect(response.status).toBe(409); expect((await response.json() as any).error).toBe('standby_snapshot_changed');
    expect(commands).toEqual([]); expect(entry.status).toBe(mutation === 'building' ? 'building' : 'running');
  });
});
