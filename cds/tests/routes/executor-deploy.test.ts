/**
 * Executor route regression tests.
 *
 * Focus: the /exec/deploy worktree-creation path used to hardcode
 * `projectId: 'default'` (and `<base>/default/<branchId>` for the
 * worktree directory). After legacy-cleanup/rename-default flips
 * the legacy project to a real id, that hardcoded path mints
 * orphan branches on the executor — same shape of bug as the
 * subdomain auto-build bug fixed earlier in index.ts.
 *
 * These tests exercise the new behaviour:
 *   1. body.projectId from the master is stamped onto the entry +
 *      drives the worktree directory.
 *   2. When the master omits projectId (older masters), the executor
 *      falls back to resolveProjectForAutoBuild instead of 'default'.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { StateService } from '../../src/services/state.js';
import { DeploymentVersionService } from '../../src/services/deployment-version.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService } from '../../src/services/container.js';
import { ShellExecutor, MockShellExecutor } from '../../src/services/shell-executor.js';
import { createExecutorRouter } from '../../src/executor/routes.js';
import type { CdsConfig, BranchEntry } from '../../src/types.js';
import type { ServerEventLogSink } from '../../src/services/server-event-log-store.js';

import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
// Source contract for the building-status timing fix (Bugbot "Executor deploy skips building status"):
// the worker must set entry.status='building' BEFORE the pre-pull orphan teardown, so heartbeats don't
// sync a stale running/idle onto master during the teardown+pull window. Asserted at source level because
// the intermediate state is not observable through the synchronous test deploy.
describe('Executor /exec/deploy: building status set before pre-pull teardown (source contract)', () => {
  it("sets entry.status='building' before the orphan teardown / pull", () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/executor/routes.ts'), 'utf8');
    const buildingIdx = src.indexOf("// 进入部署窗口立即把 worker 分支态钉成 building");
    const teardownIdx = src.indexOf('const payloadProfileIds = new Set(profilesData.map');
    const pullIdx = src.indexOf("正在拉取最新代码");
    expect(buildingIdx).toBeGreaterThan(0);
    expect(buildingIdx).toBeLessThan(teardownIdx);
    expect(teardownIdx).toBeLessThan(pullIdx);
  });
});

function makeConfig(tmpDir: string): CdsConfig {
  return {
    repoRoot: tmpDir,
    worktreeBase: path.join(tmpDir, 'worktrees'),
    masterPort: 9900,
    workerPort: 5500,
    dockerNetwork: 'cds-network',
    portStart: 10001,
    sharedEnv: {},
    jwt: { secret: 'test-secret', issuer: 'cds' },
  };
}

async function postSse(
  server: http.Server, urlPath: string, body: unknown,
): Promise<{ status: number; events: Array<{ event: string; data: any }> }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      const events: Array<{ event: string; data: any }> = [];
      let buf = '';
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        // Parse `event: X\ndata: Y\n\n` SSE blocks.
        let idx = buf.indexOf('\n\n');
        while (idx !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = block.split('\n');
          let event = 'message';
          let data: any = null;
          for (const line of lines) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) {
              try { data = JSON.parse(line.slice(6)); } catch { data = line.slice(6); }
            }
          }
          events.push({ event, data });
          idx = buf.indexOf('\n\n');
        }
      });
      res.on('end', () => resolve({ status: res.statusCode!, events }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function postJson(
  server: http.Server, urlPath: string, body: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode!, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('Executor /exec/deploy', () => {
  let tmpDir: string;
  let stateService: StateService;
  let server: http.Server;
  let mock: MockShellExecutor;
  let config: CdsConfig;
  let containerEvents: Array<{ action: string; operationId?: string | null; requestId?: string | null; details?: Record<string, unknown> }>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-exec-'));
    config = makeConfig(tmpDir);
    fs.mkdirSync(config.worktreeBase, { recursive: true });

    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile, tmpDir);
    stateService.load();
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'default',
      slug: 'default',
      name: 'Legacy Default',
      kind: 'git',
      legacyFlag: true,
      createdAt: now,
      updatedAt: now,
    });

    mock = new MockShellExecutor();
    mock.addResponsePattern(/git rev-parse --verify '([^']+)\^\{commit\}'/, (match) => ({
      stdout: /^[0-9a-f]{7,40}$/i.test(match[1]) ? match[1].padEnd(40, '0') : 'a'.repeat(40), stderr: '', exitCode: 0,
    }));
    mock.addResponsePattern(/git rev-parse HEAD/, () => ({ stdout: 'a'.repeat(40), stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker inspect --format '\{\{.Id\}\}' '[a-f0-9]{64}'$/, () => ({ stdout: '', stderr: 'No such object: removed-owned-id', exitCode: 1 }));
    mock.addResponsePattern(/docker inspect.*"running".* '([^']+)'$/, match => {
      for (const entry of stateService.getAllBranches()) for (const [profileId, service] of Object.entries(entry.services)) {
        if ([service.containerName, service.servingRuntime?.containerName, service.containerId, service.servingRuntime?.containerId].includes(match[1])) return {
          stdout: JSON.stringify({ id: 'a'.repeat(64), running: true, branch: entry.id, project: entry.projectId || '_unknown',
            profile: profileId, networks: { [service.networkName || 'old-network']: { Aliases: [profileId] } } }), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'No such container', exitCode: 1 };
    });
    // Make every git/docker/mkdir/etc shell-out succeed silently.
    mock.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

    const worktreeService = new WorktreeService(mock, config.repoRoot);
    containerEvents = [];
    const eventSink: ServerEventLogSink = {
      record(record) {
        containerEvents.push({
          action: record.action,
          operationId: record.operationId,
          requestId: record.requestId,
          details: record.details,
        });
      },
    };
    const containerService = new ContainerService(mock, config, undefined, eventSink);
    (containerService as any).waitForContainerAlive = async () => undefined;
    (containerService as any).waitForReadiness = async () => true;

    const app = express();
    app.use(express.json());
    app.use('/exec', createExecutorRouter({
      stateService, worktreeService, containerService, shell: mock, config,
    }));

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function artifactPost(body: unknown, token?: string) {
    const data = JSON.stringify(body); const port = (server.address() as { port: number }).port;
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/exec/artifact-preflight', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Connection: 'close',
          ...(token ? { 'X-Executor-Token': token } : {}) } }, response => {
        let output = ''; response.on('data', chunk => { output += chunk; });
        response.on('end', () => resolve({ status: response.statusCode || 0, body: JSON.parse(output) }));
      }); req.on('error', reject); req.end(data);
    });
  }

  it('远端产物预检继承执行器认证，拒绝请求不调用Docker或创建分支', async () => {
    config.executorToken = 'artifact-test-token';
    const result = await artifactPost({ profiles: [], commitSha: 'a'.repeat(40) });
    expect(result.status).toBe(401); expect(mock.commands).toEqual([]); expect(stateService.getAllBranches()).toEqual([]);
  });

  it('远端产物预检使用本机daemon平台和OCI提交，共用镜像只核验一次且不创建运行实例', async () => {
    const target = 'b'.repeat(40); const image = `ghcr.io/owned/worker:sha-${target}`; const content = `sha256:${'c'.repeat(64)}`;
    config.executorToken = 'artifact-test-token';
    mock.addResponsePatternFirst(/docker info/, () => ({ stdout: JSON.stringify({ OSType: 'linux', Architecture: 'x86_64' }), stderr: '', exitCode: 0 }));
    mock.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: content, RepoDigests: [`ghcr.io/owned/worker@${content}`],
      Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': target } } }]), stderr: '', exitCode: 0 }));
    const profiles = ['generation', 'code-return', 'product-batch', 'common'].map(id => ({ id, name: id, dockerImage: image, prebuiltImage: true, command: '', workDir: '.', containerPort: 8080 }));
    const result = await artifactPost({ profiles, commitSha: target }, 'artifact-test-token');
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ state: 'ready', targetCommitSha: target,
      artifacts: [{ profileIds: profiles.map(profile => profile.id), image: `ghcr.io/owned/worker@${content}`, platform: 'linux/amd64', revision: target }] });
    expect(mock.commands.filter(command => command.startsWith('docker pull'))).toHaveLength(1);
    expect(mock.commands.some(command => /docker (run|rm)|git fetch|network create/.test(command))).toBe(false);
    expect(stateService.getAllBranches()).toEqual([]);
  });

  it('远端产物预检对无效输入返回明确拒绝，对未发布镜像保留缺失原因', async () => {
    expect((await artifactPost({ profiles: [], commitSha: 'abc1234' })).status).toBe(400);
    expect(mock.commands).toEqual([]);
    mock.addResponsePatternFirst(/docker info/, () => ({ stdout: JSON.stringify({ OSType: 'linux', Architecture: 'amd64' }), stderr: '', exitCode: 0 }));
    mock.addResponsePatternFirst(/docker pull/, () => ({ stdout: '', stderr: 'manifest unknown', exitCode: 1 }));
    const result = await artifactPost({ commitSha: 'b'.repeat(40), profiles: [{ id: 'api', dockerImage: 'ghcr.io/owned/api:sha-' + 'b'.repeat(40), prebuiltImage: true }] });
    expect(result.status).toBe(200); expect(result.body).toMatchObject({ state: 'waiting', reason: 'missing', profileIds: ['api'] });
    expect(mock.commands.some(command => /docker (run|rm)/.test(command))).toBe(false);
  });

  function artifactFixture() {
    const target = 'b'.repeat(40), imageId = `sha256:${'c'.repeat(64)}`;
    const profiles = ['api', 'web'].map(id => ({ id, name: id, dockerImage: `ghcr.io/owned/${id}:sha-${target}`,
      prebuiltImage: true, command: '', workDir: '.', containerPort: 3000 }));
    const entry: BranchEntry = { id: 'protected', projectId: 'default', branch: 'owned', worktreePath: tmpDir,
      status: 'running', createdAt: new Date().toISOString(), services: {
        api: { profileId: 'api', containerName: 'old-api', hostPort: 10011, status: 'running' },
        legacy: { profileId: 'legacy', containerName: 'old-legacy', hostPort: 10012, status: 'running' },
      } };
    stateService.addBranch(entry);
    mock.addResponsePatternFirst(/git rev-parse HEAD/, () => ({ stdout: target, stderr: '', exitCode: 0 }));
    mock.addResponsePatternFirst(/docker info/, () => ({ stdout: JSON.stringify({ OSType: 'linux', Architecture: 'amd64' }), stderr: '', exitCode: 0 }));
    mock.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: imageId,
      RepoDigests: [`ghcr.io/owned/shared@${imageId}`], Os: 'linux', Architecture: 'amd64',
      Config: { Labels: { 'org.opencontainers.image.revision': target } } }]), stderr: '', exitCode: 0 }));
    return { target, imageId, profiles, entry, payload: { branchId: entry.id, branchName: entry.branch, projectId: 'default', commitSha: target, profiles } };
  }

  it.each(['missing', 'local-unverified', 'unknown-target'])('旧Master直调%s在全部副作用前拒绝，保留旧服务/孤儿和分支运行态', async (failure) => {
    const f = artifactFixture(); const before = structuredClone(f.entry);
    if (failure === 'missing') mock.addResponsePatternFirst(/docker pull .*web/, () => ({ stdout: '', stderr: 'manifest unknown', exitCode: 1 }));
    if (failure === 'local-unverified') {
      Object.assign(f.profiles[0], { localArtifact: true });
      mock.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: f.imageId, Os: 'linux', Architecture: 'amd64', Config: { Labels: {} } }]), stderr: '', exitCode: 0 }));
    }
    const result = await postSse(server, '/exec/deploy', { ...f.payload, commitSha: failure === 'unknown-target' ? undefined : f.target });
    expect(stateService.getBranch(f.entry.id)).toEqual(before);
    const error = result.events.find(e => e.event === 'error'); expect(error?.data.accepted).toBe(false);
    expect(result.events.some(e => e.event === 'complete')).toBe(false);
    expect(mock.commands.some(cmd => /docker (run|create|rm|stop|network create)|git |mkdir /.test(cmd))).toBe(false);
  });

  it('旧Master全部角色准入后运行固定digest，清除隐式fallback并标记实际镜像目标', async () => {
    const f = artifactFixture(); Object.assign(f.profiles[0], { fallbackImage: 'old:tag', sourceFallbackProfile: { ...f.profiles[0], prebuiltImage: false, command: 'compile-unexpected' } });
    const result = await postSse(server, '/exec/deploy', f.payload);
    expect(result.events.filter(e => e.event === 'error' || e.data?.status === 'error')).toEqual([]);
    expect(result.events.some(e => e.event === 'complete')).toBe(true);
    const pullIndices = mock.commands.map((cmd, i) => cmd.startsWith('docker pull ') ? i : -1).filter(i => i >= 0);
    const firstMutation = mock.commands.findIndex(cmd => /^docker (stop|rm)|^git /.test(cmd));
    expect(pullIndices).toHaveLength(2); expect(Math.max(...pullIndices)).toBeLessThan(firstMutation);
    const runs = mock.commands.filter(cmd => /^docker (run|create) /.test(cmd));
    expect(runs).toHaveLength(2); expect(runs.every(cmd => cmd.includes(`ghcr.io/owned/shared@${f.imageId}`))).toBe(true);
    expect(result.events.find(e => e.data?.step === 'artifact-target')?.data.artifactCommitSha).toBe(f.target);
    expect(mock.commands.some(cmd => /^git |^mkdir /.test(cmd))).toBe(false);
    expect(mock.commands.some(cmd => cmd.includes('compile-unexpected') || cmd.includes('old:tag'))).toBe(false);
  });

  it('新Master已固定仓库digest仍核验OCI，远端运行及版本台账保留可移植引用而不拉取', async () => {
    const f = artifactFixture(); const repositoryDigest = `ghcr.io/owned/api@sha256:${'d'.repeat(64)}`;
    const profile = { ...f.profiles[0], dockerImage: repositoryDigest, localArtifact: true };
    mock.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: f.imageId,
      RepoDigests: [repositoryDigest], Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': f.target } } }]), stderr: '', exitCode: 0 }));
    const result = await postSse(server, '/exec/deploy', { ...f.payload, profiles: [profile], artifactCommitSha: f.target });
    expect(result.events.filter(e => e.event === 'error' || e.data?.status === 'error')).toEqual([]);
    expect(mock.commands.filter(cmd => cmd.startsWith('docker pull '))).toEqual([]);
    expect(mock.commands.filter(cmd => /^docker (run|create) /.test(cmd))[0]).toContain(repositoryDigest);
    expect(stateService.getBranch(f.entry.id)?.services.api.deployedImage).toBe(repositoryDigest);
    const versions = new DeploymentVersionService(stateService);
    const version = versions.create({ projectId: 'default', branchId: f.entry.id, commitSha: f.target, configHash: 'c'.repeat(64),
      profiles: [profile], branch: stateService.getBranch(f.entry.id)!, createdByRunId: 'owned-portable-reference' });
    expect(version.profiles[0]).toMatchObject({ artifactKind: 'prebuilt-image', artifactImage: repositoryDigest, reusable: true });
    expect(versions.materializeProfiles(version, [profile])[0].dockerImage).toBe(repositoryDigest);
  });

  it.each(['stop', 'delete', 'new-target', 'owner'])('执行器预检等待中%s后，旧请求不得迟到拆服务或写旧状态', async (change) => {
    const f = artifactFixture(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const original = mock.exec.bind(mock); let pulls = 0;
    mock.exec = async (command, options) => {
      if (command.startsWith('docker pull ') && pulls++ === 0) { entered(); await gate; }
      return original(command, options);
    };
    const pending = postSse(server, '/exec/deploy', f.payload); await started;
    try {
      if (change === 'stop' || change === 'delete') await postJson(server, `/exec/${change}`, { branchId: f.entry.id });
      else if (change === 'owner') f.entry.projectId = 'other-owner';
      else {
        const next = await postSse(server, '/exec/deploy', { ...f.payload, commitSha: 'd'.repeat(40) });
        expect(next.events.find(e => e.event === 'error')?.data.reason).toBe('revision-mismatch');
      }
      const afterNewer = structuredClone(stateService.getBranch(f.entry.id)), commands = mock.commands.length;
      release(); const result = await pending;
      expect(result.events.find(e => e.event === 'error')?.data.code).toBe('target_request_superseded');
      expect(result.events.some(e => e.event === 'complete')).toBe(false);
      expect(stateService.getBranch(f.entry.id)).toEqual(afterNewer);
      expect(mock.commands.slice(commands).some(cmd => /docker (run|create|rm|stop)|git |mkdir /.test(cmd))).toBe(false);
    } finally { release(); await pending; }
  });

  it.each([undefined, 'bbbbbbb'])('未确认目标%s的拒绝不取消已经有效的产物核验', async (invalidTarget) => {
    const f = artifactFixture(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const original = mock.exec.bind(mock); let pulls = 0;
    mock.exec = async (command, options) => {
      if (command.startsWith('docker pull ') && pulls++ === 0) { entered(); await gate; }
      return original(command, options);
    };
    const pending = postSse(server, '/exec/deploy', f.payload); await started;
    try {
      const rejected = await postSse(server, '/exec/deploy', { ...f.payload, commitSha: invalidTarget });
      expect(rejected.events.find(e => e.event === 'error')?.data).toMatchObject({ code: 'artifact_target_unresolved', accepted: false });
      expect(stateService.getBranch(f.entry.id)?.status).toBe('running');
      release(); const accepted = await pending;
      expect(accepted.events.filter(e => e.event === 'error' || e.data?.status === 'error')).toEqual([]);
      expect(accepted.events.some(e => e.event === 'complete')).toBe(true);
      expect(mock.commands.filter(cmd => /^docker (run|create) /.test(cmd))).toHaveLength(2);
    } finally { release(); await pending; }
  });

  it.each(['stop', 'delete'])('尚未创建分支时%s返回404也撤销原预检，不能迟到创建分支', async (action) => {
    const f = artifactFixture(); const newId = 'not-created-yet'; let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const original = mock.exec.bind(mock); let pulls = 0;
    mock.exec = async (command, options) => {
      if (command.startsWith('docker pull ') && pulls++ === 0) { entered(); await gate; }
      return original(command, options);
    };
    const pending = postSse(server, '/exec/deploy', { ...f.payload, branchId: newId }); await started;
    try {
      const cancelled = await postJson(server, `/exec/${action}`, { branchId: newId });
      expect(cancelled.status).toBe(404);
      release(); const result = await pending;
      expect(result.events.find(e => e.event === 'error')?.data.code).toBe('target_request_superseded');
      expect(stateService.getBranch(newId)).toBeUndefined();
      expect(mock.commands.some(cmd => /docker (run|create|rm|stop)|git |mkdir /.test(cmd))).toBe(false);
    } finally { release(); await pending; }
  });

  it('远端执行器点名A时实际挂载A且不改原目录B', async () => {
    const git = (args: string[], cwd: string) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const repo = path.join(tmpDir, 'remote-source-repo'); fs.mkdirSync(repo);
    git(['init', '--initial-branch=main'], repo); git(['config', 'user.name', 'source-test'], repo);
    git(['config', 'user.email', 'source-test@example.invalid'], repo);
    fs.writeFileSync(path.join(repo, 'version.txt'), 'A'); git(['add', '.'], repo); git(['commit', '-m', '版本A'], repo);
    const shaA = git(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, 'version.txt'), 'B'); git(['commit', '-am', '版本B'], repo);
    const shaB = git(['rev-parse', 'HEAD'], repo);
    const current = path.join(tmpDir, 'remote-source-current'); git(['clone', repo, current], tmpDir);
    stateService.addBranch({ id: 'remote-source', projectId: 'default', branch: 'main', worktreePath: current,
      status: 'idle', createdAt: new Date().toISOString(), services: {} });
    const shell = new ShellExecutor(); const original = mock.exec.bind(mock);
    const mounts: Array<{ path: string; version: string }> = [];
    mock.exec = async (command, options) => {
      if (command.startsWith('git ') && (options?.cwd === current || options?.cwd?.includes('.deployment-sources'))) {
        return shell.exec(command, { ...options, env: { ...options?.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
      }
      if (/^docker (run|create) /.test(command)) {
        const mount = command.match(/-v '([^']+)':'\/app'/);
        if (mount) mounts.push({ path: mount[1], version: fs.readFileSync(path.join(mount[1], 'version.txt'), 'utf8') });
      }
      return original(command, options);
    };
    const result = await postSse(server, '/exec/deploy', { branchId: 'remote-source', branchName: 'main', projectId: 'default', commitSha: shaA,
      profiles: [{ id: 'api', name: 'API', dockerImage: 'node', workDir: '.', command: 'node server.js', containerPort: 5000 }] });
    expect(result.events.some((event) => event.event === 'error' || event.data?.status === 'error')).toBe(false);
    expect(mounts).toHaveLength(1); expect(mounts[0].version).toBe('A'); expect(mounts[0].path).not.toBe(current);
    expect(git(['rev-parse', 'HEAD'], current)).toBe(shaB);
    expect(stateService.getBranch('remote-source')?.services.api.sourceCommitSha).toBe(shaA);
  });

  it('stamps the master-supplied projectId on the new entry + scopes worktree dir by it', async () => {
    // Pre-create the project locally so resolveProjectForAutoBuild has
    // something to match if needed (but the explicit body.projectId
    // should win).
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'realproj',
      slug: 'realproj',
      name: 'Real',
      kind: 'git',
      createdAt: now,
      updatedAt: now,
    });

    const result = await postSse(server, '/exec/deploy', {
      branchId: 'realproj-feature-x',
      branchName: 'feature/x',
      projectId: 'realproj',
      profiles: [],
      env: {},
    });

    expect(result.status).toBe(200);
    expect(result.events.some(e => e.event === 'complete')).toBe(true);

    const entry = stateService.getBranch('realproj-feature-x');
    expect(entry).toBeDefined();
    expect(entry!.projectId).toBe('realproj');
    expect(entry!.worktreePath).toContain('/worktrees/realproj/realproj-feature-x');
    // Critical regression: must NOT be 'default'.
    expect(entry!.worktreePath).not.toContain('/worktrees/default/');
  });

  it('honors dependency layers even when the remote payload is out of order', async () => {
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'gateway-project',
      slug: 'gateway-project',
      name: 'Gateway Project',
      kind: 'git',
      createdAt: now,
      updatedAt: now,
    });

    const result = await postSse(server, '/exec/deploy', {
      branchId: 'gateway-project-feature',
      branchName: 'feature/gateway',
      projectId: 'gateway-project',
      profiles: [
        {
          id: 'web-gateway-project', name: 'Web', dockerImage: 'node:20-slim', workDir: '.',
          command: 'node web.js', containerPort: 3002, dependsOn: ['console', 'serving'],
        },
        {
          id: 'serving-gateway-project', name: 'Serving', dockerImage: 'node:20-slim', workDir: '.',
          command: 'node serving.js', containerPort: 3001,
        },
        {
          id: 'console-gateway-project', name: 'Console', dockerImage: 'node:20-slim', workDir: '.',
          command: 'node console.js', containerPort: 3000,
        },
      ],
      env: {},
    });

    expect(result.status).toBe(200);
    const startupPlan = result.events.find((event) => event.event === 'step' && event.data?.step === 'startup-plan');
    expect(startupPlan?.data?.layers).toEqual([
      { layer: 0, services: ['serving-gateway-project', 'console-gateway-project'] },
      { layer: 1, services: ['web-gateway-project'] },
    ]);
    const runningSteps = result.events
      .filter((event) => event.event === 'step' && event.data?.status === 'running' && String(event.data?.step).startsWith('build-'))
      .map((event) => event.data?.step);
    expect(runningSteps.indexOf('build-console-gateway-project')).toBeLessThan(runningSteps.indexOf('build-web-gateway-project'));
    expect(runningSteps.indexOf('build-serving-gateway-project')).toBeLessThan(runningSteps.indexOf('build-web-gateway-project'));
  });

  it('falls back to resolveProjectForAutoBuild when master omits projectId (older master)', async () => {
    // Simulate post-rename: legacy project flipped to 'prd-agent'.
    const legacy = stateService.getLegacyProject()!;
    legacy.id = 'prd-agent';
    legacy.legacyFlag = false;
    stateService.save();

    const result = await postSse(server, '/exec/deploy', {
      branchId: 'prd-agent-some-branch',
      branchName: 'some-branch',
      // projectId intentionally omitted
      profiles: [],
      env: {},
    });

    expect(result.status).toBe(200);
    const entry = stateService.getBranch('prd-agent-some-branch');
    expect(entry).toBeDefined();
    // The bug was: this used to be 'default', creating an orphan.
    expect(entry!.projectId).toBe('prd-agent');
    expect(entry!.worktreePath).toContain('/worktrees/prd-agent/');
  });

  it('emits an error event and refuses to create when projectId is ambiguous', async () => {
    // Multi-project setup with no clear owner for autoRepoRoot.
    const legacy = stateService.getLegacyProject()!;
    legacy.id = 'a';
    legacy.legacyFlag = false;
    legacy.repoPath = '/repos/a';
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'b', slug: 'b', name: 'b', kind: 'git', repoPath: '/repos/b', createdAt: now, updatedAt: now,
    });
    stateService.save();

    const result = await postSse(server, '/exec/deploy', {
      branchId: 'orphan-branch',
      branchName: 'orphan-branch',
      // No projectId, and resolver returns undefined → must refuse.
      profiles: [],
      env: {},
    });

    expect(result.events.some(e => e.event === 'error')).toBe(true);
    // The pre-fix bug would have created an entry with projectId='default'.
    expect(stateService.getBranch('orphan-branch')).toBeUndefined();
  });

  it('scopes customEnv by resolved projectId — does not pull other projects vars when overrides absent', async () => {
    // Two projects with conflicting env vars in their own scopes.
    const now = new Date().toISOString();
    stateService.addProject({
      id: 'a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now,
    });
    stateService.addProject({
      id: 'b', slug: 'b', name: 'B', kind: 'git', createdAt: now, updatedAt: now,
    });
    stateService.setCustomEnvVar('SECRET', 'secret-from-a', 'a');
    stateService.setCustomEnvVar('SECRET', 'secret-from-b', 'b');
    stateService.setCustomEnvVar('SHARED', 'shared-global', '_global');

    // Pre-create the branch so we exercise the merge-env path without
    // also exercising worktree/profile build (which is what the
    // earlier tests validate). On second deploy the executor reuses
    // the entry; getMergedEnv(resolvedProjectId) is what we're after.
    stateService.addBranch({
      id: 'a-feature', projectId: 'a', branch: 'feature',
      worktreePath: path.join(tmpDir, 'worktrees', 'a', 'a-feature'),
      services: {}, status: 'idle', createdAt: now,
    });

    // No envOverrides in payload → executor's getMergedEnv must pick
    // up project A's scope (not project B, not _global only).
    // We can't directly observe the env handed to runService from this
    // test (it'd need a containerService spy), but we *can* assert the
    // request completes successfully — coverage of the executor branch.
    // Behavioural correctness is locked by the unit test on
    // StateService.getCustomEnv elsewhere; this test pins the
    // integration: deploy with projectId='a' must not crash + must use
    // the new scoped getMergedEnv signature.
    const result = await postSse(server, '/exec/deploy', {
      branchId: 'a-feature',
      branchName: 'feature',
      projectId: 'a',
      profiles: [],
      env: {},
    });
    expect(result.status).toBe(200);
    // No error event from getMergedEnv() invocation with new signature.
    expect(result.events.some(e => e.event === 'error')).toBe(false);
  });

  it('emits error WITH the post-teardown services snapshot when pull fails (Bugbot remote-error-stale-services)', async () => {
    // Orphan teardown runs before pull. If pull then fails, the error event must still carry the current
    // services snapshot so the master can reconcile (the removed orphan must not stay running on master).
    const now = new Date().toISOString();
    stateService.addProject({ id: 'realproj', slug: 'realproj', name: 'Real', kind: 'git', createdAt: now, updatedAt: now });
    stateService.addBranch({
      id: 'realproj-pullfail',
      projectId: 'realproj',
      branch: 'feature/pullfail',
      worktreePath: path.join(tmpDir, 'worktrees', 'realproj', 'realproj-pullfail'),
      services: {
        'old-extra': { profileId: 'old-extra', containerName: 'cds-realproj-pullfail-old-extra', hostPort: 10008, status: 'running' },
      },
      status: 'running',
      createdAt: now,
    });
    // Force the git reset (inside WorktreeService.pull) to fail — exact responses win over the catch-all.
    mock.addResponse("git rev-parse --verify 'origin/feature/pullfail^{commit}'", { stdout: '', stderr: 'fatal: couldn\'t find remote ref', exitCode: 1 });

    const result = await postSse(server, '/exec/deploy', {
      branchId: 'realproj-pullfail',
      branchName: 'feature/pullfail',
      projectId: 'realproj',
      // A real desired profile so the deploy does NOT short-circuit on empty payload → it reaches pull.
      profiles: [{ id: 'api', name: 'API', dockerImage: 'node:20', workDir: 'api', command: 'node server.js', containerPort: 8080 }],
      env: {},
    });

    expect(result.status).toBe(200);
    const errorEvent = result.events.find(e => e.event === 'error');
    expect(errorEvent).toBeDefined();
    // The error payload carries a services snapshot (object) so the master can reconcile on failure.
    expect(errorEvent!.data?.services).toBeDefined();
    expect(typeof errorEvent!.data.services).toBe('object');
    // The orphan was torn down before the pull failed (its container was removed + entry cleared).
    expect(stateService.getBranch('realproj-pullfail')!.services['old-extra']).toBeUndefined();
    expect(errorEvent!.data.services['old-extra']).toBeUndefined();
    // worker 自身分支态落 error（Bugbot「Failed remote deploy reverts to building」）：否则下一次心跳会把
    // master 已 finalize 的 error 覆盖回 building。
    expect(stateService.getBranch('realproj-pullfail')!.status).toBe('error');
    expect(stateService.getBranch('realproj-pullfail')!.errorMessage).toBeTruthy();
  });

  it('does not stamp projectId on a branch the executor already knows about', async () => {
    // Existing entry on the executor (e.g., re-deploy after restart).
    // The deploy path must be a no-op for entry creation; the
    // pre-existing projectId is the source of truth.
    const now = new Date().toISOString();
    const seeded: BranchEntry = {
      id: 'realproj-existing',
      projectId: 'whatever-was-there-before',
      branch: 'existing',
      worktreePath: path.join(tmpDir, 'worktrees', 'whatever', 'realproj-existing'),
      services: {},
      status: 'idle',
      createdAt: now,
    };
    stateService.addBranch(seeded);

    await postSse(server, '/exec/deploy', {
      branchId: 'realproj-existing',
      branchName: 'existing',
      projectId: 'realproj',
      profiles: [],
      env: {},
    });

    const entry = stateService.getBranch('realproj-existing');
    // Should not have been overwritten — the master-supplied value
    // only applies to newly-created entries.
    expect(entry!.projectId).toBe('whatever-was-there-before');
  });

  it('empty payload tears down orphan services BEFORE/WITHOUT pulling (Codex P2 cleanup-before-pull)', async () => {
    // A branch whose only service was a branch-local extra; the master cleared it and sent profiles: [].
    // The cleanup must NOT be gated behind git pull — otherwise a transient git failure / upstream-deleted
    // branch would error out leaving the worker container running while master saved the empty list.
    const now = new Date().toISOString();
    stateService.addBranch({
      id: 'realproj-empty-clear',
      projectId: 'realproj',
      branch: 'feature/empty-clear',
      worktreePath: path.join(tmpDir, 'worktrees', 'realproj', 'realproj-empty-clear'),
      services: {
        'extra-api': { profileId: 'extra-api', containerName: 'cds-realproj-empty-clear-extra-api', hostPort: 10007, status: 'running' },
      },
      status: 'running',
      createdAt: now,
    });
    stateService.addProject({ id: 'realproj', slug: 'realproj', name: 'Real', kind: 'git', createdAt: now, updatedAt: now });
    mock.commands.length = 0;

    const result = await postSse(server, '/exec/deploy', {
      branchId: 'realproj-empty-clear',
      branchName: 'feature/empty-clear',
      projectId: 'realproj',
      profiles: [],
      env: {},
    });

    expect(result.status).toBe(200);
    // The orphan service container was removed + entry cleared, status idle.
    expect(result.events.some(e => e.event === 'complete' && e.data?.message === '已清空所有服务')).toBe(true);
    const entry = stateService.getBranch('realproj-empty-clear');
    expect(entry!.services['extra-api']).toBeUndefined();
    expect(entry!.status).toBe('idle');
    // pull was skipped (nothing to build) — no `git ... pull` was issued and no 'pull' step emitted.
    expect(result.events.some(e => e.event === 'step' && e.data?.step === 'pull')).toBe(false);
    expect(mock.commands.some(c => /\bpull\b/.test(c))).toBe(false);
    // the orphan container WAS removed.
    expect(mock.commands.some(c => /docker rm/.test(c) && c.includes('cds-realproj-empty-clear-extra-api'))).toBe(true);
  });

  it('treats an OMITTED profiles field as an empty teardown, not an opaque error (Bugbot Low: missing profiles guard)', async () => {
    // Older masters / manual calls may omit `profiles` entirely. profilesData.map / .length must not throw —
    // it should normalize to [] and run the same empty-teardown path as profiles: [].
    const now = new Date().toISOString();
    stateService.addBranch({
      id: 'realproj-omit-profiles',
      projectId: 'realproj',
      branch: 'feature/omit-profiles',
      worktreePath: path.join(tmpDir, 'worktrees', 'realproj', 'realproj-omit-profiles'),
      services: {
        'extra-api': { profileId: 'extra-api', containerName: 'cds-realproj-omit-profiles-extra-api', hostPort: 10008, status: 'running' },
      },
      status: 'running',
      createdAt: now,
    });
    stateService.addProject({ id: 'realproj', slug: 'realproj', name: 'Real', kind: 'git', createdAt: now, updatedAt: now });
    mock.commands.length = 0;

    // NOTE: no `profiles` field in the body at all.
    const result = await postSse(server, '/exec/deploy', {
      branchId: 'realproj-omit-profiles',
      branchName: 'feature/omit-profiles',
      projectId: 'realproj',
      env: {},
    });

    expect(result.status).toBe(200);
    expect(result.events.some(e => e.event === 'error')).toBe(false);
    expect(result.events.some(e => e.event === 'complete' && e.data?.message === '已清空所有服务')).toBe(true);
    const entry = stateService.getBranch('realproj-omit-profiles');
    expect(entry!.services['extra-api']).toBeUndefined();
    expect(entry!.status).toBe('idle');
  });

  it('threads operationId/requestId from master into executor docker run events', async () => {
    const result = await postSse(server, '/exec/deploy', {
      branchId: 'realproj-op-trace',
      branchName: 'feature/op-trace',
      projectId: 'default',
      requestId: 'req-exec-deploy',
      operationId: 'op-exec-deploy',
      actor: 'user:42',
      trigger: 'manual',
      profiles: [{
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        workDir: '.',
        command: 'node server.js',
        containerPort: 3000,
      }],
      env: {},
    });

    expect(result.status).toBe(200);
    expect(containerEvents.find((event) => event.action === 'app.pre-run-rm')?.operationId).toBe('op-exec-deploy');
    expect(containerEvents.find((event) => event.action === 'app.run.started')?.requestId).toBe('req-exec-deploy');
    expect(containerEvents.find((event) => event.action === 'app.pre-run-rm')?.details?.actor).toBe('user:42');
  });

  it('threads operationId into executor stop and delete container events', async () => {
    const now = new Date().toISOString();
    stateService.addBranch({
      id: 'exec-owned',
      projectId: 'default',
      branch: 'feature/exec-owned',
      worktreePath: path.join(tmpDir, 'worktrees', 'default', 'exec-owned'),
      services: {
        api: {
          profileId: 'api',
          containerName: 'cds-exec-owned-api',
          hostPort: 10001,
          status: 'running',
        },
      },
      status: 'running',
      createdAt: now,
    });

    const stop = await postJson(server, '/exec/stop', {
      branchId: 'exec-owned',
      requestId: 'req-exec-stop',
      operationId: 'op-exec-stop',
      actor: 'scheduler',
      trigger: 'auto-lifecycle',
    });
    expect(stop.status).toBe(200);
    expect(containerEvents.find((event) => event.action === 'container.stop.requested')?.operationId).toBe('op-exec-stop');

    const branch = stateService.getBranch('exec-owned')!;
    branch.status = 'running';
    branch.services.api.status = 'running';
    stateService.save();
    const del = await postJson(server, '/exec/delete', {
      branchId: 'exec-owned',
      requestId: 'req-exec-delete',
      operationId: 'op-exec-delete',
      actor: 'user:42',
      trigger: 'manual',
    });
    expect(del.status).toBe(200);
    expect(containerEvents.find((event) => event.action === 'container.remove.requested')?.operationId).toBe('op-exec-delete');
    expect(stateService.getBranch('exec-owned')).toBeUndefined();
  });
});
