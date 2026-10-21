import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { serviceRuntimeRefs } from '../../src/services/service-runtime.js';
import { execFileSync } from 'node:child_process';
import {
  clearRunningServiceErrorMessages,
  createBranchRouter,
  shouldSkipFencedDeployCleanupForNewerRuntime,
} from '../../src/routes/branches.js';
import { StateService } from '../../src/services/state.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { ContainerService, resolveEffectiveProfile } from '../../src/services/container.js';
import { BranchOperationCoordinator, pendingDeployBody } from '../../src/services/branch-operation-coordinator.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { deploymentPhaseBudget } from '../../src/services/deployment-phase-budget.js';
import { commitServiceReplacements } from '../../src/services/service-replacement.js';
import { branchAppNetworkName } from '../../src/services/branch-network.js';
import { captureDeploymentInput } from '../../src/services/deployment-input.js';
import { refreshArtifactWaiters, requestArtifactWaitRefresh } from '../../src/services/artifact-admission-wait.js';
import { componentInputComparator } from '../../src/services/prebuilt-reuse.js';
import { DeploymentVersionService } from '../../src/services/deployment-version.js';
import { ManagedProjectService } from '../../src/services/managed-project.js';
import { setBuildGateHostLoadProvider } from '../../src/services/build-gate.js';
import type { ServerEventLogSink } from '../../src/services/server-event-log-store.js';

import { ShellExecutor, MockShellExecutor } from '../../src/services/shell-executor.js';
import { IsolatedShellExecutor } from '../../src/services/isolated-shell-executor.js';
import type { BranchEntry, CdsConfig, ExecOptions } from '../../src/types.js';
import { computePreviewSlug } from '../../src/services/preview-slug.js';
import { namedServiceLabel } from '../../src/services/preview-entrypoints.js';

import { flushAllJsonStateStores } from '../../src/infra/state-store/json-backing-store.js';
function makeConfig(tmpDir: string): CdsConfig {
  return {
    repoRoot: tmpDir,
    worktreeBase: path.join(tmpDir, 'worktrees'),
    masterPort: 9900,
    workerPort: 5500,
    dockerNetwork: 'cds-network',
    portStart: 10001,
    rootDomains: ['example.test'],
    previewDomain: 'example.test',
    sharedEnv: { MONGODB_HOST: 'db:27017' },
    jwt: { secret: 'test-secret', issuer: 'prdagent' },
  };
}

describe('branch status helpers', () => {
  it('clears stale service errors once a service is running again', () => {
    const entry: BranchEntry = {
      id: 'branch-1',
      projectId: 'default',
      branch: 'main',
      worktreePath: '/tmp/branch-1',
      status: 'running',
      createdAt: new Date().toISOString(),
      services: {
        api: {
          profileId: 'api',
          containerName: 'api-container',
          hostPort: 10001,
          status: 'running',
          errorMessage: '容器 "api-container" 已消失',
        },
        worker: {
          profileId: 'worker',
          containerName: 'worker-container',
          hostPort: 10002,
          status: 'error',
          errorMessage: '启动失败',
        },
      },
    };

    clearRunningServiceErrorMessages(entry);

    expect(entry.services.api.errorMessage).toBeUndefined();
    expect(entry.services.worker.errorMessage).toBe('启动失败');
  });

  it('skips fenced deploy cleanup when a newer runtime became ready', () => {
    expect(shouldSkipFencedDeployCleanupForNewerRuntime(
      {
        lastReadyAt: '2026-06-19T20:11:35.631Z',
        lastDeployAt: '2026-06-19T20:11:35.700Z',
      },
      '2026-06-19T19:45:39.295Z',
    )).toBe(true);
  });

  it('does not skip fenced deploy cleanup without a newer ready runtime', () => {
    expect(shouldSkipFencedDeployCleanupForNewerRuntime(
      { lastReadyAt: '2026-06-19T19:40:00.000Z' },
      '2026-06-19T19:45:39.295Z',
    )).toBe(false);
  });

  it('does not skip fenced deploy cleanup after a later stop', () => {
    expect(shouldSkipFencedDeployCleanupForNewerRuntime(
      {
        lastReadyAt: '2026-06-19T20:11:35.631Z',
        lastStoppedAt: '2026-06-19T20:12:00.000Z',
      },
      '2026-06-19T19:45:39.295Z',
    )).toBe(false);
  });
});

async function request(
  server: http.Server, method: string, urlPath: string, body?: unknown, headers?: Record<string, string>,
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port: addr.port, path: urlPath, method,
      headers: {
        'Content-Type': 'application/json',
        ...(headers || {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(raw), headers: res.headers }); }
        catch { resolve({ status: res.statusCode!, body: raw, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function isAppLaunchCommand(command: string): boolean {
  return /^(?:docker run -d|docker create) /.test(command) && command.includes('--label cds.type=app');
}

function seedLegacyDefaultProject(stateService: StateService): void {
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
}

describe('Branch Routes', () => {
  let tmpDir: string;
  let server: http.Server;
  let config: CdsConfig;
  let mock: MockShellExecutor;
  let stateService: StateService;
  let containerService: ContainerService;
  let serverEventLogStore: ServerEventLogSink;
  let branchOperationCoordinator: BranchOperationCoordinator;
  let deploymentRunService: DeploymentRunService;
  let deploymentVersionService: DeploymentVersionService;
  let managedProjectService: ManagedProjectService;
  let registryNodes: any[];
  let operationEvents: Array<{
    category?: string;
    source?: string;
    severity?: string;
    action: string;
    branchId?: string | null;
    requestId?: string | null;
    operationId?: string | null;
    operationKind?: string | null;
    operationTrigger?: string | null;
    operationActor?: string | null;
    operationSource?: string | null;
    commitSha?: string | null;
    details?: Record<string, unknown>;
  }>;

  beforeEach(async () => {
    // 2026-05-28: 重置 selfStatusCache 单例,避免上个测试残留的 remoteBranches/
    // lastKnownGood 串到本测试。createBranchRouter 会重新 init cache。
    const cacheMod = await import('../../src/services/self-status-cache.js');
    cacheMod.selfStatusCache._resetForTests();
    // 这些是部署/操作-fencing 测试，与分支网络隔离正交：它们用 `docker run -d --name X` 当协调闸门。
    // 隔离开启时 runService 改走 create→connect→start，闸门匹配不到 `docker run -d` 会挂死。故本组
    // 显式关隔离（与 container.test.ts / container-network-isolation.test.ts 同款），隔离 create/start
    // 路径由 container-branch-network-isolation.test.ts 专门覆盖。
    process.env.CDS_BRANCH_NETWORK_ISOLATION = '0';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-routes-'));
    config = makeConfig(tmpDir);
    mock = new MockShellExecutor();
    Object.assign(mock, { execOwnedOperation: (command: string, options: ExecOptions & { beforeStart: () => void }) => {
      options.beforeStart(); return mock.exec(command, options);
    } });

    // 模拟真正的 detached worktree：解析得到完整身份，快照 HEAD 与请求目标一致。
    const sourceHeads = new Map<string, string>();
    const defaultSourceSha = 'abc1234' + '0'.repeat(33);
    mock.addResponsePattern(/git check-ref-format --branch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git rev-parse --verify '([^']+)\^\{commit\}'/, (match) => ({
      stdout: /^[0-9a-f]{7,40}$/i.test(match[1]) ? match[1].padEnd(40, '0') : defaultSourceSha,
      stderr: '', exitCode: 0,
    }));
    mock.addResponsePattern(/git worktree add --detach '([^']+)' '([0-9a-f]{40})'/, (match, options) => {
      sourceHeads.set(match[1], match[2]);
      fs.mkdirSync(match[1], { recursive: true });
      if (options?.cwd && fs.existsSync(options.cwd) && !match[1].startsWith(`${options.cwd}${path.sep}`)) {
        fs.cpSync(options.cwd, match[1], { recursive: true });
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mock.addResponsePattern(/git rev-parse HEAD$/, (_match, options) => ({
      stdout: sourceHeads.get(options?.cwd || '') || 'abc1234', stderr: '', exitCode: 0,
    }));
    // Default mocks
    mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git worktree add/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git worktree remove/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git worktree prune/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/test -d/, () => ({ stdout: '', stderr: '', exitCode: 1 }));
    mock.addResponsePattern(/docker network inspect --format .*Labels.* '([^']+)'$/, match => {
      const entry = stateService.getAllBranches().find(branch => branch.replacementNetworks?.includes(match[1]));
      return { stdout: JSON.stringify({ 'cds.type': 'replacement-network', 'cds.project.id': entry?.projectId || '_unknown', 'cds.branch.id': entry?.id }), stderr: '', exitCode: 0 };
    });
    mock.addResponsePattern(/docker network inspect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    // 分支级网络隔离（默认开）：runService 会 ensure 分支网 + 跑后 network connect 共享网。
    mock.addResponsePattern(/docker network create/, () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker network connect/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const cid = (name: string) => createHash('sha256').update(name).digest('hex');
    const removed = new Set<string>();
    mock.addResponsePattern(/docker create .*--label cds.type=app/, match => ({ stdout: cid(/--name ([^ ]+)/.exec(match[0])![1]), stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/^docker start /, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker run/, () => ({ stdout: 'cid123', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker stop/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker rm.* ([^ ]+)$/, match => { removed.add(match[1].replaceAll("'", '')); return { stdout: '', stderr: '', exitCode: 0 }; });
    // 本套件的remove替身表示已成功删除；回收失败及真实ID证明由容器专项/原生演练覆盖。
    mock.addResponsePattern(/docker inspect --format '\{\{.Id\}\}' '([^']+)'$/, () => ({ stdout: '', stderr: 'No such object: removed-owned-id', exitCode: 1 }));
    mock.addResponsePattern(/docker inspect.*"running".* '([^']+)'$/, match => {
      for (const entry of stateService.getAllBranches()) for (const [profileId, service] of Object.entries(entry.services)) {
        const runtime = serviceRuntimeRefs(service).find(runtime => runtime.containerName === match[1] || runtime.containerId === match[1] || cid(runtime.containerName) === match[1]);
        if (runtime && (!removed.has(match[1]) || !/^[a-f0-9]{64}$/.test(match[1]))) {
          return { stdout: JSON.stringify({ id: runtime.containerId || cid(runtime.containerName), running: true, branch: entry.id,
            project: entry.projectId || '_unknown', profile: profileId,
            networks: { [runtime.networkName || 'cds-test-network']: { Aliases: [profileId] } } }), stderr: '', exitCode: 0 };
        }
      }
      return { stdout: '', stderr: 'No such container', exitCode: 1 };
    });
    mock.addResponsePattern(/docker inspect.*Config.Labels/, match => {
      const entry = stateService.getAllBranches().find(entry => Object.values(entry.services).some(service => match[0].includes(service.containerName)));
      const profile = entry && Object.entries(entry.services).find(([, service]) => match[0].includes(service.containerName))?.[0];
      return { stdout: JSON.stringify({ 'cds.branch.id': entry?.id, 'cds.project.id': entry?.projectId || '_unknown', 'cds.profile.id': profile }), stderr: '', exitCode: 0 };
    });
    mock.addResponsePattern(/docker network (create|connect)/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker inspect/, () => ({ stdout: 'true', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/docker logs/, () => ({ stdout: 'log output', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/mkdir/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git log --oneline/, () => ({ stdout: 'abc1234 some commit', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git rev-parse/, () => ({ stdout: 'abc1234', stderr: '', exitCode: 0 }));
    mock.addResponsePattern(/git reset --hard/, () => ({ stdout: 'HEAD is now at abc1234', stderr: '', exitCode: 0 }));

    const stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile);
    stateService.load();
    // Fresh installs intentionally do not auto-create a default project.
    // This route suite exercises legacy branch APIs, so it seeds the
    // compatibility project explicitly instead of relying on StateService
    // to manufacture one.
    seedLegacyDefaultProject(stateService);

    const worktreeService = new WorktreeService(mock, config.repoRoot);
    containerService = new ContainerService(mock, config);
    (containerService as any).waitForContainerAlive = async () => undefined;
    (containerService as any).waitForReadiness = async () => true;
    registryNodes = [];
    const registry = {
      getAll: () => registryNodes,
      getOnline: () => registryNodes.filter((node) => node.status === 'online'),
      selectExecutor: () => registryNodes.find((node) => node.status === 'online') || null,
    } as any;
    operationEvents = [];
    serverEventLogStore = {
      record(record) {
        operationEvents.push({
          category: record.category,
          source: record.source,
          severity: record.severity,
          action: record.action,
          branchId: record.branchId,
          requestId: record.requestId,
          operationId: record.operationId,
          operationKind: record.operationKind,
          operationTrigger: record.operationTrigger,
          operationActor: record.operationActor,
          operationSource: record.operationSource,
          commitSha: record.commitSha,
          details: record.details,
        });
      },
    };
    branchOperationCoordinator = new BranchOperationCoordinator(serverEventLogStore);
    deploymentRunService = new DeploymentRunService(stateService, {
      isExecutionWaiting: (run, now) => !!run.operationId && run.operationGeneration !== undefined
        && (deploymentPhaseBudget.waitingOperation(run.operationId, run.operationGeneration)?.deadlineAt || 0) > now.getTime(),
    });
    deploymentVersionService = new DeploymentVersionService(stateService);
    managedProjectService = new ManagedProjectService(stateService);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const h = req.headers['x-test-key'] as string | undefined;
      if (h === 'A') (req as any).cdsProjectKey = { projectId: 'proj-a', keyId: 'key-a' };
      if (h === 'B') (req as any).cdsProjectKey = { projectId: 'proj-b', keyId: 'key-b' };
      next();
    });
    app.use('/api', createBranchRouter({
      stateService, worktreeService, containerService, shell: mock, config, registry, branchOperationCoordinator, serverEventLogStore,
      deploymentRunService,
      deploymentVersionService,
      managedProjectService,
    }));

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    config.masterPort = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await flushAllJsonStateStores();
    delete process.env.CDS_DELETE_STATE_FLUSH_TIMEOUT_MS;
    delete process.env.CDS_BRANCHES_SLOW_MS;
    delete process.env.CDS_BRANCH_NETWORK_ISOLATION;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function readyArtifactFixture() {
    const images = new Map<string, unknown>();
    mock.addResponsePatternFirst(/docker info/, () => ({ stdout: JSON.stringify({ Architecture: 'x86_64', OSType: 'linux' }), stderr: '', exitCode: 0 }));
    mock.addResponsePatternFirst(/docker pull/, () => ({ stdout: 'available', stderr: '', exitCode: 0 }));
    mock.addResponsePatternFirst(/docker image inspect (.+)/, match => {
      const reference = match[1].replace(/'/g, ''); const sha = /:sha-([a-f0-9]{40})/.exec(reference)?.[1];
      if (!images.has(reference) && sha) {
        const content = `sha256:${sha + sha.slice(0, 24)}`, digest = reference.split('@')[0].replace(/:sha-[a-f0-9]{40}$/, '') + '@' + content;
        const metadata = { Id: content, RepoDigests: [digest], Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': sha } } };
        for (const name of [reference, content, digest]) images.set(name, metadata);
      }
      return images.has(reference) ? { stdout: JSON.stringify([images.get(reference)]), stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'No such image in owned fixture', exitCode: 1 };
    });
  }

  async function waitForAcceptedRun(response: { headers: http.IncomingHttpHeaders }) {
    const id = String(response.headers['x-cds-deployment-run-id']);
    const until = Date.now() + 3_000;
    while (Date.now() < until) {
      const run = deploymentRunService.get(id);
      if (run && ['running', 'failed', 'cancelled'].includes(run.status)) return run;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`原受理任务未结束: ${deploymentRunService.get(id)?.status}`);
  }

  function unfetchedCommitFixture() {
    const git = (args: string[], cwd: string) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const seed = path.join(tmpDir, 'input-seed'), origin = path.join(tmpDir, 'input-origin.git'), repo = path.join(tmpDir, 'input-clone');
    fs.mkdirSync(seed); git(['init', '--initial-branch=main'], seed);
    git(['config', 'user.name', 'artifact-input'], seed); git(['config', 'user.email', 'artifact-input@example.invalid'], seed);
    fs.writeFileSync(path.join(seed, 'component.txt'), 'A'); git(['add', '.'], seed); git(['commit', '-m', '版本A'], seed);
    git(['clone', '--bare', seed, origin], tmpDir); git(['clone', origin, repo], tmpDir);
    const A = git(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(seed, 'other.txt'), 'B'); git(['add', '.'], seed); git(['commit', '-m', '其他组件B'], seed);
    const B = git(['rev-parse', 'HEAD'], seed); git(['push', origin, 'HEAD:refs/heads/later-object'], seed);
    expect(() => git(['cat-file', '-e', `${B}^{commit}`], repo)).toThrow();
    const native = new ShellExecutor(), original = mock.exec.bind(mock);
    mock.exec = async (command, options) => {
      if (/^'git'.*'diff'/.test(command) || options?.cwd === repo && /^git (rev-parse --verify|fetch origin [0-9a-f]{40}$)/.test(command)) {
        mock.commands.push(command); mock.cwds.push(options?.cwd); mock.stdins.push(options?.stdin);
        return native.exec(command, { ...options, env: { ...options?.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
      }
      return original(command, options);
    };
    Object.assign(mock, { execBackgroundObservation: mock.exec.bind(mock), execOwnedOperation: (command: string, options: ExecOptions & { beforeStart: () => void }) => {
      options.beforeStart(); return mock.exec(command, options);
    } });
    stateService.getProject('default')!.repoPath = repo;
    return { A, B, repo, origin, git };
  }

  describe('手动镜像认领回执恢复', () => {
    const sha = 'a'.repeat(40);
    function seedClaim() {
      stateService.getProject('default')!.githubRepoFullName = 'acme/new-repo';
      stateService.addBuildProfile({ id: 'claim-web', projectId: 'default', name: 'Web', dockerImage: 'node', workDir: '.', containerPort: 8080,
        deployModes: { express: { label: 'Express', dockerImage: 'ghcr.io/acme/demo:sha-${CDS_COMMIT_SHA}', prebuilt: true } } });
      const entry: BranchEntry = { id: 'claim-branch', projectId: 'default', branch: 'feature', worktreePath: tmpDir, status: 'running', services: {}, createdAt: new Date().toISOString(),
        githubRepoFullName: 'acme/old-repo', githubCommitSha: sha, ciTargetSha: sha, ciImageStatus: 'waiting', ciWorkflowRunUrl: '', profileOverrides: { 'claim-web': { activeDeployMode: 'express' } } };
      stateService.addBranch(entry);
      return entry;
    }
    const run = { repository: { full_name: 'acme/old-repo' }, head_branch: 'feature', head_sha: sha,
      path: '.github/workflows/branch-image.yml', status: 'completed', conclusion: 'success' };
    it('项目重新关联后仍使用在途分支缓存的仓库核验真实回执', async () => {
      const entry = seedClaim(); const original = globalThis.fetch;
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(run)));
      globalThis.fetch = fetcher;
      try {
        const result = await request(server, 'POST', '/api/branches/claim-branch/prebuilt-image/claim', { commitSha: sha, workflowRunUrl: 'https://github.com/acme/old-repo/actions/runs/123', dryRun: true });
        expect(result.status).toBe(200);
        expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/repos/acme/old-repo/actions/runs/123');
        expect(entry.ciImageStatus).toBe('waiting');
      } finally { globalThis.fetch = original; }
    });
    it('仅传提交时自动查询并保存核验后的规范运行链接', async () => {
      const entry = seedClaim(); const original = globalThis.fetch;
      globalThis.fetch = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ workflow_runs: [{ ...run, id: 123 }] })))
        .mockResolvedValueOnce(new Response(JSON.stringify(run)));
      try {
        const result = await request(server, 'POST', '/api/branches/claim-branch/prebuilt-image/claim', { commitSha: sha });
        expect(result.status).toBe(200);
        expect((result.body as any).patch.ciWorkflowRunUrl).toBe('https://github.com/acme/old-repo/actions/runs/123');
        expect(stateService.getBranch(entry.id)?.ciWorkflowRunUrl).toBe('https://github.com/acme/old-repo/actions/runs/123');
        expect(stateService.getBranch(entry.id)?.ciImageStatus).toBe('ready');
      } finally { globalThis.fetch = original; }
    });
    it('省略链接时不复用旧失败运行链接，而是查询同提交的新运行', async () => {
      const entry = seedClaim(); entry.ciWorkflowRunUrl = 'https://github.com/acme/old-repo/actions/runs/123'; entry.ciImageStatus = 'failed';
      const original = globalThis.fetch;
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ workflow_runs: [{ ...run, id: 456 }] })))
        .mockResolvedValueOnce(new Response(JSON.stringify(run)));
      globalThis.fetch = fetcher;
      try {
        const result = await request(server, 'POST', '/api/branches/claim-branch/prebuilt-image/claim', { commitSha: sha });
        expect(result.status).toBe(200);
        expect(stateService.getBranch(entry.id)?.ciWorkflowRunUrl).toBe('https://github.com/acme/old-repo/actions/runs/456');
        expect(fetcher.mock.calls[0][0]).toContain('/actions/workflows/branch-image.yml/runs?');
        expect(fetcher.mock.calls[1][0]).toBe('https://api.github.com/repos/acme/old-repo/actions/runs/456');
      } finally { globalThis.fetch = original; }
    });
    it('同名但路径不符的成功回执不能改写运行和等待状态', async () => {
      const entry = seedClaim(); const before = JSON.stringify(entry); const original = globalThis.fetch;
      globalThis.fetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...run, path: '.github/workflows/ci.yml', name: 'Branch Image' })));
      try {
        const result = await request(server, 'POST', '/api/branches/claim-branch/prebuilt-image/claim', { commitSha: sha, workflowRunUrl: 'https://github.com/acme/old-repo/actions/runs/123' });
        expect(result.status).toBe(409);
        expect((result.body as any).error).toBe('ci_evidence_mismatch');
        expect(JSON.stringify(stateService.getBranch(entry.id))).toBe(before);
      } finally { globalThis.fetch = original; }
    });
  });

  describe('真实Git部署目标与运行源码隔离', () => {
    async function sourceFixture(withMigration = false) {
      const git = (args: string[], cwd: string) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const repo = path.join(tmpDir, 'source-repo'); fs.mkdirSync(repo);
      git(['init', '--initial-branch=main'], repo);
      git(['config', 'user.name', 'source-test'], repo);
      git(['config', 'user.email', 'source-test@example.invalid'], repo);
      fs.writeFileSync(path.join(repo, 'version.txt'), 'A');
      if (withMigration) {
        fs.mkdirSync(path.join(repo, 'prisma'));
        fs.writeFileSync(path.join(repo, 'prisma/schema.prisma'), '// schema A');
        fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'source-test', packageManager: 'pnpm@10.0.0' }));
        fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
      }
      git(['add', '.'], repo); git(['commit', '-m', '版本A'], repo);
      const shaA = git(['rev-parse', 'HEAD'], repo);
      fs.writeFileSync(path.join(repo, 'version.txt'), 'B');
      if (withMigration) fs.writeFileSync(path.join(repo, 'prisma/schema.prisma'), '// schema B');
      git(['commit', '-am', '版本B'], repo);
      const shaB = git(['rev-parse', 'HEAD'], repo);
      const current = path.join(tmpDir, 'source-current'); git(['clone', repo, current], tmpDir);
      const entry: BranchEntry = { id: 'source-check', projectId: 'default', branch: 'main', worktreePath: current,
        status: 'idle', createdAt: new Date().toISOString(), services: {} };
      stateService.addBranch(entry);
      stateService.addBuildProfile({ id: 'api', projectId: 'default', name: 'API', dockerImage: 'node', workDir: '.', command: 'node server.js', containerPort: 5000 });
      stateService.addBuildProfile({ id: 'web', projectId: 'default', name: 'Web', dockerImage: 'node', workDir: '.', command: 'node server.js', containerPort: 5001 });
      const shell = new ShellExecutor(); const original = mock.exec.bind(mock);
      const mounts: Array<{ path: string; version: string }> = [];
      const migrationMounts: string[] = [];
      mock.exec = async (command, options) => {
        if (command.startsWith('git ') && (options?.cwd === current || options?.cwd?.includes('.deployment-sources'))) {
          return shell.exec(command, { ...options, env: { ...options?.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
        }
        if (command.startsWith('docker run --rm') && command.includes('prisma')) {
          const mount = command.match(/-v '([^']+)':'\/app'/);
          if (mount) migrationMounts.push(fs.readFileSync(path.join(mount[1], 'version.txt'), 'utf8'));
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        if (isAppLaunchCommand(command)) {
          const mount = command.match(/-v '([^']+)':'\/app'/);
          if (mount) mounts.push({ path: mount[1], version: fs.readFileSync(path.join(mount[1], 'version.txt'), 'utf8') });
        }
        return original(command, options);
      };
      return { git, current, entry, shaA, shaB, mounts, migrationMounts };
    }
    it('整分支迁移任务和应用均从请求A的源码读取', async () => {
      const f = await sourceFixture(true);
      const result = await request(server, 'POST', `/api/branches/${f.entry.id}/deploy`, { commitSha: f.shaA });
      expect(String(result.body)).not.toContain('event: error');
      expect(f.migrationMounts.length).toBeGreaterThan(0);
      expect(f.migrationMounts.every((version) => version === 'A')).toBe(true);
      expect(f.mounts.every((mount) => mount.version === 'A')).toBe(true);
      expect(f.git(['rev-parse', 'HEAD'], f.current)).toBe(f.shaB);
    });
    it.each(['/deploy', '/deploy/api'])('请求A时%s实际挂载A而原分支目录仍是B', async (endpoint) => {
      const f = await sourceFixture();
      const result = await request(server, 'POST', `/api/branches/${f.entry.id}${endpoint}`, { commitSha: f.shaA });
      expect(result.status).toBe(200);
      expect(String(result.body)).not.toContain('event: error');
      expect(f.mounts.length).toBeGreaterThan(0);
      expect(f.mounts.every((mount) => mount.version === 'A' && mount.path !== f.current)).toBe(true);
      expect(fs.readFileSync(path.join(f.current, 'version.txt'), 'utf8')).toBe('B');
      expect(f.git(['rev-parse', 'HEAD'], f.current)).toBe(f.shaB);
      expect(f.entry.services.api.sourceCommitSha).toBe(f.shaA);
      expect(f.entry.services.api.sourceCheckoutPath).toBe(f.mounts[0].path);
    });
    it.each(['/deploy', '/deploy/api'])('%s非法提交拒绝且没有Git和容器操作', async (endpoint) => {
      const f = await sourceFixture(); const before = mock.commands.length;
      const result = await request(server, 'POST', `/api/branches/${f.entry.id}${endpoint}`, { commitSha: 'not-a-sha' });
      expect(result.status).toBe(400);
      expect(mock.commands.slice(before).some((command) => command.startsWith('git ') || command.startsWith('docker '))).toBe(false);
    });
    it('配置清空时非法提交仍在任何服务清理之前拒绝', async () => {
      const f = await sourceFixture();
      for (const profile of stateService.getBuildProfiles()) stateService.removeBuildProfile(profile.id);
      const before = mock.commands.length;
      const result = await request(server, 'POST', `/api/branches/${f.entry.id}/deploy`, { commitSha: 'not-a-sha' });
      expect(result.status).toBe(400);
      expect(mock.commands.slice(before).some((command) => command.startsWith('git ') || command.startsWith('docker '))).toBe(false);
    });
    it('不存在的目标提交不启动容器，也不回退到HEAD', async () => {
      const f = await sourceFixture();
      const result = await request(server, 'POST', `/api/branches/${f.entry.id}/deploy/api`, { commitSha: 'f'.repeat(40) });
      expect(String(result.body)).toContain('目标提交不可用'); expect(f.mounts).toHaveLength(0);
      expect(f.git(['rev-parse', 'HEAD'], f.current)).toBe(f.shaB);
    });
    it('API部署A后Web部署B，API原挂载仍为A，服务重启沿用其实际源码', async () => {
      const f = await sourceFixture();
      await request(server, 'POST', `/api/branches/${f.entry.id}/deploy/api`, { commitSha: f.shaA });
      await request(server, 'POST', `/api/branches/${f.entry.id}/deploy/web`, { commitSha: f.shaB });
      expect(f.mounts.map((mount) => mount.version)).toEqual(['A', 'B']);
      expect(f.mounts[0].path).not.toBe(f.mounts[1].path);
      expect(fs.readFileSync(path.join(f.mounts[0].path, 'version.txt'), 'utf8')).toBe('A');
      await containerService.runService(f.entry, stateService.getBuildProfiles()[0], f.entry.services.api);
      expect(f.mounts.map((mount) => mount.version)).toEqual(['A', 'B', 'A']);
      expect(f.entry.services.api.sourceCommitSha).toBe(f.shaA);
    });
  });

  // ── Remote branches ──

  describe('GET /api/remote-branches', () => {
    it('should return list of remote branches', async () => {
      const SEP = '<SEP>';
      mock.addResponsePattern(/git for-each-ref/, () => ({
        stdout: [`main${SEP}2026-02-12${SEP}Dev${SEP}msg`, `feature/ui${SEP}2026-02-12${SEP}Dev${SEP}msg`].join('\n'),
        stderr: '', exitCode: 0,
      }));

      const res = await request(server, 'GET', '/api/remote-branches');
      expect(res.status).toBe(200);
      const body = res.body as { branches: Array<{ name: string }> };
      expect(body.branches.map(b => b.name)).toEqual(['main', 'feature/ui']);
    });

    it('first call runs git fetch and reports fetched=true', async () => {
      mock.addResponsePattern(/git for-each-ref/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      const res = await request(server, 'GET', '/api/remote-branches');
      expect(res.status).toBe(200);
      const body = res.body as { fetched: boolean; cachedAt: number | null };
      expect(body.fetched).toBe(true);
      expect(body.cachedAt).toBeGreaterThan(0);
      expect(mock.commands.some(c => c.includes('git fetch origin --prune'))).toBe(true);
    });

    it('second call within cache window skips git fetch', async () => {
      mock.addResponsePattern(/git for-each-ref/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      await request(server, 'GET', '/api/remote-branches');
      const fetchCallsBefore = mock.commands.filter(c => c.includes('git fetch origin --prune')).length;

      const res = await request(server, 'GET', '/api/remote-branches');
      expect(res.status).toBe(200);
      const body = res.body as { fetched: boolean; cachedAt: number | null };
      expect(body.fetched).toBe(false);
      expect(body.cachedAt).toBeGreaterThan(0);

      const fetchCallsAfter = mock.commands.filter(c => c.includes('git fetch origin --prune')).length;
      expect(fetchCallsAfter).toBe(fetchCallsBefore);
    });

    it('?nofetch=true skips git fetch on first call', async () => {
      mock.addResponsePattern(/git for-each-ref/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      const res = await request(server, 'GET', '/api/remote-branches?nofetch=true');
      expect(res.status).toBe(200);
      const body = res.body as { fetched: boolean; cachedAt: number | null };
      expect(body.fetched).toBe(false);
      expect(body.cachedAt).toBeNull();
      expect(mock.commands.some(c => c.includes('git fetch origin --prune'))).toBe(false);
    });

    it('persists the remote default branch onto the project', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'repo-proj',
        slug: 'repo-proj',
        name: 'Repo Project',
        kind: 'git',
        repoPath: tmpDir,
        createdAt: now,
        updatedAt: now,
      });
      const SEP = '<SEP>';
      mock.addResponsePattern(/git symbolic-ref --short refs\/remotes\/origin\/HEAD/, () => ({
        stdout: 'origin/master\n',
        stderr: '',
        exitCode: 0,
      }));
      mock.addResponsePattern(/git for-each-ref/, () => ({
        stdout: [`master${SEP}2026-02-12${SEP}Dev${SEP}msg`, `main${SEP}2026-02-11${SEP}Dev${SEP}old`].join('\n'),
        stderr: '',
        exitCode: 0,
      }));

      const res = await request(server, 'GET', '/api/remote-branches?project=repo-proj&nofetch=true');

      expect(res.status).toBe(200);
      expect((res.body as any).defaultBranch).toBe('master');
      expect((res.body as any).branches.find((b: any) => b.name === 'master')?.isDefault).toBe(true);
      expect(stateService.getProject('repo-proj')?.gitDefaultBranch).toBe('master');
    });
  });

  // ── Branch CRUD ──

  describe('POST /api/branches', () => {
    it('should add a new branch', async () => {
      const res = await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      expect(res.status).toBe(201);
      expect((res.body as any).branch.id).toBe('feature-test');
    });

    it('persists new branch state before reporting creation success', async () => {
      const order: string[] = [];
      stateService.flush = async () => {
        order.push('flush');
      };

      const res = await request(server, 'POST', '/api/branches', { branch: 'feature/flush-create' });
      order.push('response');

      expect(res.status).toBe(201);
      expect((res.body as any).branch.id).toBe('feature-flush-create');
      expect(order).toEqual(['flush', 'response']);
    });

    it('should return 400 if branch name missing', async () => {
      const res = await request(server, 'POST', '/api/branches', {});
      expect(res.status).toBe(400);
    });

    it('rejects URL-like branch names before creating a worktree', async () => {
      const res = await request(server, 'POST', '/api/branches', {
        branch: 'https/github.com/inernoro/prd_agent/pull/611',
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toBe('invalid_branch_name');
    });

    it('should return 409 if branch already exists', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      expect(res.status).toBe(409);
    });

    it('returns 409 when a branch with the same git name exists under the legacy id after legacyFlag flipped', async () => {
      // Regression for the "two main branches" phantom duplicate bug:
      // simulate a project whose `legacyFlag` was flipped from true to
      // false while an existing entry was still stored under the bare
      // slug id. A subsequent POST must refuse to spawn a phantom
      // twin — not succeed with a different id.
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'flipped',
        slug: 'flipped',
        name: 'Flipped',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
        legacyFlag: false,
      });
      // Seed a pre-existing branch under the *legacy* id shape.
      stateService.addBranch({
        id: 'main',
        projectId: 'flipped',
        branch: 'main',
        worktreePath: '/tmp/wt/flipped/main',
        services: {},
        status: 'idle',
        createdAt: now,
      });
      const res = await request(server, 'POST', '/api/branches', {
        branch: 'main',
        projectId: 'flipped',
      });
      expect(res.status).toBe(409);
      // Error must reference the *existing* id, not the new-formula one.
      expect((res.body as any).error).toContain('"main"');
    });

    it('refuses to deploy a branch that was already stored with an invalid URL-like name', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'bad-url-branch',
        projectId: 'default',
        branch: 'https/github.com/inernoro/prd_agent/pull/611',
        worktreePath: '/tmp/wt/bad-url-branch',
        services: {},
        status: 'idle',
        createdAt: now,
      });

      const res = await request(server, 'POST', '/api/branches/bad-url-branch/deploy');

      expect(res.status).toBe(400);
      expect((res.body as any).error).toBe('invalid_branch_name');
    });

    // 极速版部署不再硬闸门(用户 2026-06-23 决策:没有镜像逐组件回退固定主分支,不硬失败)。
    // 镜像可用性由 container.ts runService 处理(本 commit 镜像拉不到→回退主分支镜像),
    // 单测见 tests/services/ci-prebuilt-express.test.ts 的 fallbackImage 用例。
  });

  describe('完整自定义域名 /api/branches/:id/custom-domains', () => {
    function seedProject(id: string, slug: string): void {
      const now = new Date().toISOString();
      stateService.addProject({
        id,
        slug,
        name: slug,
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });
    }

    function seedBranch(id: string, projectId: string, branchName: string): void {
      const now = new Date().toISOString();
      stateService.addBranch({
        id,
        projectId,
        branch: branchName,
        worktreePath: `/tmp/wt/${id}`,
        services: {},
        status: 'running',
        createdAt: now,
      });
    }

    it.each(['alias-primary', 'alias-named', 'alias-legacy', 'alias-member', 'domain-primary', 'domain-named', 'domain-legacy', 'domain-member'])('项目改名后拒绝占走保留的旧入口：%s', async (kind) => {
      seedProject('proj-a', 'local-a');
      seedProject('proj-b', 'old-owner');
      seedBranch('branch-a', 'proj-a', 'main');
      seedBranch('branch-b', 'proj-b', 'feature/demo');
      stateService.addBuildProfile({ id: 'gateway', projectId: 'proj-b', name: 'Gateway', dockerImage: 'nginx:alpine', workDir: '.', containerPort: 80, subdomain: 'llmgw' });
      stateService.updateProject('proj-b', { slug: 'current-owner' });
      stateService.getBranch('branch-b')!.replicaSets = { gateway: { profileId: 'gateway', enabled: true, primaryWeight: 100, members: [{ id: 'res-1', status: 'running', hostPort: 12001, weight: 100 }] } } as BranchEntry['replicaSets'];
      const canonical = computePreviewSlug('feature/demo', 'old-owner');
      const label = kind.endsWith('primary') ? canonical : kind.endsWith('member') ? `${canonical}-gateway-res-1` : namedServiceLabel(canonical, kind.endsWith('legacy') ? 'llmgw-web' : 'llmgw');
      const alias = kind.startsWith('alias');
      const endpoint = `/api/branches/branch-a/${alias ? 'subdomain-aliases' : 'custom-domains'}`;
      const response = await request(server, 'PUT', endpoint, alias ? { aliases: [label] } : { domains: [`${label}.example.test`] }, { 'X-Test-Key': 'A' });
      expect(response.status).toBe(409);
      expect(stateService.getBranchSubdomainAliases('branch-a')).toEqual([]);
      expect(stateService.getBranchCustomDomains('branch-a')).toEqual([]);
      const allowed = await request(server, 'PUT', endpoint, alias ? { aliases: ['unoccupied'] } : { domains: ['unoccupied.example.test'] }, { 'X-Test-Key': 'A' });
      expect(allowed.status).toBe(200);
    });

    it('rejects project-scoped keys reading or writing another project custom domain config', async () => {
      seedProject('proj-a', 'a');
      seedProject('proj-b', 'b');
      seedBranch('branch-a', 'proj-a', 'main');
      seedBranch('branch-b', 'proj-b', 'main');

      const get = await request(server, 'GET', '/api/branches/branch-b/custom-domains', undefined, { 'X-Test-Key': 'A' });
      expect(get.status).toBe(403);
      expect((get.body as any).error).toBe('project_mismatch');

      const put = await request(server, 'PUT', '/api/branches/branch-b/custom-domains', {
        domains: ['www.example.test'],
      }, { 'X-Test-Key': 'A' });
      expect(put.status).toBe(403);
      expect((put.body as any).error).toBe('project_mismatch');
      expect(stateService.getBranchCustomDomains('branch-b')).toEqual([]);
    });

    it('rejects custom domains that collide with generated preview hosts and aliases', async () => {
      seedProject('proj-a', 'a');
      seedProject('proj-b', 'b');
      seedBranch('branch-a', 'proj-a', 'main');
      seedBranch('branch-b', 'proj-b', 'feature/demo');
      stateService.addBuildProfile({
        id: 'docs',
        projectId: 'proj-b',
        name: 'Docs',
        dockerImage: 'nginx:alpine',
        workDir: '.',
        containerPort: 80,
        subdomain: 'docs',
      });
      stateService.getBranch('branch-b')!.services.docs = {
        profileId: 'docs',
        containerName: 'docs-container',
        hostPort: 18080,
        status: 'running',
      };
      stateService.setBranchSubdomainAliases('branch-b', ['stable']);

      const res = await request(server, 'PUT', '/api/branches/branch-a/custom-domains', {
        domains: ['demo-feature-b.example.test', 'stable.example.test', 'demo-feature-b-docs.example.test'],
      }, { 'X-Test-Key': 'A' });

      expect(res.status).toBe(409);
      const reasons = ((res.body as any).collisions as Array<{ reason: string }>).map((collision) => collision.reason);
      expect(reasons).toContain('preview');
      expect(reasons).toContain('alias');
      expect(reasons).toContain('service-subdomain');
      expect(stateService.getBranchCustomDomains('branch-a')).toEqual([]);
    });

    it('rejects subdomain aliases that shadow another branch custom domain', async () => {
      seedProject('proj-a', 'a');
      seedProject('proj-b', 'b');
      seedBranch('branch-a', 'proj-a', 'main');
      seedBranch('branch-b', 'proj-b', 'main');
      stateService.setBranchCustomDomains('branch-b', ['app.example.test']);

      const res = await request(server, 'PUT', '/api/branches/branch-a/subdomain-aliases', {
        aliases: ['app'],
      }, { 'X-Test-Key': 'A' });

      expect(res.status).toBe(409);
      expect((res.body as any).collisions).toContainEqual({
        alias: 'app',
        domain: 'app.example.test',
        conflictWith: 'branch-b',
        reason: 'custom-domain',
      });
      expect(stateService.getBranchSubdomainAliases('branch-a')).toEqual([]);
    });
  });

  /*
   * 手动多出口配置（2026-08-31）：用户不必让 Agent 改 compose 就能加/改入口。
   * 这组用例钉的是「配置真的落到了发布口径上」——GET 扫描出的端口/来源、PUT 写的
   * 项目档与分支档、以及非法值与撞名被拦。判据都断行为（state 与 /subdomain-aliases
   * 的入口清单），不断源码字面量。
   */
  /*
   * Agent 极速版门禁（2026-09-08）。判定在 agent-prebuilt-gate.ts；这里只证明四个入口都接上了线，
   * 并且开关缺省关闭时老项目零变化（predicate-and-wiring-discipline 形状 2：删掉接线必须变红）。
   * 测试中间件把 X-Test-Key 盖成 cdsProjectKey，等价于机器凭据；不带 key 就是真人 cookie 路径。
   */
  describe('Agent 极速版门禁 agentPrebuiltOnly', () => {
    function seedGateProject(agentPrebuiltOnly: boolean): void {
      const now = new Date().toISOString();
      stateService.addProject({ id: 'proj-a', slug: 'a', name: 'A', kind: 'git', createdAt: now, updatedAt: now, agentPrebuiltOnly });
      stateService.addBuildProfile({
        id: 'api', projectId: 'proj-a', name: 'API', dockerImage: 'node:20', command: 'pnpm build && node server.js', workDir: '.', containerPort: 5000,
        activeDeployMode: 'static',
        deployModes: {
          dev: { label: '开发模式', command: 'pnpm dev' },
          static: { label: '静态部署', command: 'pnpm build && node server.js' },
          express: { label: '极速版', prebuilt: true, dockerImage: 'ghcr.io/x/api:sha-${CDS_COMMIT_SHA}' },
        },
      });
      stateService.addBranch({
        id: 'b1', projectId: 'proj-a', branch: 'feat/x', worktreePath: '/tmp/wt/b1', services: {},
        status: 'idle', createdAt: now,
      });
    }

    it('机器凭据排队重放仍保留极速版限制，不因内部派发失去身份而允许源码回退', async () => {
      seedGateProject(true); stateService.setBranchProfileOverride('b1', 'api', { activeDeployMode: 'express' });
      readyArtifactFixture();
      let release!: () => void, started!: () => void, replayed!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; }); const start = new Promise<void>((resolve) => { started = resolve; });
      const done = new Promise<void>((resolve) => { replayed = resolve; });
      const executed: any[] = [];
      const run = vi.spyOn(containerService, 'runService').mockImplementation(async (_entry, profile, service) => {
        executed.push(profile); if (executed.length === 1) { started(); await hold; }
        service.status = 'running'; service.deployedMode = 'express';
      });
      let replayStatus = 0;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input)); const response = await request(server, 'POST', url.pathname, JSON.parse(String(init?.body)), init?.headers as Record<string, string>);
        replayStatus = response.status; if (JSON.parse(String(init?.body)).commitSha === 'b'.repeat(40)) replayed(); return new Response(String(response.body), { status: response.status });
      });
      const first = request(server, 'POST', '/api/branches/b1/deploy', { commitSha: 'a'.repeat(40) }, { 'X-Test-Key': 'A' });
      try {
        await start;
        const queued = await request(server, 'POST', '/api/branches/b1/deploy', { commitSha: 'b'.repeat(40) }, { 'X-Test-Key': 'A' });
        expect(deploymentRunService.get(String(queued.headers['x-cds-deployment-run-id']))?.status).toBe('queued');
        release(); await first; await done;
        expect(replayStatus).toBe(200); expect(executed).toHaveLength(2);
        expect(executed.every((profile) => profile.prebuiltImage === true && profile.sourceFallbackProfile === undefined)).toBe(true);
      } finally { release(); await first; run.mockRestore(); vi.unstubAllGlobals(); }
    });

    it('机器凭据部署源码模式分支被 409 拒绝，响应说清被拦服务与可切模式', async () => {
      seedGateProject(true);
      const res = await request(server, 'POST', '/api/branches/b1/deploy', {}, { 'X-Test-Key': 'A' });
      expect(res.status).toBe(409);
      const body = res.body as any;
      expect(body.error).toBe('agent_prebuilt_only');
      expect(body.message).toContain('API（当前 静态部署，可切 express）');
      expect(body.message).toContain('cdscli branch set-mode b1');
      expect(body.violations).toMatchObject([{ profileId: 'api', modeId: 'static', prebuiltModes: ['express'] }]);
    });

    it('内部系统派发不带机器凭据（X-CDS-Internal 走 loopback 旁路），不受门禁；机器凭据自己加 X-CDS-Trigger 换不来豁免', async () => {
      seedGateProject(true);
      const internal = await request(server, 'POST', '/api/branches/b1/deploy', {}, { 'X-CDS-Internal': '1', 'X-CDS-Trigger': 'webhook' });
      expect(internal.status).not.toBe(409);
      const spoofed = await request(server, 'POST', '/api/branches/b1/deploy', {}, { 'X-Test-Key': 'A', 'X-CDS-Trigger': 'webhook' });
      expect(spoofed.status).toBe(409);
    });

    it('没存 projectId 的老分支归 default 项目，default 开了门禁同样拦（Codex 第二轮 P1）', async () => {
      const now = new Date().toISOString();
      const def = stateService.getProject('default');
      if (def) def.agentPrebuiltOnly = true;
      else stateService.addProject({ id: 'default', slug: 'default', name: 'default', kind: 'git', createdAt: now, updatedAt: now, agentPrebuiltOnly: true });
      stateService.addBuildProfile({
        id: 'legacy-api', projectId: 'default', name: 'Legacy API', dockerImage: 'node:20', command: 'pnpm build', workDir: '.', containerPort: 5000,
        deployModes: { static: { label: '静态' }, express: { label: '极速版', prebuilt: true, dockerImage: 'ghcr.io/x/api:sha-${CDS_COMMIT_SHA}' } },
      });
      stateService.addBranch({ id: 'legacy-b', branch: 'legacy', worktreePath: '/tmp/wt/legacy-b', services: {}, status: 'idle', createdAt: now } as any);
      const res = await request(server, 'POST', '/api/branches/legacy-b/deploy', {}, { 'x-ai-access-key': 'agent-key' });
      expect(res.status).toBe(409);
      expect((res.body as any).error).toBe('agent_prebuilt_only');
    });

    it('带 versionId 重放合规历史版本时按版本物化后的清单判，分支基线已切回源码模式也不误拦（Codex 第七轮 P2）', async () => {
      seedGateProject(true);
      const branch = stateService.getBranch('b1')!;
      const profile = stateService.getBuildProfile('api')!;
      // 历史版本是当年极速版跑出来的不可变镜像；此刻分支基线仍是 static（源码模式）。
      readyArtifactFixture();
      branch.services.api = { profileId: 'api', containerName: 'old-version-api', hostPort: 10011, status: 'running',
        deployedImage: 'ghcr.io/x/api:sha-abcdef1234567890abcdef1234567890abcdef12', deployedMode: 'express' };
      const version = deploymentVersionService.create({
        projectId: 'proj-a',
        branchId: 'b1',
        commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
        configHash: 'cfg',
        profiles: [{ ...profile, command: '', prebuiltImage: true, dockerImage: 'ghcr.io/x/api:sha-abcdef1234567890abcdef1234567890abcdef12' }],
        branch,
        createdByRunId: 'run-0',
      });
      expect(version.profiles[0]).toMatchObject({ reusable: true, artifactKind: 'prebuilt-image' });
      const plain = await request(server, 'POST', '/api/branches/b1/deploy', {}, { 'X-Test-Key': 'A' });
      expect(plain.status).toBe(409);
      const replay = await request(server, 'POST', '/api/branches/b1/deploy', { versionId: version.id }, { 'X-Test-Key': 'A' });
      expect(replay.status).toBe(200);
      await waitForAcceptedRun(replay);
      expect((replay.body as any)?.error).not.toBe('agent_prebuilt_only');
      // 分支此刻选了显式 prebuilt: false 的模式：版本重放执行时不套分支覆盖，判定也不能套（Codex 第八轮 P2）
      profile.deployModes!.legacy = { label: '源码', prebuilt: false, command: 'pnpm dev' };
      stateService.getBranch('b1')!.profileOverrides = { api: { activeDeployMode: 'legacy' } } as any;
      const overridden = await request(server, 'POST', '/api/branches/b1/deploy', {}, { 'X-Test-Key': 'A' });
      expect(overridden.status).toBe(409);
      const replayOverridden = await request(server, 'POST', '/api/branches/b1/deploy', { versionId: version.id }, { 'X-Test-Key': 'A' });
      expect(replayOverridden.status).not.toBe(409);
      expect((replayOverridden.body as any)?.error).not.toBe('agent_prebuilt_only');
    });

    it('同一 commit 自动复用可复用版本时按物化清单判：managed 配置有产物版本就放行，没有就 409（Codex 第八轮 P2）', async () => {
      seedGateProject(true);
      const commitSha = 'abcdef1234567890abcdef1234567890abcdef12';
      const profile = stateService.getBuildProfile('api')!;
      profile.dockerImage = 'cds-managed/api:sha-abcdef1234567890abcdef1234567890abcdef12';
      profile.managedBuild = { stack: 'node', installCommand: 'pnpm i', buildCommand: 'pnpm build', startCommand: 'node server.js', artifactImage: 'cds-managed/api' };
      // 真人先部署一次，拿到路由为当前配置算出的 configHash（版本能否自动复用就看它）
      const human = await request(server, 'POST', '/api/branches/b1/deploy', { commitSha });
      const runId = String(human.headers['x-cds-deployment-run-id'] || '');
      expect(runId).toMatch(/^run_|^dr_|./);
      const configHash = deploymentRunService.get(runId)?.configHash;
      expect(configHash).toBeTruthy();
      const branch = stateService.getBranch('b1')!;
      const version = deploymentVersionService.create({
        projectId: 'proj-a',
        branchId: 'b1',
        commitSha,
        configHash: configHash!,
        profiles: [stateService.getBuildProfile('api')!],
        branch: { ...branch, services: {} },
        createdByRunId: runId,
      });
      expect(version.profiles[0]).toMatchObject({ reusable: true, artifactKind: 'managed-image' });
      const noSha = await request(server, 'POST', '/api/branches/b1/deploy', {}, { 'X-Test-Key': 'A' });
      expect(noSha.status).toBe(409);
      expect((noSha.body as any).error).toBe('agent_prebuilt_only');
      const otherSha = await request(server, 'POST', '/api/branches/b1/deploy', { commitSha: '1111111111111111111111111111111111111111' }, { 'X-Test-Key': 'A' });
      expect(otherSha.status).toBe(409);
      const reuse = await request(server, 'POST', '/api/branches/b1/deploy', { commitSha }, { 'X-Test-Key': 'A' });
      expect(reuse.status).not.toBe(409);
      expect((reuse.body as any)?.error).not.toBe('agent_prebuilt_only');
    });

    it('新建构建配置带 managedBuild 在门禁下拒绝机器凭据；不带的照常创建，真人不受限（Codex 第九轮 P1）', async () => {
      seedGateProject(true);
      const managed = {
        id: 'worker', projectId: 'proj-a', name: 'Worker', dockerImage: 'node:20', containerPort: 6000,
        managedBuild: { stack: 'node', installCommand: 'pnpm i', buildCommand: 'pnpm build', startCommand: 'node worker.js', artifactImage: 'cds-managed/worker' },
      };
      const machine = await request(server, 'POST', '/api/build-profiles', managed, { 'X-Test-Key': 'A' });
      expect(machine.status).toBe(409);
      expect((machine.body as any).error).toBe('agent_prebuilt_only');
      expect((machine.body as any).message).toContain('managedBuild');
      expect(stateService.getBuildProfile('worker')).toBeUndefined();
      const plain = await request(server, 'POST', '/api/build-profiles', {
        id: 'worker-img', projectId: 'proj-a', name: 'Worker Image', dockerImage: 'ghcr.io/x/worker:sha-${CDS_COMMIT_SHA}', containerPort: 6000, prebuiltImage: true,
      }, { 'X-Test-Key': 'A' });
      expect(plain.status).toBe(201);
      const human = await request(server, 'POST', '/api/build-profiles', managed);
      expect(human.status).toBe(201);
      expect(stateService.getBuildProfile('worker')!.managedBuild).toBeDefined();
    });

    it('带空白的模式名按将要落盘的原值判：分支覆盖与通用 PUT 写 " express " 都 409，精确值放行（Codex 第十轮 P1）', async () => {
      seedGateProject(true);
      const padded = await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', { activeDeployMode: ' express ' }, { 'X-Test-Key': 'A' });
      expect(padded.status).toBe(409);
      expect((padded.body as any).error).toBe('agent_prebuilt_only');
      expect(stateService.getBranch('b1')!.profileOverrides?.api).toBeUndefined();
      const exact = await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', { activeDeployMode: 'express' }, { 'X-Test-Key': 'A' });
      expect(exact.status).toBe(200);
      expect(stateService.getBranch('b1')!.profileOverrides?.api?.activeDeployMode).toBe('express');
      const paddedProfile = await request(server, 'PUT', '/api/build-profiles/api', { activeDeployMode: ' express ' }, { 'X-Test-Key': 'A' });
      expect(paddedProfile.status).toBe(409);
      expect(stateService.getBuildProfile('api')!.activeDeployMode).toBe('static');
    });

    it('bulk-set-modes 批量改写模式定义在门禁下拒绝机器凭据，真人照常（Codex 第二轮 P1）', async () => {
      seedGateProject(true);
      const body = { profileIds: ['api'], strategy: 'replace', modes: { dev: { label: '开发', command: 'pnpm dev' } } };
      const machine = await request(server, 'POST', '/api/build-profiles/bulk-set-modes', body, { 'X-Test-Key': 'A' });
      expect(machine.status).toBe(409);
      expect((machine.body as any).error).toBe('agent_prebuilt_only');
      expect(stateService.getBuildProfile('api')!.deployModes!.express.prebuilt).toBe(true);
      const human = await request(server, 'POST', '/api/build-profiles/bulk-set-modes', body);
      expect(human.status).toBe(200);
      expect(stateService.getBuildProfile('api')!.deployModes!.express).toBeUndefined();
      // 只命中未门禁项目的批量请求不被无关的门禁项目拦下（Codex 第五轮 P2）
      const now2 = new Date().toISOString();
      stateService.addProject({ id: 'proj-free', slug: 'free', name: 'Free', kind: 'git', createdAt: now2, updatedAt: now2 });
      stateService.addBuildProfile({ id: 'py', projectId: 'proj-free', name: 'Py', dockerImage: 'python:3.12', command: 'python app.py', workDir: '.', containerPort: 8000 });
      const filtered = await request(server, 'POST', '/api/build-profiles/bulk-set-modes', { filter: 'python', strategy: 'merge', modes: { dev: { label: '开发', command: 'python app.py' } } }, { 'X-Test-Key': 'A' });
      expect(filtered.status).toBe(200);
      expect(stateService.getBuildProfile('py')!.deployModes!.dev).toBeDefined();
    });

    it('开关关闭（缺省）时机器凭据部署源码模式分支不被门禁拦', async () => {
      seedGateProject(false);
      const res = await request(server, 'POST', '/api/branches/b1/deploy', {}, { 'X-Test-Key': 'A' });
      expect(res.status).not.toBe(409);
    });

    it('机器凭据 set-mode：写 express 放行，写 dev 拒绝，清空回源码基线也拒绝', async () => {
      seedGateProject(true);
      const ok = await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', { activeDeployMode: 'express' }, { 'X-Test-Key': 'A' });
      expect(ok.status).toBe(200);
      expect(stateService.getBranchProfileOverride('b1', 'api')?.activeDeployMode).toBe('express');

      const dev = await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', { activeDeployMode: 'dev' }, { 'X-Test-Key': 'A' });
      expect(dev.status).toBe(409);
      expect((dev.body as any).error).toBe('agent_prebuilt_only');
      expect((dev.body as any).message).toContain('分支部署模式覆盖被拒绝');
      expect(stateService.getBranchProfileOverride('b1', 'api')?.activeDeployMode).toBe('express');

      const reset = await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', { activeDeployMode: '' }, { 'X-Test-Key': 'A' });
      expect(reset.status).toBe(409);
      const removed = await request(server, 'DELETE', '/api/branches/b1/profile-overrides/api', undefined, { 'X-Test-Key': 'A' });
      expect(removed.status).toBe(409);
      expect(stateService.getBranchProfileOverride('b1', 'api')?.activeDeployMode).toBe('express');

      // 只改别的覆盖字段（不带 activeDeployMode）：PUT 是整体替换，会把 express 覆盖抹掉、落回 static 基线，拒绝（Codex 第五轮 P1）
      const port = await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', { containerPort: 8080 }, { 'X-Test-Key': 'A' });
      expect(port.status).toBe(409);
      expect(stateService.getBranchProfileOverride('b1', 'api')?.activeDeployMode).toBe('express');
      // 基线本身是 express 时，不带模式的部分写入落回基线仍是极速版，放行
      stateService.updateBuildProfile('api', { activeDeployMode: 'express' });
      const portOk = await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', { containerPort: 8080 }, { 'X-Test-Key': 'A' });
      expect(portOk.status).toBe(200);
    });

    /*
     * 2026-10-08 用户指出：分支卡左上角亮闪电 = 这条分支是极速版。deployRuntime.prebuilt 只表示
     * 「任一服务」走预构建，9 个服务 1 个极速时也是 true，于是混合分支被画成了极速版。
     * prebuiltCoverage 才是展示判据：全部服务都预构建才是 all。
     */
    it('极速版覆盖程度：一部分服务极速是 partial，全部极速才是 all', async () => {
      seedGateProject(false);
      stateService.addBuildProfile({
        id: 'web', projectId: 'proj-a', name: 'Web', dockerImage: 'node:20', command: 'pnpm dev', workDir: '.', containerPort: 3000,
        deployModes: {
          dev: { label: '开发模式', command: 'pnpm dev' },
          express: { label: '极速版', prebuilt: true, dockerImage: 'ghcr.io/x/web:sha-${CDS_COMMIT_SHA}' },
        },
      });
      stateService.setBranchProfileOverride('b1', 'api', { activeDeployMode: 'express' });
      // 列表接口有 1s 载荷缓存，连读三次要走 live=true 才拿得到每一步的新值
      mock.addResponsePattern(/docker ps --format/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      const runtimeOf = async () => {
        const res = await request(server, 'GET', '/api/branches?project=proj-a&live=true');
        return (res.body as any).branches.find((b: any) => b.id === 'b1').deployRuntime;
      };
      const partial = await runtimeOf();
      expect(partial.prebuilt).toBe(true);
      expect(partial.prebuiltCoverage).toBe('partial');
      expect(partial.prebuiltProfileIds).toEqual(['api']);

      stateService.setBranchProfileOverride('b1', 'web', { activeDeployMode: 'express' });
      const all = await runtimeOf();
      expect(all.prebuiltCoverage).toBe('all');

      stateService.setBranchProfileOverride('b1', 'api', { activeDeployMode: 'dev' });
      stateService.setBranchProfileOverride('b1', 'web', { activeDeployMode: 'dev' });
      const none = await runtimeOf();
      expect(none.prebuilt).toBe(false);
      expect(none.prebuiltCoverage).toBe('none');
    });

    it('极速版分支：机器凭据部署通过门禁（不再是 409）', async () => {
      seedGateProject(true);
      stateService.setBranchProfileOverride('b1', 'api', { activeDeployMode: 'express' });
      const res = await request(server, 'POST', '/api/branches/b1/deploy', {}, { 'X-Test-Key': 'A' });
      expect(res.status).not.toBe(409);
    });

    it('切回源码模式清除旧 CI 目标，保留极速版时不清除', async () => {
      seedGateProject(true);
      const old = 'a'.repeat(40), next = 'b'.repeat(40);
      stateService.setBranchProfileOverride('b1', 'api', { activeDeployMode: 'express' });
      stateService.updateBranchGithubMeta('b1', { githubCommitSha: next, ciTargetSha: old, ciImageStatus: 'failed', ciImageError: 'old failure' });
      await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', { activeDeployMode: 'express' });
      expect(stateService.getBranch('b1')?.ciTargetSha).toBe(old);
      const source = await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', { activeDeployMode: 'dev' });
      expect(source.status).toBe(200);
      const detail = await request(server, 'GET', '/api/branches/b1');
      expect(detail.body.branch.targetCommitSha).toBe(next);
      expect(detail.body.branch.ciImageStatus).toBeUndefined();
      expect(detail.body.branch.ciImageError).toBeUndefined();
      stateService.setBranchProfileOverride('b1', 'api', { activeDeployMode: 'express' });
      stateService.updateBranchGithubMeta('b1', { ciTargetSha: old, ciImageStatus: 'failed' });
      expect((await request(server, 'DELETE', '/api/branches/b1/profile-overrides/api')).status).toBe(200);
      expect(stateService.getBranch('b1')?.ciTargetSha).toBeUndefined();
    });

    it('真人（无机器凭据）仍可把分支切成 dev，门禁只管 Agent', async () => {
      seedGateProject(true);
      const res = await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', { activeDeployMode: 'dev' });
      expect(res.status).toBe(200);
      expect(stateService.getBranchProfileOverride('b1', 'api')?.activeDeployMode).toBe('dev');
    });

    it('单服务部署端点走同一道闸：source 模式 409，express 放行（Codex P1）', async () => {
      seedGateProject(true);
      const bad = await request(server, 'POST', '/api/branches/b1/deploy/api', {}, { 'X-Test-Key': 'A' });
      expect(bad.status).toBe(409);
      expect((bad.body as any).error).toBe('agent_prebuilt_only');
      stateService.setBranchProfileOverride('b1', 'api', { activeDeployMode: 'express' });
      const ok = await request(server, 'POST', '/api/branches/b1/deploy/api', {}, { 'X-Test-Key': 'A' });
      expect(ok.status).not.toBe(409);
    });

    it('通用 PUT /build-profiles/:id 同样受闸：写 activeDeployMode=dev 409、动 deployModes / prebuiltImage 409、改名放行（Codex P1）', async () => {
      seedGateProject(true);
      const dev = await request(server, 'PUT', '/api/build-profiles/api', { activeDeployMode: 'dev' }, { 'X-Test-Key': 'A' });
      expect(dev.status).toBe(409);
      expect((dev.body as any).error).toBe('agent_prebuilt_only');
      const redefine = await request(server, 'PUT', '/api/build-profiles/api', {
        deployModes: { dev: { label: '假极速', prebuilt: true } },
      }, { 'X-Test-Key': 'A' });
      expect(redefine.status).toBe(409);
      expect((redefine.body as any).message).toContain('deployModes');
      const flag = await request(server, 'PUT', '/api/build-profiles/api', { prebuiltImage: true }, { 'X-Test-Key': 'A' });
      expect(flag.status).toBe(409);
      // managedBuild 让宿主先跑 install / build 再起容器：机器凭据不得给极速版配置加上它（Codex 第八轮 P1）
      const managed = await request(server, 'PUT', '/api/build-profiles/api', {
        managedBuild: { stack: 'node', installCommand: 'pnpm i', buildCommand: 'pnpm build', startCommand: 'node server.js', artifactImage: 'cds-managed/api' },
      }, { 'X-Test-Key': 'A' });
      expect(managed.status).toBe(409);
      expect((managed.body as any).message).toContain('managedBuild');
      expect(stateService.getBuildProfile('api')!.managedBuild).toBeUndefined();
      expect(stateService.getBuildProfile('api')!.activeDeployMode).toBe('static');
      expect(stateService.getBuildProfile('api')!.deployModes!.dev.prebuilt).toBeUndefined();

      const rename = await request(server, 'PUT', '/api/build-profiles/api', { name: 'API 服务' }, { 'X-Test-Key': 'A' });
      expect(rename.status).toBe(200);
      const express = await request(server, 'PUT', '/api/build-profiles/api', { activeDeployMode: 'express' }, { 'X-Test-Key': 'A' });
      expect(express.status).toBe(200);
      expect(stateService.getBuildProfile('api')!.activeDeployMode).toBe('express');
      // 真人改回 dev、改模式定义都不受限
      const human = await request(server, 'PUT', '/api/build-profiles/api', { activeDeployMode: 'dev', deployModes: { dev: { label: '开发' } } });
      expect(human.status).toBe(200);
    });

    it('预构建缺产物时内部与机器请求都保存等待，不能静默回退宿主源码构建', async () => {
      seedGateProject(true); stateService.setBranchProfileOverride('b1', 'api', { activeDeployMode: 'express' });
      const target = 'a'.repeat(40); stateService.getBranch('b1')!.githubCommitSha = target;
      readyArtifactFixture();
      mock.addResponsePatternFirst(/docker pull/, () => ({ stdout: '', stderr: 'manifest unknown', exitCode: 1 }));
      const sourceRuns = () => mock.commands.filter(command => command.includes('docker run') && command.includes('pnpm build')).length;
      const exempt = await request(server, 'POST', '/api/branches/b1/deploy', { commitSha: target }, { 'X-CDS-Internal': '1', 'X-CDS-Trigger': 'webhook' });
      await requestArtifactWaitRefresh(branchOperationCoordinator);
      expect(exempt.status).toBe(200); expect(String(exempt.body)).toContain('等待全部必需产物');
      expect(deploymentRunService.get(String(exempt.headers['x-cds-deployment-run-id']))?.status).toBe('queued');
      const gated = await request(server, 'POST', '/api/branches/b1/deploy', { commitSha: target }, { 'X-Test-Key': 'A' });
      await requestArtifactWaitRefresh(branchOperationCoordinator);
      expect(gated.status).toBe(200); expect(sourceRuns()).toBe(0);
      expect(deploymentRunService.get(String(gated.headers['x-cds-deployment-run-id']))?.status).toBe('queued');
      expect(stateService.getBranch('b1')?.status).toBe('idle');
    });

    it('机器 set-mode 传显式空串：即便 profile 基线是 express，空串覆盖等于源码基线，409（Codex 第四轮 P1）', async () => {
      seedGateProject(true);
      stateService.updateBuildProfile('api', { activeDeployMode: 'express' });
      const res = await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', { activeDeployMode: '' }, { 'X-Test-Key': 'A' });
      expect(res.status).toBe(409);
      expect((res.body as any).violations).toMatchObject([{ profileId: 'api', modeId: '' }]);
      expect(stateService.getBranchProfileOverride('b1', 'api')).toBeUndefined();
    });

    it('远端执行器实际产物确认后，真人与机器派发都使用固定digest且不带源码回退', async () => {
      seedGateProject(true);
      stateService.setBranchProfileOverride('b1', 'api', { activeDeployMode: 'express' });
      const b1 = stateService.getBranch('b1')!;
      b1.githubCommitSha = 'a'.repeat(40);
      b1.executorId = 'exec-gate';
      stateService.save();
      const now = new Date().toISOString();
      registryNodes.push({
        id: 'exec-gate', host: '127.0.0.1', port: 9109, status: 'online', role: 'remote', labels: [],
        branches: ['b1'], capacity: { maxBranches: 10, memoryMB: 1024, cpuCores: 2 },
        load: { memoryUsedMB: 0, cpuPercent: 0 }, registeredAt: now, lastHeartbeat: now,
      });
      const fetchCalls: Array<{ url: string; body: any }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        fetchCalls.push({ url: String(input), body });
        if (String(input).includes('/exec/artifact-preflight')) return new Response(JSON.stringify({ state: 'ready', targetCommitSha: body.commitSha,
          checkedAt: new Date().toISOString(), artifacts: body.profiles.map((profile: any) => ({ profileIds: [profile.id], requestedImage: profile.dockerImage,
            image: `ghcr.io/x/api@sha256:${'c'.repeat(64)}`, revision: body.commitSha, platform: 'linux/amd64' })) }), { status: 200 });
        if (String(input).includes('/api/branches/')) {
          const response = await request(server, 'POST', new URL(String(input)).pathname, body, init?.headers as Record<string, string>);
          return new Response(String(response.body), { status: response.status });
        }
        return new Response('event: done\ndata: {}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }) as typeof fetch;
      try {
        const human = await request(server, 'POST', '/api/branches/b1/deploy', {});
        expect(human.status).toBe(200); await waitForAcceptedRun(human);
        const humanDeploy = fetchCalls.find((c) => c.url.includes('/exec/deploy'));
        expect(humanDeploy?.body?.profiles?.find((p: any) => p.id === 'api')?.dockerImage).toBe(`ghcr.io/x/api:sha-${'a'.repeat(40)}@sha256:${'c'.repeat(64)}`);
        expect(humanDeploy?.body?.profiles?.find((p: any) => p.id === 'api')?.sourceFallbackProfile).toBeUndefined();

        fetchCalls.length = 0;
        const gated = await request(server, 'POST', '/api/branches/b1/deploy', {}, { 'X-Test-Key': 'A' });
        expect(gated.status).toBe(200); await waitForAcceptedRun(gated);
        const gatedDeploy = fetchCalls.find((c) => c.url.includes('/exec/deploy'));
        expect(gatedDeploy).toBeDefined();
        const api = gatedDeploy!.body.profiles.find((p: any) => p.id === 'api');
        expect(api.prebuiltImage).toBe(true);
        expect(api.sourceFallbackProfile).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('机器凭据改项目默认部署模式：express 放行，static 与清空拒绝', async () => {
      seedGateProject(true);
      const ok = await request(server, 'PUT', '/api/build-profiles/api/deploy-mode', { mode: 'express' }, { 'X-Test-Key': 'A' });
      expect(ok.status).toBe(200);
      expect(stateService.getBuildProfile('api')!.activeDeployMode).toBe('express');

      const bad = await request(server, 'PUT', '/api/build-profiles/api/deploy-mode', { mode: 'static' }, { 'X-Test-Key': 'A' });
      expect(bad.status).toBe(409);
      expect((bad.body as any).message).toContain('项目默认部署模式修改被拒绝');
      const reset = await request(server, 'PUT', '/api/build-profiles/api/deploy-mode', { mode: '' }, { 'X-Test-Key': 'A' });
      expect(reset.status).toBe(409);
      expect(stateService.getBuildProfile('api')!.activeDeployMode).toBe('express');

      // 真人改回 static 不受限
      const human = await request(server, 'PUT', '/api/build-profiles/api/deploy-mode', { mode: 'static' });
      expect(human.status).toBe(200);
    });
  });

  describe('手动入口配置 /api/branches/:id/web-entry-config', () => {
    function seedProject(id: string, slug: string): void {
      const now = new Date().toISOString();
      stateService.addProject({ id, slug, name: slug, kind: 'git', createdAt: now, updatedAt: now });
    }

    function seedRunningBranch(id: string, projectId: string, branchName: string, profileIds: string[]): void {
      stateService.addBranch({
        id, projectId, branch: branchName,
        worktreePath: `/tmp/wt/${id}`,
        services: Object.fromEntries(profileIds.map((profileId, i) => [profileId, {
          profileId, containerName: `${profileId}-container`, hostPort: 18100 + i, status: 'running',
        }])),
        status: 'running',
        createdAt: new Date().toISOString(),
      });
    }

    function seedProfiles(projectId: string): void {
      stateService.addBuildProfile({
        id: 'web', projectId, name: 'Web', dockerImage: 'nginx:alpine', workDir: '.',
        containerPort: 80, pathPrefixes: ['/'],
        webEntry: { name: '主应用', path: '/' },
      });
      stateService.addBuildProfile({
        id: 'gateway', projectId, name: 'Gateway', dockerImage: 'node:20', workDir: '.',
        containerPort: 8091,
      });
    }

    async function webEntryNames(branchId: string): Promise<string[]> {
      const res = await request(server, 'GET', `/api/branches/${branchId}/subdomain-aliases`);
      return ((res.body as any).webEntries as Array<{ name: string }>).map((e) => e.name);
    }

    it('GET 扫描出每个服务的端口、运行状态与当前入口来源', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway']);

      const res = await request(server, 'GET', '/api/branches/branch-a/web-entry-config', undefined, { 'X-Test-Key': 'A' });
      expect(res.status).toBe(200);
      const body = res.body as { previewSlug: string; rootDomain: string; services: any[] };
      expect(body.rootDomain).toBe('example.test');
      expect(body.previewSlug).toBeTruthy();
      const gateway = body.services.find((s) => s.serviceId === 'gateway');
      expect(gateway.containerPort).toBe(8091);
      expect(gateway.hostPort).toBe(18101);
      expect(gateway.status).toBe('running');
      expect(gateway.origin).toBe('project');
      expect(gateway.effective).toEqual({ subdomain: '', name: '', path: '/', primary: false });
      const web = body.services.find((s) => s.serviceId === 'web');
      expect(web.handlesRoot).toBe(true);
      expect(web.url).toBe(`https://${body.previewSlug}.example.test`);
    });

    it('PUT scope=project 写进项目构建配置，命名入口立刻出现在入口清单里', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway']);
      expect(await webEntryNames('branch-a')).toEqual([]);

      const res = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'project',
        entries: [
          { serviceId: 'web', name: '主应用', path: '/' },
          { serviceId: 'gateway', name: 'LLM Gateway', subdomain: 'llmgw', path: '/console' },
        ],
      }, { 'X-Test-Key': 'A' });

      expect(res.status).toBe(200);
      const slug = (res.body as any).previewSlug as string;
      expect(stateService.getBuildProfile('gateway')!.subdomain).toBe('llmgw');
      expect(stateService.getBuildProfile('gateway')!.webEntry).toEqual({ name: 'LLM Gateway', path: '/console' });
      // 项目档不该在分支上留影子覆盖
      expect(stateService.getBranchProfileOverride('branch-a', 'gateway')).toBeUndefined();
      const aliases = await request(server, 'GET', '/api/branches/branch-a/subdomain-aliases');
      expect((aliases.body as any).webEntries).toEqual([
        { subdomain: 'llmgw', serviceId: 'gateway', name: 'LLM Gateway', url: `https://${slug}-llmgw.example.test/console`, primary: false },
      ]);
    });

    it('PUT scope=branch 只写分支覆盖，项目构建配置保持不动', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway']);

      const res = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'branch',
        entries: [{ serviceId: 'gateway', name: '本分支网关', subdomain: 'gw', path: '/' }],
      }, { 'X-Test-Key': 'A' });

      expect(res.status).toBe(200);
      expect(stateService.getBuildProfile('gateway')!.subdomain).toBeUndefined();
      const override = stateService.getBranchProfileOverride('branch-a', 'gateway')!;
      expect(override.subdomain).toBe('gw');
      expect(override.webEntry).toEqual({ name: '本分支网关', path: '/' });
      expect(await webEntryNames('branch-a')).toEqual(['本分支网关']);
    });

    it('分支档可以用空名隐藏项目底座声明的入口', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      stateService.updateBuildProfile('gateway', { subdomain: 'llmgw', webEntry: { name: 'LLM Gateway', path: '/' } });
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway']);
      expect(await webEntryNames('branch-a')).toEqual(['LLM Gateway']);

      const res = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'branch',
        entries: [{ serviceId: 'gateway', name: '', subdomain: '', path: '/' }],
      }, { 'X-Test-Key': 'A' });

      expect(res.status).toBe(200);
      expect(stateService.getBuildProfile('gateway')!.webEntry).toEqual({ name: 'LLM Gateway', path: '/' });
      expect(await webEntryNames('branch-a')).toEqual([]);
    });

    it('拒绝非法子域与探针路径', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway']);

      const bad = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'project', entries: [{ serviceId: 'gateway', name: 'GW', subdomain: 'Bad_Sub' }],
      }, { 'X-Test-Key': 'A' });
      expect(bad.status).toBe(400);

      const probePath = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'project', entries: [{ serviceId: 'gateway', name: 'GW', subdomain: 'gw', path: '/healthz' }],
      }, { 'X-Test-Key': 'A' });
      expect(probePath.status).toBe(400);

      expect(stateService.getBuildProfile('gateway')!.subdomain).toBeUndefined();
    });

    it('拒绝撞上其它分支已发布命名 host 的子域', async () => {
      seedProject('proj-a', 'a');
      seedProject('proj-b', 'b');
      seedProfiles('proj-a');
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway']);
      seedRunningBranch('branch-b', 'proj-b', 'main', []);
      const slugRes = await request(server, 'GET', '/api/branches/branch-a/web-entry-config', undefined, { 'X-Test-Key': 'A' });
      const slug = (slugRes.body as any).previewSlug as string;
      // 另一条分支把同一个 host 作为自定义域名占走
      stateService.setBranchCustomDomains('branch-b', [`${slug}-llmgw.example.test`]);

      const res = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'project', entries: [{ serviceId: 'gateway', name: 'GW', subdomain: 'llmgw' }],
      }, { 'X-Test-Key': 'A' });

      expect(res.status).toBe(409);
      expect(stateService.getBuildProfile('gateway')!.subdomain).toBeUndefined();
    });

    /*
     * 下面四条是 Codex review（PR #1461）报出的四个洞，每条都钉住「保存成功却发不出路由」
     * 那一类静默失败：判据是 state 与 409，不是文案。
     */
    it('API-only 服务可以只有子域没有入口名称，保存不会把它的命名路由清掉', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      // 网关 serving 这类服务：有 cds.subdomain 拿一条可被调用的 URL，但不进用户入口清单
      stateService.updateBuildProfile('gateway', { subdomain: 'llmgw' });
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway']);

      const res = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'project',
        entries: [
          { serviceId: 'web', name: '主应用', path: '/' },
          { serviceId: 'gateway', name: '', subdomain: 'llmgw' },
        ],
      }, { 'X-Test-Key': 'A' });

      expect(res.status).toBe(200);
      expect(stateService.getBuildProfile('gateway')!.subdomain).toBe('llmgw');
      expect(stateService.getBuildProfile('gateway')!.webEntry).toBeUndefined();
      // 没名字就不该出现在入口清单里（resolveWebEntry 判据）
      expect(await webEntryNames('branch-a')).toEqual([]);
    });

    it('保存不丢 primary：改名不会把主入口挪到别的服务上', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      stateService.updateBuildProfile('gateway', {
        subdomain: 'llmgw',
        webEntry: { name: '网关控制台', path: '/', primary: true },
      });
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway']);

      const res = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'project',
        entries: [{ serviceId: 'gateway', name: '网关控制台（改名）', subdomain: 'llmgw', path: '/' }],
      }, { 'X-Test-Key': 'A' });

      expect(res.status).toBe(200);
      expect(stateService.getBuildProfile('gateway')!.webEntry).toEqual({
        name: '网关控制台（改名）', path: '/', primary: true,
      });
    });

    it('隐藏后重新启用不丢 primary：分支档空名占位不参与 primary 继承判定 (issue #1463)', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      stateService.updateBuildProfile('gateway', {
        subdomain: 'llmgw',
        webEntry: { name: '网关控制台', path: '/', primary: true },
      });
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway']);

      // 第一步：分支档隐藏这个入口——存下的是空名占位，不带 primary
      const hideRes = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'branch',
        entries: [{ serviceId: 'gateway', name: '', subdomain: 'llmgw', path: '/' }],
      }, { 'X-Test-Key': 'A' });
      expect(hideRes.status).toBe(200);
      expect(stateService.getBranchProfileOverride('branch-a', 'gateway')!.webEntry).toEqual({ name: '', path: '/' });

      // 第二步：重新启用并改名——primary 必须继承自项目档 baseline，不能被第一步的隐藏占位冲掉
      const reEnableRes = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'branch',
        entries: [{ serviceId: 'gateway', name: '网关控制台（重新启用）', subdomain: 'llmgw', path: '/' }],
      }, { 'X-Test-Key': 'A' });
      expect(reEnableRes.status).toBe(200);
      expect(stateService.getBranchProfileOverride('branch-a', 'gateway')!.webEntry).toEqual({
        name: '网关控制台（重新启用）', path: '/', primary: true,
      });
    });

    it('修复上线前已损坏的分支覆盖（有名字、没 primary）在下一次保存时从项目档修回 primary (issue #1463, Codex P1)', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      stateService.updateBuildProfile('gateway', {
        subdomain: 'llmgw',
        webEntry: { name: '网关控制台', path: '/', primary: true },
      });
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway']);
      // 模拟修复前「隐藏 → 重新启用」留下的坏数据：覆盖有名字、但 primary 已被冲掉
      stateService.setBranchProfileOverride('branch-a', 'gateway', { webEntry: { name: '网关控制台（旧覆盖）', path: '/' } });
      expect(stateService.getBranchProfileOverride('branch-a', 'gateway')!.webEntry).toEqual({ name: '网关控制台（旧覆盖）', path: '/' });

      // 一次普通的分支档改名保存，primary 必须从项目档修回来，而不是继续从坏覆盖继承「没有」
      const res = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'branch',
        entries: [{ serviceId: 'gateway', name: '网关控制台（修回）', subdomain: 'llmgw', path: '/' }],
      }, { 'X-Test-Key': 'A' });
      expect(res.status).toBe(200);
      expect(stateService.getBranchProfileOverride('branch-a', 'gateway')!.webEntry).toEqual({
        name: '网关控制台（修回）', path: '/', primary: true,
      });
    });

    it('拒绝撞上本分支自己的子域别名（发布器会因此静默跳过这条服务路由）', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway']);
      const slugRes = await request(server, 'GET', '/api/branches/branch-a/web-entry-config', undefined, { 'X-Test-Key': 'A' });
      const slug = (slugRes.body as any).previewSlug as string;
      stateService.setBranchSubdomainAliases('branch-a', [`${slug}-llmgw`]);

      const res = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'branch', entries: [{ serviceId: 'gateway', name: 'GW', subdomain: 'llmgw' }],
      }, { 'X-Test-Key': 'A' });

      expect(res.status).toBe(409);
      expect(stateService.getBranchProfileOverride('branch-a', 'gateway')).toBeUndefined();
    });

    it('存项目档要验每条会继承的分支，别的分支撞车同样拒绝', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway']);
      seedRunningBranch('branch-other', 'proj-a', 'feature/other', ['web', 'gateway']);
      // 只有 branch-other 那条 host 被占：请求分支自己完全干净
      const otherSlug = 'other-feature-a';
      stateService.setBranchCustomDomains('branch-other', [`${otherSlug}-llmgw.example.test`]);

      const res = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'project', entries: [{ serviceId: 'gateway', name: 'GW', subdomain: 'llmgw' }],
      }, { 'X-Test-Key': 'A' });

      expect(res.status).toBe(409);
      expect((res.body as any).collisions.some((c: any) => c.branchId === 'branch-other')).toBe(true);
      expect(stateService.getBuildProfile('gateway')!.subdomain).toBeUndefined();

      // 该分支用分支档把子域钉死后就不再继承项目值，项目档保存重新放行
      stateService.setBranchProfileOverride('branch-other', 'gateway', { subdomain: 'gw2' });
      const retry = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'project', entries: [{ serviceId: 'gateway', name: 'GW', subdomain: 'llmgw' }],
      }, { 'X-Test-Key': 'A' });
      expect(retry.status).toBe(200);
      expect(stateService.getBuildProfile('gateway')!.subdomain).toBe('llmgw');
    });

    it('同分支另一个服务已占同一子域时拒绝', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      stateService.addBuildProfile({
        id: 'api', projectId: 'proj-a', name: 'API', dockerImage: 'node:20', workDir: '.',
        containerPort: 5000, subdomain: 'llmgw',
      });
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'api', 'gateway']);

      const res = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'branch', entries: [{ serviceId: 'gateway', name: 'GW', subdomain: 'llmgw' }],
      }, { 'X-Test-Key': 'A' });

      expect(res.status).toBe(409);
      expect(stateService.getBranchProfileOverride('branch-a', 'gateway')).toBeUndefined();
    });

    /*
     * 托管交付项目的服务清单在 Project.managedProfiles，不在全局 buildProfiles 里，
     * 且由 ManagedProjectService 每次重新生成覆盖。裸 id 去全局表找会命中**别的项目**
     * 同名 profile（web / api 这类），鉴权过了却写坏邻居（Codex review 第二轮 P1）。
     */
    /*
     * 子域会展开出历史别名（llmgw 也发 llmgw-web，见 LEGACY_SUBDOMAIN_ALIASES）。
     * 只比规范名时，A 用 llmgw、B 用 llmgw-web 按原始字符串不相等就放行了，
     * 而两者展开后的 host 完全重合——发布器会跳过或改指其中一条，一条对外承诺过的
     * 兼容地址开始指向错的容器（Codex review 第三轮 P1）。
     */
    it('展开历史别名后重合的子域算撞车（llmgw 与 llmgw-web）', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      stateService.addBuildProfile({
        id: 'legacy', projectId: 'proj-a', name: '旧网关', dockerImage: 'node:20', workDir: '.',
        containerPort: 8092, subdomain: 'llmgw-web',
      });
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway', 'legacy']);

      const res = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'branch', entries: [{ serviceId: 'gateway', name: 'GW', subdomain: 'llmgw' }],
      }, { 'X-Test-Key': 'A' });

      expect(res.status).toBe(409);
      expect(String((res.body as any).error)).toContain('legacy');
      expect(stateService.getBranchProfileOverride('branch-a', 'gateway')).toBeUndefined();
    });

    /*
     * 同一次请求内部的撞车：两个当前都没配子域的服务，一个填 llmgw、一个填 llmgw-web，
     * 各自跟保存前状态比都干净、原始名字符串也不相等——只有按「保存后的结果态」比
     * 展开 host 才抓得到（Codex review 第四轮 P1）。
     */
    it('同一次请求里两个服务的子域展开后重合也算撞车', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      stateService.addBuildProfile({
        id: 'legacy', projectId: 'proj-a', name: '旧网关', dockerImage: 'node:20', workDir: '.',
        containerPort: 8092,
      });
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway', 'legacy']);

      const res = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'project',
        entries: [
          { serviceId: 'gateway', name: 'GW', subdomain: 'llmgw' },
          { serviceId: 'legacy', name: '旧 GW', subdomain: 'llmgw-web' },
        ],
      }, { 'X-Test-Key': 'A' });

      expect(res.status).toBe(409);
      expect(stateService.getBuildProfile('gateway')!.subdomain).toBeUndefined();
      expect(stateService.getBuildProfile('legacy')!.subdomain).toBeUndefined();
    });

    it('同一次请求里把子域从一个服务搬到另一个服务是合法的', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      stateService.addBuildProfile({
        id: 'legacy', projectId: 'proj-a', name: '旧网关', dockerImage: 'node:20', workDir: '.',
        containerPort: 8092, subdomain: 'llmgw', webEntry: { name: '旧 GW', path: '/' },
      });
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway', 'legacy']);

      const res = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'project',
        entries: [
          { serviceId: 'legacy', name: '', subdomain: '' },
          { serviceId: 'gateway', name: '新 GW', subdomain: 'llmgw' },
        ],
      }, { 'X-Test-Key': 'A' });

      expect(res.status).toBe(200);
      expect(stateService.getBuildProfile('legacy')!.subdomain).toBeUndefined();
      expect(stateService.getBuildProfile('gateway')!.subdomain).toBe('llmgw');
    });

    it('原样重存自己已有的子域不算撞车（豁免只认本服务自己的 host）', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      stateService.updateBuildProfile('gateway', {
        subdomain: 'llmgw', webEntry: { name: '网关', path: '/' },
      });
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway']);

      const res = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'project',
        entries: [
          { serviceId: 'web', name: '主应用', path: '/' },
          { serviceId: 'gateway', name: '网关（改名）', subdomain: 'llmgw', path: '/' },
        ],
      }, { 'X-Test-Key': 'A' });

      expect(res.status).toBe(200);
      expect(stateService.getBuildProfile('gateway')!.webEntry).toEqual({ name: '网关（改名）', path: '/' });
    });

    /*
     * 分支档存在同一个 profileOverrides 对象里，而通用的 PUT /profile-overrides/:profileId
     * 是「白名单重建 + 整体替换」。它不认识 subdomain / webEntry，调用方（运行模式、端口、
     * 环境变量那套 UI）也不会带上——不保护就等于「改个部署模式顺手删掉命名入口」
     * （Codex review 第七轮 P1）。
     */
    it('改别的分支覆盖设置不会顺手抹掉入口配置', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway']);

      const saved = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'branch',
        entries: [{ serviceId: 'gateway', name: '网关（本分支）', subdomain: 'gw', path: '/' }],
      }, { 'X-Test-Key': 'A' });
      expect(saved.status).toBe(200);
      expect(await webEntryNames('branch-a')).toEqual(['网关（本分支）']);

      // 用通用覆盖接口只改运行模式，请求体里完全没有 subdomain / webEntry
      const other = await request(server, 'PUT', '/api/branches/branch-a/profile-overrides/gateway', {
        activeDeployMode: 'express',
      }, { 'X-Test-Key': 'A' });
      expect(other.status).toBe(200);

      const override = stateService.getBranchProfileOverride('branch-a', 'gateway')!;
      expect(override.activeDeployMode).toBe('express');
      expect(override.subdomain).toBe('gw');
      expect(override.webEntry).toEqual({ name: '网关（本分支）', path: '/' });
      expect(await webEntryNames('branch-a')).toEqual(['网关（本分支）']);
    });

    /*
     * 同一族的第二条出口：分支覆盖 UI 在所有白名单字段都被清空时不是 PUT 空对象，
     * 而是 DELETE 整份覆盖（`overrideHasFields` 为假的那条分支）。整份删掉同样会
     * 带走入口配置——「把端口清了顺手撤掉命名路由」。
     */
    it('清空分支覆盖（DELETE）保留入口配置，只撤掉构建覆盖', async () => {
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway']);

      await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'branch',
        entries: [{ serviceId: 'gateway', name: '网关（本分支）', subdomain: 'gw', path: '/' }],
      }, { 'X-Test-Key': 'A' });
      await request(server, 'PUT', '/api/branches/branch-a/profile-overrides/gateway', {
        activeDeployMode: 'express',
      }, { 'X-Test-Key': 'A' });

      const removed = await request(server, 'DELETE', '/api/branches/branch-a/profile-overrides/gateway', undefined, { 'X-Test-Key': 'A' });
      expect(removed.status).toBe(200);

      const override = stateService.getBranchProfileOverride('branch-a', 'gateway')!;
      expect(override.activeDeployMode).toBeUndefined();
      expect(override.subdomain).toBe('gw');
      expect(override.webEntry).toEqual({ name: '网关（本分支）', path: '/' });
      expect(await webEntryNames('branch-a')).toEqual(['网关（本分支）']);
    });

    it('托管交付项目拒绝项目档保存，且不会误写别的项目的同名 profile', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'managed-p', slug: 'managed', name: '托管项目', kind: 'git',
        deliveryMode: 'managed', createdAt: now, updatedAt: now,
        managedProfiles: [{
          id: 'web', projectId: 'managed-p', name: '托管 Web', dockerImage: 'nginx:alpine',
          workDir: '.', containerPort: 80, pathPrefixes: ['/'],
          webEntry: { name: '托管应用', path: '/' },
        }],
      } as any);
      // 另一个 compose 项目里有同名 id 的 profile —— 它绝不能被这次保存碰到
      seedProject('proj-a', 'a');
      seedProfiles('proj-a');
      stateService.updateBuildProfile('web', { subdomain: 'keepme' });
      seedRunningBranch('managed-branch', 'managed-p', 'main', ['web']);

      const cfg = await request(server, 'GET', '/api/branches/managed-branch/web-entry-config');
      expect(cfg.status).toBe(200);
      expect((cfg.body as any).supportsProjectScope).toBe(false);

      const res = await request(server, 'PUT', '/api/branches/managed-branch/web-entry-config', {
        scope: 'project', entries: [{ serviceId: 'web', name: '被改的名字', subdomain: 'hijack' }],
      });
      expect(res.status).toBe(400);
      // proj-a 的 web profile 一个字都不能变
      expect(stateService.getBuildProfile('web')!.subdomain).toBe('keepme');
      expect(stateService.getBuildProfile('web')!.webEntry).toEqual({ name: '主应用', path: '/' });

      // 分支档这条路照常可用（profileOverrides 不受方案重新生成影响）
      const branchScoped = await request(server, 'PUT', '/api/branches/managed-branch/web-entry-config', {
        scope: 'branch', entries: [{ serviceId: 'web', name: '托管应用（本分支）', path: '/' }],
      });
      expect(branchScoped.status).toBe(200);
      expect(stateService.getBranchProfileOverride('managed-branch', 'web')!.webEntry)
        .toEqual({ name: '托管应用（本分支）', path: '/' });
      expect(stateService.getBuildProfile('web')!.webEntry).toEqual({ name: '主应用', path: '/' });
    });

    it('项目档不能改分支临时服务，跨项目 key 一律 403', async () => {
      seedProject('proj-a', 'a');
      seedProject('proj-b', 'b');
      seedProfiles('proj-a');
      seedRunningBranch('branch-a', 'proj-a', 'main', ['web', 'gateway', 'tmp']);
      stateService.getBranch('branch-a')!.extraProfiles = [
        { id: 'tmp', projectId: 'proj-a', name: '临时', dockerImage: 'nginx:alpine', workDir: '.', containerPort: 80, prebuiltImage: true },
      ];

      const wrongScope = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'project', entries: [{ serviceId: 'tmp', name: '临时入口', subdomain: 'tmp' }],
      }, { 'X-Test-Key': 'A' });
      expect(wrongScope.status).toBe(400);

      const branchScope = await request(server, 'PUT', '/api/branches/branch-a/web-entry-config', {
        scope: 'branch', entries: [{ serviceId: 'tmp', name: '临时入口', subdomain: 'tmp' }],
      }, { 'X-Test-Key': 'A' });
      expect(branchScope.status).toBe(200);
      expect(await webEntryNames('branch-a')).toEqual(['临时入口']);

      const foreign = await request(server, 'GET', '/api/branches/branch-a/web-entry-config', undefined, { 'X-Test-Key': 'B' });
      expect(foreign.status).toBe(403);
    });
  });

  describe('分支级额外服务 /api/branches/:id/extra-services', () => {
    const extraSvc = (id: string) => ({ id, name: id, dockerImage: 'nginx:alpine', containerPort: 80, prebuiltImage: true });
    function seedBranch(id: string, projectId = 'default') {
      stateService.addBranch({ id, projectId, branch: id, worktreePath: `/tmp/wt/${id}`, services: {}, status: 'idle', createdAt: new Date().toISOString() });
    }

    it('GET returns [] for a branch with no extras', async () => {
      seedBranch('b1');
      const res = await request(server, 'GET', '/api/branches/b1/extra-services');
      expect(res.status).toBe(200);
      expect((res.body as any).extraProfiles).toEqual([]);
    });

    it('PUT declares an extra service; GET reflects it; a sibling stays empty (zero cross-impact)', async () => {
      seedBranch('b1'); seedBranch('b2');
      const put = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [extraSvc('demo-extra')] });
      expect(put.status).toBe(200);
      expect((put.body as any).count).toBe(1);
      expect((put.body as any).redeployTriggered).toBe(false);

      const g1 = await request(server, 'GET', '/api/branches/b1/extra-services');
      expect((g1.body as any).extraProfiles.map((p: any) => p.id)).toEqual(['demo-extra']);
      const g2 = await request(server, 'GET', '/api/branches/b2/extra-services');
      expect((g2.body as any).extraProfiles).toEqual([]); // sibling untouched
    });

    it('preserves branch-local routing/ordering/readiness metadata (pathPrefixes/dependsOn/readinessProbe/startupSignal)', async () => {
      seedBranch('b1');
      const put = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{
          id: 'extra-api', name: 'extra-api', dockerImage: 'nginx:alpine', containerPort: 8080,
          pathPrefixes: ['/api/', '/graphql'],
          dependsOn: ['mysql', 'redis'],
          readinessProbe: { path: '/health', intervalSeconds: 3, timeoutSeconds: 120, noHttp: false },
          startupSignal: 'Network:',
        }],
      });
      expect(put.status).toBe(200);
      const saved = stateService.getBranch('b1')!.extraProfiles!.find((p) => p.id === 'extra-api')!;
      expect(saved.pathPrefixes).toEqual(['/api/', '/graphql']);
      expect(saved.dependsOn).toEqual(['mysql', 'redis']);
      expect(saved.readinessProbe).toEqual({ path: '/health', intervalSeconds: 3, timeoutSeconds: 120 });
      expect(saved.startupSignal).toBe('Network:');
    });

    it('preserves containerWorkDir and rejects an illegal one (Codex P2)', async () => {
      seedBranch('b1');
      // valid container-absolute path is kept
      const ok = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'svc', name: 'svc', dockerImage: 'nginx:alpine', containerPort: 80, containerWorkDir: '/srv/app' }],
      });
      expect(ok.status).toBe(200);
      expect(stateService.getBranch('b1')!.extraProfiles!.find((p) => p.id === 'svc')!.containerWorkDir).toBe('/srv/app');
      // shell-metachar / relative / traversal rejected
      for (const bad of ['app', '/srv/"; id', '/srv/../etc', '/a$(x)']) {
        const res = await request(server, 'PUT', '/api/branches/b1/extra-services', {
          extraProfiles: [{ id: 'svc', name: 'svc', dockerImage: 'nginx:alpine', containerPort: 80, containerWorkDir: bad }],
        });
        expect(res.status).toBe(400);
        expect(String((res.body as any).error)).toContain('containerWorkDir');
      }
    });

    it('rejects an extra id that collides with a project profile', async () => {
      stateService.addBuildProfile({ id: 'api', name: 'API', dockerImage: 'img', workDir: 'api', command: 'run', containerPort: 8080, projectId: 'default' });
      seedBranch('b1');
      const res = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [extraSvc('api')] });
      expect(res.status).toBe(400);
      expect(String((res.body as any).error)).toContain('撞名');
    });

    it('rejects invalid id / missing image / bad port', async () => {
      seedBranch('b1');
      expect((await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: '-bad', dockerImage: 'x', containerPort: 80 }] })).status).toBe(400);
      expect((await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: 'ok', containerPort: 80 }] })).status).toBe(400);
      expect((await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: 'ok', dockerImage: 'x', containerPort: 0 }] })).status).toBe(400);
      expect((await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: 'notarray' })).status).toBe(400);
    });

    it('rejects a dockerImage containing host-shell metacharacters (Codex P1 boundary defense)', async () => {
      seedBranch('b1');
      for (const bad of ['evil:latest; rm -rf /', 'img$(whoami)', 'img`id`', 'a b', 'img|cat', 'img&background']) {
        const res = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: 'ok', dockerImage: bad, containerPort: 80 }] });
        expect(res.status).toBe(400);
        expect(String((res.body as any).error)).toContain('dockerImage');
      }
      // A normal registry/namespace/repo:tag@digest reference is accepted.
      const ok = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: 'ok', dockerImage: 'ghcr.io/acme/api:1.2.3', containerPort: 80 }] });
      expect(ok.status).toBe(200);
    });

    it('rejects a workDir containing host-shell metacharacters or .. traversal (Codex P1 boundary defense)', async () => {
      seedBranch('b1');
      for (const bad of ['svc";id;"', 'a$(whoami)', 'p`id`', 'has space', 'a|b', 'x&y', '../../etc', 'a/../../b']) {
        const res = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: 'ok', dockerImage: 'img', containerPort: 80, workDir: bad }] });
        expect(res.status).toBe(400);
        expect(String((res.body as any).error)).toContain('workDir');
      }
      // A normal relative subdir is accepted (empty workDir也合法，下方一并验证)。
      const ok = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: 'ok', dockerImage: 'img', containerPort: 80, workDir: 'services/api' }] });
      expect(ok.status).toBe(200);
      const okEmpty = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [{ id: 'ok', dockerImage: 'img', containerPort: 80 }] });
      expect(okEmpty.status).toBe(200);
    });

    it('PUT [] clears extras', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [extraSvc('demo-extra')] });
      const clr = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [] });
      expect((clr.body as any).count).toBe(0);
      expect(stateService.getBranch('b1')!.extraProfiles).toBeUndefined();
    });

    it('?redeploy=1 reports redeployTriggered only after the self-deploy is accepted (200)', async () => {
      seedBranch('b1');
      const originalFetch = globalThis.fetch;
      const calls: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        // deploy endpoint accepts → streams SSE 200
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }) as typeof fetch;
      try {
        const res = await request(server, 'PUT', '/api/branches/b1/extra-services?redeploy=1', { extraProfiles: [extraSvc('demo-extra')] });
        expect(res.status).toBe(200);
        expect((res.body as any).redeployTriggered).toBe(true);
        expect(calls.some((u) => u.includes('/api/branches/b1/deploy'))).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('?redeploy=1 does NOT claim triggered when the self-deploy is rejected (423 paused) — surfaces the rejection', async () => {
      seedBranch('b1');
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: '分支已暂停' }), { status: 423 })) as typeof fetch;
      try {
        const res = await request(server, 'PUT', '/api/branches/b1/extra-services?redeploy=1', { extraProfiles: [extraSvc('demo-extra')] });
        expect(res.status).toBe(200);
        // The extra service is still persisted...
        expect((res.body as any).count).toBe(1);
        // ...but redeploy must NOT be reported as triggered, and the rejection is surfaced.
        expect((res.body as any).redeployTriggered).toBe(false);
        expect((res.body as any).redeployRejected?.status).toBe(423);
        expect(String((res.body as any).redeployRejected?.message)).toContain('暂停');
        expect(String((res.body as any).hint)).toContain('未成功');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('?redeploy=1 rolls back a DESTRUCTIVE removal when the self-deploy is rejected (Codex P2: no ghost service)', async () => {
      seedBranch('b1');
      // Declare an extra service AND give it a live running service row (a worker container exists for it).
      await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [extraSvc('demo-extra')] });
      stateService.getBranch('b1')!.services['demo-extra'] = {
        profileId: 'demo-extra', containerName: 'cds-b1-demo-extra', hostPort: 10099, status: 'running',
      };
      stateService.save();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: 'owning_executor_offline' }), { status: 503 })) as typeof fetch;
      try {
        // Clearing the extra service while its container still runs = destructive; deploy rejected → must roll back.
        const res = await request(server, 'PUT', '/api/branches/b1/extra-services?redeploy=1', { extraProfiles: [] });
        expect(res.status).toBe(200);
        expect((res.body as any).redeployTriggered).toBe(false);
        expect((res.body as any).removalRolledBack).toBe(true);
        expect((res.body as any).rolledBackServiceIds).toContain('demo-extra');
        // master metadata stays consistent with the still-running worker container.
        expect((res.body as any).count).toBe(1);
        expect(stateService.getBranch('b1')!.extraProfiles!.map((p) => p.id)).toEqual(['demo-extra']);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('?redeploy=1 does NOT roll back an ADD-ONLY change when the self-deploy is rejected (keeps declared config)', async () => {
      seedBranch('b1');
      // Pre-existing extra service with a live row; the new PUT keeps it and ADDS a second one (no destructive drop).
      await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [extraSvc('demo-extra')] });
      stateService.getBranch('b1')!.services['demo-extra'] = {
        profileId: 'demo-extra', containerName: 'cds-b1-demo-extra', hostPort: 10099, status: 'running',
      };
      stateService.save();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: '缺少必填环境变量' }), { status: 412 })) as typeof fetch;
      try {
        const res = await request(server, 'PUT', '/api/branches/b1/extra-services?redeploy=1', {
          extraProfiles: [extraSvc('demo-extra'), extraSvc('demo-extra-2')],
        });
        expect(res.status).toBe(200);
        expect((res.body as any).redeployTriggered).toBe(false);
        expect((res.body as any).redeployRejected?.status).toBe(412);
        // No service was dropped → not destructive → keep the declared config (do NOT roll back the add).
        expect((res.body as any).removalRolledBack).toBeUndefined();
        expect((res.body as any).count).toBe(2);
        expect(stateService.getBranch('b1')!.extraProfiles!.map((p) => p.id).sort()).toEqual(['demo-extra', 'demo-extra-2']);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('preserves + validates extra-service entrypoint override (Codex P2)', async () => {
      seedBranch('b1');
      // empty string = clear the image ENTRYPOINT (container.ts → --entrypoint="")
      const ok = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, entrypoint: '' }],
      });
      expect(ok.status).toBe(200);
      expect(stateService.getBranch('b1')!.extraProfiles![0].entrypoint).toBe('');
      // a single-token executable path is preserved
      const ok2 = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, entrypoint: '/usr/local/bin/start.sh' }],
      });
      expect(ok2.status).toBe(200);
      expect(stateService.getBranch('b1')!.extraProfiles![0].entrypoint).toBe('/usr/local/bin/start.sh');
      // spaces / shell metacharacters are rejected at the boundary
      const bad = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, entrypoint: 'sh -c "rm -rf /"' }],
      });
      expect(bad.status).toBe(400);
    });

    it('clears a stale profileOverride when its extra service is removed (Codex P2)', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80 }],
      });
      // Save an override for the extra service.
      await request(server, 'PUT', '/api/branches/b1/profile-overrides/demo-extra', { dockerImage: 'ghcr.io/acme/old:1' });
      expect(stateService.getBranch('b1')!.profileOverrides?.['demo-extra']).toBeTruthy();
      // Remove the extra service (clear). Its override must NOT linger to poison a later same-id service.
      const clr = await request(server, 'PUT', '/api/branches/b1/extra-services', { extraProfiles: [] });
      expect(clr.status).toBe(200);
      expect(stateService.getBranch('b1')!.profileOverrides?.['demo-extra']).toBeUndefined();
      // Re-create a different service with the SAME id: it must NOT inherit the old override image.
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80 }],
      });
      expect(stateService.getBranch('b1')!.profileOverrides?.['demo-extra']).toBeUndefined();
      // The override clear must be PERSISTED, not in-memory only (Bugbot Medium): a fresh StateService
      // reading the same state file must also see it gone — otherwise a restart reloads stale overrides.
      const reloaded = new StateService(path.join(tmpDir, 'state.json'));
      expect(reloaded.getBranch('b1')?.profileOverrides?.['demo-extra']).toBeUndefined();
    });

    it('preserves + validates extra-service dbScope (Codex P2)', async () => {
      seedBranch('b1');
      // per-branch isolation must survive the whitelist (else resolveProfileRuntimeEnv skips DB rewriting).
      const ok = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, dbScope: 'per-branch' }],
      });
      expect(ok.status).toBe(200);
      expect(stateService.getBranch('b1')!.extraProfiles![0].dbScope).toBe('per-branch');
      // an invalid enum value is rejected (not silently dropped).
      const bad = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, dbScope: 'bogus' }],
      });
      expect(bad.status).toBe(400);
    });

    it('strips env mask sentinels on PUT: reuses the prior real value, drops sentinels with no prior (Bugbot Medium)', async () => {
      seedBranch('b1');
      // First PUT establishes a real secret value for SECRET_KEY.
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, env: { SECRET_KEY: 'real-secret', PUBLIC: 'v1' } }],
      });
      // Second PUT comes back with the masked sentinel for SECRET_KEY (GET→edit→PUT round trip) plus a
      // brand-new key that is itself a sentinel (no prior value).
      const res = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, env: { SECRET_KEY: '***[masked]***', PUBLIC: 'v2', BRAND_NEW: '***' } }],
      });
      expect(res.status).toBe(200);
      const env = (stateService.getBranch('b1')!.extraProfiles![0].env)!;
      expect(env.SECRET_KEY).toBe('real-secret'); // masked → reused real prior value, NOT the literal sentinel
      expect(env.PUBLIC).toBe('v2');              // normal edit persists
      expect('BRAND_NEW' in env).toBe(false);     // sentinel with no prior → dropped, never persisted literally
    });

    it('merges env on PUT: omitted env keeps prior secrets, partial env preserves unmentioned keys (Bugbot High)', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, env: { SECRET_KEY: 'real-secret', OTHER: 'keep-me' } }],
      });
      // Re-declare the profile WITHOUT env at all → prior env must be preserved (not dropped).
      const r1 = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80 }],
      });
      expect(r1.status).toBe(200);
      let env = stateService.getBranch('b1')!.extraProfiles![0].env!;
      expect(env.SECRET_KEY).toBe('real-secret');
      expect(env.OTHER).toBe('keep-me');
      // Partial env (only one key) → the unmentioned prior key must still survive (merge, not replace).
      const r2 = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, env: { OTHER: 'updated' } }],
      });
      expect(r2.status).toBe(200);
      env = stateService.getBranch('b1')!.extraProfiles![0].env!;
      expect(env.SECRET_KEY).toBe('real-secret'); // preserved despite being omitted this time
      expect(env.OTHER).toBe('updated');          // updated value applied
    });

    it('redacts sensitive env in GET/PUT responses but keeps state raw (Codex P1)', async () => {
      seedBranch('b1');
      const put = await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, env: { API_TOKEN: 'tok_secretvalue', PUBLIC_URL: 'https://example.com' } }],
      });
      expect(put.status).toBe(200);
      // PUT response masks the sensitive value, leaves non-sensitive intact.
      const putEnv = (put.body as any).extraProfiles[0].env;
      expect(putEnv.API_TOKEN).toBe('***');
      expect(putEnv.PUBLIC_URL).toBe('https://example.com');
      // GET response is masked too.
      const get = await request(server, 'GET', '/api/branches/b1/extra-services');
      expect((get.body as any).extraProfiles[0].env.API_TOKEN).toBe('***');
      // But the persisted state keeps the real value (deploy reads raw env from state).
      expect(stateService.getBranch('b1')!.extraProfiles![0].env!.API_TOKEN).toBe('tok_secretvalue');
    });

    it('masks extra-service env in the profile-overrides payload (Codex P1)', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, env: { API_TOKEN: 'tok_secretvalue', PUBLIC_URL: 'https://example.com' } }],
      });
      const res = await request(server, 'GET', '/api/branches/b1/profile-overrides');
      expect(res.status).toBe(200);
      const row = (res.body as any).profiles.find((p: any) => p.profileId === 'demo-extra');
      expect(row).toBeTruthy();
      // baseline + effective env both masked for the branch-local extra profile.
      expect(row.baseline.env.API_TOKEN).toBe('***');
      expect(row.baseline.env.PUBLIC_URL).toBe('https://example.com');
      expect(row.effective.env.API_TOKEN).toBe('***');
      // State still holds the real value (deploy reads raw).
      expect(stateService.getBranch('b1')!.extraProfiles![0].env!.API_TOKEN).toBe('tok_secretvalue');
    });

    it('PUT /profile-overrides resolves a branch-local extra-only profile (no 404) — Bugbot "Extra profile overrides PUT fails"', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80 }],
      });
      // The GET panel lists demo-extra as overridable; the PUT must accept it (was 404 via project-only lookup).
      const put = await request(server, 'PUT', '/api/branches/b1/profile-overrides/demo-extra', { env: { FOO: 'bar' } });
      expect(put.status).toBe(200);
      expect(stateService.getBranch('b1')!.profileOverrides?.['demo-extra']?.env?.FOO).toBe('bar');
    });

    it('round-trips a branch HTTP readiness path through the override API and effective profile', async () => {
      stateService.addBuildProfile({ id: 'api', name: 'API', dockerImage: 'img', workDir: 'api', command: 'run', containerPort: 8080, projectId: 'default', readinessProbe: { path: '/health', noHttp: true } });
      seedBranch('b1');
      const readinessProbe = { path: '/health-api/health', intervalSeconds: 5, timeoutSeconds: 1200, noHttp: false };
      const put = await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', {
        env: { SERVER_SERVLET_CONTEXT_PATH: '/health-api' }, readinessProbe,
        // 实际 Mongo 读取的存量覆盖包含 null 的可选隔离字段。
        dbScope: null, dbInit: null,
      });
      expect(put.status).toBe(200);
      expect((put.body as any).effective.readinessProbe).toEqual(readinessProbe);
      const get = await request(server, 'GET', '/api/branches/b1/profile-overrides');
      const saved = (get.body as any).profiles.find((p: any) => p.profileId === 'api');
      expect(saved.override.readinessProbe).toEqual(readinessProbe);
      expect(saved.override.dbScope).toBeUndefined();
      expect(saved.override.dbInit).toBeUndefined();
      expect(saved.effective.readinessProbe).toEqual(readinessProbe);
      expect(saved.effective.env.SERVER_SERVLET_CONTEXT_PATH).toBe('/health-api');
    });

    it('PUT /profile-overrides passes dbScope through and enforces the enum (波1 W1c)', async () => {
      // dbScope 在 BuildProfileOverride/applyProfileOverride 早已支持,但 PUT 白名单一直漏透传,
      // per-branch DB 开关因此永远无法按分支生效——本测试钉死透传 + 枚举校验。
      stateService.addBuildProfile({ id: 'api', name: 'API', dockerImage: 'img', workDir: 'api', command: 'run', containerPort: 8080, projectId: 'default' });
      seedBranch('b1');
      // 合法值落库
      const put = await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', { dbScope: 'per-branch' });
      expect(put.status).toBe(200);
      expect(stateService.getBranch('b1')!.profileOverrides?.['api']?.dbScope).toBe('per-branch');
      // 覆盖生效链:resolveEffectiveProfile 合并出的有效 profile 带 per-branch
      expect(((put.body as any).effective as any).dbScope).toBe('per-branch');
      // 切回 shared 同样生效
      const back = await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', { dbScope: 'shared' });
      expect(back.status).toBe(200);
      expect(stateService.getBranch('b1')!.profileOverrides?.['api']?.dbScope).toBe('shared');
      // 非法值 400,且不改动已存覆盖
      const bad = await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', { dbScope: 'everything' });
      expect(bad.status).toBe(400);
      expect(String((bad.body as any).error)).toContain('dbScope');
      expect(stateService.getBranch('b1')!.profileOverrides?.['api']?.dbScope).toBe('shared');
    });

    describe('GET /api/branches/:id/effective-config(波2 配置检查器)', () => {
      it('未显式继承时不把 CDS 全局变量伪装成项目生效配置，开启后才加入溯源', async () => {
        seedBranch('b1');
        stateService.setCustomEnvVar('GLOBAL_CONTROL_ONLY', 'global-value', '_global');

        const isolated = await request(server, 'GET', '/api/branches/b1/effective-config');
        expect(isolated.status).toBe(200);
        expect((isolated.body as any).envLayers.some((layer: any) => (
          layer.source === 'global' && layer.keys.includes('GLOBAL_CONTROL_ONLY')
        ))).toBe(false);

        stateService.updateProject('default', { inheritGlobalEnv: true });
        const inherited = await request(server, 'GET', '/api/branches/b1/effective-config');
        expect(inherited.status).toBe(200);
        expect((inherited.body as any).envLayers.some((layer: any) => (
          layer.source === 'global' && layer.keys.includes('GLOBAL_CONTROL_ONLY')
        ))).toBe(true);
      });

      it('返回逐 key 溯源:extra-service/branch-override 打标 + 密钥脱敏 + plan 形状', async () => {
        stateService.addBuildProfile({ id: 'api', name: 'API', dockerImage: 'img', workDir: 'api', command: 'run', containerPort: 8080, projectId: 'default', env: { FROM_PROFILE: 'p' } });
        seedBranch('b1');
        // 项目级 env + 分支级临时服务(带密钥 env)+ 分支覆盖
        stateService.setCustomEnvVar('API_TOKEN', 'tok_supersecret_value', 'default');
        stateService.setCustomEnvVar('PLAIN', 'visible', 'default');
        await request(server, 'PUT', '/api/branches/b1/extra-services', {
          extraProfiles: [{ id: 'nacos', name: 'nacos', dockerImage: 'nacos/nacos-server:v2.3.2', containerPort: 8848, env: { MODE: 'standalone' }, prebuiltImage: true }],
        });
        await request(server, 'PUT', '/api/branches/b1/profile-overrides/api', { env: { FROM_PROFILE: 'overridden' }, dbScope: 'per-branch' });

        const res = await request(server, 'GET', '/api/branches/b1/effective-config');
        expect(res.status).toBe(200);
        const body = res.body as any;
        expect(body.branchId).toBe('b1');
        // envLayers 是段A分层摘要(至少含 project 层)
        expect(body.envLayers.some((l: any) => l.source === 'project' && l.keys.includes('API_TOKEN'))).toBe(true);
        // profiles 含项目底座 + 临时服务
        const api = body.profiles.find((p: any) => p.profileId === 'api');
        const nacos = body.profiles.find((p: any) => p.profileId === 'nacos');
        expect(api).toBeTruthy();
        expect(nacos).toBeTruthy();
        expect(nacos.isExtra).toBe(true);
        // 溯源打标:被 branch-override 覆盖的 key 记录 shadow 链
        const fromProfile = api.envProvenance.find((p: any) => p.key === 'FROM_PROFILE');
        expect(fromProfile).toMatchObject({ source: 'branch-override', shadowed: ['profile'] });
        // 临时服务自带 env 打 extra-service
        const mode = nacos.envProvenance.find((p: any) => p.key === 'MODE');
        expect(mode).toMatchObject({ source: 'extra-service' });
        // 项目 env 到达容器,来源 project
        const plain = api.envProvenance.find((p: any) => p.key === 'PLAIN');
        expect(plain).toMatchObject({ source: 'project', value: 'visible' });
        // 密钥脱敏:API_TOKEN 不得以明文出现
        const token = api.envProvenance.find((p: any) => p.key === 'API_TOKEN');
        expect(token.value).not.toBe('tok_supersecret_value');
        // dbScope 覆盖生效 + 来源标注
        expect(api.dbScope).toBe('per-branch');
        expect(api.dbScopeSource).toBe('branch-override');
        // plan 形状:容器清单含两个服务,infra 判定为记录态
        expect(body.plan.stateBasis).toBe('recorded');
        expect(body.plan.containers.map((c: any) => c.profileId).sort()).toEqual(['api', 'nacos']);
        expect(body.plan.networks.sharedNetwork).toBeTruthy();
      });

      it('缺失 ${VAR} 模板值时不 fail 端点,该 profile 带 envError 显性化缺口', async () => {
        stateService.addBuildProfile({ id: 'api', name: 'API', dockerImage: 'img', workDir: 'api', command: 'run', containerPort: 8080, projectId: 'default', env: { DB_URL: 'mysql://h:${NOT_SET_ANYWHERE_XYZ}/app' } });
        seedBranch('b1');
        const res = await request(server, 'GET', '/api/branches/b1/effective-config');
        expect(res.status).toBe(200);
        const api = (res.body as any).profiles.find((p: any) => p.profileId === 'api');
        expect(api.envError).toContain('NOT_SET_ANYWHERE_XYZ');
        expect(api.envProvenance).toEqual([]);
      });

      it('跨项目 agent key 越权拿不到别的项目分支的生效配置(assertProjectAccess)', async () => {
        const now = new Date().toISOString();
        stateService.addProject({ id: 'proj-a', slug: 'proj-a', name: 'A', kind: 'git', createdAt: now, updatedAt: now });
        stateService.addBranch({ id: 'ba', projectId: 'proj-a', branch: 'ba', worktreePath: '/tmp/wt/ba', services: {}, status: 'idle', createdAt: now });
        const denied = await request(server, 'GET', '/api/branches/ba/effective-config', undefined, { 'x-test-key': 'B' });
        expect(denied.status).toBe(403);
        const ok = await request(server, 'GET', '/api/branches/ba/effective-config', undefined, { 'x-test-key': 'A' });
        expect(ok.status).toBe(200);
      });
    });

    describe('分支派生快照拷贝(波3 配置树)', () => {
      const seedSourceWithConfig = async (id: string) => {
        seedBranch(id);
        await request(server, 'PUT', `/api/branches/${id}/extra-services`, {
          extraProfiles: [{ id: 'nacos', name: 'nacos', dockerImage: 'nacos/nacos-server:v2.3.2', containerPort: 8848, env: { MODE: 'standalone' }, prebuiltImage: true }],
        });
        stateService.addBuildProfile({ id: 'api', name: 'API', dockerImage: 'img', workDir: 'api', command: 'run', containerPort: 8080, projectId: 'default' });
        await request(server, 'PUT', `/api/branches/${id}/profile-overrides/api`, { env: { KEY: 'from-source' }, dbScope: 'per-branch' });
      };

      it('POST /branches 带 sourceBranchId:深拷贝 overrides+extraProfiles,写派生指针,改新不串旧', async () => {
        await seedSourceWithConfig('src-branch');
        const res = await request(server, 'POST', '/api/branches', { branch: 'derived-x', sourceBranchId: 'src-branch' });
        expect(res.status).toBe(201);
        const created = stateService.getBranch('derived-x')!;
        expect(created.derivedFromBranchId).toBe('src-branch');
        expect(created.derivedFromBranchName).toBe('src-branch');
        expect(created.derivedAt).toBeTruthy();
        expect(created.profileOverrides?.['api']?.env?.KEY).toBe('from-source');
        expect(created.profileOverrides?.['api']?.dbScope).toBe('per-branch');
        expect(created.extraProfiles?.map((p) => p.id)).toEqual(['nacos']);
        // 深拷贝隔离:改新分支的配置不得串改来源分支
        created.profileOverrides!['api']!.env!.KEY = 'mutated';
        created.extraProfiles![0].env!.MODE = 'mutated';
        const source = stateService.getBranch('src-branch')!;
        expect(source.profileOverrides?.['api']?.env?.KEY).toBe('from-source');
        expect(source.extraProfiles?.[0].env?.MODE).toBe('standalone');
      });

      it.each([undefined, false, true])('派生保留项目极速默认，只有显式例外才继承源码模式: %s', async inheritSourceModes => {
        await seedSourceWithConfig('source-exception');
        stateService.updateBuildProfile('api', { activeDeployMode: 'express', deployModes: {
          express: { label: '极速版', prebuilt: true, command: '' },
          source: { label: '源码版', prebuilt: false, command: 'run' },
        } });
        stateService.updateProject('default', { defaultDeployModes: { api: 'express' } });
        stateService.getBranch('source-exception')!.profileOverrides!.api!.activeDeployMode = 'source';
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'derived-express', sourceBranchId: 'source-exception',
          ...(inheritSourceModes === undefined ? {} : { inheritSourceModes }),
        });
        expect(res.status).toBe(201);
        const created = stateService.getBranch('derived-express')!;
        expect(created.profileOverrides?.api?.activeDeployMode).toBe(inheritSourceModes === true ? 'source' : 'express');
        expect(created.profileOverrides?.api?.env?.KEY).toBe('from-source');
        expect(created.extraProfiles?.map(p => p.id)).toEqual(['nacos']);
        expect(stateService.getBranch('source-exception')!.profileOverrides!.api!.activeDeployMode).toBe('source');
      });

      it('POST /branches sourceBranchId 校验:不存在 400,跨项目 400,且不留孤儿分支', async () => {
        const now = new Date().toISOString();
        const missing = await request(server, 'POST', '/api/branches', { branch: 'd1', sourceBranchId: 'ghost' });
        expect(missing.status).toBe(400);
        expect(stateService.getBranch('d1')).toBeUndefined();
        stateService.addProject({ id: 'proj-a', slug: 'proj-a', name: 'A', kind: 'git', createdAt: now, updatedAt: now });
        stateService.addBranch({ id: 'other', projectId: 'proj-a', branch: 'other', worktreePath: '/tmp/wt/other', services: {}, status: 'idle', createdAt: now });
        const cross = await request(server, 'POST', '/api/branches', { branch: 'd2', sourceBranchId: 'other' });
        expect(cross.status).toBe(400);
        expect(String((cross.body as any).error)).toContain('跨项目');
      });

      it('POST /branches/:id/copy-config-from/:sourceId:先拍快照再整体替换,可从快照回滚', async () => {
        await seedSourceWithConfig('src-branch');
        seedBranch('target');
        // target 先有自己的配置(将被替换)
        await request(server, 'PUT', '/api/branches/target/profile-overrides/api', { env: { KEY: 'target-own' } });

        const res = await request(server, 'POST', '/api/branches/target/copy-config-from/src-branch');
        expect(res.status).toBe(200);
        const body = res.body as any;
        expect(body.copied).toBe(true);
        expect(body.snapshotId).toBeTruthy();
        const target = stateService.getBranch('target')!;
        expect(target.profileOverrides?.['api']?.env?.KEY).toBe('from-source');
        expect(target.extraProfiles?.map((p) => p.id)).toEqual(['nacos']);
        expect(target.derivedFromBranchId).toBe('src-branch');

        // 误拷回滚:快照分支层恢复 target 拷贝前的配置
        const rollback = await request(server, 'POST', `/api/config-snapshots/${body.snapshotId}/rollback`, {});
        // snapshots 路由不在本测试 app 里 → 直接走 state 层验证回滚语义
        if (rollback.status === 404 || typeof rollback.body === 'string') {
          stateService.rollbackToConfigSnapshot(body.snapshotId);
        }
        const restored = stateService.getBranch('target')!;
        expect(restored.profileOverrides?.['api']?.env?.KEY).toBe('target-own');
        expect(restored.extraProfiles).toBeUndefined();
        expect(restored.derivedFromBranchId).toBeUndefined();
      });

      it('copy-config-from 校验:自拷 400 / 跨项目 400', async () => {
        const now = new Date().toISOString();
        seedBranch('b1');
        const self = await request(server, 'POST', '/api/branches/b1/copy-config-from/b1');
        expect(self.status).toBe(400);
        stateService.addProject({ id: 'proj-a', slug: 'proj-a', name: 'A', kind: 'git', createdAt: now, updatedAt: now });
        stateService.addBranch({ id: 'other', projectId: 'proj-a', branch: 'other', worktreePath: '/tmp/wt/other', services: {}, status: 'idle', createdAt: now });
        const cross = await request(server, 'POST', '/api/branches/b1/copy-config-from/other');
        expect(cross.status).toBe(400);
      });

      it('快照分支层:旧快照(无 branchConfigs)回滚分支层 no-op;新快照不复活已删分支', async () => {
        seedBranch('keeper');
        await request(server, 'PUT', '/api/branches/keeper/extra-services', {
          extraProfiles: [{ id: 'svc', name: 'svc', dockerImage: 'nginx:alpine', containerPort: 80, prebuiltImage: true }],
        });
        // 旧格式快照:手工去掉 branchConfigs 字段 → 回滚不碰分支层
        const legacySnap = stateService.createConfigSnapshot({ trigger: 'manual', label: 'legacy', projectId: null });
        delete (legacySnap.payload as any).branchConfigs;
        stateService.rollbackToConfigSnapshot(legacySnap.id);
        expect(stateService.getBranch('keeper')!.extraProfiles?.length).toBe(1);

        // 新快照:拍照后删分支,回滚不复活分支
        const snap = stateService.createConfigSnapshot({ trigger: 'manual', label: 'with-branches', projectId: null });
        expect(snap.payload.branchConfigs?.['keeper']?.extraProfiles?.length).toBe(1);
        stateService.removeBranch('keeper');
        stateService.rollbackToConfigSnapshot(snap.id);
        expect(stateService.getBranch('keeper')).toBeUndefined();
      });
    });

    it('PUT /profile-overrides rejects a shell-injecting dockerImage override (Codex P1)', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, prebuiltImage: true }],
      });
      // A caller cannot bypass extra-services image validation by overriding dockerImage here:
      // `alpine; touch /tmp/pwn` would hit the host `docker pull` if accepted.
      const bad = await request(server, 'PUT', '/api/branches/b1/profile-overrides/demo-extra', { dockerImage: 'alpine:latest; touch /tmp/pwn' });
      expect(bad.status).toBe(400);
      expect(stateService.getBranch('b1')!.profileOverrides?.['demo-extra']?.dockerImage).toBeUndefined();
      // A legitimate image reference is still accepted.
      const ok = await request(server, 'PUT', '/api/branches/b1/profile-overrides/demo-extra', { dockerImage: 'ghcr.io/acme/api:1.2.3' });
      expect(ok.status).toBe(200);
      expect(stateService.getBranch('b1')!.profileOverrides?.['demo-extra']?.dockerImage).toBe('ghcr.io/acme/api:1.2.3');
      // A traversal/metachar containerWorkDir override is also rejected.
      const badCwd = await request(server, 'PUT', '/api/branches/b1/profile-overrides/demo-extra', { containerWorkDir: '/app/../etc' });
      expect(badCwd.status).toBe(400);
    });

    it('container-exec masks a secret stored via profile-overrides (Codex P2: resolve overrides before masking exec output)', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80 }],
      });
      // The secret lives ONLY in the profile override (the extra profile itself has no env).
      await request(server, 'PUT', '/api/branches/b1/profile-overrides/demo-extra', { env: { SECRET_TOKEN: 'supersecretvalue123' } });
      // A running service row so container-exec finds a container to exec into.
      stateService.getBranch('b1')!.services['demo-extra'] = {
        profileId: 'demo-extra', containerName: 'cds-b1-demo-extra', hostPort: 10099, status: 'running',
      };
      stateService.save();

      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        // simulate `echo $SECRET_TOKEN` dumping the raw secret on its own line
        if (command.includes('docker exec cds-b1-demo-extra')) {
          return { stdout: 'supersecretvalue123\n', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };
      try {
        const res = await request(server, 'POST', '/api/branches/b1/container-exec', { profileId: 'demo-extra', command: 'echo $SECRET_TOKEN' });
        expect(res.status).toBe(200);
        expect((res.body as any).masked).toBe(true);
        // Override-supplied secret must be redacted (was leaked when masking read the unmerged profile).
        expect((res.body as any).stdout).not.toContain('supersecretvalue123');
        expect((res.body as any).stdout).toContain('***');
      } finally {
        mock.exec = originalExec;
      }
    });

    it('container-exec single-quotes the command so the CDS host shell never expands $VAR / $(...) (#1448)', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80 }],
      });
      stateService.getBranch('b1')!.services['demo-extra'] = {
        profileId: 'demo-extra', containerName: 'cds-b1-demo-extra', hostPort: 10099, status: 'running',
      };
      stateService.save();

      const command = `echo "$(printenv)" && echo $CDS_JWT_SECRET && echo 'it'"'"'s'`;
      const res = await request(server, 'POST', '/api/branches/b1/container-exec', { profileId: 'demo-extra', command });
      expect(res.status).toBe(200);

      const sent = mock.commands.find((c) => c.includes('docker exec cds-b1-demo-extra'));
      expect(sent).toBeDefined();
      // Single-quoted word: `$` is inert on the host, and embedded single quotes are re-escaped.
      expect(sent).toBe(`docker exec cds-b1-demo-extra sh -c '${command.replace(/'/g, `'\\''`)}'`);
      expect(sent).not.toContain(`sh -c "`);
    });

    it('container-exec masks a multi-line PEM private key dumped by printenv (#1448)', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80 }],
      });
      stateService.getBranch('b1')!.services['demo-extra'] = {
        profileId: 'demo-extra', containerName: 'cds-b1-demo-extra', hostPort: 10099, status: 'running',
      };
      stateService.save();

      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (command.includes('docker exec cds-b1-demo-extra')) {
          return {
            stdout: [
              'HOME=/root',
              'APP_PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----',
              'MIIEpAIBAAKCAQEA0Z3VS5JJcds',
              'wJ6ZbN3f1YkYqVhZ2u9xL0vTfq',
              '-----END RSA PRIVATE KEY-----',
              'NODE_ENV=production',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
          };
        }
        return originalExec(command, options);
      };
      try {
        const res = await request(server, 'POST', '/api/branches/b1/container-exec', { profileId: 'demo-extra', command: 'printenv' });
        expect(res.status).toBe(200);
        const stdout = (res.body as any).stdout as string;
        expect(stdout).not.toContain('MIIEpAIBAAKCAQEA0Z3VS5JJcds');
        expect(stdout).not.toContain('wJ6ZbN3f1YkYqVhZ2u9xL0vTfq');
        expect(stdout).toContain('APP_PRIVATE_KEY=***[masked]***');
        expect(stdout).toContain('HOME=/root');
        expect(stdout).toContain('NODE_ENV=production');
      } finally {
        mock.exec = originalExec;
      }
    });

    it('PUT /profile-overrides masks extra-profile secret env in the save response (Codex P1)', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80, env: { API_TOKEN: 'tok_secret', PUBLIC_URL: 'https://example.com' } }],
      });
      // Save an innocuous override; the response must NOT leak the extra service's secret env.
      const put = await request(server, 'PUT', '/api/branches/b1/profile-overrides/demo-extra', { env: { API_TOKEN: 'tok_overridesecret' } });
      expect(put.status).toBe(200);
      expect((put.body as any).effective.env.API_TOKEN).toBe('***');
      expect((put.body as any).effective.env.PUBLIC_URL).toBe('https://example.com');
      expect((put.body as any).override.env.API_TOKEN).toBe('***');
      // State still holds the real value (deploy reads raw).
      expect(stateService.getBranch('b1')!.profileOverrides?.['demo-extra']?.env?.API_TOKEN).toBe('tok_overridesecret');
    });

    it('GET /profile-overrides also masks the saved override env for extra profiles (Codex P1)', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80 }],
      });
      await request(server, 'PUT', '/api/branches/b1/profile-overrides/demo-extra', { env: { API_TOKEN: 'tok_overridesecret' } });
      const res = await request(server, 'GET', '/api/branches/b1/profile-overrides');
      expect(res.status).toBe(200);
      const row = (res.body as any).profiles.find((p: any) => p.profileId === 'demo-extra');
      // override.env must be masked too (baseline/effective already were; override was leaking).
      expect(row.override.env.API_TOKEN).toBe('***');
      expect(stateService.getBranch('b1')!.profileOverrides?.['demo-extra']?.env?.API_TOKEN).toBe('tok_overridesecret');
    });

    it('PUT /profile-overrides strips mask sentinels and restores the prior override secret (Bugbot High)', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80 }],
      });
      // First save the real override secret.
      await request(server, 'PUT', '/api/branches/b1/profile-overrides/demo-extra', { env: { API_TOKEN: 'real_secret', LOG: 'info' } });
      // GET→edit→PUT round trip re-submits the masked sentinel for the unchanged key.
      const put = await request(server, 'PUT', '/api/branches/b1/profile-overrides/demo-extra', { env: { API_TOKEN: '***', LOG: 'debug' } });
      expect(put.status).toBe(200);
      // The literal sentinel must NOT be persisted — the real secret is restored, the edited key updates.
      expect(stateService.getBranch('b1')!.profileOverrides?.['demo-extra']?.env?.API_TOKEN).toBe('real_secret');
      expect(stateService.getBranch('b1')!.profileOverrides?.['demo-extra']?.env?.LOG).toBe('debug');
    });

    it('GET /api/branches/:id masks the extra-profile override env in the branch view (Codex P1)', async () => {
      seedBranch('b1');
      await request(server, 'PUT', '/api/branches/b1/extra-services', {
        extraProfiles: [{ id: 'demo-extra', name: 'demo-extra', dockerImage: 'nginx:alpine', containerPort: 80 }],
      });
      await request(server, 'PUT', '/api/branches/b1/profile-overrides/demo-extra', { env: { API_TOKEN: 'tok_overridesecret' } });
      const res = await request(server, 'GET', '/api/branches/b1');
      expect(res.status).toBe(200);
      // The branch view (also used by /branches list + stream) must redact override.env for extra profiles.
      expect((res.body as any).branch.profileOverrides['demo-extra'].env.API_TOKEN).toBe('***');
      // State still holds the real value.
      expect(stateService.getBranch('b1')!.profileOverrides?.['demo-extra']?.env?.API_TOKEN).toBe('tok_overridesecret');
    });

    it('404 for unknown branch', async () => {
      expect((await request(server, 'GET', '/api/branches/nope/extra-services')).status).toBe(404);
      expect((await request(server, 'PUT', '/api/branches/nope/extra-services', { extraProfiles: [] })).status).toBe(404);
    });
  });

  describe('GET /api/branches', () => {
    it('should return empty branches initially', async () => {
      const res = await request(server, 'GET', '/api/branches');
      expect(res.status).toBe(200);
      expect((res.body as any).branches).toEqual([]);
      expect((res.body as any).defaultBranch).toBeNull();
    });

    it('should return added branches', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'main' });
      const res = await request(server, 'GET', '/api/branches');
      expect((res.body as any).branches).toHaveLength(1);
      expect((res.body as any).branches[0].id).toBe('main');
    });

    it('returns named Web pages, deduplicates the main profile, and excludes stopped routes', async () => {
      const now = new Date().toISOString();
      config.rootDomains = ['hidden-backup.example.test', 'example.test'];
      config.previewDomain = 'example.test';
      stateService.addBuildProfile({
        id: 'admin',
        projectId: 'default',
        name: 'Main app',
        dockerImage: 'admin:latest',
        workDir: '.',
        command: 'serve',
        containerPort: 80,
        pathPrefixes: ['/'],
        subdomain: 'admin',
        webEntry: { name: 'MOS 管理端', path: '/' },
      });
      stateService.addBuildProfile({
        id: 'llmgw-web',
        projectId: 'default',
        name: 'Model gateway',
        dockerImage: 'llmgw-web:latest',
        workDir: '.',
        command: 'serve',
        containerPort: 8100,
        subdomain: 'llmgw-web',
        webEntry: { name: '模型网关控制台', path: '/console' },
      });
      stateService.addBuildProfile({
        id: 'stopped-docs',
        projectId: 'default',
        name: 'Stopped docs',
        dockerImage: 'docs:latest',
        workDir: '.',
        command: 'serve',
        containerPort: 8080,
        subdomain: 'docs',
        webEntry: { name: '帮助中心', path: '/' },
      });
      stateService.addBranch({
        id: 'dual-entry',
        projectId: 'default',
        branch: 'feature/dual-entry',
        worktreePath: path.join(tmpDir, 'worktrees', 'dual-entry'),
        status: 'running',
        services: {
          admin: {
            profileId: 'admin',
            containerName: 'cds-dual-entry-admin',
            hostPort: 18080,
            status: 'running',
          },
          'llmgw-web': {
            profileId: 'llmgw-web',
            containerName: 'cds-dual-entry-llmgw-web',
            hostPort: 18100,
            status: 'running',
          },
          'stopped-docs': {
            profileId: 'stopped-docs',
            containerName: 'cds-dual-entry-docs',
            hostPort: 18081,
            status: 'stopped',
          },
        },
        createdAt: now,
      });

      const res = await request(server, 'GET', '/api/branches?project=default');
      const branch = (res.body as any).branches.find((item: any) => item.id === 'dual-entry');

      expect(res.status).toBe(200);
      expect(branch.previewUrl).toBe('https://dual-entry-feature-default.example.test');
      expect(branch.previewUrls).toEqual([
        'https://dual-entry-feature-default.example.test',
        'https://dual-entry-feature-default-llmgw-web.example.test/console',
      ]);
      expect(branch.previewEntries).toEqual([
        {
          name: 'MOS 管理端',
          url: 'https://dual-entry-feature-default.example.test',
          serviceId: 'admin',
          primary: true,
        },
        {
          name: '模型网关控制台',
          url: 'https://dual-entry-feature-default-llmgw-web.example.test/console',
          serviceId: 'llmgw-web',
          subdomain: 'llmgw-web',
          primary: false,
        },
      ]);
      expect(branch.previewUrls.join('\n')).not.toContain('-admin.');
      expect(branch.previewUrls.join('\n')).not.toContain('stopped-docs');
      expect(branch.previewUrls.join('\n')).not.toContain('hidden-backup.example.test');
    });

    /*
     * 2026-08-06 review P2-1：显式 primary 声明在**非根路由**的 profile 上时，主入口 URL
     * 曾一律拼成主域名根，点开落到承载 `/` 的另一个应用；而它自己那条能用的 URL 又被
     * 命名子域循环跳过（profileId === primaryProfile.id），于是声明 primary 反而更糟。
     * 这条用例走真实 API，断言最终 URL 带上了它自己的挂载前缀。
     */
    it('primary declared on a prefix-mounted profile lands under that prefix', async () => {
      const now = new Date().toISOString();
      config.previewDomain = 'example.test';
      stateService.addBuildProfile({
        id: 'root-app',
        projectId: 'default',
        name: 'Root app',
        dockerImage: 'root:latest',
        workDir: '.',
        command: 'serve',
        containerPort: 80,
        pathPrefixes: ['/'],
        webEntry: { name: '管理端', path: '/' },
      });
      stateService.addBuildProfile({
        id: 'open-platform',
        projectId: 'default',
        name: 'Open platform',
        dockerImage: 'open:latest',
        workDir: '.',
        command: 'serve',
        containerPort: 8200,
        pathPrefixes: ['/open/'],
        webEntry: { name: '开放平台', path: '/', primary: true },
      });
      stateService.addBranch({
        id: 'prefix-primary',
        projectId: 'default',
        branch: 'feature/prefix-primary',
        worktreePath: path.join(tmpDir, 'worktrees', 'prefix-primary'),
        status: 'running',
        services: {
          'root-app': { profileId: 'root-app', containerName: 'cds-pp-root', hostPort: 18090, status: 'running' },
          'open-platform': { profileId: 'open-platform', containerName: 'cds-pp-open', hostPort: 18200, status: 'running' },
        },
        createdAt: now,
      });

      const res = await request(server, 'GET', '/api/branches?project=default');
      const branch = (res.body as any).branches.find((item: any) => item.id === 'prefix-primary');

      expect(res.status).toBe(200);
      // 关键断言：不是裸主域名根（那会落到 root-app），而是开放平台自己的挂载前缀
      expect(branch.previewUrl).toBe('https://prefix-primary-feature-default.example.test/open/');
      expect(branch.previewEntries[0]).toEqual({
        name: '开放平台',
        url: 'https://prefix-primary-feature-default.example.test/open/',
        serviceId: 'open-platform',
        primary: true,
      });
    });

    it('returns cached branch state by default without probing Docker', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'cached-main',
        projectId: 'default',
        branch: 'main',
        worktreePath: path.join(tmpDir, 'worktrees', 'cached-main'),
        status: 'running',
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-cached-main-api',
            hostPort: 10001,
            status: 'running',
          },
        },
        createdAt: now,
      });

      const res = await request(server, 'GET', '/api/branches?project=default');

      expect(res.status).toBe(200);
      expect((res.body as any).branches[0].services.api.status).toBe('running');
      expect(mock.commands.some((cmd) => cmd.includes('docker ps'))).toBe(false);
      expect(mock.commands.some((cmd) => cmd.includes('git log -1'))).toBe(false);
    });

    it('records timing headers and slow diagnostics for default branch snapshots without live probing', async () => {
      process.env.CDS_BRANCHES_SLOW_MS = '0';
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'timed-main',
        projectId: 'default',
        branch: 'main',
        worktreePath: path.join(tmpDir, 'worktrees', 'timed-main'),
        status: 'running',
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-timed-main-api',
            hostPort: 10001,
            status: 'running',
          },
        },
        createdAt: now,
      });

      const res = await request(server, 'GET', '/api/branches?project=default', undefined, {
        'X-CDS-Request-Id': 'req-branches-timing',
      });

      expect(res.status).toBe(200);
      expect(String(res.headers['server-timing'])).toContain('getState;dur=');
      expect(String(res.headers['server-timing'])).toContain('liveSkipped;dur=');
      expect(mock.commands.some((cmd) => cmd.includes('docker ps'))).toBe(false);
      expect(mock.commands.some((cmd) => cmd.includes('git log -1'))).toBe(false);
      const slowEvent = operationEvents.find((event) => event.action === 'branches.list.slow');
      expect(slowEvent?.source).toBe('api.branches');
      expect(slowEvent?.requestId).toBe('req-branches-timing');
      expect(slowEvent?.details?.live).toBe(false);
      expect(slowEvent?.details?.branchCount).toBeGreaterThanOrEqual(1);
      expect((slowEvent?.details?.timings as Record<string, number>)?.total).toBeGreaterThanOrEqual(0);
    });

    it('live=true explicitly reconciles branch state with Docker', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'live-main',
        projectId: 'default',
        branch: 'main',
        worktreePath: path.join(tmpDir, 'worktrees', 'live-main'),
        status: 'running',
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-live-main-api',
            hostPort: 10001,
            status: 'running',
          },
        },
        createdAt: now,
      });
      mock.addResponsePattern(/docker ps --format/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      const res = await request(server, 'GET', '/api/branches?project=default&live=true');

      expect(res.status).toBe(200);
      expect((res.body as any).branches[0].services.api.status).toBe('stopped');
      expect(mock.commands.some((cmd) => cmd.includes('docker ps'))).toBe(true);
    });

    it.each([[true, false], [false, false], [true, true]])('explicit live reconcile checks HTTP readiness=%s and concurrent operation=%s', async (ready, superseded) => {
      stateService.addBuildProfile({ id: 'worker', name: 'Worker', dockerImage: 'img', workDir: '.', command: 'run', containerPort: 9999, projectId: 'default', readinessProbe: { path: '/', noHttp: false } });
      stateService.addBranch({ id: 'replacement-ready', projectId: 'default', branch: 'main', worktreePath: path.join(tmpDir, 'worktrees', 'replacement-ready'), status: 'error', services: {}, createdAt: new Date().toISOString() });
      const branch = stateService.getBranch('replacement-ready')!;
      branch.status = 'error';
      branch.services = {
        worker: { profileId: 'worker', containerName: 'cds-worker', hostPort: 10001, status: 'error', errorMessage: '旧容器退出 kind=cds-pre-run-replace' },
        failed: { profileId: 'failed', containerName: 'cds-failed', hostPort: 10002, status: 'error', errorMessage: '应用启动失败' },
      };
      mock.addResponsePattern(/docker ps --format/, () => ({ stdout: 'cds-worker\ncds-failed', stderr: '', exitCode: 0 }));
      const check = vi.spyOn(containerService, 'waitForReadiness').mockImplementation(async () => {
        if (superseded) branchOperationCoordinator.begin({ branchId: branch.id, kind: 'stop', trigger: 'manual' });
        return ready;
      });
      try {
        await request(server, 'GET', '/api/branches?project=default');
        expect(check).not.toHaveBeenCalled();
        const res = await request(server, 'GET', '/api/branches?project=default&live=true');
        expect(res.status).toBe(200);
        expect(check).toHaveBeenCalledOnce();
        expect(check).toHaveBeenCalledWith(10001, { path: '/', noHttp: false, timeoutSeconds: 3, intervalSeconds: 1 }, undefined, undefined, 'cds-worker');
        expect(branch.services.worker.status).toBe(ready && !superseded ? 'running' : 'error');
        expect(branch.services.worker.errorMessage).toBe(ready && !superseded ? undefined : '旧容器退出 kind=cds-pre-run-replace');
        expect(branch.services.failed.status).toBe('error');
        expect(branch.services.failed.errorMessage).toBe('应用启动失败');
      } finally { check.mockRestore(); }
    });

    it('P4 Part 3b: filters by ?project= query param', async () => {
      // The migration creates a legacy 'default' project automatically,
      // but we need an 'alt' project to exist before POST /branches
      // will accept a branch stamped with projectId='alt'.
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'alt',
        slug: 'alt',
        name: 'Alt Project',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });

      // Seed: one branch on the legacy default project, one on 'alt'
      await request(server, 'POST', '/api/branches', {
        branch: 'legacy-branch',
      });
      await request(server, 'POST', '/api/branches', {
        branch: 'alt-branch',
        projectId: 'alt',
      });

      // Default filter → only legacy
      const legacyRes = await request(server, 'GET', '/api/branches?project=default');
      const legacyBranches = (legacyRes.body as any).branches;
      expect(legacyBranches.map((b: any) => b.id)).toEqual(['legacy-branch']);

      // Alt filter → only alt. Non-legacy projects auto-prefix branch
      // IDs with the project slug so two projects can share a branch
      // name (e.g. both having "main"); the legacy project keeps the
      // bare slug for back-compat.
      const altRes = await request(server, 'GET', '/api/branches?project=alt');
      const altBranches = (altRes.body as any).branches;
      expect(altBranches.map((b: any) => b.id)).toEqual(['alt-alt-branch']);

      stateService.addProject({
        id: 'p-alt-slug',
        slug: 'alt-slug',
        name: 'Alt Slug Project',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });
      await request(server, 'POST', '/api/branches', {
        branch: 'slug-branch',
        projectId: 'p-alt-slug',
      });
      const altSlugRes = await request(server, 'GET', '/api/branches?project=alt-slug');
      const altSlugBranches = (altSlugRes.body as any).branches;
      expect(altSlugBranches.map((b: any) => b.id)).toEqual(['alt-slug-slug-branch']);

      // No filter → both
      const allRes = await request(server, 'GET', '/api/branches');
      expect((allRes.body as any).branches).toHaveLength(3);
    });

    it('P4 Part 3b: POST rejects an unknown projectId with 400', async () => {
      const res = await request(server, 'POST', '/api/branches', {
        branch: 'x',
        projectId: 'no-such-project',
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain('未知项目');
    });

    it('P4 Part 3b: POST stamps the projectId onto the created branch', async () => {
      // 'alt' project will exist because addBranch pre-validates it.
      // We use the default project id to exercise the happy path since
      // that's guaranteed to exist after StateService.migrateProjects().
      const res = await request(server, 'POST', '/api/branches', {
        branch: 'stamped',
        projectId: 'default',
      });
      expect(res.status).toBe(201);
      expect((res.body as any).branch.projectId).toBe('default');
    });

    // P4 Part 18 (G1.5): a branch cannot be created under a project
    // whose clone hasn't finished. The guard triggers on any
    // non-'ready' cloneStatus and preserves legacy projects (whose
    // cloneStatus is simply absent) unchanged.
    describe('P4 Part 18 (G1.5): project not-ready guard', () => {
      const NOW = new Date().toISOString();

      function addProject(id: string, cloneStatus?: 'pending' | 'cloning' | 'ready' | 'error', cloneError?: string) {
        stateService.addProject({
          id,
          slug: id,
          name: id,
          kind: 'git',
          createdAt: NOW,
          updatedAt: NOW,
          ...(cloneStatus ? { cloneStatus } : {}),
          ...(cloneError ? { cloneError } : {}),
          ...(cloneStatus ? { repoPath: `/test-repos/${id}` } : {}),
        });
      }

      it('refuses with 409 when cloneStatus is pending', async () => {
        addProject('p-pending', 'pending');
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'x',
          projectId: 'p-pending',
        });
        expect(res.status).toBe(409);
        expect((res.body as any).error).toBe('project_not_ready');
        expect((res.body as any).cloneStatus).toBe('pending');
      });

      it('refuses with 409 when cloneStatus is cloning', async () => {
        addProject('p-cloning', 'cloning');
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'x',
          projectId: 'p-cloning',
        });
        expect(res.status).toBe(409);
        expect((res.body as any).cloneStatus).toBe('cloning');
      });

      it('refuses with 409 when cloneStatus is error and surfaces cloneError', async () => {
        addProject('p-error', 'error', 'fatal: repository not found');
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'x',
          projectId: 'p-error',
        });
        expect(res.status).toBe(409);
        expect((res.body as any).cloneStatus).toBe('error');
        expect((res.body as any).message).toContain('fatal: repository not found');
      });

      it('allows when cloneStatus is ready', async () => {
        addProject('p-ready', 'ready');
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'ready-branch',
          projectId: 'p-ready',
        });
        expect(res.status).toBe(201);
      });

      it('legacy project (no cloneStatus) is unaffected by the guard', async () => {
        // The migration creates 'default' without cloneStatus — legacy
        // single-repo behaviour. POST /branches should still work.
        const res = await request(server, 'POST', '/api/branches', {
          branch: 'legacy-flow',
          projectId: 'default',
        });
        expect(res.status).toBe(201);
      });
    });
  });

  describe('POST /api/branches/:id/pull', () => {
    it('should pull latest code', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'POST', '/api/branches/feature-test/pull');
      expect(res.status).toBe(200);
      expect((res.body as any).head).toBeDefined();
      expect(stateService.getBranch('feature-test')?.lastPullAt).toBeDefined();
      expect(stateService.getProject('default')?.lastPullAt).toBeDefined();
    });

    it('pulls a real git project branch named cds-managed-runtime', async () => {
      stateService.addBranch({
        id: 'regular-runtime',
        projectId: 'default',
        branch: 'cds-managed-runtime',
        worktreePath: path.join(tmpDir, 'worktrees', 'regular-runtime'),
        status: 'running',
        services: {},
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
        githubCommitSha: 'abc1234',
      });
      mock.commands.length = 0;

      const res = await request(server, 'POST', '/api/branches/regular-runtime/pull');

      expect(res.status).toBe(200);
      expect((res.body as any).skipped).toBeUndefined();
      expect(mock.commands.some(command => command.includes('git fetch'))).toBe(true);
    });

    it('skips pull only for the shared-service synthetic cds-managed-runtime branch', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'shared-sidecar-pool',
        slug: 'shared-sidecar-pool',
        name: 'Shared Sidecar Pool',
        kind: 'shared-service',
        createdAt: now,
        updatedAt: now,
      });
      stateService.addBranch({
        id: 'shared-runtime',
        projectId: 'shared-sidecar-pool',
        branch: 'cds-managed-runtime',
        worktreePath: path.join(tmpDir, 'worktrees', 'shared-runtime'),
        status: 'running',
        services: {},
        createdAt: now,
        lastAccessedAt: now,
        githubCommitSha: 'cds-managed-runtime',
      });
      mock.commands.length = 0;

      const res = await request(server, 'POST', '/api/branches/shared-runtime/pull');

      expect(res.status).toBe(200);
      expect((res.body as any).skipped).toBe(true);
      expect((res.body as any).reason).toBe('synthetic-cds-managed-runtime');
      expect(mock.commands.some(command => command.includes('git fetch'))).toBe(false);
    });

    it('does not skip pull when only the synthetic SHA sentinel matches', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'shared-sidecar-pool',
        slug: 'shared-sidecar-pool',
        name: 'Shared Sidecar Pool',
        kind: 'shared-service',
        createdAt: now,
        updatedAt: now,
      });
      stateService.addBranch({
        id: 'shared-runtime-stale-sha',
        projectId: 'shared-sidecar-pool',
        branch: 'feature/runtime',
        worktreePath: path.join(tmpDir, 'worktrees', 'shared-runtime-stale-sha'),
        status: 'running',
        services: {},
        createdAt: now,
        lastAccessedAt: now,
        githubCommitSha: 'cds-managed-runtime',
      });
      mock.commands.length = 0;

      const res = await request(server, 'POST', '/api/branches/shared-runtime-stale-sha/pull');

      expect(res.status).toBe(200);
      expect((res.body as any).skipped).toBeUndefined();
      expect(mock.commands.some(command => command.includes('git fetch'))).toBe(true);
    });

    it('should return 404 for unknown branch', async () => {
      const res = await request(server, 'POST', '/api/branches/nope/pull');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/branches/:id/stop', () => {
    it('should stop all services', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'POST', '/api/branches/feature-test/stop');
      expect(res.status).toBe(200);
      expect(stateService.getBranch('feature-test')?.lastStopSource).toBe('user');
      expect(stateService.getBranch('feature-test')?.lastStopReason).toBe('用户手动停止');
      const operationActions = operationEvents
        .filter((event) => event.branchId === 'feature-test')
        .map((event) => event.action);
      expect(operationActions).toContain('branch.operation.started');
      expect(operationActions).toContain('branch.operation.completed');
    });

    it('实际停止失败仍在运行时返回失败，保留服务事实并继续停止其他服务', async () => {
      const branch: BranchEntry = { id: 'stop-failed', projectId: 'default', branch: 'stop-failed', worktreePath: tmpDir,
        status: 'running', createdAt: new Date().toISOString(), services: {
          api: { profileId: 'api', containerName: 'stop-failed-api', hostPort: 10001, status: 'running' },
          web: { profileId: 'web', containerName: 'stop-failed-web', hostPort: 10002, status: 'running' },
        } };
      stateService.addBranch(branch); await stateService.flush();
      mock.addResponsePatternFirst(/^docker stop stop-failed-api$/, () => ({ stdout: '', stderr: 'isolated daemon unavailable', exitCode: 1 }));
      mock.addResponsePatternFirst(/^docker inspect 'stop-failed-api'$/, () => ({ stdout: JSON.stringify([{ Id: 'a'.repeat(64), State: { Status: 'running', Running: true } }]), stderr: '', exitCode: 0 }));
      const result = await request(server, 'POST', '/api/branches/stop-failed/stop');
      expect(result.status).toBe(503);
      expect(branch.status).toBe('error'); expect(branch.services.api.status).toBe('running');
      expect(branch.services.api.errorMessage).toContain('停止'); expect(branch.services.web.status).toBe('stopped');
      expect(branch.lastStoppedAt).toBeUndefined(); expect(branch.stopCount || 0).toBe(0);
      expect(mock.commands).toContain('docker stop stop-failed-web');
      const reopened = new StateService(path.join(tmpDir, 'state.json')); reopened.load();
      expect(reopened.getBranch(branch.id)?.services.api.status).toBe('running');
      expect(JSON.stringify(result.body)).not.toContain('isolated daemon unavailable');
    });

    it('attributes webhook-triggered stops to webhook instead of user', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/webhook-stop' });
      const res = await request(
        server,
        'POST',
        '/api/branches/feature-webhook-stop/stop',
        undefined,
        { 'X-CDS-Trigger': 'webhook' },
      );
      expect(res.status).toBe(200);
      expect(stateService.getBranch('feature-webhook-stop')?.lastStopSource).toBe('webhook');
      expect(stateService.getBranch('feature-webhook-stop')?.lastStopReason).toBe('GitHub webhook 触发停止');
    });

    it('preserves webhook attribution when stopping a remote executor branch', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'remote-webhook-stop',
        projectId: 'default',
        branch: 'feature/remote-webhook-stop',
        worktreePath: path.join(tmpDir, 'worktrees', 'remote-webhook-stop'),
        status: 'running',
        createdAt: now,
        executorId: 'exec-1',
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-remote-webhook-stop-api',
            hostPort: 10001,
            status: 'running',
          },
        },
      });
      registryNodes.push({
        id: 'exec-1',
        host: '127.0.0.1',
        port: 9101,
        status: 'online',
        role: 'remote',
        labels: [],
        branches: ['remote-webhook-stop'],
        capacity: { maxBranches: 10, memoryMB: 1024, cpuCores: 2 },
        load: { memoryUsedMB: 0, cpuPercent: 0 },
        registeredAt: now,
        lastHeartbeat: now,
      });
      const fetchCalls: Array<{ url: string; body: any }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch;

      try {
        const res = await request(
          server,
          'POST',
          '/api/branches/remote-webhook-stop/stop',
          undefined,
          { 'X-CDS-Trigger': 'webhook' },
        );

        expect(res.status).toBe(200);
        expect(fetchCalls[0]?.body?.trigger).toBe('webhook');
        expect(stateService.getBranch('remote-webhook-stop')?.lastStopSource).toBe('webhook');
        expect(stateService.getBranch('remote-webhook-stop')?.lastStopReason).toContain('GitHub webhook 触发停止');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('POST /api/branches/cleanup-damaged-containers', () => {
    it('removes only non-running damaged services and records branch operations', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'damaged-branch',
        projectId: 'default',
        branch: 'feature/damaged',
        worktreePath: path.join(tmpDir, 'worktrees', 'damaged-branch'),
        status: 'error',
        createdAt: now,
        services: {
          api: {
            profileId: 'api',
            containerName: 'missing-api',
            hostPort: 10001,
            status: 'error',
          },
          web: {
            profileId: 'web',
            containerName: 'running-web',
            hostPort: 10002,
            status: 'running',
          },
        },
      });
      mock.addResponse('docker ps --format "{{.Names}}"', {
        stdout: 'running-web\n',
        stderr: '',
        exitCode: 0,
      });

      const res = await request(server, 'POST', '/api/branches/cleanup-damaged-containers');

      expect(res.status).toBe(200);
      expect((res.body as any).removedCount).toBe(1);
      expect((res.body as any).skippedRunningCount).toBe(1);
      const branch = stateService.getBranch('damaged-branch')!;
      expect(branch.services.api).toBeUndefined();
      expect(branch.services.web).toBeDefined();
      const cleanupEvent = operationEvents.find((event) => event.source === 'bulk-damaged-container-cleanup');
      expect(cleanupEvent?.action).toBe('app.damaged-containers.cleanup');
      expect(cleanupEvent?.details?.removed).toEqual([
        expect.objectContaining({ branchId: 'damaged-branch', profileId: 'api', containerName: 'missing-api' }),
      ]);
      expect(cleanupEvent?.details?.skippedRunning).toEqual([
        expect.objectContaining({ branchId: 'damaged-branch', profileId: 'web', containerName: 'running-web' }),
      ]);
      const operationActions = operationEvents
        .filter((event) => event.branchId === 'damaged-branch')
        .map((event) => event.action);
      expect(operationActions).toContain('branch.operation.started');
      expect(operationActions).toContain('branch.operation.completed');
    });

    it('keeps building, starting, restarting, and actually running services during damaged cleanup', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'mixed-damaged',
        projectId: 'default',
        branch: 'feature/mixed-damaged',
        worktreePath: path.join(tmpDir, 'worktrees', 'mixed-damaged'),
        status: 'error',
        createdAt: now,
        services: {
          missing: {
            profileId: 'missing',
            containerName: 'missing-container',
            hostPort: 10001,
            status: 'error',
          },
          building: {
            profileId: 'building',
            containerName: 'building-container',
            hostPort: 10002,
            status: 'building',
          },
          starting: {
            profileId: 'starting',
            containerName: 'starting-container',
            hostPort: 10003,
            status: 'starting',
          },
          restarting: {
            profileId: 'restarting',
            containerName: 'restarting-container',
            hostPort: 10004,
            status: 'restarting',
          },
          staleButRunning: {
            profileId: 'staleButRunning',
            containerName: 'stale-running-container',
            hostPort: 10005,
            status: 'error',
          },
        },
      });
      mock.addResponse('docker ps --format "{{.Names}}"', {
        stdout: 'stale-running-container\n',
        stderr: '',
        exitCode: 0,
      });

      const res = await request(server, 'POST', '/api/branches/cleanup-damaged-containers');

      expect(res.status).toBe(200);
      expect((res.body as any).removedCount).toBe(1);
      expect((res.body as any).skippedRunningCount).toBe(4);
      const branch = stateService.getBranch('mixed-damaged')!;
      expect(Object.keys(branch.services).sort()).toEqual([
        'building',
        'restarting',
        'staleButRunning',
        'starting',
      ]);
      expect(mock.commands.some((command) => command.includes('docker rm missing-container'))).toBe(true);
      expect(mock.commands.some((command) => command.includes('docker rm building-container'))).toBe(false);
      expect(mock.commands.some((command) => command.includes('docker rm starting-container'))).toBe(false);
      expect(mock.commands.some((command) => command.includes('docker rm restarting-container'))).toBe(false);
      expect(mock.commands.some((command) => command.includes('docker rm stale-running-container'))).toBe(false);
      const cleanupEvent = operationEvents.find((event) => event.source === 'bulk-damaged-container-cleanup');
      expect(cleanupEvent?.details?.removed).toEqual([
        expect.objectContaining({ branchId: 'mixed-damaged', profileId: 'missing', containerName: 'missing-container' }),
      ]);
      expect(cleanupEvent?.details?.skippedRunning).toEqual(expect.arrayContaining([
        expect.objectContaining({ branchId: 'mixed-damaged', profileId: 'building', containerName: 'building-container' }),
        expect.objectContaining({ branchId: 'mixed-damaged', profileId: 'starting', containerName: 'starting-container' }),
        expect.objectContaining({ branchId: 'mixed-damaged', profileId: 'restarting', containerName: 'restarting-container' }),
        expect.objectContaining({ branchId: 'mixed-damaged', profileId: 'staleButRunning', containerName: 'stale-running-container' }),
      ]));
    });
  });

  describe('POST /api/branches/cleanup-orphan-containers', () => {
    it('runs orphan removals through branch operation fencing and container diagnostics', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'orphan-host',
        projectId: 'default',
        branch: 'feature/orphan-host',
        worktreePath: path.join(tmpDir, 'worktrees', 'orphan-host'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      mock.addResponsePattern(/docker ps -a --filter "label=cds\.managed=true"/, () => ({
        stdout: [
          'orphan-api|exited|cds.managed=true,cds.type=app,cds.branch.id=orphan-host,cds.profile.id=api,cds.network=cds-network',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }));

      const res = await request(server, 'POST', '/api/branches/cleanup-orphan-containers?includeStopped=true');

      expect(res.status).toBe(200);
      expect((res.body as any).removed).toEqual([
        expect.objectContaining({ branchId: 'orphan-host', profileId: 'api', containerName: 'orphan-api' }),
      ]);
      const opEvents = operationEvents.filter((event) => event.branchId === 'orphan-host');
      const started = opEvents.find((event) => event.action === 'branch.operation.started');
      const completed = opEvents.find((event) => event.action === 'branch.operation.completed');
      expect(started?.details).toMatchObject({
        kind: 'cleanup-orphans',
        source: 'api.cleanup-orphan-containers',
      });
      expect(completed?.operationId).toBe(started?.operationId);
      expect(mock.commands.some((command) => command.includes('docker stop orphan-api'))).toBe(true);
      expect(mock.commands.some((command) => command.includes('docker rm orphan-api'))).toBe(true);
    });
  });

  describe('POST /api/cleanup-cross-project-services', () => {
    it('skips polluted service cleanup while the branch has an active lifecycle operation', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'cross-cleanup-busy',
        projectId: 'default',
        branch: 'feature/cross-cleanup-busy',
        worktreePath: path.join(tmpDir, 'worktrees', 'cross-cleanup-busy'),
        status: 'idle',
        createdAt: now,
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-cross-cleanup-busy-api',
            hostPort: 10001,
            status: 'idle',
          },
          foreign: {
            profileId: 'foreign',
            containerName: 'cds-cross-cleanup-busy-foreign',
            hostPort: 10002,
            status: 'running',
          },
        },
      });
      stateService.save();

      let releaseRun!: () => void;
      const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
      let markRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        // Block the deploy at its OWN pre-pull orphan removal of `foreign` (deploy now reconciles the
        // desired profile set before git pull — Codex P2). At this point the deploy holds the branch
        // lease and `foreign` is still in entry.services (removal awaiting), so the cross-project sweep
        // must observe the active operation and skip — the realistic busy-skip window.
        if (command.includes('docker stop cds-cross-cleanup-busy-foreign')) {
          markRunStarted();
          await runRelease;
          return { stdout: 'cds-cross-cleanup-busy-foreign', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const deployPromise = request(server, 'POST', '/api/branches/cross-cleanup-busy/deploy');
      try {
        await runStarted;

        const cleanup = await request(
          server,
          'POST',
          '/api/cleanup-cross-project-services',
          undefined,
          { 'X-CDS-Request-Id': 'req-cross-cleanup' },
        );

        expect(cleanup.status).toBe(200);
        expect((cleanup.body as any).trimmedCount).toBe(0);
        expect((cleanup.body as any).skippedBusyCount).toBe(1);
        expect(stateService.getBranch('cross-cleanup-busy')?.services.foreign).toBeTruthy();
        expect(mock.commands.some((command) => command.includes('docker rm -f cds-cross-cleanup-busy-foreign'))).toBe(false);
        const skipped = operationEvents.find((event) => event.action === 'app.cross-project-service.cleanup-skipped');
        expect(skipped?.requestId).toBe('req-cross-cleanup');
        expect(skipped?.branchId).toBe('cross-cleanup-busy');
        expect(skipped?.operationKind).toBe('deploy');
      } finally {
        releaseRun();
      }
      const deploy = await deployPromise;
      expect(deploy.status).toBe(200);
      expect(String(deploy.body)).toContain('event: deployment-run');
      const localRunId = String(deploy.headers['x-cds-deployment-run-id']);
      const localRun = deploymentRunService.get(localRunId);
      expect(localRun).toMatchObject({
        branchId: 'cross-cleanup-busy',
        status: 'running',
        phase: 'complete',
      });
      expect(localRun?.events.map((event) => event.status)).toEqual(expect.arrayContaining([
        'pending', 'preparing', 'building', 'starting', 'verifying', 'running',
      ]));
    });

    it('removes orphan services BEFORE the pull so a later pull failure cannot leave ghosts (Codex P2)', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api', name: 'API', dockerImage: 'node', command: 'node server.js', workDir: '.', containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'orphan-prepull',
        projectId: 'default',
        branch: 'feature/orphan-prepull',
        worktreePath: path.join(tmpDir, 'worktrees', 'orphan-prepull'),
        status: 'running',
        createdAt: now,
        services: {
          api: { profileId: 'api', containerName: 'cds-orphan-prepull-api', hostPort: 10001, status: 'running' },
          // demo-extra is NOT in the desired profile set → an orphan to be torn down.
          'demo-extra': { profileId: 'demo-extra', containerName: 'cds-orphan-prepull-demo-extra', hostPort: 10002, status: 'running' },
        },
      });
      stateService.save();

      // Fail the pull (git reset --hard) for THIS branch's worktree — a fallible step AFTER the
      // pre-pull orphan cleanup. If cleanup ran late (in finalize), the failed pull would skip it and
      // leave demo-extra as a ghost.
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (command.includes('git fetch') && options?.cwd?.includes('orphan-prepull')) {
          throw new Error('simulated pull failure');
        }
        return originalExec(command, options);
      };
      try {
        const res = await request(server, 'POST', '/api/branches/orphan-prepull/deploy');
        expect(res.status).toBe(200); // SSE; the failure is an in-stream error event
      } finally {
        mock.exec = originalExec;
      }

      // Orphan torn down pre-pull → no ghost: container removed + state row dropped.
      expect(stateService.getBranch('orphan-prepull')?.services['demo-extra']).toBeUndefined();
      expect(mock.commands.some((c) => c.includes('docker rm cds-orphan-prepull-demo-extra'))).toBe(true);
      // The still-desired api service is untouched by orphan cleanup.
      expect(stateService.getBranch('orphan-prepull')?.services['api']).toBeTruthy();
      // The deploy itself ends in error because the pull failed.
      expect(stateService.getBranch('orphan-prepull')?.status).toBe('error');
    });
  });

  it.each([['/deploy',''], ['/deploy/api',''], ['/deploy','node dist/server.js'], ['/deploy/api','node dist/server.js']])('pure image %s command %s resolves its target without creating a detached source tree', async (endpoint,command) => {
    const sha = 'b'.repeat(40);
    stateService.addBuildProfile({ id: 'api', projectId: 'default', name: 'API',
      dockerImage: `ghcr.io/acme/api:sha-${sha}`, prebuiltImage: true, command, workDir: '.', containerPort: 3000 });
    stateService.addBranch({ id: 'image-without-source', projectId: 'default', branch: 'feature/image-only',
      worktreePath: path.join(tmpDir, 'worktrees', 'image-without-source'), status: 'idle', services: {}, createdAt: new Date().toISOString() });
    mock.addResponsePatternFirst(/git rev-parse/, () => ({ stdout: sha, stderr: '', exitCode: 0 }));
    mock.addResponsePatternFirst(/git ls-tree/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    readyArtifactFixture();
    const response = await request(server, 'POST', `/api/branches/image-without-source${endpoint}`, { commitSha: sha });
    expect((await waitForAcceptedRun(response)).status).toBe('running');
    expect(mock.commands.some(command => command.includes('git fetch'))).toBe(true);
    expect(mock.commands.filter(command => command.includes('git worktree add --detach'))).toEqual([]);
    expect(fs.existsSync(WorktreeService.deploymentSourceRootFor(stateService.getBranch('image-without-source')!.worktreePath))).toBe(false);
  });

  it.each([true,false])('image deploy initializes only target-commit scripts (target has init: %s)',async targetHasInit=>{
    const sha='b'.repeat(40),canonical=path.join(tmpDir,'worktrees','image-db-target');
    fs.mkdirSync(canonical,{recursive:true});fs.writeFileSync(path.join(canonical,'manage.py'),'canonical B must not run');
    stateService.addBuildProfile({id:'api',projectId:'default',name:'API',dockerImage:`ghcr.io/acme/api:sha-${sha}`,prebuiltImage:true,command:'node dist/server.js',workDir:'.',containerPort:3000});
    stateService.addBranch({id:'image-db-target',projectId:'default',branch:'feature/image-db',worktreePath:canonical,status:'idle',services:{},createdAt:new Date().toISOString()});
    mock.addResponsePatternFirst(/git rev-parse/,()=>({stdout:sha,stderr:'',exitCode:0}));
    mock.addResponsePatternFirst(/git ls-tree/,()=>({stdout:targetHasInit?'manage.py\0':'',stderr:'',exitCode:0}));
    mock.addResponsePatternFirst(/git worktree add --detach '([^']+)'/,match=>{
      fs.mkdirSync(match[1],{recursive:true});fs.writeFileSync(path.join(match[1],'manage.py'),'target A only');return{stdout:'',stderr:'',exitCode:0};
    });
    const migration=vi.spyOn(containerService,'runProfileCommand').mockImplementation(async entry=>{
      expect(entry.worktreePath).not.toBe(canonical);
      expect(fs.readFileSync(path.join(entry.worktreePath,'manage.py'),'utf8')).toBe('target A only');
      return{stdout:'migration done',stderr:'',exitCode:0};
    });
    readyArtifactFixture();
    try{
      const response=await request(server,'POST','/api/branches/image-db-target/deploy',{commitSha:sha});
      expect((await waitForAcceptedRun(response)).status).toBe('running');
      expect(migration).toHaveBeenCalledTimes(targetHasInit?1:0);
      expect(fs.readFileSync(path.join(canonical,'manage.py'),'utf8')).toBe('canonical B must not run');
    }finally{migration.mockRestore();}
  });

  describe('immutable deployment version reuse', () => {
    it('creates a reusable version and redeploys the same commit without pulling source again', async () => {
      const commitSha = '1234567890abcdef1234567890abcdef12345678';
      const image = `ghcr.io/acme/api:sha-${commitSha}`;
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: image,
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
        prebuiltImage: true,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'version-reuse',
        projectId: 'default',
        branch: 'feature/version-reuse',
        worktreePath: path.join(tmpDir, 'worktrees', 'version-reuse'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      stateService.save();
      // pull 后 worktree 真实停在被请求的那个 commit —— 全局 fixture 默认返回一个
      // 与之无关的 'abc1234'，而部署台账现在按**实际落地的 sha** 记（Codex PR #1275
      // 四轮 P2），不再照抄 entry.githubCommitSha。真实 git 下这两者本就一致，这里
      // 把 fixture 对齐到现实，否则测的是一个现实中不存在的错位场景。
      mock.addResponsePatternFirst(/git log --oneline/, () => ({ stdout: `${commitSha} some commit`, stderr: '', exitCode: 0 }));
      mock.addResponsePatternFirst(/git rev-parse/, () => ({ stdout: commitSha, stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker pull .*ghcr\.io\/acme\/api:sha-/, () => ({ stdout: 'pulled', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker ps -a --filter/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker ps -aq --filter/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      readyArtifactFixture();
      const first = await request(server, 'POST', '/api/branches/version-reuse/deploy', { commitSha });
      expect(first.status).toBe(200);
      const firstRun = await waitForAcceptedRun(first);
      expect(firstRun.status).toBe('running');
      const branchAfterFirst = stateService.getBranch('version-reuse');
      const versionId = branchAfterFirst?.currentVersionId;
      expect(versionId).toMatch(/^dv_/);
      expect(deploymentVersionService.get(versionId!)).toMatchObject({
        commitSha,
        profiles: [expect.objectContaining({ artifactImage: image + `@sha256:${commitSha + commitSha.slice(0, 24)}`, reusable: true })],
      });
      const sourcePullCount = mock.commands.filter((command) => command.includes('git fetch')).length;

      const second = await request(server, 'POST', '/api/branches/version-reuse/deploy', { commitSha });
      expect(second.status).toBe(200);
      await waitForAcceptedRun(second);
      expect(mock.commands.filter((command) => command.includes('git fetch'))).toHaveLength(sourcePullCount);
      const secondRunId = String(second.headers['x-cds-deployment-run-id']);
      expect(deploymentRunService.get(secondRunId)).toMatchObject({
        versionId,
        status: 'running',
        phase: 'complete',
      });
      expect(stateService.getDeploymentVersions({ branchId: 'version-reuse' })).toHaveLength(1);
    });

    it('deploys a managed project without a hand-authored BuildProfile and reuses its local artifact', async () => {
      const commitSha = 'abcdef1234567890abcdef1234567890abcdef12';
      const worktreePath = path.join(tmpDir, 'worktrees', 'managed-auto');
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.writeFileSync(path.join(worktreePath, 'package.json'), JSON.stringify({
        scripts: { build: 'vite build', start: 'vite --host 0.0.0.0' },
        dependencies: { vite: '^6.0.0', react: '^18.0.0' },
      }));
      const project = stateService.getProject('default')!;
      project.deliveryMode = 'managed';
      project.managedSpec = {
        apps: [{ id: 'web', appPath: '.', workload: 'web', health: { type: 'http', path: '/' } }],
        capabilities: [],
      };
      stateService.addBranch({
        id: 'managed-auto',
        projectId: 'default',
        branch: 'feature/managed-auto',
        worktreePath,
        status: 'idle',
        createdAt: new Date().toISOString(),
        services: {},
      });
      stateService.save();
      // pull 后 worktree 真实停在被请求的那个 commit —— 全局 fixture 默认返回一个
      // 与之无关的 'abc1234'，而部署台账现在按**实际落地的 sha** 记（Codex PR #1275
      // 四轮 P2），不再照抄 entry.githubCommitSha。真实 git 下这两者本就一致，这里
      // 把 fixture 对齐到现实，否则测的是一个现实中不存在的错位场景。
      mock.addResponsePatternFirst(/git log --oneline/, () => ({ stdout: `${commitSha} some commit`, stderr: '', exitCode: 0 }));
      mock.addResponsePatternFirst(/git rev-parse/, () => ({ stdout: commitSha, stderr: '', exitCode: 0 }));
      const contentId = `sha256:${'9'.repeat(64)}`; let built = false, contractHash = '';
      mock.addResponsePatternFirst(/docker info/, () => ({ stdout: JSON.stringify({ OSType: 'linux', Architecture: 'amd64' }), stderr: '', exitCode: 0 }));
      mock.addResponsePatternFirst(/docker image inspect (.*)/, match => {
        if (!built) return { stdout: '', stderr: 'No such image', exitCode: 1 };
        const labels = { 'org.opencontainers.image.revision': commitSha, 'cds.managed.contract': contractHash };
        return { stdout: JSON.stringify(match[1].includes('--format') ? labels : [{ Id: contentId, Os: 'linux', Architecture: 'amd64', Config: { Labels: labels } }]), stderr: '', exitCode: 0 };
      });
      mock.addResponsePattern(/docker create .*managed-build/, () => ({ stdout: 'builder', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker cp/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/docker exec .*managed-build/, () => ({ stdout: 'built', stderr: '', exitCode: 0 }));
      mock.addResponsePatternFirst(/docker commit (.*)/, match => { built = true; contractHash = match[1].match(/LABEL cds\.managed\.contract=([a-f0-9]{64})/)?.[1] || ''; return { stdout: contentId, stderr: '', exitCode: 0 }; });
      mock.addResponsePattern(/docker start .*managed-build/, () => ({ stdout: '', stderr: '', exitCode: 0 }));

      expect(stateService.getBuildProfilesForProject('default')).toEqual([]);
      const first = await request(server, 'POST', '/api/branches/managed-auto/deploy', { commitSha });
      expect(first.status).toBe(200);
      expect((await waitForAcceptedRun(first)).status).toBe('running');
      expect(stateService.getBranch('managed-auto')?.services.web.deployedImage).toBe(contentId);
      expect(stateService.getBuildProfilesForProject('default')[0]).toMatchObject({
        id: 'web',
        managedBuild: { artifactImage: expect.stringMatching(/^cds-managed\//) },
      });
      const versionId = stateService.getBranch('managed-auto')?.currentVersionId;
      expect(deploymentVersionService.get(versionId!)?.profiles[0]).toMatchObject({
        artifactKind: 'managed-image',
        reusable: true,
      });
      const buildExecCount = mock.commands.filter((command) => command.includes('docker exec') && command.includes('managed-build')).length;
      const sourcePullCount = mock.commands.filter((command) => command.includes('git fetch')).length;

      const second = await request(server, 'POST', '/api/branches/managed-auto/deploy', { commitSha });
      expect(second.status).toBe(200);
      expect(String(second.body)).toContain('已锁定版本');
      expect(String(second.body)).not.toContain('npm install && npm run build');
      expect(mock.commands.filter((command) => command.includes('docker exec') && command.includes('managed-build'))).toHaveLength(buildExecCount);
      expect(mock.commands.filter((command) => command.includes('git fetch'))).toHaveLength(sourcePullCount);
      expect(stateService.getDeploymentVersions({ branchId: 'managed-auto' })).toHaveLength(1);
    });
  });

  describe('structured deployment diagnosis', () => {
    it('classifies the first concrete build error and keeps evidence references on the run', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api', name: 'API', dockerImage: 'node:22', command: 'pnpm build && pnpm start', workDir: '.', containerPort: 3000,
      });
      stateService.addBranch({
        id: 'structured-failure', projectId: 'default', branch: 'feature/structured-failure',
        worktreePath: path.join(tmpDir, 'worktrees', 'structured-failure'), status: 'idle',
        createdAt: new Date().toISOString(), services: {},
      });
      stateService.save();
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command) && command.includes('cds-structured-failure-api')) {
          return { stdout: '', stderr: 'src/index.ts(4,2): error TS2322: Type string is not assignable', exitCode: 1 };
        }
        return originalExec(command, options);
      };
      try {
        const response = await request(server, 'POST', '/api/branches/structured-failure/deploy');
        const runId = String(response.headers['x-cds-deployment-run-id']);
        expect(deploymentRunService.get(runId)?.failure).toMatchObject({
          code: 'build.compile.typescript',
          owner: 'code',
          retryable: false,
          serviceId: 'api',
        });
        expect(deploymentRunService.get(runId)?.failure?.evidenceRefs).toEqual(expect.arrayContaining([
          `deployment-run:${runId}`,
          expect.stringMatching(new RegExp(`^deployment-run:${runId}:event:`)),
          'service:structured-failure:api',
        ]));
      } finally {
        mock.exec = originalExec;
      }
    });
  });

  describe('POST /api/branches/:id/force-rebuild/:profileId', () => {
    it('can reserve the next deploy as the same operation chain', async () => {
      const now = new Date().toISOString();
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      stateService.addBranch({
        id: 'force-branch',
        projectId: 'default',
        branch: 'feature/force',
        worktreePath: path.join(tmpDir, 'worktrees', 'force-branch'),
        status: 'running',
        createdAt: now,
        services: {
          api: {
            profileId: 'api',
            containerName: 'force-api',
            hostPort: 10001,
            status: 'running',
          },
        },
      });
      mock.addResponsePattern(/find .* -type d .* echo done/, () => ({ stdout: 'done\n', stderr: '', exitCode: 0 }));

      const res = await request(server, 'POST', '/api/branches/force-branch/force-rebuild/api?reserveDeploy=1');

      expect(res.status).toBe(200);
      expect((res.body as any).reserveDeploy).toBe(true);
      expect((res.body as any).operationId).toMatch(/^op_/);
      const actions = operationEvents
        .filter((event) => event.branchId === 'force-branch')
        .map((event) => event.action);
      expect(actions).toContain('branch.operation.started');
      expect(actions).toContain('branch.operation.completed');
      expect(actions).toContain('branch.operation.queued');
    });

    it('keeps force-rebuild deploy continuation on the same operation while merging webhook deploys behind it', async () => {
      const now = new Date().toISOString();
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      stateService.addBranch({
        id: 'force-webhook',
        projectId: 'default',
        branch: 'feature/force-webhook',
        worktreePath: path.join(tmpDir, 'worktrees', 'force-webhook'),
        status: 'running',
        createdAt: now,
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-force-webhook-api',
            hostPort: 10001,
            status: 'running',
          },
        },
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();
      mock.addResponsePattern(/find .* -type d .* echo done/, () => ({ stdout: 'done\n', stderr: '', exitCode: 0 }));

      const fetchCalls: Array<{ url: string; body: unknown; requestId?: string }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          requestId: new Headers(init?.headers).get('X-CDS-Request-Id') || undefined,
        });
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }) as typeof fetch;

      try {
        const force = await request(
          server,
          'POST',
          '/api/branches/force-webhook/force-rebuild/api?reserveDeploy=1',
          undefined,
          { 'X-CDS-Request-Id': 'req-force' },
        );
        expect(force.status).toBe(200);
        const forceOperationId = (force.body as any).operationId;
        expect(forceOperationId).toMatch(/^op_/);

        const webhook = await request(
          server,
          'POST',
          '/api/branches/force-webhook/deploy',
          { commitSha: '2222222222222222222222222222222222222222' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-force-webhook' },
        );
        expect(String(webhook.body)).toContain('merged');
        expect(fetchCalls).toEqual([]);

        const deploy = await request(
          server,
          'POST',
          '/api/branches/force-webhook/deploy/api',
          undefined,
          { 'X-CDS-Request-Id': 'req-force-deploy' },
        );
        expect(deploy.status).toBe(200);
        expect(String(deploy.body)).toContain('complete');
        expect(String(deploy.body)).toContain('event: deployment-run');
        expect(stateService.getBranch('force-webhook')?.status).toBe('running');
        const profileRunId = String(deploy.headers['x-cds-deployment-run-id']);
        expect(profileRunId).toMatch(/^dr_/);
        const profileRun = deploymentRunService.get(profileRunId);
        expect(profileRun).toMatchObject({
          branchId: 'force-webhook',
          status: 'running',
          phase: 'complete',
          operationId: forceOperationId,
          versionId: expect.stringMatching(/^dv_/),
        });
        expect(stateService.getBranch('force-webhook')?.currentVersionId).toBe(profileRun?.versionId);
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].url).toContain('/api/branches/force-webhook/deploy');
        expect(fetchCalls[0].body).toEqual({ commitSha: '2222222222222222222222222222222222222222',
          pendingReplay: { operationId: expect.any(String), generation: expect.any(Number) } });
        expect(fetchCalls[0].requestId).toBe('req-force-webhook');

        const events = operationEvents.filter((event) => event.branchId === 'force-webhook');
        expect(events.find((event) => event.action === 'branch.operation.queued')?.operationId).toBe(forceOperationId);
        expect(events.find((event) => event.action === 'branch.operation.continued')?.operationId).toBe(forceOperationId);
        const deployStarted = events.find((event) => event.action === 'branch.operation.started' && event.details?.kind === 'deploy-profile');
        expect(deployStarted?.operationId).toBe(forceOperationId);
        const pendingDispatch = events.find((event) => event.action === 'branch.operation.pending-dispatch.started');
        expect(pendingDispatch?.details).toMatchObject({
          commitSha: '2222222222222222222222222222222222222222',
          trigger: 'webhook',
          actor: 'system:webhook',
          kind: 'deploy',
          mergedCount: 1,
        });
        expect(pendingDispatch).toMatchObject({
          operationKind: 'deploy',
          operationTrigger: 'webhook',
          operationActor: 'system:webhook',
          operationSource: 'api.deploy-branch',
          commitSha: '2222222222222222222222222222222222222222',
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('branch operation fencing', () => {
    it.each(['/deploy', '/deploy/api'])('重放%s领取落盘失败返回503，原run失败且不执行Git或Docker', async (endpoint) => {
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'node', command: 'node server.js', workDir: '.', containerPort: 3000 });
      stateService.addBranch({ id: 'claim-fail', projectId: 'default', branch: 'main', worktreePath: path.join(tmpDir, 'worktrees', 'claim-fail'),
        status: 'idle', createdAt: new Date().toISOString(), services: {} });
      const active = branchOperationCoordinator.begin({ projectId: 'default', branchId: 'claim-fail', kind: 'deploy', trigger: 'manual' });
      const queued = await request(server, 'POST', `/api/branches/claim-fail${endpoint}`, { commitSha: 'b'.repeat(40) }, { 'X-CDS-Trigger': 'webhook' });
      const runId = String(queued.headers['x-cds-deployment-run-id']);
      expect(deploymentRunService.get(runId)?.status).toBe('queued');
      const pending = branchOperationCoordinator.completeAll(active.lease!, 'completed')[0];
      const count = mock.commands.length;
      const flush = vi.spyOn(stateService, 'flush').mockRejectedValueOnce(new Error('synthetic claim write failure'));
      try {
        const replay = await request(server, 'POST', `/api/branches/claim-fail${endpoint}`, pendingDeployBody(pending), { 'X-CDS-Trigger': 'webhook' });
        expect(replay.status).toBe(503);
        expect(deploymentRunService.get(runId)?.status).toBe('failed');
        expect(deploymentRunService.list({ branchId: 'claim-fail' })).toHaveLength(1);
        expect(mock.commands.slice(count).filter((command) => /git (fetch|pull|checkout)|docker (run|pull)/.test(command))).toEqual([]);
        expect(branchOperationCoordinator.getActive('claim-fail')).toBeUndefined();
      } finally { flush.mockRestore(); }
    });

    it('已派发待办的HTTP重放迟于新目标到达时，不得重新启动旧目标', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api', name: 'API', dockerImage: 'node', command: 'node server.js', workDir: '.', containerPort: 3000,
      });
      stateService.addBranch({
        id: 'replay-fence', projectId: 'default', branch: 'feature/replay-fence',
        worktreePath: path.join(tmpDir, 'worktrees', 'replay-fence'), status: 'idle',
        createdAt: new Date().toISOString(), services: {}, githubCommitSha: 'a'.repeat(40),
      });
      let release!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; });
      let markStarted!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      let actualRuns = 0;
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command) && command.includes('--name cds-replay-fence-api')) {
          if (actualRuns++ === 0) { markStarted(); await hold; }
          return { stdout: `cid-replay-fence-${actualRuns}`, stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };
      const replays: Record<string, unknown>[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        if (String(url).includes('/api/branches/replay-fence/deploy')) replays.push(JSON.parse(String(init?.body)));
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }));
      setBuildGateHostLoadProvider(() => ({ cores: 18, load1: 0 }));
      let active: ReturnType<typeof request> | undefined;
      try {
        active = request(server, 'POST', '/api/branches/replay-fence/deploy', { commitSha: 'a'.repeat(40) });
        await started;
        const queued = await request(server, 'POST', '/api/branches/replay-fence/deploy',
          { commitSha: 'b'.repeat(40) }, { 'X-CDS-Trigger': 'webhook' });
        expect(String(queued.body)).toContain('merged');
        const pending = branchOperationCoordinator.getPendingWebhookDeploy('replay-fence')!;
        release();
        await active;
        expect(replays).toHaveLength(1);
        await request(server, 'POST', '/api/branches/replay-fence/deploy', { commitSha: 'c'.repeat(40) });
        const stale = await request(server, 'POST', '/api/branches/replay-fence/deploy', {
          ...replays[0], pendingReplay: { operationId: pending.operationId, generation: pending.generation },
        }, { 'X-CDS-Trigger': 'webhook' });
        expect(String(stale.body)).toContain('"operationStatus":"rejected"');
        expect(actualRuns).toBe(2);
        expect(replays[0].pendingReplay).toEqual({ operationId: pending.operationId, generation: pending.generation });
      } finally {
        release();
        await Promise.allSettled([active]);
        setBuildGateHostLoadProvider(null);
        vi.unstubAllGlobals();
      }
    });

    it('实际HTTP路径保留API和Web待办，API更新不覆盖Web且重放走各自服务入口', async () => {
      for (const id of ['api', 'web']) await request(server, 'POST', '/api/build-profiles', {
        id, name: id, dockerImage: 'node', command: 'node server.js', workDir: '.', containerPort: 3000,
      });
      stateService.addBranch({
        id: 'service-pending', projectId: 'default', branch: 'feature/service-pending',
        worktreePath: path.join(tmpDir, 'worktrees', 'service-pending'), status: 'idle',
        createdAt: new Date().toISOString(), services: {}, githubCommitSha: 'a'.repeat(40),
      });
      let release!: () => void;
      const hold = new Promise<void>(resolve => { release = resolve; });
      let markStarted!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command) && command.includes('--name cds-service-pending-api')) {
          markStarted();
          await hold;
          return { stdout: 'cid-service-pending-api', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };
      const replays: Array<{ url: string; commitSha: string }> = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        if (String(url).includes('/api/branches/service-pending/deploy')) {
          replays.push({ url: String(url), commitSha: JSON.parse(String(init?.body)).commitSha });
        }
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }));
      setBuildGateHostLoadProvider(() => ({ cores: 18, load1: 0 }));
      let active: ReturnType<typeof request> | undefined;
      try {
        active = request(server, 'POST', '/api/branches/service-pending/deploy', { commitSha: 'a'.repeat(40) });
        await started;
        for (const [profileId, sha] of [['api', 'b'], ['web', 'c'], ['api', 'd']]) {
          const queued = await request(server, 'POST', `/api/branches/service-pending/deploy/${profileId}`,
            { commitSha: sha.repeat(40) }, { 'X-CDS-Trigger': 'webhook' });
          expect(String(queued.body)).toContain('merged');
        }
        release();
        await active;
        expect(replays).toHaveLength(2);
        expect(replays).toEqual(expect.arrayContaining([
          { url: `http://127.0.0.1:${config.masterPort}/api/branches/service-pending/deploy/api`, commitSha: 'd'.repeat(40) },
          { url: `http://127.0.0.1:${config.masterPort}/api/branches/service-pending/deploy/web`, commitSha: 'c'.repeat(40) },
        ]));
        expect(branchOperationCoordinator.getPendingWebhookDeploy('service-pending')).toBeUndefined();
      } finally {
        release();
        await Promise.allSettled([active]);
        setBuildGateHostLoadProvider(null);
        vi.unstubAllGlobals();
      }
    });

    it('实际HTTP路径中较新的手动部署不重放此前排队的旧目标', async () => {
      const shaA = '1111111111111111111111111111111111111111';
      const shaB = '2222222222222222222222222222222222222222';
      const shaC = '3333333333333333333333333333333333333333';
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api', name: 'API', dockerImage: 'node', command: 'node server.js', workDir: '.', containerPort: 3000,
      });
      stateService.addBranch({
        id: 'latest-target', projectId: 'default', branch: 'feature/latest-target',
        worktreePath: path.join(tmpDir, 'worktrees', 'latest-target'), status: 'idle',
        createdAt: new Date().toISOString(), services: {}, githubCommitSha: shaA,
      });
      const releases: Array<() => void> = [];
      const waits = [0, 1].map(() => new Promise<void>((resolve) => { releases.push(resolve); }));
      const marks: Array<() => void> = [];
      const starts = [0, 1].map(() => new Promise<void>((resolve) => { marks.push(resolve); }));
      let actualRuns = 0;
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command) && command.includes('--name cds-latest-target-api')) {
          const index = actualRuns++;
          marks[index]?.();
          await waits[index];
          return { stdout: `cid-latest-target-${index}`, stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };
      const replayTargets: unknown[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        if (String(url).includes('/api/branches/latest-target/deploy')) {
          replayTargets.push(JSON.parse(String(init?.body)));
        }
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }));
      // 此处验证目标调度，避免测试宿主实时负载改变是否获得编译槽位。
      setBuildGateHostLoadProvider(() => ({ cores: 18, load1: 0 }));
      let first: ReturnType<typeof request> | undefined;
      let latest: ReturnType<typeof request> | undefined;
      try {
        first = request(server, 'POST', '/api/branches/latest-target/deploy', { commitSha: shaA }, { 'X-CDS-Trigger': 'webhook' });
        await starts[0];
        const queued = await request(server, 'POST', '/api/branches/latest-target/deploy', { commitSha: shaB }, { 'X-CDS-Trigger': 'webhook' });
        expect(String(queued.body)).toContain('merged');
        latest = request(server, 'POST', '/api/branches/latest-target/deploy', { commitSha: shaC });
        await starts[1];
        releases[1]();
        await latest;
        releases[0]();
        await first;
        expect(actualRuns).toBe(2);
        expect(replayTargets).toEqual([]);
        expect(branchOperationCoordinator.getPendingWebhookDeploy('latest-target')).toBeUndefined();
        expect(stateService.getBranch('latest-target')?.status).toBe('running');
      } finally {
        releases.forEach((release) => release());
        await Promise.allSettled([first, latest]);
        setBuildGateHostLoadProvider(null);
        vi.unstubAllGlobals();
      }
    });

    // Codex 三轮 P1：并入在途部署时，响应头必须指向那条真的会跑完的 run。
    // 外层 handler 在取租约前就建了占位 run 并写进 X-CDS-Deployment-Run-Id，并入后
    // 占位 run 会被取消，而 cdscli 只认这个头、见 cancelled 即判部署失败——正是本批
    // 要治的「push 后紧跟 deploy」路径。
    it.each([false, true])('真实HTTP整分支领取期间新API等待，传输失败=%s后仍推进原API记录', async (failTransport) => {
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'node', workDir: '.', command: 'node server.js', containerPort: 3000 });
      const branchId = 'scope-barrier';
      stateService.addBranch({ id: branchId, projectId: 'default', branch: 'main', worktreePath: path.join(tmpDir, 'worktrees', branchId), status: 'idle', createdAt: new Date().toISOString(), services: {} });
      let releaseActive!: () => void, activeStarted!: () => void, releaseReplay!: () => void, dispatchStarted!: () => void, apiFinished!: () => void;
      const activeGate = new Promise<void>((r) => { releaseActive = r; }); const activeReady = new Promise<void>((r) => { activeStarted = r; });
      const replayGate = new Promise<void>((r) => { releaseReplay = r; }); const dispatched = new Promise<void>((r) => { dispatchStarted = r; });
      const apiDone = new Promise<void>((r) => { apiFinished = r; });
      const original = mock.exec.bind(mock); let actualRuns = 0; const replayIds: string[] = [];
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command) && command.includes('cds-scope-barrier-api')) {
          actualRuns++; if (actualRuns === 1) { activeStarted(); await activeGate; }
        }
        return original(command, options);
      };
      let wholeDispatch: Promise<Response> | undefined;
      vi.stubGlobal('fetch', vi.fn((url, init) => {
        const route = new URL(String(url)).pathname;
        const task = (async () => {
        if (route === `/api/branches/${branchId}/deploy`) { dispatchStarted(); await replayGate; if (failTransport) throw new Error('controlled pending transport failure'); }
        const response = await request(server, 'POST', route, JSON.parse(String(init?.body)), { 'X-CDS-Trigger': String((init?.headers as any)?.['X-CDS-Trigger'] || 'webhook') });
        replayIds.push(String(response.headers['x-cds-deployment-run-id']));
        if (route.endsWith('/api')) apiFinished();
        return new Response(String(response.body), { status: response.status });
        })();
        if (route === `/api/branches/${branchId}/deploy`) wholeDispatch = task;
        return task;
      }));
      const active = request(server, 'POST', `/api/branches/${branchId}/deploy`, { commitSha: 'a'.repeat(40) });
      try {
        await activeReady;
        const whole = await request(server, 'POST', `/api/branches/${branchId}/deploy`, { commitSha: 'b'.repeat(40) }, { 'X-CDS-Trigger': 'webhook' });
        const wholeId = String(whole.headers['x-cds-deployment-run-id']);
        releaseActive(); await active; await dispatched;
        const api = await request(server, 'POST', `/api/branches/${branchId}/deploy/api`, { commitSha: 'c'.repeat(40) });
        const apiId = String(api.headers['x-cds-deployment-run-id']);
        expect(String(api.body)).toContain('merged'); expect(actualRuns).toBe(1); expect(deploymentRunService.get(apiId)?.status).toBe('queued');
        releaseReplay(); await apiDone;
        expect(actualRuns).toBe(failTransport ? 2 : 3);
        expect(replayIds).toEqual(failTransport ? [apiId] : [wholeId, apiId]);
        expect(deploymentRunService.get(wholeId)?.status).toBe(failTransport ? 'cancelled' : 'running');
        expect(deploymentRunService.get(apiId)?.status).toBe('running');
      } finally { releaseActive(); releaseReplay(); await Promise.allSettled([active, wholeDispatch]); vi.unstubAllGlobals(); }
    });

    it('受理落盘失败返回503并释放租约，旧服务未被替换', async () => {
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'node', workDir: '.', command: 'node server.js', containerPort: 3000 });
      stateService.addBranch({ id: 'admission-fail', projectId: 'default', branch: 'main', worktreePath: path.join(tmpDir, 'worktrees', 'admission-fail'),
        status: 'running', createdAt: new Date().toISOString(), services: { api: { profileId: 'api', containerName: 'old-api', hostPort: 10001, status: 'running' } } });
      const flush = vi.spyOn(stateService, 'flush').mockRejectedValueOnce(new Error('disk unavailable'));
      const before = mock.commands.length;
      try {
        const result = await request(server, 'POST', '/api/branches/admission-fail/deploy', { commitSha: 'a'.repeat(40) });
        expect(result.status).toBe(503);
        expect(String(JSON.stringify(result.body))).toContain('尚未开始执行');
        expect(mock.commands.slice(before).some((command) => command.startsWith('docker ') || command.startsWith('git '))).toBe(false);
        expect(branchOperationCoordinator.getActive('admission-fail')).toBeUndefined();
        expect(stateService.getBranch('admission-fail')?.services.api.containerName).toBe('old-api');
        expect(deploymentRunService.list({ branchId: 'admission-fail' })[0]?.status).toBe('failed');
      } finally { flush.mockRestore(); }
    });

    it('最新请求回到当前A时取消旧待办B，不在A完成后重放B', async () => {
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'node', workDir: '.', command: 'node server.js', containerPort: 3000 });
      stateService.addBranch({ id: 'return-current', projectId: 'default', branch: 'main', worktreePath: path.join(tmpDir, 'worktrees', 'return-current'), status: 'idle', createdAt: new Date().toISOString(), services: {} });
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; }); const start = new Promise<void>((resolve) => { started = resolve; });
      const original = mock.exec.bind(mock); let actualRuns = 0;
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command) && command.includes('cds-return-current-api')) { actualRuns++; started(); await gate; }
        return original(command, options);
      };
      const fetches = vi.fn(async () => new Response('event: complete\ndata: {}\n\n')); vi.stubGlobal('fetch', fetches);
      const first = request(server, 'POST', '/api/branches/return-current/deploy', { commitSha: 'a'.repeat(40) });
      try {
        await start; const activeId = deploymentRunService.list({ branchId: 'return-current' })[0].id;
        const queued = await request(server, 'POST', '/api/branches/return-current/deploy', { commitSha: 'b'.repeat(40) }, { 'X-CDS-Trigger': 'webhook' });
        const bId = String(queued.headers['x-cds-deployment-run-id']);
        const latest = await request(server, 'POST', '/api/branches/return-current/deploy', { commitSha: 'a'.repeat(40) });
        expect(latest.headers['x-cds-deployment-run-id']).toBe(activeId);
        const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state.json'), 'utf8'));
        expect(persisted.deploymentRuns[bId]?.status).toBe('cancelled');
        release(); await first; expect(actualRuns).toBe(1); expect(fetches).not.toHaveBeenCalled();
      } finally { release(); await first; vi.unstubAllGlobals(); }
    });

    it('排队受理等待写盘期间被新目标取代，返回409且不删除新待办', async () => {
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'node', workDir: '.', command: 'node server.js', containerPort: 3000 });
      stateService.addBranch({ id: 'admission-replaced', projectId: 'default', branch: 'main', worktreePath: path.join(tmpDir, 'worktrees', 'admission-replaced'), status: 'idle', createdAt: new Date().toISOString(), services: {} });
      branchOperationCoordinator.begin({ branchId: 'admission-replaced', projectId: 'default', kind: 'deploy', trigger: 'manual' });
      let release!: () => void, blocked!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { blocked = resolve; });
      const originalFlush = stateService.flush.bind(stateService);
      const flush = vi.spyOn(stateService, 'flush').mockImplementationOnce(async () => { blocked(); await gate; await originalFlush(); });
      const previous = request(server, 'POST', '/api/branches/admission-replaced/deploy', { commitSha: 'b'.repeat(40) });
      try {
        await started;
        const latest = await request(server, 'POST', '/api/branches/admission-replaced/deploy', { commitSha: 'c'.repeat(40) });
        expect(latest.status).toBe(200); release(); expect((await previous).status).toBe(409);
        expect(branchOperationCoordinator.getPendingWebhookDeploy('admission-replaced')?.request.commitSha).toBe('c'.repeat(40));
        expect(deploymentRunService.get(String(latest.headers['x-cds-deployment-run-id']))?.status).toBe('queued');
        expect(mock.commands.some((command) => isAppLaunchCommand(command))).toBe(false);
      } finally { release(); await previous; flush.mockRestore(); branchOperationCoordinator.cancelBranch('admission-replaced', '测试结束'); }
    });

    it.each(['/deploy', '/deploy/api'])('受理%s后配置修改不改变已受理部署的命令、覆盖和环境变量', async (endpoint) => {
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'node', workDir: '.', command: 'node original.js', containerPort: 3000,
        env: { PROFILE_VALUE: 'profile-before', CONFIG_VALUE: '${CONFIG_VALUE}' } });
      const branchId = 'input-snapshot';
      stateService.addBranch({ id: branchId, projectId: 'default', branch: 'feature/input-snapshot', worktreePath: path.join(tmpDir, 'worktrees', branchId),
        status: 'idle', createdAt: new Date().toISOString(), services: {} });
      stateService.setBranchProfileOverride(branchId, 'api', { command: 'node override-before.js', env: { OVERRIDE_VALUE: 'override-before' } });
      stateService.setCustomEnvVar('CONFIG_VALUE', 'config-before', branchId);
      let release!: () => void, blocked!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { blocked = resolve; });
      const originalFlush = stateService.flush.bind(stateService);
      const flush = vi.spyOn(stateService, 'flush').mockImplementationOnce(async () => { blocked(); await gate; await originalFlush(); });
      const environments: string[] = [];
      let infrastructurePort = '18081';
      const cdsEnv = vi.spyOn(stateService, 'getCdsEnvVars').mockImplementation(() => ({ CDS_MONGODB_PORT: infrastructurePort }));
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command)) {
          const envFile = command.match(/--env-file "([^"]+)"/)?.[1];
          if (envFile) environments.push(fs.readFileSync(envFile, 'utf8'));
        }
        return originalExec(command, options);
      };
      const deploy = request(server, 'POST', `/api/branches/${branchId}${endpoint}`, { commitSha: 'a'.repeat(40) });
      try {
        await started;
        stateService.updateBuildProfile('api', { command: 'node changed.js', env: { PROFILE_VALUE: 'profile-after', CONFIG_VALUE: '${CONFIG_VALUE}' } });
        stateService.setBranchProfileOverride(branchId, 'api', { command: 'node override-after.js', env: { OVERRIDE_VALUE: 'override-after' } });
        stateService.setCustomEnvVar('CONFIG_VALUE', 'config-after', branchId);
        infrastructurePort = '18082';
        release(); const result = await deploy;
        expect(result.status).toBe(200);
        const commands = mock.commands.filter((command) => isAppLaunchCommand(command));
        expect(commands).toHaveLength(1);
        expect(commands[0]).toContain('override-before.js');
        expect(environments).toHaveLength(1);
        expect(environments[0]).toContain('PROFILE_VALUE=profile-before');
        expect(environments[0]).toContain('OVERRIDE_VALUE=override-before');
        expect(environments[0]).toContain('CONFIG_VALUE=config-before');
        expect(environments[0]).toContain('CDS_MONGODB_PORT=18082');
        expect(commands[0]).not.toContain('override-after.js');
        expect(environments[0]).not.toContain('config-after');
      } finally { release(); await deploy; flush.mockRestore(); cdsEnv.mockRestore(); }
    });

    it('远端派发沿用受理时配置和环境，发送阶段不重读构建配置', async () => {
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'node', workDir: '.', command: 'node remote-before.js', containerPort: 3000 });
      const id = 'remote-input'; const now = new Date().toISOString();
      stateService.addBranch({ id, projectId: 'default', branch: 'feature/remote-input', worktreePath: path.join(tmpDir, 'worktrees', id), status: 'idle', createdAt: now, services: {} });
      stateService.setCustomEnvVar('CONFIG_VALUE', 'remote-before', id);
      registryNodes.push({ id: 'exec-input', host: '127.0.0.1', port: 9102, status: 'online', role: 'remote', labels: [], branches: [],
        capacity: { maxBranches: 10, memoryMB: 1024, cpuCores: 2 }, load: { memoryUsedMB: 0, cpuPercent: 0 }, registeredAt: now, lastHeartbeat: now });
      let release!: () => void, blocked!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { blocked = resolve; });
      const originalFlush = stateService.flush.bind(stateService);
      const flush = vi.spyOn(stateService, 'flush').mockImplementationOnce(async () => { blocked(); await gate; await originalFlush(); });
      let dispatched: any;
      vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
        dispatched = JSON.parse(String(init?.body));
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      });
      const deploy = request(server, 'POST', `/api/branches/${id}/deploy`, { commitSha: 'a'.repeat(40), targetExecutorId: 'exec-input' });
      try {
        await started; stateService.updateBuildProfile('api', { command: 'node remote-after.js' });
        stateService.setCustomEnvVar('CONFIG_VALUE', 'remote-after', id); release(); const response = await deploy;
        expect(response.status).toBe(200); expect(dispatched.profiles[0].command).toBe('node remote-before.js');
        expect(dispatched.env.CONFIG_VALUE).toBe('remote-before');
        expect(mock.commands.some((command) => isAppLaunchCommand(command))).toBe(false);
      } finally { release(); await deploy; flush.mockRestore(); vi.unstubAllGlobals(); }
    });

    it.each(['/deploy', '/deploy/api'])('排队%s重放沿用原配置和run，配置编辑不能取消已受理目标', async (endpoint) => {
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'node', workDir: '.', command: 'node queue-before.js', containerPort: 3000,
        env: { CONFIG_VALUE: '${CONFIG_VALUE}' } });
      const branchId = 'queued-input';
      stateService.addBranch({ id: branchId, projectId: 'default', branch: 'feature/queued-input', worktreePath: path.join(tmpDir, 'worktrees', branchId),
        status: 'idle', createdAt: new Date().toISOString(), services: {} });
      stateService.setCustomEnvVar('CONFIG_VALUE', 'queued-private-before', branchId);
      let release!: () => void, started!: () => void, replayed!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const start = new Promise<void>((resolve) => { started = resolve; });
      const done = new Promise<void>((resolve) => { replayed = resolve; });
      const originalExec = mock.exec.bind(mock); const runs: Array<{ command: string; env: string }> = [];
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command)) {
          const envFile = command.match(/--env-file "([^"]+)"/)?.[1];
          runs.push({ command, env: envFile ? fs.readFileSync(envFile, 'utf8') : '' });
          if (runs.length === 1) { started(); await hold; }
        }
        return originalExec(command, options);
      };
      let replayStatus = 0, replayRunId = ''; const replayBodies: unknown[] = [];
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input)); const body = JSON.parse(String(init?.body)); replayBodies.push(body);
        const replay = await request(server, 'POST', url.pathname, body, init?.headers as Record<string, string>);
        replayStatus = replay.status; replayRunId = String(replay.headers['x-cds-deployment-run-id']); replayed();
        return new Response(String(replay.body), { status: replay.status });
      });
      setBuildGateHostLoadProvider(async () => ({ loadAvg1: 0, cpuCores: 16, usedMemPercent: 10, memAvailableMB: 32000 }));
      const first = request(server, 'POST', `/api/branches/${branchId}${endpoint}`, { commitSha: 'a'.repeat(40) });
      try {
        await start;
        const queued = await request(server, 'POST', `/api/branches/${branchId}${endpoint}`, { commitSha: 'b'.repeat(40) }, { 'X-CDS-Trigger': 'webhook' });
        const queuedId = String(queued.headers['x-cds-deployment-run-id']);
        expect(deploymentRunService.get(queuedId)?.status).toBe('queued');
        stateService.updateBuildProfile('api', { command: 'node queue-after.js' });
        stateService.setCustomEnvVar('CONFIG_VALUE', 'queued-private-after', branchId);
        release(); await first; await done;
        expect(replayStatus).toBe(200); expect(replayRunId).toBe(queuedId);
        expect(deploymentRunService.get(queuedId)?.status).toBe('running');
        expect(runs).toHaveLength(2); expect(runs[1].command).toContain('queue-before.js');
        expect(runs[1].env).toContain('CONFIG_VALUE=queued-private-before');
        expect(runs[1].env).not.toContain('queued-private-after');
        expect(deploymentRunService.list({ branchId })).toHaveLength(2);
        expect(JSON.stringify({ replayBodies, operationEvents, active: branchOperationCoordinator.getActiveOperations(), run: deploymentRunService.get(queuedId) })).not.toContain('queued-private-before');
      } finally { release(); await first; setBuildGateHostLoadProvider(null); vi.unstubAllGlobals(); }
    });

    it('固定提交的镜像模板指纹不随分支缓存更新而变化，同目标只执行一次', async () => {
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'node:${CDS_COMMIT_SHA}', workDir: '.', command: 'node server.js', containerPort: 3000 });
      const id = 'input-sha';
      stateService.addBranch({ id, projectId: 'default', branch: 'feature/input-sha', worktreePath: path.join(tmpDir, 'worktrees', id), status: 'idle', createdAt: new Date().toISOString(),
        githubCommitSha: 'a'.repeat(40), services: {} });
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; }); const start = new Promise<void>((resolve) => { started = resolve; });
      const originalExec = mock.exec.bind(mock); let actualRuns = 0;
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command)) { actualRuns++; if (actualRuns === 1) { started(); await gate; } }
        return originalExec(command, options);
      };
      setBuildGateHostLoadProvider(async () => ({ loadAvg1: 0, cpuCores: 16, usedMemPercent: 10, memAvailableMB: 32000 }));
      const first = request(server, 'POST', `/api/branches/${id}/deploy`, { commitSha: 'b'.repeat(40) });
      try {
        await start;
        const second = await request(server, 'POST', `/api/branches/${id}/deploy`, { commitSha: 'b'.repeat(40) });
        expect(String(second.body)).toContain('"operationStatus":"joined"');
        release(); const original = await first;
        expect(second.headers['x-cds-deployment-run-id']).toBe(original.headers['x-cds-deployment-run-id']);
        expect(actualRuns).toBe(1); expect(deploymentRunService.list({ branchId: id })).toHaveLength(1);
      } finally { release(); await first; setBuildGateHostLoadProvider(null); }
    });

    it.each(['/deploy', '/deploy/api'])('短SHA%s通过实际Git固定完整身份，模板与原等待记录不借旧CI或HEAD', async (endpoint) => {
      const repo = path.join(tmpDir, 'identity-project'); fs.mkdirSync(repo);
      const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
      git('init', '-q'); git('config', 'user.name', 'Owned'); git('config', 'user.email', 'owned@example.test');
      fs.writeFileSync(path.join(repo, 'owned.txt'), 'first'); git('add', '.'); git('commit', '-qm', '自有目标'); const target = git('rev-parse', 'HEAD');
      fs.writeFileSync(path.join(repo, 'owned.txt'), 'second'); git('commit', '-qam', '自有后续'); const actualHead = git('rev-parse', 'HEAD');
      stateService.addProject({ id: 'identity-project', slug: 'identity-project', name: 'Owned', repoPath: repo, cloneStatus: 'ready' } as any);
      stateService.addBuildProfile({ id: 'api', projectId: 'identity-project', name: 'API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}',
        prebuiltImage: true, command: '', workDir: '.', containerPort: 3000 });
      const id = 'identity-full'; stateService.addBranch({ id, projectId: 'identity-project', branch: 'owned-target', status: 'running', services: {},
        worktreePath: repo, createdAt: new Date().toISOString(), githubCommitSha: 'a'.repeat(40), ciTargetSha: 'a'.repeat(40) });
      const operation = new IsolatedShellExecutor(new ShellExecutor(), { isolatedLane: 'operation', concurrency: 2 });
      const reads = new IsolatedShellExecutor(operation); await Promise.all([reads.start(), operation.start()]);
      Object.assign(mock, { execBackgroundObservation: reads.execBackgroundObservation.bind(reads) });
      mock.addResponsePatternFirst(/docker info/, () => ({ stdout: JSON.stringify({ Architecture: 'x86_64', OSType: 'linux' }), stderr: '', exitCode: 0 }));
      mock.addResponsePatternFirst(/docker pull/, () => ({ stdout: '', stderr: 'manifest unknown', exitCode: 1 }));
      try {
        const response = await request(server, 'POST', `/api/branches/${id}${endpoint}`, { commitSha: target.slice(0, 7).toUpperCase() });
        expect(response.status).toBe(200); await requestArtifactWaitRefresh(branchOperationCoordinator);
        const run = deploymentRunService.get(String(response.headers['x-cds-deployment-run-id']))!;
        expect(run).toMatchObject({ status: 'queued', commitSha: target });
        expect(branchOperationCoordinator.getArtifactWaiters()[0]).toMatchObject({ pending: { request: { commitSha: target, commitPinned: true } },
          input: { targetCommitSha: target, artifactAdmission: { targetCommitSha: target, reason: 'missing' } } });
        expect(mock.commands.filter(command => command.startsWith('docker pull '))).toEqual([`docker pull 'ghcr.io/owned/api:sha-${target}'`]);
        const repeated = await request(server, 'POST', `/api/branches/${id}${endpoint}`, { commitSha: target });
        expect(repeated.headers['x-cds-deployment-run-id']).toBe(run.id); expect(deploymentRunService.list({ branchId: id })).toHaveLength(1);
        expect(git('rev-parse', 'HEAD')).toBe(actualHead); expect(git('status', '--porcelain')).toBe('');
      } finally { await Promise.all([reads.close(), operation.close()]); }
    });

    it.each(['/deploy', '/deploy/api'])('短SHA%s无法确认时明确未受理，不造永远无法恢复的等待，不触发部署', async (endpoint) => {
      stateService.addBuildProfile({ id: 'api', projectId: 'default', name: 'API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}',
        prebuiltImage: true, command: '', workDir: '.', containerPort: 3000 });
      const id = 'identity-unknown'; stateService.addBranch({ id, projectId: 'default', branch: 'owned-target', status: 'running', services: {},
        worktreePath: tmpDir, createdAt: new Date().toISOString(), githubCommitSha: 'a'.repeat(40), ciTargetSha: 'a'.repeat(40) });
      Object.assign(mock, { execBackgroundObservation: async () => ({ stdout: '', stderr: 'ambiguous or unavailable', exitCode: 1 }) });
      const before = mock.commands.length;
      const response = await request(server, 'POST', `/api/branches/${id}${endpoint}`, { commitSha: 'abcdef1' });
      expect(response.status).toBe(503); expect(response.body).toMatchObject({ error: 'target_identity_unavailable' });
      expect(deploymentRunService.list({ branchId: id })).toEqual([]); expect(branchOperationCoordinator.getArtifactWaiters()).toEqual([]);
      expect(mock.commands.slice(before)).toEqual([]); expect(stateService.getBranch(id)?.status).toBe('running');
    });

    it.each(['new-target', 'shared-prefix', 'stop', 'owner', 'pause'])('短SHA解析期间%s变化使旧请求不能迟到受理或覆盖新目标', async (change) => {
      const target = change === 'shared-prefix' ? '28261299422b4388c244cc4c847dc9254ef16a7d' : 'abcdef1234567890abcdef1234567890abcdef12';
      const newer = change === 'shared-prefix' ? '2826129b5eeb46aab2818d635d5853a08c67a8cb' : 'b'.repeat(40);
      stateService.addBuildProfile({ id: 'api', projectId: 'default', name: 'API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}',
        prebuiltImage: true, command: '', workDir: '.', containerPort: 3000 });
      const id = 'identity-inflight'; stateService.addBranch({ id, projectId: 'default', branch: 'owned-target', status: 'running', services: {},
        worktreePath: tmpDir, createdAt: new Date().toISOString(), githubCommitSha: 'a'.repeat(40), ciTargetSha: 'a'.repeat(40) });
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
      Object.assign(mock, { execBackgroundObservation: async (_command: string, options: any) => {
        options?.beforeStart?.(); entered(); await gate; options?.onData?.(target, 'stdout'); return { stdout: '', stderr: '', exitCode: 0 };
      } });
      mock.addResponsePatternFirst(/docker pull/, () => ({ stdout: '', stderr: 'manifest unknown', exitCode: 1 }));
      const pendingResponse = request(server, 'POST', `/api/branches/${id}/deploy`, { commitSha: target.slice(0, 7) });
      await started;
      let newestRun: string | undefined;
      if (change === 'new-target' || change === 'shared-prefix') {
        const response = await request(server, 'POST', `/api/branches/${id}/deploy`, { commitSha: newer });
        expect(response.status).toBe(200); newestRun = String(response.headers['x-cds-deployment-run-id']);
      } else if (change === 'stop') {
        expect((await request(server, 'POST', `/api/branches/${id}/stop`)).status).toBe(200);
      } else if (change === 'owner') {
        stateService.getBranch(id)!.projectId = 'different-owner';
      } else stateService.getProject('default')!.paused = true;
      release(); const rejected = await pendingResponse;
      expect(rejected.status).toBe(change === 'pause' ? 423 : 409);
      const runs = deploymentRunService.list({ branchId: id });
      expect(runs).toHaveLength(['new-target', 'shared-prefix'].includes(change) ? 1 : 0);
      if (newestRun) expect(deploymentRunService.get(newestRun)).toMatchObject({ commitSha: newer, status: 'queued' });
      expect(mock.commands.some(command => /^docker run|git fetch|worktree add/.test(command))).toBe(false);
    });

    it.each([['webhook', 'manual'], ['manual', 'webhook']])('短SHA原HTTP共享读票%s先/%s后保留所有有效手动资格', async (firstTrigger, secondTrigger) => {
      const target = 'abcdef1234567890abcdef1234567890abcdef12';
      stateService.addBuildProfile({ id: 'api', projectId: 'default', name: 'API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}',
        prebuiltImage: true, command: '', workDir: '.', containerPort: 3000 });
      const id = 'identity-priority'; stateService.addBranch({ id, projectId: 'default', branch: 'owned-target', status: 'running', services: {},
        worktreePath: tmpDir, createdAt: new Date().toISOString(), githubCommitSha: 'a'.repeat(40), ciTargetSha: 'a'.repeat(40) });
      let release!: () => void, joined!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), registered = new Promise<void>(resolve => { joined = resolve; });
      const originalBegin = branchOperationCoordinator.beginArtifactTargetRead.bind(branchOperationCoordinator); let tickets = 0;
      const registration = vi.spyOn(branchOperationCoordinator, 'beginArtifactTargetRead').mockImplementation(input => {
        const ticket = originalBegin(input); if (++tickets === 2) joined(); return ticket;
      });
      Object.assign(mock, { execBackgroundObservation: async (_command: string, options: any) => {
        options?.beforeStart?.(); await gate; options?.onData?.(target, 'stdout'); return { stdout: '', stderr: '', exitCode: 0 };
      } });
      mock.addResponsePatternFirst(/docker pull/, () => ({ stdout: '', stderr: 'manifest unknown', exitCode: 1 }));
      const first = request(server, 'POST', `/api/branches/${id}/deploy`, { commitSha: target.slice(0, 7) }, { 'X-CDS-Trigger': firstTrigger });
      const second = request(server, 'POST', `/api/branches/${id}/deploy`, { commitSha: target.slice(0, 7) }, { 'X-CDS-Trigger': secondTrigger });
      try {
        await registered;
        const rejected = await request(server, 'POST', `/api/branches/${id}/deploy`, { commitSha: 'b'.repeat(40) }, { 'X-CDS-Trigger': 'webhook' });
        expect(String(rejected.body)).toContain('"operationStatus":"rejected"');
        expect(deploymentRunService.list({ branchId: id })).toHaveLength(0);
        release(); const responses = await Promise.all([first, second]); expect(responses.map(r => r.status)).toEqual([200, 200]);
        expect(responses[0].headers['x-cds-deployment-run-id']).toBe(responses[1].headers['x-cds-deployment-run-id']);
        expect(deploymentRunService.list({ branchId: id })).toHaveLength(1);
        expect(branchOperationCoordinator.getArtifactWaiters()[0].pending.request.commitSha).toBe(target);
      } finally { release(); await Promise.all([first, second]); registration.mockRestore(); }
    });

    it('最后一个必需产物缺失时保留旧入口与孤儿服务，不初始化数据库或准备源码，原任务持久等待', async () => {
      const target = 'b'.repeat(40); const imageId = `sha256:${'c'.repeat(64)}`;
      for (const role of ['api', 'web']) await request(server, 'POST', '/api/build-profiles', { id: role, name: role,
        dockerImage: `ghcr.io/owned/${role}:sha-${target}`, workDir: '.', command: '', containerPort: 3000, prebuiltImage: true });
      const id = 'artifact-all-required';
      stateService.addBranch({ id, projectId: 'default', branch: 'feature/artifact-all-required', worktreePath: path.join(tmpDir, 'worktrees', id),
        status: 'running', createdAt: new Date().toISOString(), githubCommitSha: 'a'.repeat(40), ciTargetSha: 'a'.repeat(40), services: {
          api: { profileId: 'api', containerName: 'old-api', hostPort: 10031, status: 'running' },
          legacy: { profileId: 'legacy', containerName: 'old-legacy', hostPort: 10032, status: 'running' },
        } });
      mock.addResponsePatternFirst(/docker info/, () => ({ stdout: JSON.stringify({ Architecture: 'x86_64', OSType: 'linux' }), stderr: '', exitCode: 0 }));
      mock.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: imageId,
        RepoDigests: [`ghcr.io/owned/api@${imageId}`, `ghcr.io/owned/web@${imageId}`],
        Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': target } } }]), stderr: '', exitCode: 0 }));
      mock.addResponsePatternFirst(/docker pull (.+)/, match => ({ stdout: match[1].includes('/web:') ? '' : 'available',
        stderr: match[1].includes('/web:') ? 'manifest unknown' : '', exitCode: match[1].includes('/web:') ? 1 : 0 }));
      const commandsBefore = mock.commands.length;
      const response = await request(server, 'POST', `/api/branches/${id}/deploy`, { commitSha: target });
      const { requestArtifactWaitRefresh } = await import('../../src/services/artifact-admission-wait.js');
      await requestArtifactWaitRefresh(branchOperationCoordinator);
      expect(response.status).toBe(200);
      const run = deploymentRunService.get(String(response.headers['x-cds-deployment-run-id']))!;
      expect(run.status).toBe('queued'); expect(run.phase).toBe('artifact-wait');
      expect(String(response.body)).toContain('等待全部必需产物');
      expect(stateService.getBranch(id)).toMatchObject({ status: 'running', githubCommitSha: 'a'.repeat(40), services: {
        api: { containerName: 'old-api', status: 'running' }, legacy: { containerName: 'old-legacy', status: 'running' } } });
      expect(mock.commands.slice(commandsBefore).some(command => /docker (rm|run)|git fetch|network create|database-init/.test(command))).toBe(false);
      expect(branchOperationCoordinator.getActiveOperations(id)).toHaveLength(0);
      expect(branchOperationCoordinator.getArtifactWaiters()[0]).toMatchObject({ pending: { operationId: run.operationId, generation: run.operationGeneration },
        input: { targetCommitSha: target, artifactAdmission: { state: 'waiting', reason: 'missing', profileIds: ['web'] } } });
      expect(run.events.some(event => event.detail?.reason === 'missing')).toBe(true);
      mock.addResponsePatternFirst(/docker pull/, () => ({ stdout: 'now published', stderr: '', exitCode: 0 }));
      const { refreshArtifactWaiters } = await import('../../src/services/artifact-admission-wait.js');
      const [pending] = await refreshArtifactWaiters({ coordinator: branchOperationCoordinator, containerService, getBranch: id => stateService.getBranch(id), recheckMs: 0 });
      expect(pending).toMatchObject({ operationId: run.operationId, generation: run.operationGeneration });
      const resumed = await request(server, 'POST', `/api/branches/${id}/deploy`, pendingDeployBody(pending), { 'X-CDS-Internal': '1', 'X-CDS-Trigger': pending.request.trigger });
      expect(resumed.status).toBe(200); expect(resumed.headers['x-cds-deployment-run-id']).toBe(run.id);
      expect(deploymentRunService.list({ branchId: id })).toHaveLength(1);
      expect(deploymentRunService.get(run.id)?.status).toBe('running');
      const executions = mock.commands.filter(command => isAppLaunchCommand(command)).length;
      expect(executions).toBe(2);
      expect(await refreshArtifactWaiters({ coordinator: branchOperationCoordinator, containerService, getBranch: id => stateService.getBranch(id), recheckMs: 0 })).toEqual([]);
      expect(mock.commands.filter(command => isAppLaunchCommand(command))).toHaveLength(executions);
    });

    it('历史A固定产物准入不被当前B部署模式覆盖，按A版本运行并保留B待发布目标', async () => {
      const A = 'a'.repeat(40), B = 'b'.repeat(40), digest = 'd'.repeat(64);
      const artifact = `ghcr.io/owned/api:sha-${A}@sha256:${digest}`;
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'node:22',
        workDir: '.', command: 'source-build', containerPort: 3000,
        deployModes: { express: { label: 'CI', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}', command: '', prebuilt: true } } });
      const branch = { id: 'fixed-version-input', projectId: 'default', branch: 'feature/fixed-version-input', worktreePath: path.join(tmpDir, 'fixed-version-input'),
        status: 'running', createdAt: new Date().toISOString(), ciTargetSha: B, githubCommitSha: B,
        profileOverrides: { api: { activeDeployMode: 'express' } }, services: { api: { profileId: 'api', containerName: 'old-api',
          hostPort: 10011, status: 'running', deployedImage: artifact, deployedMode: 'express' } } } as BranchEntry;
      stateService.addBranch(branch);
      const version = deploymentVersionService.create({ projectId: 'default', branchId: branch.id, commitSha: A,
        configHash: 'c'.repeat(64), profiles: [resolveEffectiveProfile(stateService.getBuildProfile('api')!, branch)], branch, createdByRunId: 'verified-old' });
      branch.services.api.deployedImage = `ghcr.io/owned/api:sha-${B}`;
      mock.addResponsePatternFirst(/docker info/, () => ({ stdout: JSON.stringify({ OSType: 'linux', Architecture: 'amd64' }), stderr: '', exitCode: 0 }));
      mock.addResponsePatternFirst(/docker pull (.+)/, match => ({ stdout: match[1].includes(`@sha256:${digest}`) ? 'fixed artifact available' : '',
        stderr: match[1].includes(`@sha256:${digest}`) ? '' : 'manifest unknown', exitCode: match[1].includes(`@sha256:${digest}`) ? 0 : 1 }));
      mock.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: `sha256:${'e'.repeat(64)}`,
        RepoDigests: [`ghcr.io/owned/api@sha256:${digest}`], Os: 'linux', Architecture: 'amd64',
        Config: { Labels: { 'org.opencontainers.image.revision': A } } }]), stderr: '', exitCode: 0 }));
      const response = await request(server, 'POST', `/api/branches/${branch.id}/deploy`, { versionId: version.id });
      expect(response.status).toBe(200);
      const run = await waitForAcceptedRun(response);
      expect(run.status).toBe('running'); expect(run.versionId).toBe(version.id);
      expect(stateService.getBranch(branch.id)?.services.api.deployedImage).toBe(artifact);
      expect(stateService.getBranch(branch.id)?.ciTargetSha).toBe(B);
      expect(mock.commands.some(command => command.startsWith('git fetch') || command.includes('source-build'))).toBe(false);
    });

    it('指定历史版本产物缺少OCI身份时HTTP拒绝，外层分发不误报受理且旧服务不变', async () => {
      const target = 'a'.repeat(40);
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: `ghcr.io/owned/api:sha-${target}`,
        workDir: '.', command: '', containerPort: 3000, prebuiltImage: true });
      readyArtifactFixture();
      mock.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`ghcr.io/owned/api@sha256:${'c'.repeat(64)}`], Os: 'linux', Architecture: 'amd64', Config: { Labels: {} } }]), stderr: '', exitCode: 0 }));
      const id = 'legacy-version-rejection';
      const branch = { id, projectId: 'default', branch: 'feature/legacy-version-rejection', worktreePath: path.join(tmpDir, id),
        status: 'running', createdAt: new Date().toISOString(), services: { api: { profileId: 'api', containerName: 'kept-old',
          hostPort: 10011, status: 'running', deployedImage: `ghcr.io/owned/api:sha-${target}`, deployedMode: 'express' } } } as BranchEntry;
      stateService.addBranch(branch);
      const version = deploymentVersionService.create({ projectId: 'default', branchId: id, commitSha: target,
        configHash: 'c'.repeat(64), profiles: [stateService.getBuildProfile('api')!], branch, createdByRunId: 'old-import' });
      const before = structuredClone(branch);
      const response = await request(server, 'POST', `/api/branches/${id}/deploy`, { versionId: version.id });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ ok: false, operationStatus: 'rejected', error: expect.stringContaining('产物') });
      expect(response.headers['x-cds-deployment-run-id']).toBeUndefined();
      expect(stateService.getBranch(id)).toEqual(before);
      expect(deploymentRunService.list({ branchId: id })).toEqual([]);
      expect(mock.commands.some(command => isAppLaunchCommand(command) || /^docker (stop|rm) /.test(command))).toBe(false);
    });

    it('单服务预构建原记录和版本必须记录本次目标而非分支旧缓存', async () => {
      const previous = 'a'.repeat(40), requested = 'b'.repeat(40);
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}',
        workDir: '.', command: '', containerPort: 3000, prebuiltImage: true });
      readyArtifactFixture();
      const id = 'artifact-service-ledger';
      stateService.addBranch({ id, projectId: 'default', branch: 'feature/artifact-service-ledger', worktreePath: path.join(tmpDir, 'worktrees', id),
        status: 'idle', createdAt: new Date().toISOString(), githubCommitSha: previous, ciTargetSha: previous, services: {} });
      const response = await request(server, 'POST', `/api/branches/${id}/deploy/api`, { commitSha: requested });
      expect(response.status).toBe(200);
      const run = await waitForAcceptedRun(response);
      expect(run.status).toBe('running');
      expect(stateService.getBranch(id)?.services.api.deployedImage).toBe(`ghcr.io/owned/api:sha-${requested}@sha256:${requested + requested.slice(0, 24)}`);
      expect(run.commitSha).toBe(requested);
      expect(deploymentVersionService.get(run.versionId!)?.commitSha).toBe(requested);
    });

    it.each([false, true])('上游已发布但clone缺目标B时，真实Master准入及等待重试能取回再比较，重试=%s', async retry => {
      const { A, B, repo, origin, git } = unfetchedCommitFixture(), content = `sha256:${'c'.repeat(64)}`;
      const fallback = 'ghcr.io/owned/api:branch-main', scope = ['component.txt'];
      stateService.addBuildProfile({ id: 'api', projectId: 'default', name: 'API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}',
        fallbackImage: [fallback], buildScope: scope, workDir: '.', command: '', containerPort: 3000, prebuiltImage: true });
      const id = 'unfetched-admission'; stateService.addBranch({ id, projectId: 'default', branch: 'main',
        worktreePath: path.join(tmpDir, 'untrusted-checkout'), status: 'idle', createdAt: new Date().toISOString(), githubCommitSha: B, ciTargetSha: B, services: {} });
      let available = !retry, elapsed = 1000;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
      mock.addResponsePatternFirst(/docker info/, () => ({ stdout: JSON.stringify({ Architecture: 'amd64', OSType: 'linux' }), stderr: '', exitCode: 0 }));
      mock.addResponsePatternFirst(/docker pull (.+)/, match => ({ stdout: '', stderr: available && match[1].includes(fallback) ? '' : 'manifest unknown',
        exitCode: available && match[1].includes(fallback) ? 0 : 1 }));
      mock.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: content, RepoDigests: [`ghcr.io/owned/api@${content}`],
        Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': A } } }]), stderr: '', exitCode: 0 }));
      const checked: Array<{ state: string; reason?: string }> = [], inspect = containerService.inspectDeploymentArtifacts.bind(containerService);
      const inspection = vi.spyOn(containerService, 'inspectDeploymentArtifacts').mockImplementation(async (...args) => {
        const result = await inspect(...args); checked.push(result); return result;
      });
      try {
        const response = await request(server, 'POST', `/api/branches/${id}/deploy`, { commitSha: B });
        expect(response.status).toBe(200); await requestArtifactWaitRefresh(branchOperationCoordinator);
        if (retry) {
          expect(checked.at(-1)).toMatchObject({ state: 'waiting', reason: 'missing' });
          expect(mock.commands.some(command => /^git fetch/.test(command))).toBe(false);
          available = true; elapsed += 30_001; await requestArtifactWaitRefresh(branchOperationCoordinator);
        }
        expect(checked.at(-1)).toMatchObject({ state: 'ready', targetCommitSha: B, artifacts: [{ revision: A }] });
        expect(git(['rev-parse', '--verify', `${B}^{commit}`], repo)).toBe(B);
        const fetched = mock.commands.indexOf(`git fetch origin ${B}`), compared = mock.commands.findIndex(command => /^'git'.*'diff'/.test(command));
        expect(fetched).toBeGreaterThanOrEqual(0); expect(fetched).toBeLessThan(compared);
        expect(git(['rev-parse', 'HEAD'], repo)).toBe(A); expect(git(['remote', 'get-url', 'origin'], repo)).toBe(origin);
        const run = await waitForAcceptedRun(response); expect(run).toMatchObject({ status: 'running', commitSha: B });
        expect(stateService.getBranch(id)?.services.api.deployedImage).toBe(`ghcr.io/owned/api:sha-${A}@${content}`);
      } finally { clock.mockRestore(); inspection.mockRestore(); }
    });

    it.each(['/deploy', '/deploy/api'])('真实Master %s精确目标产物已齐时不准备Git对象，即使clone缺B', async endpoint => {
      const { B } = unfetchedCommitFixture(), id = 'exact-unfetched'; readyArtifactFixture();
      stateService.addBuildProfile({ id: 'api', projectId: 'default', name: 'API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}',
        fallbackImage: ['ghcr.io/owned/api:branch-main'], buildScope: ['component.txt'], workDir: '.', command: '', containerPort: 3000, prebuiltImage: true });
      stateService.addBranch({ id, projectId: 'default', branch: 'main', worktreePath: path.join(tmpDir, 'exact-checkout'), status: 'idle',
        createdAt: new Date().toISOString(), githubCommitSha: B, ciTargetSha: B, services: {} });
      const prepare = vi.spyOn(WorktreeService.prototype, 'ensureCommitAvailable');
      try {
        const response = await request(server, 'POST', `/api/branches/${id}${endpoint}`, { commitSha: B });
        expect(response.status).toBe(200); await requestArtifactWaitRefresh(branchOperationCoordinator);
        expect((await waitForAcceptedRun(response)).status).toBe('running'); expect(prepare).not.toHaveBeenCalled();
      } finally { prepare.mockRestore(); }
    });

    it.each(['stop', 'project', 'repo'])('真实Master准备槽等待中%s变化撤销原票据，不得迟到fetch或放行', async change => {
      const { A, B } = unfetchedCommitFixture(), id = 'input-revoked', content = `sha256:${'c'.repeat(64)}`;
      stateService.addBuildProfile({ id: 'api', projectId: 'default', name: 'API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}',
        fallbackImage: ['ghcr.io/owned/api:branch-main'], buildScope: ['component.txt'], workDir: '.', command: '', containerPort: 3000, prebuiltImage: true });
      stateService.addBranch({ id, projectId: 'default', branch: 'main', worktreePath: path.join(tmpDir, 'revoked-checkout'), status: 'idle',
        createdAt: new Date().toISOString(), githubCommitSha: B, ciTargetSha: B, services: {} });
      mock.addResponsePatternFirst(/docker info/, () => ({ stdout: JSON.stringify({ Architecture: 'amd64', OSType: 'linux' }), stderr: '', exitCode: 0 }));
      mock.addResponsePatternFirst(/docker pull (.+)/, match => ({ stdout: '', stderr: match[1].includes(B) ? 'manifest unknown' : '', exitCode: match[1].includes(B) ? 1 : 0 }));
      mock.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: content, RepoDigests: [`ghcr.io/owned/api@${content}`],
        Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': A } } }]), stderr: '', exitCode: 0 }));
      let enter!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const owned = (mock as any).execOwnedOperation;
      Object.assign(mock, { execOwnedOperation: async (command: string, options: ExecOptions & { beforeStart: () => void }) => {
        if (command.includes(B)) { enter(); await gate; } return owned(command, options);
      } });
      const response = await request(server, 'POST', `/api/branches/${id}/deploy`, { commitSha: B }); await started;
      try {
        if (change === 'stop') expect((await request(server, 'POST', `/api/branches/${id}/stop`)).status).toBe(200);
        else if (change === 'project') stateService.getBranch(id)!.projectId = 'foreign';
        else stateService.getProject('default')!.repoPath = path.join(tmpDir, 'foreign');
        release(); await requestArtifactWaitRefresh(branchOperationCoordinator);
        expect(mock.commands.some(command => /^git fetch|^docker (run|create)/.test(command))).toBe(false);
        expect(deploymentRunService.get(String(response.headers['x-cds-deployment-run-id']))?.status).not.toBe('running');
      } finally { release(); await requestArtifactWaitRefresh(branchOperationCoordinator); }
    });

    it.each(['/deploy', '/deploy/api'])('增量镜像%s从真实准入入口复用A而原任务/版本仍锁定B', async endpoint => {
      const A = 'a'.repeat(40), B = 'b'.repeat(40), content = `sha256:${'c'.repeat(64)}`;
      const scope = ['prd-api/**', '.github/workflows/branch-image.yml'];
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}',
        fallbackImage: ['ghcr.io/owned/api:branch-main'], buildScope: scope, workDir: '.', command: '', containerPort: 3000, prebuiltImage: true });
      const id = 'incremental-admission';
      stateService.addBranch({ id, projectId: 'default', branch: 'feature/incremental-admission', worktreePath: path.join(tmpDir, 'untrusted-checkout'),
        status: 'idle', createdAt: new Date().toISOString(), githubCommitSha: B, ciTargetSha: B, services: {} });
      const trustedRepo = path.join(tmpDir, 'trusted-project-repo'); stateService.getProject('default')!.repoPath = trustedRepo;
      Object.assign(mock, { execBackgroundObservation: mock.exec.bind(mock) });
      mock.addResponsePatternFirst(/^'git'.*'diff'/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePatternFirst(/docker info/, () => ({ stdout: JSON.stringify({ Architecture: 'amd64', OSType: 'linux' }), stderr: '', exitCode: 0 }));
      mock.addResponsePatternFirst(/docker pull (.+)/, match => ({ stdout: '', stderr: match[1].includes(`sha-${B}`) ? 'manifest unknown' : '',
        exitCode: match[1].includes(`sha-${B}`) ? 1 : 0 }));
      mock.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: content, RepoDigests: [`ghcr.io/owned/api@${content}`],
        Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': A } } }]), stderr: '', exitCode: 0 }));
      const response = await request(server, 'POST', `/api/branches/${id}${endpoint}`, { commitSha: B });
      expect(response.status).toBe(200);
      const run = await waitForAcceptedRun(response);
      expect(run.status).toBe('running'); expect(run.commitSha).toBe(B);
      expect(deploymentVersionService.get(run.versionId!)?.profiles[0].buildScope).toEqual(scope);
      expect(deploymentVersionService.get(run.versionId!)?.commitSha).toBe(B);
      expect(stateService.getBranch(id)?.services.api.deployedImage).toBe(`ghcr.io/owned/api:sha-${A}@${content}`);
      const reads = mock.commands.filter(command => /^'git'.*'diff'/.test(command));
      expect(reads.length).toBeGreaterThanOrEqual(2);
      expect(reads.every(command => command.includes(`'-C' '${trustedRepo}'`) && command.includes(`'${A}' '${B}'`))).toBe(true);
      // 正常部署受理后仍保留既有源码准备步骤；准入证明不能依赖这一步才发生。
      const compared = mock.commands.findIndex(command => reads.includes(command));
      expect(mock.commands.slice(0, compared)).toContain(`git rev-parse --verify '${B}^{commit}'`);
      expect(compared).toBeLessThan(mock.commands.findIndex(command => /^git fetch origin (?![0-9a-f]{40}$)/.test(command)));
      expect(mock.commands.filter(command => isAppLaunchCommand(command)).every(command => command.includes(`:sha-${A}@${content}`))).toBe(true);
    });

    async function incrementalVersionReplayFixture(id: string) {
      const B = 'b'.repeat(40), A1 = 'a'.repeat(40), A2 = 'c'.repeat(40);
      const digest1 = `sha256:${'d'.repeat(64)}`, digest2 = `sha256:${'e'.repeat(64)}`;
      const scope = ['prd-api/**', '.github/workflows/branch-image.yml'];
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}',
        fallbackImage: ['ghcr.io/owned/api:branch-main'], buildScope: scope, workDir: '.', command: '', containerPort: 3000, prebuiltImage: true });
      const branch: BranchEntry = { id, projectId: 'default', branch: `feature/${id}`, worktreePath: path.join(tmpDir, id),
        status: 'idle', createdAt: new Date().toISOString(), githubCommitSha: B, ciTargetSha: B, services: {} };
      stateService.addBranch(branch);
      stateService.getProject('default')!.repoPath = path.join(tmpDir, 'trusted-project-repo');
      Object.assign(mock, { execBackgroundObservation: mock.exec.bind(mock) });
      mock.addResponsePatternFirst(/^'git'.*'diff'/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePatternFirst(/docker info/, () => ({ stdout: JSON.stringify({ Architecture: 'amd64', OSType: 'linux' }), stderr: '', exitCode: 0 }));
      mock.addResponsePatternFirst(/docker pull (.+)/, match => ({ stdout: '', stderr: match[1].includes(`sha-${B}`) ? 'manifest unknown' : '',
        exitCode: match[1].includes(`sha-${B}`) ? 1 : 0 }));
      let moved = false;
      mock.addResponsePatternFirst(/docker image inspect (.+)/, match => {
        const first = match[1].includes(digest1) || !match[1].includes(digest2) && !moved;
        const revision = first ? A1 : A2, digest = first ? digest1 : digest2;
        return { stdout: JSON.stringify([{ Id: digest, RepoDigests: [`ghcr.io/owned/api@${digest}`], Os: 'linux', Architecture: 'amd64',
          Config: { Labels: { 'org.opencontainers.image.revision': revision } } }]), stderr: '', exitCode: 0 };
      });
      const firstResponse = await request(server, 'POST', `/api/branches/${id}/deploy`, { commitSha: B });
      expect(firstResponse.status).toBe(200);
      const firstRun = await waitForAcceptedRun(firstResponse); expect(firstRun.status).toBe('running');
      const firstVersion = deploymentVersionService.get(firstRun.versionId!)!;
      const image1 = `ghcr.io/owned/api:sha-${A1}@${digest1}`, image2 = `ghcr.io/owned/api:sha-${A2}@${digest2}`;
      expect(firstVersion).toMatchObject({ commitSha: B, profiles: [{ artifactImage: image1, buildScope: scope }] });
      return { B, A1, A2, scope, branch, firstVersion, image1, image2, moveFallback: () => { moved = true; } };
    }

    it('增量产物同B重复部署在fallback前移后不自动套用不相容旧版本', async () => {
      const fixture = await incrementalVersionReplayFixture('incremental-repeat-auto');
      const snapshot = structuredClone(fixture.firstVersion);
      fixture.moveFallback();
      const response = await request(server, 'POST', `/api/branches/${fixture.branch.id}/deploy`, { commitSha: fixture.B });
      expect(response.status).toBe(200);
      const run = await waitForAcceptedRun(response);
      expect(run.status).toBe('running'); expect(run.commitSha).toBe(fixture.B);
      const version = deploymentVersionService.get(run.versionId!)!;
      expect(version).toMatchObject({ commitSha: fixture.B, configHash: fixture.firstVersion.configHash,
        profiles: [{ artifactImage: fixture.image2, buildScope: fixture.scope }] });
      expect(version.id).not.toBe(fixture.firstVersion.id);
      expect(fixture.branch.services.api.deployedImage).toBe(fixture.image2);
      expect(deploymentVersionService.get(fixture.firstVersion.id)).toEqual(snapshot);
      expect(run.events.some(event => event.step === 'version-reuse')).toBe(false);
    });

    it.each(['known', 'unknown'] as const)('增量产物显式versionId保留原快照且历史scope=%s不借当前配置', async mode => {
      const fixture = await incrementalVersionReplayFixture(`incremental-replay-${mode}`);
      const version = mode === 'known' ? fixture.firstVersion : deploymentVersionService.create({
        projectId: 'default', branchId: fixture.branch.id, commitSha: fixture.B, configHash: fixture.firstVersion.configHash,
        profiles: [{ ...stateService.getBuildProfile('api')!, buildScope: undefined }], branch: fixture.branch, createdByRunId: 'legacy-scope' });
      fixture.moveFallback();
      const before = structuredClone(fixture.branch), launches = mock.commands.filter(isAppLaunchCommand).length;
      const response = await request(server, 'POST', `/api/branches/${fixture.branch.id}/deploy`, { versionId: version.id });
      if (mode === 'known') {
        expect(response.status).toBe(200);
        const run = await waitForAcceptedRun(response);
        expect(run).toMatchObject({ status: 'running', commitSha: fixture.B, versionId: version.id });
        expect(fixture.branch.services.api.deployedImage).toBe(fixture.image1);
        expect(mock.commands.filter(isAppLaunchCommand).slice(launches).every(command => command.includes(fixture.image1))).toBe(true);
      } else {
        expect(response.status).toBe(409);
        expect(response.headers['x-cds-deployment-run-id']).toBeUndefined();
        expect(fixture.branch).toEqual(before);
        expect(mock.commands.filter(isAppLaunchCommand)).toHaveLength(launches);
        expect(deploymentRunService.list({ branchId: fixture.branch.id })).toHaveLength(1);
      }
    });

    it.each(['valid', 'master-changed', 'forged-scope', 'accepted-only', 'wrong-repository'] as const)
    ('远端增量回执%s必须由Master用可信仓库完整范围独立复核', async mode => {
      const A = 'a'.repeat(40), B = 'b'.repeat(40), content = `sha256:${'d'.repeat(64)}`;
      const scope = ['prd-api/**', '.github/workflows/branch-image.yml'], fallback = 'ghcr.io/owned/api:branch-main';
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}',
        fallbackImage: [fallback], buildScope: scope, workDir: '.', command: '', containerPort: 3000, prebuiltImage: true });
      const id = 'incremental-remote', now = new Date().toISOString();
      stateService.addBranch({ id, projectId: 'default', branch: 'feature/incremental-remote', worktreePath: path.join(tmpDir, 'wrong-checkout'),
        status: 'idle', createdAt: now, githubCommitSha: B, ciTargetSha: B, services: {} });
      const trustedRepo = path.join(tmpDir, 'trusted-project-repo'); stateService.getProject('default')!.repoPath = trustedRepo;
      registryNodes.push({ id: 'exec-incremental', host: '127.0.0.1', port: 9102, status: 'online', role: 'remote', labels: [], branches: [],
        capacity: { maxBranches: 10, memoryMB: 1024, cpuCores: 2 }, load: { memoryUsedMB: 0, cpuPercent: 0 }, registeredAt: now, lastHeartbeat: now });
      Object.assign(mock, { execBackgroundObservation: mock.exec.bind(mock) });
      mock.addResponsePatternFirst(/^'git'.*'diff'/, () => ({ stdout: '', stderr: '', exitCode: mode === 'master-changed' ? 1 : 0 }));
      let dispatched: any;
      vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (String(_input).includes('/artifact-preflight')) return new Response(JSON.stringify({ state: 'ready', targetCommitSha: B,
          checkedAt: now, repoRoot: '/remote-untrusted-proof-root', accepted: true, artifacts: [{ profileIds: ['api'], requestedImage: body.profiles[0].dockerImage,
            selectedImage: fallback, image: `${mode === 'wrong-repository' ? 'ghcr.io/foreign/api' : 'ghcr.io/owned/api'}@${content}`,
            revision: A, platform: 'linux/amd64', accepted: true, ...(mode === 'accepted-only' ? {} : {
              proof: { kind: 'component-unchanged', buildScope: mode === 'forged-scope' ? ['prd-api/small.cs'] : scope } }) }] }), { status: 200 });
        dispatched = body; return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      });
      try {
        const response = await request(server, 'POST', `/api/branches/${id}/deploy`, { commitSha: B, targetExecutorId: 'exec-incremental' });
        expect(response.status).toBe(200); // 既有SSE拒绝协议，拒绝不能只靠HTTP状态判断。
        if (mode === 'valid') {
          expect(dispatched.profiles[0].dockerImage).toBe(`ghcr.io/owned/api:sha-${A}@${content}`);
          expect(dispatched.commitSha).toBe(B); expect(dispatched.artifactCommitSha).toBe(B);
        } else {
          expect(dispatched).toBeUndefined();
          expect(String(response.body)).toContain('"operationStatus":"rejected"');
        }
        const reads = mock.commands.filter(command => /^'git'.*'diff'/.test(command));
        expect(reads).toHaveLength(['valid', 'master-changed'].includes(mode) ? 1 : 0);
        expect(reads.every(command => command.includes(`'-C' '${trustedRepo}'`) && command.includes(`'${A}' '${B}'`))).toBe(true);
        expect(mock.commands.some(command => /docker |git fetch|git worktree/.test(command))).toBe(false);
      } finally { vi.unstubAllGlobals(); }
    });

    it('增量镜像排队复核沿用原scope/候选和同一run，不能借已修改配置放行', async () => {
      const A = 'a'.repeat(40), B = 'b'.repeat(40), content = `sha256:${'c'.repeat(64)}`;
      const scope = ['prd-api/**', '.github/workflows/branch-image.yml'], fallback = 'ghcr.io/owned/api:branch-main';
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}',
        fallbackImage: [fallback], buildScope: scope, workDir: '.', command: '', containerPort: 3000, prebuiltImage: true });
      const id = 'incremental-queued';
      stateService.addBranch({ id, projectId: 'default', branch: 'feature/incremental-queued', worktreePath: path.join(tmpDir, id),
        status: 'idle', createdAt: new Date().toISOString(), githubCommitSha: B, ciTargetSha: B, services: {} });
      let available = false;
      Object.assign(mock, { execBackgroundObservation: mock.exec.bind(mock) });
      mock.addResponsePatternFirst(/^'git'.*'diff'.*$/, match => ({ stdout: '', stderr: '',
        exitCode: scope.every(item => match[0].includes(`'${item}'`)) ? 0 : 1 }));
      mock.addResponsePatternFirst(/docker info/, () => ({ stdout: JSON.stringify({ Architecture: 'amd64', OSType: 'linux' }), stderr: '', exitCode: 0 }));
      mock.addResponsePatternFirst(/docker pull (.+)/, match => ({ stdout: '', stderr: available && match[1].includes(fallback) ? '' : 'manifest unknown',
        exitCode: available && match[1].includes(fallback) ? 0 : 1 }));
      mock.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: content, RepoDigests: [`ghcr.io/owned/api@${content}`],
        Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': A } } }]), stderr: '', exitCode: 0 }));
      const response = await request(server, 'POST', `/api/branches/${id}/deploy`, { commitSha: B });
      await requestArtifactWaitRefresh(branchOperationCoordinator);
      const runId = String(response.headers['x-cds-deployment-run-id']);
      expect(deploymentRunService.get(runId)).toMatchObject({ status: 'queued', phase: 'artifact-wait' });
      expect(mock.commands.some(command => /docker (run|create|stop|rm)|git fetch|git worktree/.test(command))).toBe(false);
      Object.assign(stateService.getBuildProfile('api')!, { buildScope: ['unrelated/**'], fallbackImage: ['ghcr.io/foreign/api:latest'] });
      available = true;
      // 不快进产品时钟；直接请求下一轮有界复核，使用真实准入器与原快照解析路径。
      let checked: unknown;
      const [pending] = await refreshArtifactWaiters({ coordinator: branchOperationCoordinator, getBranch: key => stateService.getBranch(key), recheckMs: 0,
        containerService: { inspectDeploymentArtifacts: async (profiles, target, assertCurrent) => {
          const result = await containerService.inspectDeploymentArtifacts(profiles, target, assertCurrent,
            { isComponentUnchangedSince: componentInputComparator(mock, config.repoRoot, assertCurrent) });
          checked = result; return result;
        } } });
      expect((checked as any)?.reason).toBeUndefined(); expect(checked).toMatchObject({ state: 'ready' });
      expect(pending).toBeDefined();
      const resumed = await request(server, 'POST', `/api/branches/${id}/deploy`, pendingDeployBody(pending), { 'X-CDS-Internal': '1', 'X-CDS-Trigger': pending.request.trigger });
      expect(resumed.headers['x-cds-deployment-run-id']).toBe(runId);
      expect((await waitForAcceptedRun(resumed)).status).toBe('running');
      expect(deploymentRunService.list({ branchId: id })).toHaveLength(1);
      expect(stateService.getBranch(id)?.services.api.deployedImage).toBe(`ghcr.io/owned/api:sha-${A}@${content}`);
      expect(mock.commands.some(command => command.includes('ghcr.io/foreign/api'))).toBe(false);
      expect(mock.commands.filter(command => /^'git'.*'diff'/.test(command)).every(command => scope.every(item => command.includes(`'${item}'`)))).toBe(true);
    });

    it.each(['/deploy', '/deploy/api'])('显式产物目标%s缺失时不能用旧CI提交的镜像冒充', async (endpoint) => {
      const requested = 'b'.repeat(40), previous = 'a'.repeat(40);
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}',
        workDir: '.', command: '', containerPort: 3000, prebuiltImage: true });
      readyArtifactFixture();
      const id = 'artifact-target';
      stateService.addBranch({ id, projectId: 'default', branch: 'feature/artifact-target', worktreePath: path.join(tmpDir, 'worktrees', id),
        status: 'idle', createdAt: new Date().toISOString(), githubCommitSha: previous, ciTargetSha: previous, services: {} });
      mock.addResponsePatternFirst(/docker pull (.+)/, (match) => ({ stdout: match[1].includes(previous) ? 'old CI image available' : '',
        stderr: match[1].includes(previous) ? '' : 'manifest unknown', exitCode: match[1].includes(previous) ? 0 : 1 }));
      const response = await request(server, 'POST', `/api/branches/${id}${endpoint}`, { commitSha: requested });
      expect(response.status).toBe(200); // 受理原任务，缺产物停在可靠等待。
      await requestArtifactWaitRefresh(branchOperationCoordinator);
      expect(mock.commands.some(c => c.startsWith('docker pull ') && c.includes(requested))).toBe(true);
      expect(mock.commands.some(c => c.startsWith('docker pull ') && c.includes(previous))).toBe(false);
      expect(mock.commands.some(c => isAppLaunchCommand(c))).toBe(false);
      expect(deploymentRunService.list({ branchId: id })[0].status).toBe('queued');
    });

    it.each([true, false])('远端派发显式目标%s或CI默认目标携带已核验完整身份，不让执行器改取HEAD', async (explicit) => {
      const previous = 'a'.repeat(40), requested = explicit ? 'b'.repeat(40) : previous;
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}',
        workDir: '.', command: '', containerPort: 3000, prebuiltImage: true });
      const id = 'artifact-remote'; const now = new Date().toISOString();
      stateService.addBranch({ id, projectId: 'default', branch: 'feature/artifact-remote', worktreePath: path.join(tmpDir, 'worktrees', id),
        status: 'idle', createdAt: now, githubCommitSha: previous, ciTargetSha: previous, services: {} });
      registryNodes.push({ id: 'exec-artifact', host: '127.0.0.1', port: 9102, status: 'online', role: 'remote', labels: [], branches: [],
        capacity: { maxBranches: 10, memoryMB: 1024, cpuCores: 2 }, load: { memoryUsedMB: 0, cpuPercent: 0 }, registeredAt: now, lastHeartbeat: now });
      let dispatched: any, preflight: any;
      const digest = `ghcr.io/owned/api@sha256:${'d'.repeat(64)}`;
      vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        if (String(_input).includes('/artifact-preflight')) {
          preflight = body; return new Response(JSON.stringify({ state: 'ready', targetCommitSha: requested, checkedAt: new Date().toISOString(),
            artifacts: [{ profileIds: ['api'], requestedImage: body.profiles[0].dockerImage, image: digest, revision: requested, platform: 'linux/amd64' }] }), { status: 200 });
        }
        dispatched = body; return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      });
      try {
        expect((await request(server, 'POST', `/api/branches/${id}/deploy`, { ...(explicit ? { commitSha: requested } : {}), targetExecutorId: 'exec-artifact' })).status).toBe(200);
        expect(preflight.profiles[0].dockerImage).toBe(`ghcr.io/owned/api:sha-${requested}`);
        expect(dispatched.profiles[0].dockerImage).toBe(digest.replace('@', `:sha-${requested}@`));
        expect(dispatched.commitSha).toBe(requested); expect(dispatched.artifactCommitSha).toBe(requested);
        expect(mock.commands.some(c => isAppLaunchCommand(c))).toBe(false);
      } finally { vi.unstubAllGlobals(); }
    });

    it('显式产物目标修正保留未点名部署的docs-only旧CI镜像约定', async () => {
      const previous = 'a'.repeat(40), docsOnly = 'c'.repeat(40);
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'ghcr.io/owned/api:sha-${CDS_COMMIT_SHA}',
        workDir: '.', command: '', containerPort: 3000, prebuiltImage: true });
      readyArtifactFixture();
      const id = 'artifact-unpinned';
      stateService.addBranch({ id, projectId: 'default', branch: 'feature/artifact-unpinned', worktreePath: path.join(tmpDir, 'worktrees', id),
        status: 'idle', createdAt: new Date().toISOString(), githubCommitSha: docsOnly, ciTargetSha: previous, services: {} });
      mock.addResponsePatternFirst(/docker pull (.+)/, (match) => ({ stdout: match[1].includes(previous) ? 'old CI image available' : '',
        stderr: match[1].includes(previous) ? '' : 'manifest unknown', exitCode: match[1].includes(previous) ? 0 : 1 }));
      const response = await request(server, 'POST', `/api/branches/${id}/deploy`);
      expect(response.status).toBe(200); await waitForAcceptedRun(response);
      expect(stateService.getBranch(id)?.services.api.deployedImage).toBe(`ghcr.io/owned/api:sha-${previous}@sha256:${previous + previous.slice(0, 24)}`);
      expect(deploymentRunService.list({ branchId: id })[0].status).toBe('running');
    });

    it('同目标并入等待原受理落盘，不创建占位run、不启动第二次部署', async () => {
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'node', workDir: '.', command: 'node server.js', containerPort: 3000 });
      stateService.addBranch({ id: 'acceptance-wait', projectId: 'default', branch: 'feature/acceptance-wait', worktreePath: path.join(tmpDir, 'worktrees', 'acceptance-wait'),
        status: 'idle', createdAt: new Date().toISOString(), services: {} });
      let release!: () => void, blocked!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { blocked = resolve; });
      const originalFlush = stateService.flush.bind(stateService);
      const flush = vi.spyOn(stateService, 'flush').mockImplementationOnce(async () => { blocked(); await gate; await originalFlush(); });
      const addRun = vi.spyOn(stateService, 'addDeploymentRun'); let duplicateAnswered = false;
      const sha = 'a'.repeat(40);
      const first = request(server, 'POST', '/api/branches/acceptance-wait/deploy', { commitSha: sha });
      let duplicate: ReturnType<typeof request> | undefined;
      try {
        await started;
        duplicate = request(server, 'POST', '/api/branches/acceptance-wait/deploy', { commitSha: sha }).then((r) => { duplicateAnswered = true; return r; });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(duplicateAnswered).toBe(false);
        expect(addRun).toHaveBeenCalledTimes(1); expect(flush).toHaveBeenCalledTimes(1);
        expect(mock.commands.filter((command) => isAppLaunchCommand(command))).toHaveLength(0);
        release(); const [a, b] = await Promise.all([first, duplicate]);
        expect(a.headers['x-cds-deployment-run-id']).toBe(b.headers['x-cds-deployment-run-id']);
        expect(mock.commands.filter((command) => isAppLaunchCommand(command))).toHaveLength(1);
      } finally { release(); await Promise.allSettled([first, duplicate]); flush.mockRestore(); addRun.mockRestore(); }
    });

    it.each(['/deploy', '/deploy/api'])('排队%s沿用原run、重复目标不新建run、新目标取消旧待办', async (endpoint) => {
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'node', workDir: '.', command: 'node server.js', containerPort: 3000 });
      stateService.addBranch({ id: 'queued-run', projectId: 'default', branch: 'feature/queued-run', worktreePath: path.join(tmpDir, 'worktrees', 'queued-run'),
        status: 'idle', createdAt: new Date().toISOString(), services: {} });
      const shaA = 'a'.repeat(40), shaB = 'b'.repeat(40), shaC = 'c'.repeat(40);
      let release!: () => void, started!: () => void, replayed!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const start = new Promise<void>((resolve) => { started = resolve; });
      const replayDone = new Promise<void>((resolve) => { replayed = resolve; });
      const original = mock.exec.bind(mock); let actualRuns = 0; const replayRunIds: string[] = [];
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command) && command.includes('cds-queued-run-api')) {
          actualRuns++;
          if (actualRuns === 1) { started(); await hold; }
        }
        return original(command, options);
      };
      const addRun = vi.spyOn(stateService, 'addDeploymentRun');
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const replay = await request(server, 'POST', url.pathname, JSON.parse(String(init?.body)), init?.headers as Record<string, string>);
        replayRunIds.push(String(replay.headers['x-cds-deployment-run-id']));
        replayed();
        return new Response(String(replay.body), { status: replay.status });
      });
      setBuildGateHostLoadProvider(async () => ({ loadAvg1: 0, cpuCores: 16, usedMemPercent: 10, memAvailableMB: 32000 }));
      const first = request(server, 'POST', `/api/branches/queued-run${endpoint}`, { commitSha: shaA });
      try {
        await start;
        const queued = await request(server, 'POST', `/api/branches/queued-run${endpoint}`, { commitSha: shaB }, { 'X-CDS-Trigger': 'webhook' });
        const queuedId = String(queued.headers['x-cds-deployment-run-id']);
        expect(deploymentRunService.get(queuedId)?.status).toBe('queued');
        const persisted = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state.json'), 'utf8'));
        expect(persisted.deploymentRuns[queuedId]?.status).toBe('queued');
        const count = addRun.mock.calls.length;
        const duplicate = await request(server, 'POST', `/api/branches/queued-run${endpoint}`, { commitSha: shaB });
        expect(duplicate.headers['x-cds-deployment-run-id']).toBe(queuedId);
        expect(addRun.mock.calls.length).toBe(count);
        const newer = await request(server, 'POST', `/api/branches/queued-run${endpoint}`, { commitSha: shaC }, { 'X-CDS-Trigger': 'webhook' });
        expect(newer.status, JSON.stringify(newer.body)).toBe(200);
        const newId = String(newer.headers['x-cds-deployment-run-id']);
        expect(deploymentRunService.get(queuedId)?.status).toBe('cancelled');
        expect(deploymentRunService.get(newId)?.status).toBe('queued');
        release(); await first; await replayDone;
        expect(replayRunIds).toEqual([newId]);
        expect(deploymentRunService.get(newId)?.status).toBe('running');
        expect(deploymentRunService.list({ branchId: 'queued-run' })).toHaveLength(3);
        expect(actualRuns).toBe(2);
      } finally { release(); await first; setBuildGateHostLoadProvider(null); vi.unstubAllGlobals(); addRun.mockRestore(); }
    });

    it('points a joined deploy at the in-flight run, not the cancelled placeholder', async () => {
      const sha = '4444444444444444444444444444444444444444';
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api', name: 'API', dockerImage: 'node', command: 'node server.js', workDir: '.', containerPort: 3000,
      });
      stateService.addBranch({
        id: 'joined-run',
        projectId: 'default',
        branch: 'feature/joined-run',
        worktreePath: path.join(tmpDir, 'worktrees', 'joined-run'),
        status: 'idle',
        createdAt: new Date().toISOString(),
        services: {},
        githubCommitSha: sha,
      });
      stateService.save();

      let releaseRun!: () => void;
      const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
      let markRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command) && command.includes('--name cds-joined-run-api')) {
          markRunStarted();
          await runRelease;
          return { stdout: 'cid-joined-run', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const activeDeploy = request(
        server, 'POST', '/api/branches/joined-run/deploy', { commitSha: sha },
        { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-active' },
      );
      await runStarted;
      const activeRunId = deploymentRunService.list({ branchId: 'joined-run' })[0]?.id;
      expect(activeRunId).toBeTruthy();

      try {
      // cdscli 的同 sha 手动部署：并入，不再自己拆装容器
      const joined = await request(server, 'POST', '/api/branches/joined-run/deploy', { commitSha: sha });
      expect(String(joined.body)).toContain('joined');
      const headerRunId = joined.headers['x-cds-deployment-run-id'];
      expect(headerRunId).toBe(activeRunId);
      // 同目标不创建占位记录，也不触发额外部署。
      expect(deploymentRunService.list({ branchId: 'joined-run' })).toHaveLength(1);

      releaseRun();
      await activeDeploy;
      // CLI 跟着这个头轮询，最终看到的是 running（成功），不是 cancelled（失败）
      expect(deploymentRunService.get(String(headerRunId))?.status).toBe('running');
      } finally { releaseRun(); await activeDeploy; }
    });

    it('dispatches only the latest merged webhook commit after the active deploy completes', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'pending-latest',
        projectId: 'default',
        branch: 'feature/pending-latest',
        worktreePath: path.join(tmpDir, 'worktrees', 'pending-latest'),
        status: 'idle',
        createdAt: now,
        services: {},
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();

      let releaseRun!: () => void;
      const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
      let markRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command) && command.includes('--name cds-pending-latest-api')) {
          markRunStarted();
          await runRelease;
          return { stdout: 'cid-pending-latest', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const fetchCalls: Array<{ url: string; body: unknown; requestId?: string }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          requestId: new Headers(init?.headers).get('X-CDS-Request-Id') || undefined,
        });
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }) as typeof fetch;

      try {
        const activeDeploy = request(
          server,
          'POST',
          '/api/branches/pending-latest/deploy',
          { commitSha: '1111111111111111111111111111111111111111' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-a' },
        );
        await runStarted;

        const mergedB = await request(
          server,
          'POST',
          '/api/branches/pending-latest/deploy',
          { commitSha: '2222222222222222222222222222222222222222' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-b' },
        );
        const mergedC = await request(
          server,
          'POST',
          '/api/branches/pending-latest/deploy',
          { commitSha: '3333333333333333333333333333333333333333' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-c' },
        );

        expect(String(mergedB.body)).toContain('operationStatus');
        expect(String(mergedB.body)).toContain('merged');
        expect(String(mergedC.body)).toContain('3333333333333333333333333333333333333333');

        releaseRun();
        const active = await activeDeploy;
        expect(active.status).toBe(200);
        expect(fetchCalls).toHaveLength(1);
        expect(fetchCalls[0].url).toContain('/api/branches/pending-latest/deploy');
        expect(fetchCalls[0].body).toEqual({ commitSha: '3333333333333333333333333333333333333333',
          pendingReplay: { operationId: expect.any(String), generation: expect.any(Number) } });
        expect(fetchCalls[0].requestId).toBe('req-c');

        const pendingDispatch = operationEvents.find((event) =>
          event.branchId === 'pending-latest' && event.action === 'branch.operation.pending-dispatch.started',
        );
        expect(pendingDispatch?.operationId).toMatch(/^op_/);
        expect(pendingDispatch?.details).toMatchObject({
          commitSha: '3333333333333333333333333333333333333333',
          trigger: 'webhook',
          actor: 'system:webhook',
          kind: 'deploy',
          mergedCount: 2,
        });
        expect(pendingDispatch).toMatchObject({
          operationKind: 'deploy',
          operationTrigger: 'webhook',
          operationActor: 'system:webhook',
          operationSource: 'api.deploy-branch',
          commitSha: '3333333333333333333333333333333333333333',
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('records pending webhook drops with queryable operation metadata when the branch is gone', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'pending-gone',
        projectId: 'default',
        branch: 'feature/pending-gone',
        worktreePath: path.join(tmpDir, 'worktrees', 'pending-gone'),
        status: 'idle',
        createdAt: now,
        services: {},
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();

      let releaseRun!: () => void;
      const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
      let markRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command) && command.includes('--name cds-pending-gone-api')) {
          markRunStarted();
          await runRelease;
          return { stdout: 'cid-pending-gone', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const fetchCalls: string[] = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        fetchCalls.push(String(input));
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }) as typeof fetch;

      try {
        const activeDeploy = request(
          server,
          'POST',
          '/api/branches/pending-gone/deploy',
          { commitSha: '1111111111111111111111111111111111111111' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-gone-a' },
        );
        await runStarted;

        const merged = await request(
          server,
          'POST',
          '/api/branches/pending-gone/deploy',
          { commitSha: '2222222222222222222222222222222222222222' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-gone-b' },
        );
        expect(String(merged.body)).toContain('merged');

        stateService.removeBranch('pending-gone');
        stateService.save();
        releaseRun();

        const active = await activeDeploy;
        expect(active.status).toBe(200);
        expect(fetchCalls).toHaveLength(0);

        const pendingDrop = operationEvents.find((event) =>
          event.branchId === 'pending-gone' && event.action === 'branch.operation.pending-drop',
        );
        expect(pendingDrop).toMatchObject({
          requestId: 'req-gone-b',
          operationId: expect.stringMatching(/^op_/),
          operationKind: 'deploy',
          operationTrigger: 'webhook',
          operationActor: 'system:webhook',
          operationSource: 'api.deploy-branch',
          commitSha: '2222222222222222222222222222222222222222',
        });
        expect(pendingDrop?.details).toMatchObject({
          operationId: pendingDrop?.operationId,
          commitSha: '2222222222222222222222222222222222222222',
          trigger: 'webhook',
          actor: 'system:webhook',
          source: 'api.deploy-branch',
          kind: 'deploy',
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('manual stop cancels queued webhook deploy dispatch after an active deploy is fenced', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'stop-pending',
        projectId: 'default',
        branch: 'feature/stop-pending',
        worktreePath: path.join(tmpDir, 'worktrees', 'stop-pending'),
        status: 'idle',
        createdAt: now,
        services: {},
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();

      let releaseRun!: () => void;
      const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
      let markRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command) && command.includes('--name cds-stop-pending-api')) {
          markRunStarted();
          await runRelease;
          return { stdout: 'cid-stop-pending', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const fetchCalls: Array<{ url: string; body: unknown; requestId?: string }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          requestId: new Headers(init?.headers).get('X-CDS-Request-Id') || undefined,
        });
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }) as typeof fetch;

      try {
        const activeDeploy = request(
          server,
          'POST',
          '/api/branches/stop-pending/deploy',
          { commitSha: '1111111111111111111111111111111111111111' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-stop-a' },
        );
        await runStarted;

        const mergedB = await request(
          server,
          'POST',
          '/api/branches/stop-pending/deploy',
          { commitSha: '2222222222222222222222222222222222222222' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-stop-b' },
        );
        expect(String(mergedB.body)).toContain('merged');

        const stop = await request(
          server,
          'POST',
          '/api/branches/stop-pending/stop',
          undefined,
          { 'X-CDS-Request-Id': 'req-stop-manual' },
        );
        expect(stop.status).toBe(200);

        releaseRun();
        const active = await activeDeploy;
        expect(active.status).toBe(200);
        expect(String(active.body)).toContain('error');
        expect(fetchCalls).toHaveLength(0);
        expect(stateService.getBranch('stop-pending')?.status).toBe('idle');

        const events = operationEvents.filter((event) => event.branchId === 'stop-pending');
        expect(events.some((event) =>
          event.action === 'branch.operation.cancelled'
          && event.operationKind === 'deploy'
          && event.details?.reason === 'superseded by stop',
        )).toBe(true);
        expect(events.some((event) =>
          event.action === 'branch.operation.cancelled'
          && event.operationKind === 'deploy'
          && event.details?.pending === true
          && event.details?.reason === 'superseded by stop',
        )).toBe(true);
        expect(events.find((event) => event.action === 'branch.operation.pending-dispatch.started')).toBeUndefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    for (const pathKind of ['pre-pull', 'empty-profiles', 'retirement'] as const) for (const expired of [true, false]) {
      it(`local queued cleanup ${pathKind}: ${expired ? 'revoked old slot cannot delete the successor' : 'valid wait survives 15 minutes and still cleans up'}`, async () => {
        const id = `queued-cleanup-${pathKind}`, serviceId = pathKind === 'retirement' ? 'api' : 'orphan';
        const containerName = `cds-${id}-${serviceId}`, oldCid = 'a'.repeat(64);
        if (pathKind !== 'empty-profiles') await request(server, 'POST', '/api/build-profiles', {
          id: 'api', name: 'API', dockerImage: 'node', command: 'node server.js', workDir: '.', containerPort: 3000,
        });
        stateService.addBranch({ id, projectId: 'default', branch: `feature/${id}`,
          worktreePath: path.join(tmpDir, 'worktrees', id), status: 'running', createdAt: new Date().toISOString(),
          services: { [serviceId]: { profileId: serviceId, containerName, hostPort: 10002, status: 'running',
            ...(pathKind === 'retirement' ? { containerId: oldCid, networkName: 'cds-test-network',
              servingRuntime: { containerName, containerId: oldCid, hostPort: 10002, networkName: 'cds-test-network' } } : {}) } } });
        stateService.save();
        const release = await deploymentPhaseBudget.acquire('cleanup', { branchId: 'unrelated-cleanup-holder' });
        const deploy = request(server, 'POST', `/api/branches/${id}/deploy`);
        try {
          await vi.waitFor(() => expect(deploymentPhaseBudget.snapshot().cleanup.queued.some(item => item.branchId === id)).toBe(true));
          const run = deploymentRunService.list({ branchId: id })[0];
          const queued = deploymentPhaseBudget.snapshot().cleanup.queued.find(item => item.branchId === id)!;
          let successor: ReturnType<BranchOperationCoordinator['begin']> | undefined;
          if (expired) {
            expect(deploymentRunService.reconcileInterrupted(new Date(queued.enqueuedAt + 21 * 60_000)).map(item => item.id)).toContain(run.id);
            successor = branchOperationCoordinator.begin({ projectId: 'default', branchId: id, kind: 'deploy', trigger: 'manual',
              commitSha: 'b'.repeat(40), commitPinned: true });
            expect(successor.status).toBe('started');
            stateService.getBranch(id)!.services[serviceId].containerId = 'd'.repeat(64);
          } else {
            const heartbeat = run.heartbeatAt;
            expect(deploymentRunService.reconcileInterrupted(new Date(queued.enqueuedAt + 16 * 60_000))).toEqual([]);
            expect(run.heartbeatAt).toBe(heartbeat);
            expect(queued.operationGeneration).toBe(run.operationGeneration);
          }
          release();
          const response = await deploy;
          expect(response.status).toBe(200);
          const removal = mock.commands.filter(command => /^docker (?:stop|rm) /.test(command)
            && command.includes(pathKind === 'retirement' ? oldCid : containerName));
          if (expired) {
            expect(removal).toEqual([]);
            expect(successor!.lease!.isCurrent()).toBe(true);
            expect(stateService.getBranch(id)!.services[serviceId].containerId).toBe('d'.repeat(64));
          } else {
            expect(removal.some(command => command.startsWith('docker rm '))).toBe(true);
            if (pathKind !== 'retirement') expect(stateService.getBranch(id)!.services.orphan).toBeUndefined();
            else expect(stateService.getBranch(id)!.services.api.retainedRuntimes).toEqual([]);
          }
          expect(deploymentPhaseBudget.snapshot().cleanup.queued.some(item => item.branchId === id)).toBe(false);
        } finally { release(); await deploy; }
      });
    }

    it.each(['failed-candidate', 'unused-network'])('local replacement cleanup %s keeps the exact bounded wait', async kind => {
      const id = `replacement-${kind}`, oldCid = 'a'.repeat(64), candidateCid = 'b'.repeat(64);
      const unusedNetwork = `${branchAppNetworkName(id).slice(0, 27)}-r-${'c'.repeat(32)}`;
      mock.addResponsePatternFirst(/^docker network rm /, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      const entry: BranchEntry = { id, projectId: 'default', branch: `feature/${id}`,
        worktreePath: path.join(tmpDir, 'worktrees', id), status: 'running', createdAt: new Date().toISOString(),
        replacementNetwork: unusedNetwork, replacementNetworks: [unusedNetwork], services: { api: {
          profileId: 'api', containerName: 'candidate-api', containerId: candidateCid, hostPort: 10002,
          status: kind === 'failed-candidate' ? 'error' : 'running', creationIssued: true,
          networkName: kind === 'failed-candidate' ? unusedNetwork : 'current-network',
          ...(kind === 'failed-candidate' ? { servingRuntime: { containerName: 'old-api', containerId: oldCid,
            hostPort: 10001, networkName: 'old-network' } } : { retainedRuntimes: [{ containerName: 'unknown-old-api', hostPort: 10003 }] }),
        } } };
      stateService.addBranch(entry);
      const lease = branchOperationCoordinator.begin({ projectId: 'default', branchId: id, kind: 'deploy', trigger: 'manual' }).lease!;
      const run = await deploymentRunService.begin({ projectId: 'default', branchId: id, trigger: 'manual',
        operationId: lease.operationId, operationGeneration: lease.generation });
      deploymentRunService.transition(run.id, 'preparing', { phase: 'cleanup', message: '真实替换清理' });
      const heartbeat = run.heartbeatAt;
      const release = await deploymentPhaseBudget.acquire('cleanup', { branchId: 'unrelated-cleanup-holder' });
      const cleanup = commitServiceReplacements({ entry, profileIds: ['api'], state: stateService, container: containerService,
        operationId: lease.operationId, operationGeneration: lease.generation, assertCurrent: step => lease.assertCurrent(step) });
      const result = cleanup.then(() => undefined, error => error);
      try {
        await vi.waitFor(() => expect(deploymentPhaseBudget.snapshot().cleanup.queued.some(item => item.branchId === id)).toBe(true));
        const queued = deploymentPhaseBudget.snapshot().cleanup.queued.find(item => item.branchId === id)!;
        expect(deploymentRunService.reconcileInterrupted(new Date(queued.enqueuedAt + 16 * 60_000))).toEqual([]);
        expect(run.heartbeatAt).toBe(heartbeat);
        expect(queued.operationGeneration).toBe(lease.generation);
        release(); expect(await result).toBeUndefined();
        if (kind === 'failed-candidate') {
          expect(mock.commands.some(command => command === `docker rm ${candidateCid}`)).toBe(true);
          expect(entry.services.api.containerId).toBe(oldCid);
        } else {
          expect(mock.commands.some(command => command === `docker network rm '${unusedNetwork}'`)).toBe(true);
          expect(entry.replacementNetworks).toEqual([]);
        }
        expect(mock.commands.some(command => command === `docker rm ${oldCid}`)).toBe(false);
      } finally { release(); await result; }
    });

    it('orphan-service removal does not delete entry.services when the deploy lease is superseded mid-loop', async () => {
      // Bugbot Medium (learned rule: BranchOperationCoordinator lease safety): the deploy-finalize
      // loop that tears down services removed from the desired set awaits containerService.remove.
      // If a higher-priority op (manual stop) supersedes the deploy lease during that await, the loop
      // must assertCurrent and abort BEFORE deleting entry.services + save() — not mutate state under
      // a cancelled deploy.
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'orphan-fence',
        projectId: 'default',
        branch: 'feature/orphan-fence',
        worktreePath: path.join(tmpDir, 'worktrees', 'orphan-fence'),
        status: 'idle',
        createdAt: now,
        services: {
          api: { profileId: 'api', containerName: 'cds-orphan-fence-api', hostPort: 10001, status: 'idle' },
          // zombie: no matching build profile → the deploy's orphan-removal loop will try to remove it.
          zombie: { profileId: 'zombie', containerName: 'cds-orphan-fence-zombie', hostPort: 10002, status: 'idle' },
        },
      });
      stateService.save();

      // Gate the deploy inside the orphan-removal loop: pause when it issues `docker rm` for the
      // zombie container, then supersede the lease via a manual stop, then release.
      let releaseRm!: () => void;
      const rmRelease = new Promise<void>((resolve) => { releaseRm = resolve; });
      let markRmStarted!: () => void;
      const rmStarted = new Promise<void>((resolve) => { markRmStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (command.includes('docker rm') && command.includes('cds-orphan-fence-zombie')) {
          markRmStarted();
          await rmRelease;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const deployPromise = request(server, 'POST', '/api/branches/orphan-fence/deploy');
      try {
        await rmStarted;
        // Manual stop supersedes the in-flight deploy lease.
        const stop = await request(
          server,
          'POST',
          '/api/branches/orphan-fence/stop',
          undefined,
          { 'X-CDS-Request-Id': 'req-orphan-stop' },
        );
        expect(stop.status).toBe(200);
      } finally {
        releaseRm();
      }
      const deploy = await deployPromise;
      expect(deploy.status).toBe(200);
      // The superseded deploy must NOT have deleted the zombie service entry under a cancelled lease.
      expect(stateService.getBranch('orphan-fence')?.services.zombie).toBeTruthy();
    });

    it('deploy with an empty effective profile list tears down lingering services instead of 400 (Codex P2)', async () => {
      // A branch whose only running service was a branch-local extra. After the extra is cleared the
      // effective profile list is empty. The deploy must NOT just 400 and leave the old container +
      // entry.services row behind — it should reconcile (tear down) the now-orphaned services.
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'empty-cleanup',
        projectId: 'default',
        branch: 'feature/empty-cleanup',
        worktreePath: path.join(tmpDir, 'worktrees', 'empty-cleanup'),
        status: 'running',
        createdAt: now,
        currentVersionId: 'dv_previous',
        // No build profiles configured for the project AND no extraProfiles → effective list empty,
        // but a leftover service is still tracked (the just-cleared extra).
        services: {
          'demo-extra': { profileId: 'demo-extra', containerName: 'cds-empty-cleanup-demo-extra', hostPort: 10005, status: 'running' },
        },
      });
      stateService.save();

      const res = await request(server, 'POST', '/api/branches/empty-cleanup/deploy');
      expect(res.status).toBe(200);
      // deploy 端点契约是 SSE：清空路径以 event: complete 收尾（不再是 200 JSON，Bugbot Medium）。
      expect(res.headers['content-type']).toContain('text/event-stream');
      const sse = String(res.body);
      expect(sse).toContain('event: complete');
      expect(sse).toContain('event: deployment-run');
      expect(sse).toContain('demo-extra'); // cleared 列表在 complete data 里
      // The lingering service row is gone (container was torn down + entry removed).
      expect(stateService.getBranch('empty-cleanup')?.services['demo-extra']).toBeUndefined();
      expect(Object.keys(stateService.getBranch('empty-cleanup')?.services || {})).toHaveLength(0);
      expect(stateService.getBranch('empty-cleanup')?.currentVersionId).toBeUndefined();
      const runId = String(res.headers['x-cds-deployment-run-id']);
      expect(runId).toMatch(/^dr_/);
      expect(stateService.getBranch('empty-cleanup')?.lastDeploymentRunId).toBe(runId);
      expect(deploymentRunService.get(runId)).toMatchObject({
        branchId: 'empty-cleanup',
        trigger: 'manual',
        status: 'running',
        phase: 'complete',
      });
    });

    it('deploy with empty profiles refuses (503) when the owning executor is offline — no state mutation (Bugbot High)', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'empty-offline-exec',
        projectId: 'default',
        branch: 'feature/empty-offline-exec',
        worktreePath: path.join(tmpDir, 'worktrees', 'empty-offline-exec'),
        status: 'running',
        createdAt: now,
        executorId: 'exec-off',
        services: {
          'demo-extra': { profileId: 'demo-extra', containerName: 'cds-empty-offline-exec-demo-extra', hostPort: 10006, status: 'running' },
        },
      });
      registryNodes.push({
        id: 'exec-off', host: '127.0.0.1', port: 9109, status: 'offline', role: 'remote',
        labels: [], branches: ['empty-offline-exec'],
        capacity: { maxBranches: 10, memoryMB: 1024, cpuCores: 2 }, load: { memoryUsedMB: 0, cpuPercent: 0 }, registeredAt: now,
      });
      stateService.save();

      const res = await request(server, 'POST', '/api/branches/empty-offline-exec/deploy');
      expect(res.status).toBe(503);
      expect((res.body as any).error).toBe('owning_executor_offline');
      // state untouched — the worker container must not be orphaned/ghosted.
      expect(stateService.getBranch('empty-offline-exec')?.services['demo-extra']).toBeTruthy();
      expect(stateService.getBranch('empty-offline-exec')?.status).toBe('running');
    });

    it('deploy refuses (503) when dropping ONE service while project profiles remain + owning executor offline (Codex P2)', async () => {
      const now = new Date().toISOString();
      // Project profile 'api' remains; the branch also has a leftover 'demo-extra' service that is NOT in the
      // effective profile list (extra cleared) → it would be dropped. Owner offline → must refuse, not delete.
      stateService.addBuildProfile({ id: 'api', name: 'API', dockerImage: 'img', workDir: 'api', command: 'run', containerPort: 8080, projectId: 'default' });
      stateService.addBranch({
        id: 'partial-offline-exec',
        projectId: 'default',
        branch: 'feature/partial-offline-exec',
        worktreePath: path.join(tmpDir, 'worktrees', 'partial-offline-exec'),
        status: 'running',
        createdAt: now,
        executorId: 'exec-off2',
        services: {
          api: { profileId: 'api', containerName: 'cds-partial-offline-exec-api', hostPort: 10010, status: 'running' },
          'demo-extra': { profileId: 'demo-extra', containerName: 'cds-partial-offline-exec-demo-extra', hostPort: 10011, status: 'running' },
        },
      });
      registryNodes.push({
        id: 'exec-off2', host: '127.0.0.1', port: 9110, status: 'offline', role: 'remote',
        labels: [], branches: ['partial-offline-exec'],
        capacity: { maxBranches: 10, memoryMB: 1024, cpuCores: 2 }, load: { memoryUsedMB: 0, cpuPercent: 0 }, registeredAt: now,
      });
      stateService.save();

      const res = await request(server, 'POST', '/api/branches/partial-offline-exec/deploy');
      expect(res.status).toBe(503);
      expect((res.body as any).error).toBe('owning_executor_offline');
      expect((res.body as any).droppedServices).toContain('demo-extra');
      // state untouched — both services remain tracked.
      expect(stateService.getBranch('partial-offline-exec')?.services['demo-extra']).toBeTruthy();
      expect(stateService.getBranch('partial-offline-exec')?.services['api']).toBeTruthy();
    });

    it('deploy refuses (503) when a remote-attributed branch drops a service but the executor is NOT in the registry (Bugbot "Missing executor skips offline guard")', async () => {
      const now = new Date().toISOString();
      stateService.addBuildProfile({ id: 'api', name: 'API', dockerImage: 'img', workDir: 'api', command: 'run', containerPort: 8080, projectId: 'default' });
      stateService.addBranch({
        id: 'gone-exec-branch',
        projectId: 'default',
        branch: 'feature/gone-exec',
        worktreePath: path.join(tmpDir, 'worktrees', 'gone-exec-branch'),
        status: 'running',
        createdAt: now,
        // executorId points at a remote executor that is NOT registered (deregistered / stale attribution).
        executorId: 'exec-gone',
        services: {
          api: { profileId: 'api', containerName: 'cds-gone-exec-branch-api', hostPort: 10020, status: 'running' },
          'demo-extra': { profileId: 'demo-extra', containerName: 'cds-gone-exec-branch-demo-extra', hostPort: 10021, status: 'running' },
        },
      });
      // Deliberately do NOT push 'exec-gone' into registryNodes.
      stateService.save();

      const res = await request(server, 'POST', '/api/branches/gone-exec-branch/deploy');
      expect(res.status).toBe(503);
      expect((res.body as any).error).toBe('owning_executor_offline');
      // state untouched — must not orphan the remote worker's container.
      expect(stateService.getBranch('gone-exec-branch')?.services['demo-extra']).toBeTruthy();
      expect(stateService.getBranch('gone-exec-branch')?.services['api']).toBeTruthy();
    });

    it('deploy with no profiles AND no services still returns the original 400', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'empty-nosvc',
        projectId: 'default',
        branch: 'feature/empty-nosvc',
        worktreePath: path.join(tmpDir, 'worktrees', 'empty-nosvc'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      stateService.save();
      const res = await request(server, 'POST', '/api/branches/empty-nosvc/deploy');
      expect(res.status).toBe(400);
      expect(String((res.body as any).error)).toContain('构建配置');
    });

    it('flushes branch state before reporting empty-profile cleanup complete', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'flush-empty-cleanup',
        projectId: 'default',
        branch: 'feature/flush-empty-cleanup',
        worktreePath: path.join(tmpDir, 'worktrees', 'flush-empty-cleanup'),
        status: 'running',
        createdAt: now,
        services: {
          obsolete: {
            profileId: 'obsolete',
            containerName: 'cds-flush-empty-cleanup-obsolete',
            hostPort: 10001,
            status: 'running',
          },
        },
      });
      stateService.save();

      stateService.flush = async () => {
        operationEvents.push({ action: 'test.state-flushed', branchId: 'flush-empty-cleanup' });
      };

      const res = await request(server, 'POST', '/api/branches/flush-empty-cleanup/deploy');

      expect(res.status).toBe(200);
      expect(String(res.body)).toContain('complete');
      expect(stateService.getBranch('flush-empty-cleanup')?.services.obsolete).toBeUndefined();
      const actions = operationEvents
        .filter((event) => event.branchId === 'flush-empty-cleanup')
        .map((event) => event.action);
      expect(actions.indexOf('test.state-flushed')).toBeGreaterThanOrEqual(0);
      expect(actions.indexOf('branch.operation.completed')).toBeGreaterThan(actions.indexOf('test.state-flushed'));
    });

    it('records branch delete completion only after state flush succeeds', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'flush-delete',
        projectId: 'default',
        branch: 'feature/flush-delete',
        worktreePath: path.join(tmpDir, 'worktrees', 'flush-delete'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      stateService.save();

      stateService.flush = async () => {
        operationEvents.push({ action: 'test.state-flushed', branchId: 'flush-delete' });
      };

      const del = await request(server, 'DELETE', '/api/branches/flush-delete');
      expect(del.status).toBe(200);
      expect(stateService.getBranch('flush-delete')).toBeUndefined();

      const actions = operationEvents
        .filter((event) => event.branchId === 'flush-delete')
        .map((event) => event.action);
      expect(actions.indexOf('test.state-flushed')).toBeGreaterThanOrEqual(0);
      expect(actions.indexOf('branch.delete.completed')).toBeGreaterThan(actions.indexOf('test.state-flushed'));
    });

    it('does not keep delete SSE open when immediate delete completion audit hangs', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'hung-audit-delete',
        projectId: 'default',
        branch: 'feature/hung-audit-delete',
        worktreePath: path.join(tmpDir, 'worktrees', 'hung-audit-delete'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      stateService.save();

      serverEventLogStore.recordImmediate = async () => {
        await new Promise<void>(() => { /* simulate a stuck Mongo write */ });
      };

      const startedAt = Date.now();
      const del = await request(server, 'DELETE', '/api/branches/hung-audit-delete');
      const elapsedMs = Date.now() - startedAt;

      expect(del.status).toBe(200);
      expect(elapsedMs).toBeLessThan(2_000);
      expect(String(del.body)).toContain('complete');
      expect(stateService.getBranch('hung-audit-delete')).toBeUndefined();
      expect(operationEvents.find((event) =>
        event.branchId === 'hung-audit-delete' && event.action === 'branch.delete.completed',
      )).toBeTruthy();
      expect(operationEvents.find((event) =>
        event.branchId === 'hung-audit-delete' && event.action === 'branch.delete.audit-timeout',
      )).toBeTruthy();
      expect(operationEvents.find((event) =>
        event.branchId === 'hung-audit-delete' && event.action === 'branch.operation.completed',
      )).toBeTruthy();
    });

    it('does not fail branch delete when immediate delete completion audit throws', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'failed-audit-delete',
        projectId: 'default',
        branch: 'feature/failed-audit-delete',
        worktreePath: path.join(tmpDir, 'worktrees', 'failed-audit-delete'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      stateService.save();

      serverEventLogStore.recordImmediate = async () => {
        throw new Error('mongo temporarily unavailable');
      };

      const del = await request(server, 'DELETE', '/api/branches/failed-audit-delete');

      expect(del.status).toBe(200);
      expect(String(del.body)).toContain('complete');
      expect(stateService.getBranch('failed-audit-delete')).toBeUndefined();
      expect(operationEvents.find((event) =>
        event.branchId === 'failed-audit-delete' && event.action === 'branch.delete.completed',
      )).toBeTruthy();
      expect(operationEvents.find((event) =>
        event.branchId === 'failed-audit-delete' && event.action === 'branch.operation.completed',
      )).toBeTruthy();
    });

    it('does not report delete success when state flush hangs after removing branch state', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'hung-flush-delete',
        projectId: 'default',
        branch: 'feature/hung-flush-delete',
        worktreePath: path.join(tmpDir, 'worktrees', 'hung-flush-delete'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      stateService.save();

      stateService.flush = async () => {
        await new Promise<void>(() => { /* simulate stuck write-behind persistence */ });
      };

      process.env.CDS_DELETE_STATE_FLUSH_TIMEOUT_MS = '500';
      const startedAt = Date.now();
      const del = await request(server, 'DELETE', '/api/branches/hung-flush-delete');
      delete process.env.CDS_DELETE_STATE_FLUSH_TIMEOUT_MS;
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeLessThan(2_000);
      expect(String(del.body)).toContain('error');
      expect(String(del.body)).toContain('持久化超时');
      expect(stateService.getBranch('hung-flush-delete')).toBeUndefined();
      expect(operationEvents.find((event) =>
        event.branchId === 'hung-flush-delete' && event.action === 'branch.delete.state-flush-timeout',
      )).toBeTruthy();
      expect(operationEvents.find((event) =>
        event.branchId === 'hung-flush-delete' && event.action === 'branch.delete.completed',
      )).toBeFalsy();
      expect(operationEvents.find((event) =>
        event.branchId === 'hung-flush-delete' && event.action === 'branch.operation.failed',
      )).toBeTruthy();
    });

    it('does not persist delete cleanup intent when operation lease rejects the delete', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'delete-lease-rejected',
        projectId: 'default',
        branch: 'feature/delete-lease-rejected',
        worktreePath: path.join(tmpDir, 'worktrees', 'delete-lease-rejected'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      stateService.save();

      const active = branchOperationCoordinator.begin({
        branchId: 'delete-lease-rejected',
        projectId: 'default',
        kind: 'delete',
        trigger: 'manual',
        actor: 'test',
        source: 'test.active-delete',
        reason: 'simulate an already-running terminal operation',
      });
      expect(active.status).toBe('started');

      const rejectedDelete = await request(server, 'DELETE', '/api/branches/delete-lease-rejected');
      const branchAfterReject = stateService.getBranch('delete-lease-rejected')!;
      expect(String(rejectedDelete.body)).toContain('operationStatus');
      expect(branchAfterReject.lastStopReason || '').not.toContain('删除分支流程已开始');
      expect(branchAfterReject.lastStopSource).toBeUndefined();
      expect(branchAfterReject.status).not.toBe('stopping');
    });

    it('releases the delete lease when persisting delete intent fails', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'delete-save-fails',
        projectId: 'default',
        branch: 'feature/delete-save-fails',
        worktreePath: path.join(tmpDir, 'worktrees', 'delete-save-fails'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      stateService.save();

      const originalSave = stateService.save.bind(stateService);
      let shouldFailSave = true;
      stateService.save = () => {
        if (shouldFailSave) throw new Error('disk full');
        return originalSave();
      };

      const failedDelete = await request(server, 'DELETE', '/api/branches/delete-save-fails');
      expect(failedDelete.status).toBe(500);
      expect(branchOperationCoordinator.getActive('delete-save-fails')).toBeUndefined();
      expect(stateService.getBranch('delete-save-fails')?.status).toBe('idle');
      expect(stateService.getBranch('delete-save-fails')?.lastStopReason).toBeUndefined();

      shouldFailSave = false;
      const nextDelete = await request(server, 'DELETE', '/api/branches/delete-save-fails');
      expect(String(nextDelete.body)).toContain('complete');
    });

    it('does not keep delete SSE open for slow best-effort volume cleanup', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'slow-volume-delete',
        projectId: 'default',
        branch: 'feature/slow-volume-delete',
        worktreePath: path.join(tmpDir, 'worktrees', 'slow-volume-delete'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      stateService.save();

      const originalExec = mock.exec.bind(mock);
      let volumeCleanupStarted = false;
      mock.exec = async (command, options) => {
        if (command.includes('docker volume ls') && command.includes('--filter name=cds-nm-')) {
          volumeCleanupStarted = true;
          await new Promise<void>(() => { /* simulate a hung Docker volume command */ });
        }
        return originalExec(command, options);
      };

      const del = await request(server, 'DELETE', '/api/branches/slow-volume-delete');
      expect(del.status).toBe(200);
      expect(String(del.body)).toContain('complete');
      expect(stateService.getBranch('slow-volume-delete')).toBeUndefined();
      expect(volumeCleanupStarted).toBe(true);
      expect(operationEvents.find((event) =>
        event.branchId === 'slow-volume-delete' && event.action === 'branch.delete.completed',
      )).toBeTruthy();
    });

    it('manual delete fences an in-flight webhook deploy and the old deploy cannot recreate branch state', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'race-delete',
        projectId: 'default',
        branch: 'feature/race-delete',
        worktreePath: path.join(tmpDir, 'worktrees', 'race-delete'),
        status: 'idle',
        createdAt: now,
        services: {},
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();

      let releaseRun!: () => void;
      const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
      let markRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command) && command.includes('--name cds-race-delete-api')) {
          markRunStarted();
          await runRelease;
          return { stdout: 'cid-race-delete', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const deployPromise = request(
        server,
        'POST',
        '/api/branches/race-delete/deploy',
        { commitSha: '2222222222222222222222222222222222222222' },
        { 'X-CDS-Trigger': 'webhook' },
      );
      await runStarted;

      const del = await request(server, 'DELETE', '/api/branches/race-delete');
      expect(del.status).toBe(200);
      expect(stateService.getBranch('race-delete')).toBeUndefined();

      releaseRun();
      const deploy = await deployPromise;
      expect(deploy.status).toBe(200);
      expect(String(deploy.body)).toContain('no longer current');
      expect(stateService.getBranch('race-delete')).toBeUndefined();

      const events = operationEvents.filter((event) => event.branchId === 'race-delete');
      expect(events.map((event) => event.action)).toContain('branch.operation.cancelled');
      expect(events.map((event) => event.action)).toContain('branch.operation.completed');
      const deleteStarted = events.find((event) => event.action === 'branch.operation.started' && event.details?.kind === 'delete');
      const deleteOperationId = deleteStarted?.operationId;
      expect(deleteOperationId).toMatch(/^op_/);
      expect(events.find((event) => event.action === 'branch.delete.requested')?.operationId).toBe(deleteOperationId);
      expect(events.find((event) => event.action === 'branch.delete.completed')?.operationId).toBe(deleteOperationId);
      expect(events.find((event) =>
        event.action === 'container.logs.archived' && event.details?.archiveSource === 'branch-delete',
      )?.operationId).toBe(deleteOperationId);
      expect(events.map((event) => event.action)).toContain('container.remove.after-fenced-deploy');
      expect(events.map((event) => event.action)).not.toContain('container.remove.after-fenced-deploy.skipped');
    });

    it('manual delete before docker run prevents a fenced webhook deploy from creating containers', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'race-delete-before-run',
        projectId: 'default',
        branch: 'feature/race-delete-before-run',
        worktreePath: path.join(tmpDir, 'worktrees', 'race-delete-before-run'),
        status: 'idle',
        createdAt: now,
        services: {},
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();

      let releaseReset!: () => void;
      const resetRelease = new Promise<void>((resolve) => { releaseReset = resolve; });
      let markResetStarted!: () => void;
      const resetStarted = new Promise<void>((resolve) => { markResetStarted = resolve; });
      let dockerRunCount = 0;
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (command.includes('git worktree add --detach')) {
          markResetStarted();
          await resetRelease;
          return originalExec(command, options);
        }
        if (isAppLaunchCommand(command) && command.includes('--name cds-race-delete-before-run-api')) {
          dockerRunCount += 1;
        }
        return originalExec(command, options);
      };

      const deployPromise = request(
        server,
        'POST',
        '/api/branches/race-delete-before-run/deploy',
        { commitSha: '2222222222222222222222222222222222222222' },
        { 'X-CDS-Trigger': 'webhook' },
      );
      await resetStarted;

      const del = await request(server, 'DELETE', '/api/branches/race-delete-before-run');
      expect(del.status).toBe(200);
      expect(stateService.getBranch('race-delete-before-run')).toBeUndefined();

      releaseReset();
      const deploy = await deployPromise;
      expect(deploy.status).toBe(200);
      expect(String(deploy.body)).toContain('no longer current');
      expect(stateService.getBranch('race-delete-before-run')).toBeUndefined();
      expect(dockerRunCount).toBe(0);

      const events = operationEvents.filter((event) => event.branchId === 'race-delete-before-run');
      expect(events.map((event) => event.action)).toContain('branch.operation.cancelled');
    });

    it.each(['/deploy', '/deploy/api'].flatMap(endpoint =>
      ['ready', 'probe-error', 'diagnostic', 'port-error', 'port-inspection'].map(stage => [endpoint, stage])))
    ('心跳收割后%s的%s迟到结果不能覆盖后继服务状态', async (endpoint, stage) => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api', name: 'API', dockerImage: 'node', command: 'node server.js', workDir: '.', containerPort: 3000,
      });
      const id = 'stale-readiness';
      stateService.addBranch({ id, projectId: 'default', branch: 'feature/stale-readiness',
        worktreePath: path.join(tmpDir, 'worktrees', id), status: 'idle', createdAt: new Date().toISOString(), services: {} });
      let successor: ReturnType<BranchOperationCoordinator['begin']> | undefined;
      let probeVisited = false;
      let portFailure = false;
      const takeOver = () => {
        const [old] = deploymentRunService.list({ branchId: id });
        expect(deploymentRunService.reconcileInterrupted(new Date(Date.now() + 16 * 60_000)).map(run => run.id)).toContain(old.id);
        successor = branchOperationCoordinator.begin({ projectId: 'default', branchId: id,
          kind: 'deploy', trigger: 'manual', commitSha: 'b'.repeat(40), commitPinned: true });
        expect(successor.status).toBe('started');
        const branch = stateService.getBranch(id)!;
        branch.services.api.status = 'stopped';
        branch.services.api.errorMessage = '后继操作保留的状态';
        branch.status = 'idle';
      };
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (stage === 'port-inspection' && portFailure && command === 'ss -H -ltn' && !successor) takeOver();
        return originalExec(command, options);
      };
      vi.spyOn(containerService, 'runService').mockImplementation(async () => {
        if (!stage.startsWith('port-')) return;
        probeVisited = true; portFailure = true;
        if (stage === 'port-error') takeOver();
        throw new Error('Bind for 0.0.0.0:10001 failed: port is already allocated');
      });
      vi.spyOn(containerService, 'waitForReadiness').mockImplementation(async () => {
        probeVisited = true;
        if (stage === 'diagnostic') return false;
        takeOver();
        if (stage === 'probe-error') throw new Error('迟到探测错误');
        return true;
      });
      vi.spyOn(containerService, 'getLogs').mockImplementation(async () => {
        if (probeVisited && !successor) takeOver();
        return 'Error: old runtime failed';
      });
      const response = await request(server, 'POST', `/api/branches/${id}${endpoint}`, { commitSha: 'a'.repeat(40) });
      expect(response.status).toBe(200);
      expect(probeVisited).toBe(true);
      expect(successor?.lease?.isCurrent()).toBe(true);
      expect(stateService.getBranch(id)?.services.api).toMatchObject({ status: 'stopped', errorMessage: '后继操作保留的状态' });
      expect(stateService.getBranch(id)?.status).toBe('idle');
      expect(deploymentRunService.list({ branchId: id })[0]).toMatchObject({ status: 'failed', failure: { code: 'cds.run.interrupted' } });
      if (successor?.lease) branchOperationCoordinator.completeAll(successor.lease, 'completed');
    });

    it('manual delete after pre-run cleanup still fences before docker run', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'race-delete-during-runservice',
        projectId: 'default',
        branch: 'feature/race-delete-during-runservice',
        worktreePath: path.join(tmpDir, 'worktrees', 'race-delete-during-runservice'),
        status: 'idle',
        createdAt: now,
        services: {},
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();

      let releasePreRun!: () => void;
      const preRunRelease = new Promise<void>((resolve) => { releasePreRun = resolve; });
      let markPreRunStarted!: () => void;
      const preRunStarted = new Promise<void>((resolve) => { markPreRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (command === 'docker rm -f cds-race-delete-during-runservice-api') {
          markPreRunStarted();
          await preRunRelease;
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const deployPromise = request(
        server,
        'POST',
        '/api/branches/race-delete-during-runservice/deploy',
        { commitSha: '2222222222222222222222222222222222222222' },
        { 'X-CDS-Trigger': 'webhook' },
      );
      await preRunStarted;

      const del = await request(server, 'DELETE', '/api/branches/race-delete-during-runservice');
      expect(del.status).toBe(200);
      expect(stateService.getBranch('race-delete-during-runservice')).toBeUndefined();

      releasePreRun();
      const deploy = await deployPromise;
      expect(deploy.status).toBe(200);
      expect(String(deploy.body)).toContain('no longer current');
      expect(mock.commands.some((command) =>
        isAppLaunchCommand(command) && command.includes('--name cds-race-delete-during-runservice-api'),
      )).toBe(false);
    });

    async function seedStopRecovery(remote = false): Promise<string> {
      const id = 'durable-stop';
      const branch: BranchEntry = { id, projectId: 'default', branch: 'main', worktreePath: path.join(tmpDir, 'worktrees', id),
        status: 'running', createdAt: new Date().toISOString(), services: { api: { profileId: 'api', containerName: 'durable-stop-api', hostPort: 10001, status: 'running' } } };
      if (remote) {
        branch.executorId = 'remote-stop';
        registryNodes.push({ id: 'remote-stop', role: 'worker', host: '127.0.0.1', port: 12345 });
      }
      stateService.addBranch(branch);
      branchOperationCoordinator.begin({ projectId: 'default', branchId: id, kind: 'deploy', trigger: 'manual', commitSha: 'a'.repeat(40), commitPinned: true });
      const queuedRequest = { projectId: 'default', branchId: id, kind: 'deploy' as const, trigger: 'webhook' as const,
        commitSha: 'b'.repeat(40), commitPinned: true, configHash: 'stop-config' };
      const queued = branchOperationCoordinator.begin(queuedRequest);
      const input = captureDeploymentInput(branch, [{ id: 'api', projectId: 'default', name: 'API', dockerImage: 'node', command: 'node original.js', workDir: '.', containerPort: 3000 }], { TOKEN: 'synthetic-stop-input' });
      input.configHash = 'stop-config';
      const run = await deploymentRunService.begin({ projectId: 'default', branchId: id, trigger: 'webhook', commitSha: queuedRequest.commitSha,
        configHash: 'stop-config', initialStatus: 'queued', operationId: queued.operationId, operationGeneration: queued.generation,
        executionInput: { request: queuedRequest, input } });
      await stateService.flush();
      return run.id;
    }

    it.each([false, true])('停止旧队列保存失败时不得停止本地容器或发送远端请求，remote=%s', async (remote) => {
      const runId = await seedStopRecovery(remote);
      const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('synthetic stop persistence failure'));
      const originalFetch = globalThis.fetch, calls: string[] = [];
      globalThis.fetch = (async (url: RequestInfo | URL) => { calls.push(String(url)); return new Response('{}', { status: 200 }); }) as typeof fetch;
      try {
        const result = await request(server, 'POST', '/api/branches/durable-stop/stop');
        expect(result.status).toBe(503);
        expect(mock.commands.some((command) => command.startsWith('docker stop '))).toBe(false);
        expect(calls).toEqual([]);
        const restarted = new StateService(path.join(tmpDir, 'state.json')); restarted.load();
        const recovered = new DeploymentRunService(restarted);
        expect(recovered.restoreQueued(new BranchOperationCoordinator()).map((run) => run.id)).toEqual([runId]);
      } finally { rename.mockRestore(); globalThis.fetch = originalFetch; }
    });

    it('停止返回成功前原队列及最终分支状态落盘，立即重启不恢复旧待办', async () => {
      const runId = await seedStopRecovery();
      const result = await request(server, 'POST', '/api/branches/durable-stop/stop');
      expect(result.status).toBe(200);
      const restarted = new StateService(path.join(tmpDir, 'state.json')); restarted.load();
      const recovered = new DeploymentRunService(restarted);
      expect(recovered.restoreQueued(new BranchOperationCoordinator())).toEqual([]);
      expect(recovered.get(runId)?.status).toBe('cancelled');
      expect(restarted.getDeploymentIntents()).toEqual([]);
      expect(restarted.getBranch('durable-stop')).toMatchObject({ status: 'idle', services: { api: { status: 'stopped' } } });
    });

    it('停止等待容器时被重置取代，不继续停止下一服务或改写新状态', async () => {
      await seedStopRecovery();
      const branch = stateService.getBranch('durable-stop')!;
      branch.services.web = { profileId: 'web', containerName: 'durable-stop-web', hostPort: 10002, status: 'running' };
      await stateService.flush();
      let started!: () => void, release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const reached = new Promise<void>((resolve) => { started = resolve; });
      const stop = vi.spyOn(containerService, 'stop').mockImplementation(async () => { started(); await gate; });
      const stopping = request(server, 'POST', '/api/branches/durable-stop/stop');
      try {
        await reached;
        const reset = await request(server, 'POST', '/api/branches/durable-stop/reset');
        expect(reset.status).toBe(200);
        release();
        const result = await stopping;
        expect(result.status).toBe(409);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(stop.mock.calls[0][0]).toBe('durable-stop-api');
        expect(branch.lastStoppedAt).toBeUndefined();
      } finally { release(); await stopping; stop.mockRestore(); }
    });

    it.each(['DELETE', 'reset'])('取消记录保存失败时%s不得移除分支或确认重置', async (action) => {
      const runId = await seedStopRecovery();
      const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValue(new Error('synthetic cancellation persistence failure'));
      try {
        const result = await request(server, action === 'DELETE' ? 'DELETE' : 'POST',
          '/api/branches/durable-stop' + (action === 'DELETE' ? '' : '/reset'));
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(stateService.getBranch('durable-stop')?.status).toBe('running');
        expect(mock.commands.some((command) => command.startsWith('docker stop ') || command.startsWith('docker rm '))).toBe(false);
        const restarted = new StateService(path.join(tmpDir, 'state.json')); restarted.load();
        expect(new DeploymentRunService(restarted).restoreQueued(new BranchOperationCoordinator()).map((run) => run.id)).toEqual([runId]);
      } finally { rename.mockRestore(); }
    });

    it('manual stop clears an active and queued webhook deploy without dispatching the queued commit', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'race-stop',
        projectId: 'default',
        branch: 'feature/race-stop',
        worktreePath: path.join(tmpDir, 'worktrees', 'race-stop'),
        status: 'idle',
        createdAt: now,
        services: {},
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();

      let releaseRun!: () => void;
      const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
      let markRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command) && command.includes('--name cds-race-stop-api')) {
          markRunStarted();
          await runRelease;
          return { stdout: 'cid-race-stop', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const fetchCalls: Array<{ url: string; body: unknown }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }) as typeof fetch;

      try {
        const activeDeploy = request(
          server,
          'POST',
          '/api/branches/race-stop/deploy',
          { commitSha: '1111111111111111111111111111111111111111' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-stop-a' },
        );
        await runStarted;

        const merged = await request(
          server,
          'POST',
          '/api/branches/race-stop/deploy',
          { commitSha: '2222222222222222222222222222222222222222' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-stop-b' },
        );
        expect(String(merged.body)).toContain('merged');

        const stop = await request(
          server,
          'POST',
          '/api/branches/race-stop/stop',
          undefined,
          { 'X-CDS-Request-Id': 'req-stop-user' },
        );
        expect(stop.status).toBe(200);
        expect((stop.body as any).message).toContain('已停止');
        expect(stateService.getBranch('race-stop')?.status).toBe('idle');
        expect(Object.values(stateService.getBranch('race-stop')?.services || {}).every((svc) => svc.status === 'stopped')).toBe(true);

        releaseRun();
        const deploy = await activeDeploy;
        expect(deploy.status).toBe(200);
        expect(String(deploy.body)).toContain('no longer current');
        expect(fetchCalls).toEqual([]);
        expect(stateService.getBranch('race-stop')?.status).toBe('idle');

        const events = operationEvents.filter((event) => event.branchId === 'race-stop');
        const cancelled = events.filter((event) => event.action === 'branch.operation.cancelled');
        expect(cancelled.some((event) => event.details?.kind === 'deploy' && event.details?.pending !== true)).toBe(true);
        expect(cancelled.some((event) => event.details?.pending === true && event.details?.reason === 'superseded by stop')).toBe(true);
        const stopStarted = events.find((event) => event.action === 'branch.operation.started' && event.details?.kind === 'stop');
        expect(stopStarted?.operationId).toMatch(/^op_/);
        expect(events.find((event) => event.action === 'container.logs.archived' && event.details?.archiveSource === 'manual-stop')?.operationId)
          .toBe(stopStarted?.operationId);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('remote executor deploy completes the branch operation lease so later webhook deploys are not merged into a stale active op', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'remote-lease',
        projectId: 'default',
        branch: 'feature/remote-lease',
        worktreePath: path.join(tmpDir, 'worktrees', 'remote-lease'),
        status: 'idle',
        createdAt: now,
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-remote-lease-api',
            hostPort: 10001,
            status: 'idle',
          },
        },
        githubCommitSha: '1111111111111111111111111111111111111111',
      });
      stateService.save();
      registryNodes.push({
        id: 'exec-1',
        host: '127.0.0.1',
        port: 9101,
        status: 'online',
        role: 'remote',
        labels: [],
        branches: [],
        capacity: { maxBranches: 10, memoryMB: 1024, cpuCores: 2 },
        load: { memoryUsedMB: 0, cpuPercent: 0 },
        registeredAt: now,
        lastHeartbeat: now,
      });

      const fetchCalls: Array<{ url: string; body: any }> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response([
          'event: step',
          'data: {"step":"remote","status":"running","title":"remote deploy"}',
          '',
          'event: complete',
          'data: {"ok":true,"services":{"api":{"status":"running"}}}',
          '',
          '',
        ].join('\n'), { status: 200 });
      }) as typeof fetch;

      try {
        const first = await request(
          server,
          'POST',
          '/api/branches/remote-lease/deploy',
          { commitSha: '1111111111111111111111111111111111111111', targetExecutorId: 'exec-1' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-remote-a' },
        );
        expect(first.status).toBe(200);
        expect(String(first.body)).toContain('event: deployment-run');
        const firstRunId = String(first.headers['x-cds-deployment-run-id']);
        expect(deploymentRunService.get(firstRunId)).toMatchObject({
          branchId: 'remote-lease',
          status: 'running',
          executorId: 'exec-1',
          trigger: 'webhook',
        });

        const second = await request(
          server,
          'POST',
          '/api/branches/remote-lease/deploy',
          { commitSha: '2222222222222222222222222222222222222222', targetExecutorId: 'exec-1' },
          { 'X-CDS-Trigger': 'webhook', 'X-CDS-Request-Id': 'req-remote-b' },
        );
        expect(second.status).toBe(200);
        expect(String(second.body)).not.toContain('merged');
        expect(fetchCalls).toHaveLength(2);
        expect(fetchCalls.map((call) => call.body.commitSha)).toEqual(['1'.repeat(40), '2'.repeat(40)]);
        const secondRunId = String(second.headers['x-cds-deployment-run-id']);
        expect(secondRunId).not.toBe(firstRunId);
        expect(fetchCalls[0].body.deploymentRunId).toBe(firstRunId);
        expect(fetchCalls[1].body.deploymentRunId).toBe(secondRunId);

        const events = operationEvents.filter((event) => event.branchId === 'remote-lease');
        const started = events.filter((event) => event.action === 'branch.operation.started' && event.details?.kind === 'deploy');
        const completed = events.filter((event) => event.action === 'branch.operation.completed' && event.details?.kind === 'deploy');
        expect(started).toHaveLength(2);
        expect(completed).toHaveLength(2);
        expect(events.some((event) => event.action === 'branch.operation.merged')).toBe(false);
        expect(fetchCalls[0].body.operationId).toBe(started[0].operationId);
        expect(fetchCalls[1].body.operationId).toBe(started[1].operationId);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('normalizes project-scoped dependencies before dispatching to a remote executor', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'gateway-project',
        slug: 'gateway-project',
        name: 'Gateway Project',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });
      for (const profile of [
        { id: 'console-gateway-project', name: 'Console', dependsOn: undefined },
        { id: 'serving-gateway-project', name: 'Serving', dependsOn: undefined },
        { id: 'web-gateway-project', name: 'Web', dependsOn: ['console', 'serving'] },
      ]) {
        stateService.addBuildProfile({
          ...profile,
          projectId: 'gateway-project',
          dockerImage: 'node:20-slim',
          command: 'node server.js',
          workDir: '.',
          containerPort: 3000,
        });
      }
      stateService.addBranch({
        id: 'gateway-project-remote',
        projectId: 'gateway-project',
        branch: 'feature/remote',
        worktreePath: path.join(tmpDir, 'worktrees', 'gateway-project-remote'),
        status: 'idle',
        createdAt: now,
        services: {},
      });
      registryNodes.push({
        id: 'exec-gateway',
        host: '127.0.0.1',
        port: 9102,
        status: 'online',
        role: 'remote',
        labels: [],
        branches: [],
        capacity: { maxBranches: 10, memoryMB: 1024, cpuCores: 2 },
        load: { memoryUsedMB: 0, cpuPercent: 0 },
        registeredAt: now,
        lastHeartbeat: now,
      });

      let dispatchedBody: any;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        dispatchedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        return new Response('event: complete\ndata: {"ok":true}\n\n', { status: 200 });
      }) as typeof fetch;

      try {
        const result = await request(server, 'POST', '/api/branches/gateway-project-remote/deploy', {
          targetExecutorId: 'exec-gateway',
        });

        expect(result.status).toBe(200);
        expect(dispatchedBody.profiles.find((profile: any) => profile.id === 'web-gateway-project')?.dependsOn).toEqual([
          'console-gateway-project',
          'serving-gateway-project',
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('POST /api/branches/:id/set-default', () => {
    it('should set default branch', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'main' });
      const res = await request(server, 'POST', '/api/branches/main/set-default');
      expect(res.status).toBe(200);

      const list = await request(server, 'GET', '/api/branches');
      expect((list.body as any).defaultBranch).toBe('main');
    });
  });

  describe('POST /api/branches/:id/reset', () => {
    it('should reset error status to idle', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const branch = stateService.getBranch('feature-test')!;
      branch.status = 'error';
      branch.errorMessage = 'build failed';
      stateService.save();

      const res = await request(server, 'POST', '/api/branches/feature-test/reset');
      expect(res.status).toBe(200);
      expect((res.body as any).operationId).toMatch(/^op_/);

      const list = await request(server, 'GET', '/api/branches');
      expect((list.body as any).branches[0].status).toBe('idle');
      expect(operationEvents.some((event) => event.action === 'branch.operation.completed'
        && event.operationKind === 'reset'
        && event.operationTrigger === 'manual'
        && event.branchId === 'feature-test')).toBe(true);
    });
  });

  // ── Routing rules ──

  describe('routing rules CRUD', () => {
    it('should create and list rules', async () => {
      const rule = { id: 'r1', name: 'Test', type: 'domain', match: '*.dev.com', branch: 'main', priority: 0, enabled: true };
      const createRes = await request(server, 'POST', '/api/routing-rules', rule);
      expect(createRes.status).toBe(201);

      const listRes = await request(server, 'GET', '/api/routing-rules');
      expect((listRes.body as any).rules).toHaveLength(1);
    });

    it('should update and delete rules', async () => {
      await request(server, 'POST', '/api/routing-rules', { id: 'r1', name: 'T', type: 'domain', match: 'a', branch: 'b' });
      await request(server, 'PUT', '/api/routing-rules/r1', { enabled: false });

      let list = await request(server, 'GET', '/api/routing-rules');
      expect((list.body as any).rules[0].enabled).toBe(false);

      await request(server, 'DELETE', '/api/routing-rules/r1');
      list = await request(server, 'GET', '/api/routing-rules');
      expect((list.body as any).rules).toHaveLength(0);
    });

    // P4 Part 17 (G14): routing rules created from a non-default project
    // page must land in that project, not silently in 'default'. This
    // mirrors the B1 fix on POST /build-profiles and POST /infra. Three
    // tests cover body.projectId, fallback to 'default', and rejection
    // of unknown projectId.
    it('P4 Part 17 (G14): POST /routing-rules honors body.projectId', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'rules-alt',
        slug: 'rules-alt',
        name: 'Rules Alt',
        kind: 'git',
        dockerNetwork: 'cds-proj-rules-alt',
        legacyFlag: false,
        createdAt: now,
        updatedAt: now,
      });

      const res = await request(server, 'POST', '/api/routing-rules', {
        id: 'r-alt',
        name: 'Alt rule',
        type: 'domain',
        match: '*.alt.dev',
        branch: 'main',
        projectId: 'rules-alt',
      });
      expect(res.status).toBe(201);

      const altList = await request(server, 'GET', '/api/routing-rules?project=rules-alt');
      expect((altList.body as any).rules).toHaveLength(1);
      expect((altList.body as any).rules[0].projectId).toBe('rules-alt');
    });

    it('P4 Part 17 (G14): POST /routing-rules defaults to "default" when no projectId', async () => {
      const res = await request(server, 'POST', '/api/routing-rules', {
        id: 'r-def',
        name: 'Default rule',
        type: 'domain',
        match: '*.dev',
        branch: 'main',
      });
      expect(res.status).toBe(201);

      const list = await request(server, 'GET', '/api/routing-rules?project=default');
      expect((list.body as any).rules).toHaveLength(1);
      expect((list.body as any).rules[0].projectId).toBe('default');
    });

    it('P4 Part 17 (G14): POST /routing-rules rejects unknown projectId with 400', async () => {
      const res = await request(server, 'POST', '/api/routing-rules', {
        id: 'r-bad',
        name: 'Bad rule',
        type: 'domain',
        match: '*.dev',
        branch: 'main',
        projectId: 'no-such-project',
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain('未知项目');
    });
  });

  // ── Build profiles ──

  describe('build profiles CRUD', () => {
    it('should create and list profiles', async () => {
      const profile = { id: 'api', name: 'API', dockerImage: 'dotnet:8', command: 'dotnet run', workDir: '.', containerPort: 8080 };
      const createRes = await request(server, 'POST', '/api/build-profiles', profile);
      expect(createRes.status).toBe(201);

      const listRes = await request(server, 'GET', '/api/build-profiles');
      expect((listRes.body as any).profiles).toHaveLength(1);
    });

    it('should delete profiles', async () => {
      await request(server, 'POST', '/api/build-profiles', { id: 'api', name: 'API', dockerImage: 'x', command: 'x' });
      await request(server, 'DELETE', '/api/build-profiles/api');

      const list = await request(server, 'GET', '/api/build-profiles');
      expect((list.body as any).profiles).toHaveLength(0);
    });

    it('skips build profile service cleanup while the branch has an active lifecycle operation', async () => {
      await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        workDir: '.',
        containerPort: 3000,
      });
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'profile-delete-busy',
        projectId: 'default',
        branch: 'feature/profile-delete-busy',
        worktreePath: path.join(tmpDir, 'worktrees', 'profile-delete-busy'),
        status: 'idle',
        createdAt: now,
        services: {
          api: {
            profileId: 'api',
            containerName: 'cds-profile-delete-busy-api',
            hostPort: 10001,
            status: 'idle',
          },
        },
      });
      stateService.save();

      let releaseRun!: () => void;
      const runRelease = new Promise<void>((resolve) => { releaseRun = resolve; });
      let markRunStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => { markRunStarted = resolve; });
      const originalExec = mock.exec.bind(mock);
      mock.exec = async (command, options) => {
        if (isAppLaunchCommand(command) && command.includes('--name cds-profile-delete-busy-api')) {
          markRunStarted();
          await runRelease;
          return { stdout: 'cid-profile-delete-busy', stderr: '', exitCode: 0 };
        }
        return originalExec(command, options);
      };

      const deployPromise = request(server, 'POST', '/api/branches/profile-delete-busy/deploy');
      try {
        await runStarted;

        const deletion = await request(
          server,
          'DELETE',
          '/api/build-profiles/api',
          undefined,
          { 'X-CDS-Request-Id': 'req-profile-delete' },
        );

        expect(deletion.status).toBe(200);
        expect((deletion.body as any).skippedBusyCount).toBe(1);
        expect(stateService.getBranch('profile-delete-busy')?.services.api).toBeTruthy();
        const skipped = operationEvents.find((event) => event.action === 'app.build-profile-service.cleanup-skipped');
        expect(skipped?.requestId).toBe('req-profile-delete');
        expect(skipped?.branchId).toBe('profile-delete-busy');
        expect(skipped?.operationKind).toBe('deploy');
      } finally {
        releaseRun();
      }
      const deploy = await deployPromise;
      expect(deploy.status).toBe(200);
    });

    it('P4 Part 16 (B1): POST /build-profiles honors body.projectId', async () => {
      // Pre-create the target project
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'alt-proj',
        slug: 'alt-proj',
        name: 'Alt Project',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });

      const res = await request(server, 'POST', '/api/build-profiles', {
        id: 'web',
        name: 'Web',
        dockerImage: 'nginx',
        command: 'nginx -g "daemon off;"',
        projectId: 'alt-proj',
      });
      expect(res.status).toBe(201);

      // Profile lands in alt-proj, not default
      const altList = await request(server, 'GET', '/api/build-profiles?project=alt-proj');
      expect((altList.body as any).profiles).toHaveLength(1);
      expect((altList.body as any).profiles[0].projectId).toBe('alt-proj');

      const defaultList = await request(server, 'GET', '/api/build-profiles?project=default');
      expect((defaultList.body as any).profiles).toHaveLength(0);
    });

    it('P4 Part 16 (B1): POST /build-profiles defaults to "default" when no projectId', async () => {
      const res = await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
      });
      expect(res.status).toBe(201);

      const list = await request(server, 'GET', '/api/build-profiles?project=default');
      expect((list.body as any).profiles).toHaveLength(1);
      expect((list.body as any).profiles[0].projectId).toBe('default');
    });

    it('P4 Part 16 (B1): POST /build-profiles rejects unknown projectId with 400', async () => {
      const res = await request(server, 'POST', '/api/build-profiles', {
        id: 'api',
        name: 'API',
        dockerImage: 'node',
        command: 'node server.js',
        projectId: 'nonexistent',
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain('未知项目');
    });

    // P4 Part 17 (G2 fix): the deploy hot path was reading the global
    // getBuildProfiles() instead of getBuildProfilesForProject(). That
    // meant deploying a branch in project A would silently pull in
    // every profile from project B as well — total cross-project bleed.
    //
    // This test proves the fix: a branch in project 'default' with an
    // 'alt'-scoped profile must hit the "no profiles configured" 400
    // because the deploy reader now respects the branch's projectId.
    it('P4 Part 17 (G2): POST /branches/:id/deploy is project-scoped', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'alt-deploy',
        slug: 'alt-deploy',
        name: 'Alt Deploy',
        kind: 'git',
        dockerNetwork: 'cds-proj-alt-deploy',
        legacyFlag: false,
        createdAt: now,
        updatedAt: now,
      });

      // Profile lives in 'alt-deploy', NOT in default
      const profileRes = await request(server, 'POST', '/api/build-profiles', {
        id: 'web',
        name: 'Web',
        dockerImage: 'nginx',
        command: 'nginx -g "daemon off;"',
        projectId: 'alt-deploy',
      });
      expect(profileRes.status).toBe(201);

      // Branch lives in default
      const branchRes = await request(server, 'POST', '/api/branches', { branch: 'main' });
      expect(branchRes.status).toBe(201);

      // Deploying the default branch must NOT see the alt-deploy profile.
      // Pre-G2 fix this returned 200 + started deploying with the leaked
      // profile. After the fix we expect 400 "尚未配置构建配置".
      const deployRes = await request(server, 'POST', '/api/branches/main/deploy');
      expect(deployRes.status).toBe(400);
      expect((deployRes.body as any).error).toContain('尚未配置构建配置');
    });
  });

  // ── Config ──

  describe('GET /api/config', () => {
    it('should return masked config', async () => {
      const res = await request(server, 'GET', '/api/config');
      expect(res.status).toBe(200);
      expect((res.body as any).jwt.secret).toBe('***');
    });

    it('should use GITHUB_REPO_URL from customEnv when set', async () => {
      // Set GITHUB_REPO_URL in custom env
      await request(server, 'PUT', '/api/env/GITHUB_REPO_URL', { value: 'https://github.com/my-org/my-repo' });

      const res = await request(server, 'GET', '/api/config');
      expect(res.status).toBe(200);
      expect((res.body as any).githubRepoUrl).toBe('https://github.com/my-org/my-repo');
    });

    it('should fallback to git remote when GITHUB_REPO_URL not set', async () => {
      mock.addResponsePattern(/git remote get-url origin/, () => ({
        stdout: 'git@github.com:test-org/test-repo.git\n', stderr: '', exitCode: 0,
      }));

      const res = await request(server, 'GET', '/api/config');
      expect(res.status).toBe(200);
      expect((res.body as any).githubRepoUrl).toBe('https://github.com/test-org/test-repo');
    });
  });

  // ── Config sync via env vars ──

  describe('CDS config sync via env vars', () => {
    it('should sync CDS_REPO_ROOT into config when setting env var', async () => {
      await request(server, 'PUT', '/api/env/CDS_REPO_ROOT', { value: '/custom/repo' });

      const configRes = await request(server, 'GET', '/api/config');
      expect((configRes.body as any).repoRoot).toBe('/custom/repo');
    });

    it('should sync CDS_WORKTREE_BASE into config when setting env var', async () => {
      await request(server, 'PUT', '/api/env/CDS_WORKTREE_BASE', { value: '/custom/worktrees' });

      const configRes = await request(server, 'GET', '/api/config');
      expect((configRes.body as any).worktreeBase).toBe('/custom/worktrees');
    });

    it('should sync CDS_REPO_ROOT via bulk env update', async () => {
      await request(server, 'PUT', '/api/env', {
        CDS_REPO_ROOT: '/bulk/repo',
        CDS_WORKTREE_BASE: '/bulk/worktrees',
        GITHUB_REPO_URL: 'https://github.com/bulk-org/bulk-repo',
      });

      const configRes = await request(server, 'GET', '/api/config');
      expect((configRes.body as any).repoRoot).toBe('/bulk/repo');
      expect((configRes.body as any).worktreeBase).toBe('/bulk/worktrees');
      expect((configRes.body as any).githubRepoUrl).toBe('https://github.com/bulk-org/bulk-repo');
    });
  });

  describe('POST /api/quickstart project-scoped dependencies', () => {
    it('scopes application dependencies while preserving infra dependencies', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'gateway-project',
        slug: 'gateway-project',
        name: 'Gateway Project',
        kind: 'git',
        repoPath: tmpDir,
        createdAt: now,
        updatedAt: now,
      });
      fs.writeFileSync(path.join(tmpDir, 'cds-compose.yml'), [
        'services:',
        '  gateway-api:',
        '    image: node:20-slim',
        '    volumes:',
        '      - ./api:/repo/api',
        '    working_dir: /repo/api',
        '    command: node server.js',
        '    ports:',
        '      - "8080"',
        '  gateway-web:',
        '    image: node:20-slim',
        '    volumes:',
        '      - ./web:/repo/web',
        '    working_dir: /repo/web',
        '    command: node server.js',
        '    ports:',
        '      - "5173"',
        '    depends_on:',
        '      - gateway-api',
        '      - mongodb',
        '  mongodb:',
        '    image: mongo:8.0',
        '    ports:',
        '      - "27017"',
      ].join('\n'));

      const res = await request(server, 'POST', '/api/quickstart?project=gateway-project');

      expect(res.status).toBe(201);
      const saved = stateService.getBuildProfilesForProject('gateway-project');
      expect(saved.map((item) => item.id).sort()).toEqual([
        'gateway-api-gateway-project',
        'gateway-web-gateway-project',
      ]);
      expect(saved.find((item) => item.id === 'gateway-web-gateway-project')?.dependsOn).toEqual([
        'gateway-api-gateway-project',
        'mongodb',
      ]);
      expect(stateService.getInfraServicesForProject('gateway-project').map((item) => item.id)).toContain('mongodb');
    });
  });

  // ── Infra services (P4 Part 16: B1 fix) ──

  describe('POST /api/infra (project scoping)', () => {
    it('honors body.projectId on creation', async () => {
      // Pre-create the target project
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'redis-proj',
        slug: 'redis-proj',
        name: 'Redis Project',
        kind: 'git',
        createdAt: now,
        updatedAt: now,
      });

      const res = await request(server, 'POST', '/api/infra', {
        id: 'redis',
        name: 'Redis',
        dockerImage: 'redis:7-alpine',
        containerPort: 6379,
        env: { REDIS_PASSWORD: 'test-secret' },
        command: ['sh', '-c', 'exec redis-server --requirepass "$REDIS_PASSWORD"'],
        projectId: 'redis-proj',
      });
      expect(res.status).toBe(201);
      expect((res.body as any).service.projectId).toBe('redis-proj');

      // Verify scope: appears in redis-proj filter, NOT in default
      const altList = await request(server, 'GET', '/api/infra?project=redis-proj');
      expect((altList.body as any).services).toHaveLength(1);

      const defaultList = await request(server, 'GET', '/api/infra?project=default');
      expect((defaultList.body as any).services).toHaveLength(0);
    });

    it('defaults to "default" projectId when none supplied', async () => {
      const res = await request(server, 'POST', '/api/infra', {
        id: 'mongo',
        name: 'MongoDB',
        dockerImage: 'mongo:8.0',
        containerPort: 27017,
        env: {
          MONGO_INITDB_ROOT_USERNAME: 'test-admin',
          MONGO_INITDB_ROOT_PASSWORD: 'test-secret',
        },
      });
      expect(res.status).toBe(201);
      expect((res.body as any).service.projectId).toBe('default');
    });

    it('rejects unknown projectId with 400', async () => {
      const res = await request(server, 'POST', '/api/infra', {
        id: 'pg',
        name: 'Postgres',
        dockerImage: 'postgres:16',
        containerPort: 5432,
        projectId: 'nonexistent',
      });
      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain('未知项目');
    });
  });

  describe('GET /api/branches/state-audit', () => {
    it('counts only warning-severity findings as issues while preserving info totals', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'info-main',
        projectId: 'default',
        branch: 'main',
        worktreePath: path.join(tmpDir, 'worktrees', 'info-main'),
        status: 'idle',
        services: {},
        createdAt: now,
        lastDeployAt: '2026-05-26T22:00:00.000Z',
        lastPushAt: '2026-05-26T23:00:00.000Z',
        githubCommitSha: 'abc1234',
      });

      const res = await request(server, 'GET', '/api/branches/state-audit?project=default');

      expect(res.status).toBe(200);
      expect((res.body as any).ok).toBe(true);
      expect((res.body as any).issueCount).toBe(0);
      expect((res.body as any).warnCount).toBe(0);
      expect((res.body as any).infoCount).toBe(1);
      expect((res.body as any).totalCount).toBe(1);
      expect((res.body as any).issues[0].kind).toBe('push-newer-than-successful-deploy');
    });
  });

  // ── Logs ──

  describe('GET /api/branches/:id/logs', () => {
    it('should return empty logs for new branch', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'GET', '/api/branches/feature-test/logs');
      expect(res.status).toBe(200);
      expect((res.body as any).logs).toEqual([]);
    });

    // F10 (2026-05-02 onboarding UAT): the historical logs are flushed only
    // when a deploy finalizes, so an in-progress build returns empty. The
    // response must include a `liveStreamHint` pointing at the SSE stream
    // so smart consumers can subscribe instead of polling.
    it('exposes a liveStreamHint for in-progress visibility', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      const res = await request(server, 'GET', '/api/branches/feature-test/logs');
      expect(res.status).toBe(200);
      const body = res.body as { liveStreamHint?: { url?: string; eventTypes?: string[]; note?: string } };
      expect(body.liveStreamHint).toBeDefined();
      expect(body.liveStreamHint?.url).toContain('/api/branches/stream');
      expect(body.liveStreamHint?.url).toContain('project=default');
      expect(body.liveStreamHint?.eventTypes).toContain('branch.status');
      expect(body.liveStreamHint?.note).toBeTruthy();
    });

    it('liveStreamHint reflects the branch projectId', async () => {
      const now = new Date().toISOString();
      stateService.addProject({
        id: 'p2', slug: 'p2', name: 'P2', kind: 'git',
        createdAt: now, updatedAt: now,
      });
      await request(server, 'POST', '/api/branches', { branch: 'fx', projectId: 'p2' });
      const res = await request(server, 'GET', '/api/branches/p2-fx/logs');
      expect(res.status).toBe(200);
      const body = res.body as { liveStreamHint?: { url?: string } };
      expect(body.liveStreamHint?.url).toContain('project=p2');
    });

    it('is a passive read path and does not touch Docker, Git, or branch operations', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/test' });
      mock.commands.length = 0;
      operationEvents.length = 0;

      const res = await request(server, 'GET', '/api/branches/feature-test/logs');

      expect(res.status).toBe(200);
      expect(mock.commands.some((cmd) => /docker |git /.test(cmd))).toBe(false);
      expect(operationEvents.filter((event) => event.action.startsWith('branch.operation.'))).toEqual([]);
    });
  });

  // ── F9 (2026-05-02 onboarding UAT): Branch detail endpoint ──
  //
  // Before this fix, `GET /api/branches/<id>` fell through to the React
  // static fallback, returning HTML — the React loader saw 200 OK and
  // rendered a blank panel. These tests lock in the JSON contract.
  describe('GET /api/branches/:id (F9)', () => {
    it('运行 A 与被 CI 拦截的目标 B 在列表和详情保持分离', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/x' });
      const branch = stateService.getBranch('feature-x')!;
      const A = 'a'.repeat(40), B = 'b'.repeat(40);
      branch.githubCommitSha = B;
      branch.ciTargetSha = B;
      branch.ciImageStatus = 'failed';
      branch.status = 'running';
      branch.services = { web: { profileId: 'web', containerName: 'lab-web', hostPort: 18080, status: 'running', deployedImage: `ghcr.io/test/lab:sha-${A}` } };
      const detail = await request(server, 'GET', '/api/branches/feature-x');
      const list = await request(server, 'GET', '/api/branches?project=default&live=false');
      for (const view of [(detail.body as any).branch, (list.body as any).branches.find((b: any) => b.id === branch.id)]) {
        expect(view.runningCommitSha).toBe(A);
        expect(view.targetCommitSha).toBe(B);
        expect(view.ciImageStatus).toBe('failed');
      }
    });

    it('returns 200 + { branch } when the id exists', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/x' });
      const res = await request(server, 'GET', '/api/branches/feature-x');
      expect(res.status).toBe(200);
      const body = res.body as { branch: { id: string; branch: string } };
      expect(body.branch).toBeDefined();
      expect(body.branch.id).toBe('feature-x');
      expect(body.branch.branch).toBe('feature/x');
    });

    it('is a passive read path and does not reconcile, deploy, or emit operation events', async () => {
      await request(server, 'POST', '/api/branches', { branch: 'feature/x' });
      mock.commands.length = 0;
      operationEvents.length = 0;

      const res = await request(server, 'GET', '/api/branches/feature-x');

      expect(res.status).toBe(200);
      expect(mock.commands.some((cmd) => /docker |git /.test(cmd))).toBe(false);
      expect(operationEvents.filter((event) => event.action.startsWith('branch.operation.'))).toEqual([]);
    });

    it('returns 404 when the id does not exist', async () => {
      const res = await request(server, 'GET', '/api/branches/no-such-branch');
      expect(res.status).toBe(404);
      expect((res.body as any).error).toContain('no-such-branch');
    });

    it('does not collide with /branches/stream (literal route wins)', async () => {
      // Regression: if `:id` were declared before `stream`, Express would
      // intercept the SSE endpoint and try to look up a branch named
      // "stream", returning 404. We assert the SSE endpoint sends a 200
      // status header within the keep-alive timeout (no need to read body
      // — the SSE channel never closes naturally).
      const status = await new Promise<number>((resolve, reject) => {
        const addr = server.address() as { port: number };
        const req = http.request({
          hostname: '127.0.0.1', port: addr.port,
          path: '/api/branches/stream', method: 'GET',
        }, (res) => {
          // Headers received → the route matched successfully. Tear down
          // the socket immediately, the test only cares about routing
          // ordering.
          resolve(res.statusCode!);
          req.destroy();
        });
        req.on('error', (err) => {
          // ECONNRESET after we destroy() is expected; surface anything
          // earlier as a real error.
          if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
          reject(err);
        });
        req.end();
      });
      expect(status).toBe(200);
    });
  });

  describe('GET /api/branches/:id/effective-env', () => {
    it('全局变量只有在项目显式开启继承后才显示为生效', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'env-global-scope',
        projectId: 'default',
        branch: 'env/global-scope',
        worktreePath: path.join(tmpDir, 'worktrees', 'env-global-scope'),
        services: {},
        status: 'idle',
        createdAt: now,
      });
      stateService.setCustomEnvVar('LLMGW_SCOPE_GUARD', 'must-not-leak', '_global');

      const isolated = await request(server, 'GET', '/api/branches/env-global-scope/effective-env');
      expect(isolated.status).toBe(200);
      expect((isolated.body as any).variables.some((item: any) => item.key === 'LLMGW_SCOPE_GUARD')).toBe(false);
      expect((isolated.body as any).bySource.global).toBe(0);

      stateService.updateProject('default', { inheritGlobalEnv: true });
      const inherited = await request(server, 'GET', '/api/branches/env-global-scope/effective-env');
      expect(inherited.status).toBe(200);
      expect((inherited.body as any).variables).toContainEqual(expect.objectContaining({
        key: 'LLMGW_SCOPE_GUARD',
        value: 'must-not-leak',
        source: 'global',
      }));
      expect((inherited.body as any).bySource.global).toBe(1);
    });

    it('shows branch-scoped env overrides above project env', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'env-branch',
        projectId: 'default',
        branch: 'env/branch',
        worktreePath: path.join(tmpDir, 'worktrees', 'env-branch'),
        services: {},
        status: 'idle',
        createdAt: now,
      });
      stateService.setCustomEnvVar('FEATURE_FLAG', 'project-value', 'default');
      stateService.setCustomEnvVar('FEATURE_FLAG', 'branch-value', 'env-branch');
      stateService.setCustomEnvVar('PROJECT_ONLY', 'project-only', 'default');

      const res = await request(server, 'GET', '/api/branches/env-branch/effective-env');

      expect(res.status).toBe(200);
      const body = res.body as any;
      const feature = body.variables.find((v: any) => v.key === 'FEATURE_FLAG');
      const projectOnly = body.variables.find((v: any) => v.key === 'PROJECT_ONLY');
      expect(feature).toMatchObject({ value: 'branch-value', source: 'branch' });
      expect(projectOnly).toMatchObject({ value: 'project-only', source: 'project' });
      expect(body.bySource.branch).toBe(1);
    });
  });

  describe('GET /api/loading-pages/cds-waiting-room/preview', () => {
    it('renders the real CDS waiting-room loading page for settings preview', async () => {
      const res = await request(server, 'GET', '/api/loading-pages/cds-waiting-room/preview?status=building');

      expect(res.status).toBe(503);
      expect(res.body).toContain('CDS Waiting Room');
      expect(res.body).toContain('magic-rings-bg');
      expect(res.body).toContain('id="magic-rings"');
      expect(res.body).toContain('id="magic-rings-fragment"');
      expect(res.body).not.toContain('rings-orbit');
      expect(res.body).not.toContain('class="panel"');
      expect(res.body).toContain('分支环境正在构建');
    });
  });

  describe('POST /api/branches/:id/verify-runtime/:profileId', () => {
    it('returns a clear error when the recorded container no longer exists', async () => {
      const now = new Date().toISOString();
      stateService.addBranch({
        id: 'runtime-missing',
        projectId: 'default',
        branch: 'runtime/missing',
        worktreePath: '/tmp/wt/runtime-missing',
        services: {
          api: {
            profileId: 'api',
            containerName: 'missing-container',
            hostPort: 12345,
            status: 'error',
          },
        },
        status: 'error',
        createdAt: now,
      });
      mock.addResponse('docker inspect --format="{{.State.Running}}" missing-container', {
        stdout: '',
        stderr: 'No such object: missing-container',
        exitCode: 1,
      });
      mock.addResponse('docker inspect --format="{{.State.Status}}" \'missing-container\'', {
        stdout: '',
        stderr: 'No such object: missing-container',
        exitCode: 1,
      });

      const res = await request(server, 'POST', '/api/branches/runtime-missing/verify-runtime/api');

      expect(res.status).toBe(400);
      expect((res.body as any).error).toContain('不存在或已被清理');
      expect(mock.commands.some((command) => command.startsWith('docker exec missing-container'))).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /api/self-branches — Bugbot 第八轮 HIGH fix(2026-05-04 PR #523)
  //
  // 关键回归:format 用 `%1f`(git 输出真 0x1F 字节)+ JS split 用 '\x1f'。
  // 之前写 `'\\x1f'`(4 字符 literal)git 不解析 → split 找不到分隔符 → 整个
  // branch picker 返回空数组,self-update UI 完全不可用。
  // ──────────────────────────────────────────────────────────────────
  describe('GET /api/self-branches', () => {
    // 2026-05-28 重构:/api/self-branches 不再直接同步扫 git,改读
    // selfStatusCache.remoteBranches。下面的测试直接调 cache.enqueueRefresh
    // 让 cache 跑一次 scanRemoteBranchesFromGit,等 refresh job done 后再 GET。
    // (test app 没有挂 cds-events router,所以无法走 POST /api/self-refresh)
    // mock shell 响应仍然是同一套(模拟 git for-each-ref 等)。
    const waitForRefresh = async (): Promise<void> => {
      // cache 的 refresh job 是异步的;实际跑完需要让微任务 + 后续 await 全部执行。
      for (let i = 0; i < 30; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    const triggerCacheRefresh = async (): Promise<void> => {
      const mod = await import('../../src/services/self-status-cache.js');
      const job = mod.selfStatusCache.enqueueRefresh('manual');
      expect(['queued', 'running']).toContain(job.status);
      await waitForRefresh();
    };
    it('正确解析 git for-each-ref 用 0x1F 分隔的输出', async () => {
      mock.clearPatterns();
      const SEP = '\x1f'; // 真 0x1F 字节
      // git for-each-ref 输出 — 模拟 git 自己用 %1f 转义后输出真 0x1F 字节
      mock.addResponsePattern(/^git for-each-ref/, () => ({
        stdout: [
          `origin/main${SEP}2026-05-04T12:00:00+00:00${SEP}aaa1111${SEP}feat: latest main commit`,
          `origin/feat-x${SEP}2026-05-03T10:00:00+00:00${SEP}bbb2222${SEP}wip: feat-x progress`,
          `origin/HEAD -> origin/main${SEP}2026-05-04T12:00:00+00:00${SEP}aaa1111${SEP}should be filtered`,
          `origin${SEP}2026-05-04T12:00:00+00:00${SEP}aaa1111${SEP}symbolic ref${SEP}refs/remotes/origin/main`,
          `origin/old-branch${SEP}2026-04-01T00:00:00+00:00${SEP}ccc3333${SEP}old: legacy`,
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      }));
      mock.addResponsePattern(/git rev-parse --abbrev-ref HEAD/, () => ({
        stdout: 'main', stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git rev-parse --short HEAD/, () => ({
        stdout: 'aaa1111', stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git log -1 --format=%cI HEAD/, () => ({
        stdout: '2026-05-04T12:00:00+00:00', stderr: '', exitCode: 0,
      }));
      // cdsTouched 检查 — feat-x 动了 cds,old-branch 没动
      mock.addResponsePattern(/git log --format=%H -n 1 origin\/main\.\.origin\/feat-x -- cds\//, () => ({
        stdout: 'somesha', stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git log --format=%H -n 1 origin\/main\.\.origin\/old-branch -- cds\//, () => ({
        stdout: '', stderr: '', exitCode: 0,
      }));

      // 触发 cache refresh,等 job done。新契约:/api/self-branches 读 cache。
      await triggerCacheRefresh();

      const res = await request(server, 'GET', '/api/self-branches');
      expect(res.status).toBe(200);
      const body = res.body as {
        ok?: boolean;
        degraded?: boolean;
        current: string;
        detached: boolean;
        recommended: string;
        commitHash: string;
        currentCommitterDate: string;
        branches: string[];
        branchDetails: Array<{
          name: string;
          committerDate: string;
          commitHash: string;
          subject: string;
          cdsTouched: boolean;
        }>;
      };

      // 关键断言:branchDetails 不能为空(之前 bug 让它空)
      expect(body.branchDetails).toBeDefined();
      expect(body.branchDetails.length).toBeGreaterThan(0);

      // origin/HEAD -> origin/main 这种 ref 应被过滤
      const names = body.branchDetails.map((b) => b.name);
      expect(names).not.toContain('HEAD -> main');
      expect(names).not.toContain('HEAD');
      expect(names).not.toContain('origin');
      expect(body.detached).toBe(false);
      expect(body.recommended).toBe('main');

      // 分支按 committerDate 倒序(git for-each-ref --sort=-committerdate 已排,前端不再排)
      // 第一行 main,第二行 feat-x,第三行被 HEAD 过滤,第四行 old-branch
      expect(names).toEqual(['main', 'feat-x', 'old-branch']);

      // origin/ 前缀应被剥掉
      expect(names.every((n) => !n.startsWith('origin/'))).toBe(true);

      // 字段被正确解析(说明 split('\x1f') 工作)
      const main = body.branchDetails.find((b) => b.name === 'main')!;
      expect(main.committerDate).toBe('2026-05-04T12:00:00+00:00');
      expect(main.commitHash).toBe('aaa1111');
      expect(main.subject).toBe('feat: latest main commit');

      // cdsTouched:feat-x = true,old-branch = false(当前分支 main 自己不算)
      const featX = body.branchDetails.find((b) => b.name === 'feat-x')!;
      expect(featX.cdsTouched).toBe(true);
      const old = body.branchDetails.find((b) => b.name === 'old-branch')!;
      expect(old.cdsTouched).toBe(false);

      // 旧字段 branches: string[] 也按时间倒排
      expect(body.branches).toEqual(['main', 'feat-x', 'old-branch']);
    });

    it('游离 HEAD 不作为目标分支并推荐 origin/HEAD 指向的分支', async () => {
      mock.clearPatterns();
      const SEP = '\x1f';
      mock.addResponsePattern(/^git for-each-ref/, () => ({
        stdout: [
          `origin/main${SEP}2026-07-19T00:00:00+00:00${SEP}abc1234${SEP}latest main${SEP}`,
          `origin${SEP}2026-07-19T00:00:00+00:00${SEP}abc1234${SEP}symbolic ref${SEP}refs/remotes/origin/main`,
        ].join('\n'),
        stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git rev-parse --abbrev-ref HEAD/, () => ({
        stdout: 'HEAD', stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git symbolic-ref --quiet --short refs\/remotes\/origin\/HEAD/, () => ({
        stdout: 'origin/main', stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git rev-parse --short HEAD/, () => ({ stdout: 'abc1234', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git log -1 --format=%cI HEAD/, () => ({
        stdout: '2026-07-19T00:00:00+00:00', stderr: '', exitCode: 0,
      }));

      await triggerCacheRefresh();

      const res = await request(server, 'GET', '/api/self-branches');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        current: '',
        detached: true,
        recommended: 'main',
        branches: ['main'],
      });
    });

    it('subject 含空格和特殊字符仍能正确解析(0x1F 分隔不被空格破坏)', async () => {
      mock.clearPatterns();
      const SEP = '\x1f';
      mock.addResponsePattern(/^git for-each-ref/, () => ({
        stdout: [
          // subject 含中文 + 空格 + 特殊字符,SEP 才能可靠分割
          `origin/main${SEP}2026-05-04T12:00:00+00:00${SEP}aaa1111${SEP}fix(cds): 修 bug — 含 () : / 等特殊符号`,
        ].join('\n'),
        stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git rev-parse --abbrev-ref HEAD/, () => ({
        stdout: 'main', stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git rev-parse --short HEAD/, () => ({ stdout: 'aaa1111', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/git log -1 --format=%cI HEAD/, () => ({ stdout: '2026-05-04T12:00:00+00:00', stderr: '', exitCode: 0 }));

      await triggerCacheRefresh();

      const res = await request(server, 'GET', '/api/self-branches');
      expect(res.status).toBe(200);
      const body = res.body as { branchDetails: Array<{ subject: string }> };
      expect(body.branchDetails).toHaveLength(1);
      expect(body.branchDetails[0].subject).toBe('fix(cds): 修 bug — 含 () : / 等特殊符号');
    });

    it('git for-each-ref 失败时返回 200 + degraded(永不 5xx)', async () => {
      // 2026-05-28 契约变更:本端点永远 200,失败用 degraded:true 暴露。
      mock.clearPatterns();
      mock.addResponsePattern(/git rev-parse --abbrev-ref HEAD/, () => ({
        stdout: 'main', stderr: '', exitCode: 0,
      }));
      mock.addResponsePattern(/git fetch/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
      mock.addResponsePattern(/^git for-each-ref/, () => {
        throw new Error('fatal: not a git repository');
      });

      await triggerCacheRefresh();

      const res = await request(server, 'GET', '/api/self-branches');
      expect(res.status).toBe(200);
      const body = res.body as {
        ok: boolean;
        degraded: boolean;
        reason?: string | null;
        branchDetails: unknown[];
      };
      // remoteBranches scan 抛错时 cache.scanRemoteBranches 会内部 catch,
      // 仍然保留旧 remoteBranches(空)— 接口表现为 ok+空列表,不是 500。
      expect(body.branchDetails).toEqual([]);
    });
  });

  // ── 轻量重启 + 分支系统日志（2026-05-18）──

  describe('POST /api/branches/:id/recover-runtime', () => {
    it('不存在和缺少精确身份时拒绝，不能触发宿主命令', async () => {
      expect((await request(server, 'POST', '/api/branches/nope/recover-runtime')).status).toBe(404);
      stateService.addBranch({ id: 'recover', branch: 'recover', projectId: 'default', worktreePath: '/tmp/wt/recover',
        services: {}, status: 'error', createdAt: new Date().toISOString() });
      mock.commands.length = 0;
      expect((await request(server, 'POST', '/api/branches/recover/recover-runtime', {})).status).toBe(400);
      expect(mock.commands).toEqual([]);
    });

    it('过期提交保留失败状态，恢复租约正常收尾且不执行 Docker', async () => {
      stateService.addBranch({ id: 'recover', branch: 'recover', projectId: 'default', worktreePath: '/tmp/wt/recover',
        githubCommitSha: 'a'.repeat(40), services: {}, status: 'error', errorMessage: 'original failure', createdAt: new Date().toISOString() });
      mock.commands.length = 0;
      const response = await request(server, 'POST', '/api/branches/recover/recover-runtime', { expectedCommitSha: 'b'.repeat(40), expectedContainers: {} });
      expect(String(response.body)).toContain('恢复目标提交已变化');
      expect(stateService.getBranch('recover')?.errorMessage).toBe('original failure');
      expect(mock.commands).toEqual([]);
      expect(operationEvents.some(event => event.branchId === 'recover' && event.action === 'branch.operation.failed')).toBe(true);
    });
  });

  describe('POST /api/branches/:id/restart', () => {
    it('404 when branch does not exist', async () => {
      const res = await request(server, 'POST', '/api/branches/nope/restart');
      expect(res.status).toBe(404);
    });

    it('409 when branch has no built containers', async () => {
      stateService.addBranch({
        id: 'feat-x', branch: 'feat/x', worktreePath: '/tmp/wt/feat-x',
        services: {}, status: 'idle', createdAt: '2026-02-12T00:00:00Z',
        projectId: 'default',
      });
      const res = await request(server, 'POST', '/api/branches/feat-x/restart');
      expect(res.status).toBe(409);
    });

    it('records manual restart as a fenced branch operation with container operationId', async () => {
      stateService.addBranch({
        id: 'feat-restart',
        branch: 'feat/restart',
        worktreePath: '/tmp/wt/feat-restart',
        services: {
          api: {
            profileId: 'api',
            containerName: 'restart-api',
            hostPort: 10001,
            status: 'stopped',
          },
        },
        status: 'idle',
        createdAt: '2026-02-12T00:00:00Z',
        projectId: 'default',
      });
      mock.addResponsePattern(/docker restart restart-api/, () => ({ stdout: 'restart-api', stderr: '', exitCode: 0 }));

      const res = await request(server, 'POST', '/api/branches/feat-restart/restart');

      expect(res.status).toBe(200);
      const branch = stateService.getBranch('feat-restart')!;
      expect(branch.status).toBe('running');
      expect(branch.services.api.status).toBe('running');
      expect(Date.parse(branch.lastDeployStartedAt || '')).toBeGreaterThan(Date.parse('2026-02-12T00:00:00Z'));
      const started = operationEvents.find((event) => event.branchId === 'feat-restart' && event.action === 'branch.operation.started');
      const completed = operationEvents.find((event) => event.branchId === 'feat-restart' && event.action === 'branch.operation.completed');
      expect(started?.details).toMatchObject({ kind: 'restart', source: 'api.restart-branch' });
      expect(completed?.operationId).toBe(started?.operationId);
      expect(mock.commands.some((command) => command.includes('docker restart restart-api'))).toBe(true);
    });

  });

  describe('GET /api/branches/:id/activity-logs', () => {
    it('404 for unknown branch', async () => {
      const res = await request(server, 'GET', '/api/branches/nope/activity-logs');
      expect(res.status).toBe(404);
    });

    it('只返回本分支事件且最新在前', async () => {
      stateService.addBranch({
        id: 'feat-z', branch: 'feat/z', worktreePath: '/tmp/wt/feat-z',
        services: {}, status: 'idle', createdAt: '2026-02-12T00:00:00Z', projectId: 'default',
      });
      stateService.appendActivityLog('default', { type: 'deploy', branchId: 'feat-z', actor: 'user', at: '2026-05-18T00:00:00.000Z' });
      stateService.appendActivityLog('default', { type: 'crash', branchId: 'feat-z', actor: 'auto-restart', at: '2026-05-18T01:00:00.000Z' });
      stateService.appendActivityLog('default', { type: 'stop', branchId: 'other-branch', actor: 'user', at: '2026-05-18T02:00:00.000Z' });
      stateService.save();
      const res = await request(server, 'GET', '/api/branches/feat-z/activity-logs');
      expect(res.status).toBe(200);
      const body = res.body as { logs: Array<{ type: string; branchId: string }> };
      expect(body.logs.every((e) => e.branchId === 'feat-z')).toBe(true);
      expect(body.logs[0].type).toBe('crash'); // 最新在前
      expect(body.logs.map((e) => e.type)).toEqual(['crash', 'deploy']);
    });
  });

  // ── 预览地址按提交派发（P5）──────────────────────────────────────
  describe('POST /api/preview-dispatch', () => {
    const REPO = 'octocat/monorepo';
    const now = () => new Date().toISOString();

    function seedProject(id: string, slug: string, name: string, buildScope?: string[]): void {
      stateService.addProject({
        id, slug, name, kind: 'git', createdAt: now(), updatedAt: now(),
        githubRepoFullName: REPO,
      });
      stateService.addBuildProfile({
        id: `${id}-web`,
        projectId: id,
        name: 'web',
        dockerImage: 'node:22',
        workDir: '.',
        containerPort: 3000,
        hostPortPreference: 0,
        buildCommand: 'echo build',
        pathPrefixes: ['/'],
        webEntry: { name: '主应用入口', path: '/' },
        ...(buildScope ? { buildScope } : {}),
      } as any);
    }

    function seedRunningBranch(projectId: string, slug: string, branch: string): string {
      const branchId = `${slug}-${branch.replace(/[^a-z0-9-]+/gi, '-')}`;
      stateService.addBranch({
        id: branchId,
        projectId,
        branch,
        worktreePath: path.join(tmpDir, branchId),
        status: 'running',
        createdAt: now(),
        services: {
          [`${projectId}-web`]: {
            profileId: `${projectId}-web`,
            containerName: `${branchId}-web`,
            hostPort: 10010,
            status: 'running',
          },
        },
      } as any);
      return branchId;
    }

    it('两个项目都被波及时给出两行地址，格式为 [项目] URL', async () => {
      seedProject('proj-main', 'mainp', 'MAP');
      seedProject('proj-self', 'selfp', 'CDS Self');
      seedRunningBranch('proj-main', 'mainp', 'feature/x');
      seedRunningBranch('proj-self', 'selfp', 'feature/x');

      const res = await request(server, 'POST', '/api/preview-dispatch', {
        repo: REPO, branch: 'feature/x',
      });

      expect(res.status).toBe(200);
      expect(res.body.projects).toHaveLength(2);
      expect(res.body.lines).toHaveLength(2);
      expect(res.body.lines.some((l: string) => l.startsWith('[MAP] https://'))).toBe(true);
      expect(res.body.lines.some((l: string) => l.startsWith('[CDS Self] https://'))).toBe(true);
      // 地址必须来自服务端的入口表，不能是客户端拼的
      expect(res.body.lines.every((l: string) => l.includes('.example.test'))).toBe(true);
    });

    it('作用域挡掉的项目仍然出现在结果里，状态为 not-affected 而不是消失', async () => {
      seedProject('proj-main', 'mainp', 'MAP', ['prd-api/**']);
      seedProject('proj-self', 'selfp', 'CDS Self', ['cds/**']);
      seedRunningBranch('proj-main', 'mainp', 'feature/x');
      seedRunningBranch('proj-self', 'selfp', 'feature/x');

      const res = await request(server, 'POST', '/api/preview-dispatch', {
        repo: REPO, branch: 'feature/x', changedPaths: ['cds/src/server.ts'],
      });

      expect(res.status).toBe(200);
      expect(res.body.lines).toHaveLength(1);
      expect(res.body.lines[0]).toContain('[CDS Self]');
      const main = res.body.projects.find((p: any) => p.projectId === 'proj-main');
      expect(main.status).toBe('not-affected');
      expect(main.entries).toEqual([]);
    });

    /**
     * Codex P2：只要配了预览域名，`computeBranchWebEntries` 就无条件造一条默认
     * 入口，于是「分支在、但还没跑起来」这一档永远走不到 —— 命令行会照常打印
     * 一个打不开的地址。四种结论分开报是 P5 的整个卖点，少一档等于没分开。
     */
    it('分支刚建、还在构建：affected-not-deployed，不许给打不开的地址', async () => {
      seedProject('proj-main', 'mainp', 'MAP');
      const branchId = seedRunningBranch('proj-main', 'mainp', 'feature/x');
      // 刚建出来还在构建的分支：没有任何服务在跑，自然没有能打开的地址。
      // （只翻总状态、留着一个还在跑且有端口的服务，那地址其实是能打开的 ——
      //  判据要看的是「背后有没有人接」，不是分支这一刻的总状态。）
      const branch = stateService.getBranch(branchId)!;
      branch.status = 'building';
      branch.services = {};

      const res = await request(server, 'POST', '/api/preview-dispatch', {
        repo: REPO, branch: 'feature/x',
      });

      expect(res.status).toBe(200);
      expect(res.body.projects[0].status).toBe('affected-not-deployed');
      expect(res.body.lines).toHaveLength(0);
    });

    /**
     * Codex 第二次点同一处：上一轮我只按分支总状态判「跑起来了没」，而只跑后台
     * worker 的分支同样是 running —— 照样给出一个背后没人接的地址。判据得看
     * 「有没有可路由服务在跑」，与转发器发布路由用同一条。
     */
    it('分支在跑但只有后台服务：仍是 affected-not-deployed，不给没人接的地址', async () => {
      seedProject('proj-main', 'mainp', 'MAP');
      const branchId = seedRunningBranch('proj-main', 'mainp', 'feature/x');
      // 服务还在跑，但没有对外端口 —— 典型的 worker-only 分支
      const svc = stateService.getBranch(branchId)!.services!['proj-main-web'];
      delete (svc as { hostPort?: number }).hostPort;

      const res = await request(server, 'POST', '/api/preview-dispatch', {
        repo: REPO, branch: 'feature/x',
      });

      expect(res.status).toBe(200);
      expect(res.body.projects[0].status).toBe('affected-not-deployed');
      expect(res.body.lines).toHaveLength(0);
    });

    it('波及但 CDS 上没有这条分支：affected-no-branch，不是报错', async () => {
      seedProject('proj-self', 'selfp', 'CDS Self', ['cds/**']);

      const res = await request(server, 'POST', '/api/preview-dispatch', {
        repo: REPO, branch: 'feature/missing', changedPaths: ['cds/src/server.ts'],
      });

      expect(res.status).toBe(200);
      expect(res.body.projects[0].status).toBe('affected-no-branch');
      expect(res.body.lines).toEqual([]);
    });

    it('项目级凭据只看得到自己那个项目，别人的项目名与地址一概不出现', async () => {
      seedProject('proj-a', 'proja', '项目 A');
      seedProject('proj-b', 'projb', '项目 B');
      seedRunningBranch('proj-a', 'proja', 'feature/x');
      seedRunningBranch('proj-b', 'projb', 'feature/x');

      const res = await request(server, 'POST', '/api/preview-dispatch', {
        repo: REPO, branch: 'feature/x',
      }, { 'x-test-key': 'A' });

      expect(res.status).toBe(200);
      expect(res.body.projects).toHaveLength(1);
      expect(res.body.projects[0].projectId).toBe('proj-a');
      expect(JSON.stringify(res.body)).not.toContain('项目 B');
    });

    it('仓库没有绑定任何项目时明说，不返回 500', async () => {
      const res = await request(server, 'POST', '/api/preview-dispatch', {
        repo: 'nobody/nothing', branch: 'feature/x',
      });
      expect(res.status).toBe(200);
      expect(res.body.projects).toEqual([]);
      expect(res.body.message).toContain('没有任何项目绑定');
    });

    it('缺 repo 或 branch 一律 400', async () => {
      expect((await request(server, 'POST', '/api/preview-dispatch', { branch: 'x' })).status).toBe(400);
      expect((await request(server, 'POST', '/api/preview-dispatch', { repo: REPO })).status).toBe(400);
    });
  });

});
