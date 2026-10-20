import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import { admittedArtifactProfile, artifactInspectionContext, inspectDeploymentArtifacts, verifyArtifactAdmission } from '../../src/services/artifact-admission.js';
import { WorktreeService } from '../../src/services/worktree.js';
import { OperationExecutionError } from '../../src/services/isolated-shell-executor.js';
import { READ_TIMEOUT_MS } from '../../src/services/release-git-reader.js';
import { proveFallbackImage } from '../../src/services/prebuilt-reuse.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BuildProfile, ExecOptions } from '../../src/types.js';
import { branchVersionFacts } from '../../src/services/running-version.js';
import { ContainerService } from '../../src/services/container.js';
import type { BranchEntry, CdsConfig, ServiceState } from '../../src/types.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const target = 'b'.repeat(40);
const actualRevision = 'a'.repeat(40);
const repository = 'ghcr.io/owned/api';
const primary = `${repository}:sha-${target}`;
const fallback = `${repository}:branch-main`;
const contentId = `sha256:${'c'.repeat(64)}`;
const fixedImage = `${repository}@${contentId}`;

describe('增量 CI 与完整产物准入的复用契约', () => {
  it('真实工作流对只改 admin 的 feature 提交跳过未变组件，不保证全部目标 SHA 镜像存在', () => {
    const workflow = yaml.load(fs.readFileSync(path.join(repoRoot, '.github/workflows/branch-image.yml'), 'utf8')) as {
      jobs: Record<string, { if?: string }>;
    };
    const inputs = {
      needs: { changes: { outputs: { api: 'false', admin: 'true', llmgw: 'false', llmgw_web: 'false',
        llmgw_serve: 'false', design_opendesign: 'false', same_as_main: 'false' } } },
      github: { ref: 'refs/heads/codex/only-admin-changed', event_name: 'push' },
    };
    const scheduled = ['api-image', 'admin-image', 'llmgw-image', 'llmgw-web-image',
      'llmgw-serve-image', 'design-opendesign-image'].filter(jobId => {
      const condition = workflow.jobs[jobId]?.if;
      expect(condition, `工作流缺少 ${jobId} 条件`).toBeTruthy();
      // 执行仓库真实的有限 job 条件，不在测试里复制一份“哪些组件要构建”的判据。
      const expression = condition!.replace(/^\s*\$\{\{\s*/, '').replace(/\s*\}\}\s*$/, '');
      return vm.runInNewContext(expression, inputs, { timeout: 100 });
    });
    expect(scheduled).toEqual(['admin-image']);
  });

  it('未变组件应在准入前复用已证明等价的固定内容，并保留镜像真实 revision', async () => {
    const shell = new MockShellExecutor();
    const profile: BuildProfile = { id: 'api', name: 'API', dockerImage: primary, fallbackImage: [fallback],
      buildScope: ['prd-api/**', '.github/workflows/branch-image.yml'], workDir: '.', command: '',
      containerPort: 8080, prebuiltImage: true };
    const comparisons: unknown[][] = [];
    const isComponentUnchangedSince = async (...args: [string, string, readonly string[]]) => {
      comparisons.push(args);
      return true;
    };
    shell.addResponsePattern(/docker info/, () => ({ stdout: JSON.stringify({ Architecture: 'amd64', OSType: 'linux' }),
      stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/docker pull (.+)/, match => match[1].includes(primary)
      ? { stdout: '', stderr: 'manifest unknown', exitCode: 1 }
      : { stdout: 'pulled', stderr: '', exitCode: 0 });
    shell.addResponsePattern(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: contentId,
      RepoDigests: [fixedImage], Os: 'linux', Architecture: 'amd64',
      Config: { Labels: { 'org.opencontainers.image.revision': actualRevision } } }]), stderr: '', exitCode: 0 }));

    // 现成的等价证明零件已经接受该输入；完整准入不能在尝试它之前永久等待缺失的主镜像。
    await expect(proveFallbackImage({ revision: actualRevision, targetSha: target, buildScope: profile.buildScope,
      isComponentUnchangedSince })).resolves.toMatchObject({ accepted: true, reason: 'component-unchanged' });
    comparisons.length = 0;
    const options = { inspectLocalArtifacts: false, isComponentUnchangedSince };
    const admission = await inspectDeploymentArtifacts(shell, [profile], target, () => {}, options);
    expect(admission.state).toBe('ready');
    expect(comparisons).toEqual([[actualRevision, target, profile.buildScope]]);
    expect(admission).toMatchObject({ targetCommitSha: target, artifacts: [{ profileIds: ['api'],
      requestedImage: primary, image: fixedImage, revision: actualRevision, platform: 'linux/amd64' }] });
    const runtime = admittedArtifactProfile(profile, admission);
    expect(runtime.dockerImage).toBe(`${repository}:sha-${actualRevision}@${contentId}`);
    expect(runtime.dockerImage).not.toContain(`:sha-${target}@`);
    const rechecked = await inspectDeploymentArtifacts(shell, [runtime], target, () => {}, {
      inspectLocalArtifacts: true, isComponentUnchangedSince });
    expect(rechecked).toMatchObject({ state: 'ready', targetCommitSha: target, artifacts: [{ revision: actualRevision }] });
    expect(admittedArtifactProfile({ ...runtime, localArtifact: false }, rechecked).dockerImage).toBe(runtime.dockerImage);
    expect(branchVersionFacts({ githubCommitSha: target, services: {
      api: { profileId: 'api', status: 'running', deployedImage: runtime.dockerImage },
    } } as any)).toEqual({ runningCommitSha: actualRevision, targetCommitSha: target });
    expect(shell.commands.some(command => /docker (run|rm|create)|git worktree|database/.test(command))).toBe(false);
  });

  function reusable() {
    const shell = new MockShellExecutor();
    const profile: BuildProfile = { id: 'api', name: 'API', dockerImage: primary, fallbackImage: [fallback],
      buildScope: ['prd-api/**', '.github/workflows/branch-image.yml'], workDir: '.', command: '', containerPort: 8080, prebuiltImage: true };
    shell.addResponsePattern(/docker info/, () => ({ stdout: JSON.stringify({ Architecture: 'amd64', OSType: 'linux' }), stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/docker pull (.+)/, match => ({ stdout: '', stderr: match[1].includes(primary) ? 'manifest unknown' : '',
      exitCode: match[1].includes(primary) ? 1 : 0 }));
    shell.addResponsePattern(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: contentId, RepoDigests: [fixedImage],
      Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': actualRevision } } }]), stderr: '', exitCode: 0 }));
    return { shell, profile };
  }

  it.each(['认证返回', 'fetch槽派发', '预算失效'])('真实准入比较在%s后不得使用旧资格继续取B或转ready', async phase => {
    const { shell, profile } = reusable(); let current = true, elapsed = 1000, enter!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed), commands: string[] = [];
    const assertCurrent = () => { if (!current) throw new Error('本轮资格已取代'); };
    Object.assign(shell, { execOwnedOperation: async (command: string, options: ExecOptions & { beforeStart: () => void }) => {
      if (command.startsWith('git fetch') && phase !== '认证返回') { enter(); await gate; }
      options.beforeStart(); commands.push(command);
      return { stdout: command.includes(actualRevision) ? actualRevision : '', stderr: '', exitCode: command.includes(actualRevision) ? 0 : 128 };
    } });
    const worktree = new WorktreeService(shell, async () => { if (phase === '认证返回') { enter(); await gate; } return { TEST_AUTH: 'synthetic-only' }; });
    const outcome = inspectDeploymentArtifacts(shell, [profile], target, assertCurrent,
      artifactInspectionContext(shell, worktree, '/owned', assertCurrent)).catch(error => error);
    try {
      await started; if (phase === '预算失效') elapsed += 120_001; else current = false;
      release(); expect((await outcome)?.state).not.toBe('ready'); expect(commands.some(command => command.startsWith('git fetch'))).toBe(false);
    } finally { release(); await outcome; clock.mockRestore(); }
  });

  it('认证超过同轮剩余预算后有限结束，迟返认证不能再派Git或泄露内容', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { shell, profile } = reusable(); let enter!: () => void, release!: (value: Record<string, string>) => void;
    const started = new Promise<void>(resolve => { enter = resolve; }), auth = new Promise<Record<string, string>>(resolve => { release = resolve; });
    const commands: string[] = [];
    Object.assign(shell, { execOwnedOperation: async (command: string, options: ExecOptions & { beforeStart: () => void }) => {
      options.beforeStart(); commands.push(command); return { stdout: command.includes(actualRevision) ? actualRevision : '', stderr: '', exitCode: command.includes(actualRevision) ? 0 : 128 };
    } });
    const worktree = new WorktreeService(shell, async () => { enter(); return auth; });
    const outcome = inspectDeploymentArtifacts(shell, [profile], target, () => {}, artifactInspectionContext(shell, worktree, '/owned', () => {}, 10));
    try {
      await started; await vi.advanceTimersByTimeAsync(11); expect((await outcome).state).toBe('waiting');
      release({ TEST_AUTH: 'synthetic-secret' }); await Promise.resolve(); await Promise.resolve();
      expect(commands.some(command => command.startsWith('git fetch'))).toBe(false); expect(JSON.stringify(await outcome)).not.toContain('synthetic-secret');
    } finally { release({}); vi.useRealTimers(); }
  });

  it('同repoRoot前任真实占住mutation时，本轮在剩余窗内返回且释放后不迟到fetch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-artifact-mutation-'));
    const { shell, profile } = reusable();
    let release!: () => void, entered!: () => void, queued!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const preparing = new Promise<void>(resolve => { queued = resolve; });
    const original = shell.exec.bind(shell), owned: string[] = [];
    for (const command of ['git fetch origin held-ref', 'git reset --hard origin/held-ref']) {
      shell.addResponse(command, { stdout: '', stderr: '', exitCode: 0 });
    }
    shell.addResponse('git rev-parse --short HEAD', { stdout: actualRevision.slice(0, 7), stderr: '', exitCode: 0 });
    shell.addResponse('git rev-parse HEAD', { stdout: actualRevision, stderr: '', exitCode: 0 });
    shell.addResponse('git log --oneline -1', { stdout: `${actualRevision.slice(0, 7)} held fixture`, stderr: '', exitCode: 0 });
    shell.exec = async (command, options) => {
      if (command === 'git fetch origin held-ref') { entered(); await hold; }
      return original(command, options);
    };
    shell.addResponsePatternFirst(/git rev-parse --verify '([0-9a-f]{40})\^\{commit\}'/, match => ({
      stdout: match[1] === actualRevision ? actualRevision : '', stderr: '', exitCode: match[1] === actualRevision ? 0 : 128,
    }));
    Object.assign(shell, { execOwnedOperation: (command: string, options: ExecOptions & { beforeStart: () => void }) => {
      options.beforeStart(); owned.push(command); return shell.exec(command, options);
    } });
    let authCalls = 0, predecessorDone = false, settled = false;
    const worktree = new WorktreeService(shell, async () => { if (++authCalls === 2) queued(); return undefined; });
    const predecessor = worktree.pull('held-ref', root).finally(() => { predecessorDone = true; });
    let outcome: Promise<unknown> | undefined;
    try {
      await started;
      outcome = inspectDeploymentArtifacts(shell, [profile], target, () => {},
        artifactInspectionContext(shell, worktree, root, () => {}, 10))
        .then(value => { settled = true; return value; }, error => { settled = true; return error; });
      await preparing;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(authCalls).toBe(2);
      expect(predecessorDone).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      expect(performance.now()).toBe(10);
      expect(settled).toBe(true);
      expect(predecessorDone).toBe(false);
      expect(await outcome).toMatchObject({ state: 'waiting', targetCommitSha: target });
      release(); await predecessor; await outcome;
      expect(owned.filter(command => command.startsWith('git fetch'))).toEqual([]);
      expect(shell.commands.filter(command => command.startsWith('git fetch'))).toEqual(['git fetch origin held-ref']);
    } finally {
      release();
      try { await predecessor; await outcome; }
      finally { vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); }
    }
  });

  it.each(['期限', 'owner'] as const)('owned fetch清理未知后%s失效也不得释放同root mutation围栏', async invalidation => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-artifact-cleanup-'));
    const shell = new MockShellExecutor();
    let now = 1000, current = true;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    const cleanup = new OperationExecutionError('cleanup');
    const owned: string[] = [];
    const assertCurrent = () => { if (!current) throw new Error('本轮资格已取代'); };
    shell.addResponsePattern(/git rev-parse --verify/, () => ({ stdout: '', stderr: '', exitCode: 128 }));
    shell.addResponsePattern(/.*/, () => ({ stdout: actualRevision, stderr: '', exitCode: 0 }));
    Object.assign(shell, { execOwnedOperation: async (command: string, options: ExecOptions & { beforeStart: () => void }) => {
      options.beforeStart();
      expect(options.cwd).toBe(root);
      expect(options.timeout).toBe(120_000);
      owned.push(command);
      if (command.startsWith('git fetch')) {
        if (invalidation === '期限') now += 120_001;
        else current = false;
        throw cleanup;
      }
      return shell.exec(command, options);
    } });
    try {
      await expect(new WorktreeService(shell).ensureCommitAvailable(root, target, assertCurrent,
        () => 120_000 - (now - 1000))).rejects.toThrow();
      expect(owned).toEqual([`git rev-parse --verify '${target}^{commit}'`, `git fetch origin ${target}`]);
      await expect(new WorktreeService(shell).pull('after-cleanup', root))
        .rejects.toMatchObject({ code: 'worktree-held' });
      expect(shell.commands.some(command => /^git (fetch|reset)/.test(command))).toBe(false);
    } finally {
      clock.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('剩余时间不足原只读窗时不入队，exact primary不准备任何Git输入', async () => {
    const { shell, profile } = reusable(), prepare = vi.fn(async (_repo: string, sha: string) => sha);
    Object.assign(shell, { execBackgroundObservation: shell.exec.bind(shell) });
    const context = artifactInspectionContext(shell, { ensureCommitAvailable: prepare }, '/owned', () => {}, READ_TIMEOUT_MS - 1);
    expect((await inspectDeploymentArtifacts(shell, [profile], target, () => {}, context)).state).toBe('waiting');
    expect(shell.commands.some(command => /^'git'/.test(command))).toBe(false);
    prepare.mockClear(); shell.addResponsePatternFirst(/docker pull/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    shell.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: contentId, RepoDigests: [fixedImage], Os: 'linux', Architecture: 'amd64',
      Config: { Labels: { 'org.opencontainers.image.revision': target } } }]), stderr: '', exitCode: 0 }));
    expect((await inspectDeploymentArtifacts(shell, [profile], target, () => {}, context)).state).toBe('ready'); expect(prepare).not.toHaveBeenCalled();
  });

  it.each([actualRevision, target])('本地裸仓库digest保持原样，实际revision=%s及运行环境仍以OCI事实为准', async revision => {
    const { shell, profile } = reusable();
    const local = { ...profile, dockerImage: fixedImage, localArtifact: true };
    shell.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: contentId, RepoDigests: [fixedImage],
      Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': revision } } }]), stderr: '', exitCode: 0 }));
    shell.addResponsePattern(/.*/, () => ({ stdout: 'd'.repeat(64), stderr: '', exitCode: 0 }));
    const runtime: ServiceState = { profileId: 'api', containerName: `owned-digest-${revision[0]}`, hostPort: 10001, status: 'running' };
    const entry: BranchEntry = { id: 'owned-digest', projectId: 'owned', branch: 'owned', worktreePath: '/tmp/owned-artifact-fixture',
      githubCommitSha: target, ciTargetSha: target, status: 'running', createdAt: new Date().toISOString(), services: { api: runtime } };
    const service = new ContainerService(shell, { repoRoot: entry.worktreePath, worktreeBase: entry.worktreePath,
      dockerNetwork: 'owned-network', sharedEnv: {}, jwt: { secret: 'synthetic-only', issuer: 'owned' } } as CdsConfig);
    const alive = vi.spyOn(service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    const ready = vi.spyOn(service as any, 'waitForReadiness').mockResolvedValue(true);
    const original = (service as any).writeEnvFile.bind(service); let environment: Record<string, string> | undefined;
    const envFile = vi.spyOn(service as any, 'writeEnvFile').mockImplementation((env: Record<string, string>) => {
      environment = { ...env }; return original(env);
    });
    try {
      await service.runService(entry, local, runtime, undefined, undefined, { artifactCommitSha: target,
        isComponentUnchangedSince: async (from, to, scope) => {
          expect([from, to, scope]).toEqual([actualRevision, target, profile.buildScope]); return true;
        } });
      expect(runtime.deployedImage).toBe(fixedImage);
      expect(environment?.CDS_COMMIT_SHA).toBe(revision);
      expect(shell.commands.find(command => /^docker (run|create) /.test(command))).toContain(`'${fixedImage}'`);
      expect(shell.commands.some(command => command.startsWith('docker pull') || /git |docker (exec|commit)/.test(command))).toBe(false);
    } finally { alive.mockRestore(); ready.mockRestore(); envFile.mockRestore(); }
  });

  it.each(['unauthorized: authentication required', 'TLS handshake timeout', 'Cannot connect to Docker daemon'])
  ('主目标%s不是明确缺失，不尝试回退', async stderr => {
    const { shell, profile } = reusable();
    shell.addResponsePatternFirst(/docker pull/, () => ({ stdout: '', stderr, exitCode: 1 }));
    const result = await inspectDeploymentArtifacts(shell, [profile], target, () => {}, { isComponentUnchangedSince: async () => true });
    expect(result.state).toBe('waiting');
    expect(shell.commands.filter(command => command.startsWith('docker pull'))).toHaveLength(1);
  });

  it('主目标存在但OCI版本错误时不能借等价证明跳过精确目标身份检查', async () => {
    const { shell, profile } = reusable(); let compared = 0;
    shell.addResponsePatternFirst(/docker pull/, () => ({ stdout: 'present', stderr: '', exitCode: 0 }));
    expect(await inspectDeploymentArtifacts(shell, [profile], target, () => {}, {
      isComponentUnchangedSince: async () => { compared++; return true; },
    })).toMatchObject({ state: 'waiting', reason: 'revision-mismatch', artifacts: [] });
    expect(compared).toBe(0);
    expect(shell.commands.filter(command => command.startsWith('docker pull'))).toHaveLength(1);
  });

  it('配置中跨仓库候选不被拉取，不能用另一服务产物填补缺失目标', async () => {
    const { shell, profile } = reusable(); profile.fallbackImage = ['ghcr.io/foreign/api:branch-main'];
    expect(await inspectDeploymentArtifacts(shell, [profile], target, () => {}, { isComponentUnchangedSince: async () => true }))
      .toMatchObject({ state: 'waiting', reason: 'missing', artifacts: [] });
    expect(shell.commands.filter(command => command.startsWith('docker pull'))).toHaveLength(1);
  });

  it.each(['scope', 'history', 'changed', 'comparator'] as const)('缺%s不能证明旧产物适用于目标', async missing => {
    const { shell, profile } = reusable(); if (missing === 'scope') profile.buildScope = undefined;
    const result = await inspectDeploymentArtifacts(shell, [profile], target, () => {}, {
      isComponentUnchangedSince: missing === 'comparator' ? undefined : async () => {
        if (missing === 'history') throw new Error('history missing'); return false;
      } });
    expect(result).toMatchObject({ state: 'waiting', reason: 'revision-mismatch', artifacts: [] });
  });

  it('回退镜像平台错误不能借等价证明绕过或继续别的候选', async () => {
    const { shell, profile } = reusable(); profile.fallbackImage = [fallback, `${repository}:branch-other`];
    shell.addResponsePatternFirst(/docker image inspect/, () => ({ stdout: JSON.stringify([{ Id: contentId, RepoDigests: [fixedImage],
      Os: 'linux', Architecture: 'arm64', Config: { Labels: { 'org.opencontainers.image.revision': actualRevision } } }]), stderr: '', exitCode: 0 }));
    expect(await inspectDeploymentArtifacts(shell, [profile], target, () => {}, { isComponentUnchangedSince: async () => true }))
      .toMatchObject({ state: 'waiting', reason: 'platform-mismatch', artifacts: [] });
    expect(shell.commands.some(command => command.includes('branch-other'))).toBe(false);
  });

  it('Master对远端等价proof独立比较完整范围，不接受布尔或缩窄scope', async () => {
    const { shell, profile } = reusable();
    const admission = await inspectDeploymentArtifacts(shell, [profile], target, () => {}, { isComponentUnchangedSince: async () => true });
    let compared = 0;
    expect(await verifyArtifactAdmission([profile], target, admission, async (from, to, scope) => {
      compared++; expect([from, to, scope]).toEqual([actualRevision, target, profile.buildScope]); return true;
    }, () => {})).toBe(true);
    expect(compared).toBe(1);
    expect(await verifyArtifactAdmission([profile], target, admission, async () => false, () => {})).toBe(false);
    const fake = structuredClone(admission); delete fake.artifacts[0].proof;
    Object.assign(fake.artifacts[0], { accepted: true });
    expect(await verifyArtifactAdmission([profile], target, fake, async () => true, () => {})).toBe(false);
    fake.artifacts[0].proof = { kind: 'component-unchanged', buildScope: ['prd-api/only-one-file.cs'] };
    expect(await verifyArtifactAdmission([profile], target, fake, async () => true, () => {})).toBe(false);
  });

  it('相同镜像的不同角色逐个证明其完整scope，不能借第一个角色放行', async () => {
    const { shell, profile } = reusable(); const second = { ...profile, id: 'second', buildScope: ['llmgw/**'] };
    expect(await inspectDeploymentArtifacts(shell, [profile, second], target, () => {}, {
      isComponentUnchangedSince: async (_from, _to, scope) => scope[0] === 'prd-api/**',
    })).toMatchObject({ state: 'waiting', profileIds: ['second'], artifacts: [] });
    expect(shell.commands.filter(command => command.includes('docker pull'))).toHaveLength(2);
  });

  it('比较完成后的旧资格不能发布ready', async () => {
    const { shell, profile } = reusable(); let current = true;
    await expect(inspectDeploymentArtifacts(shell, [profile], target, () => { if (!current) throw new Error('superseded'); }, {
      isComponentUnchangedSince: async () => { current = false; return true; },
    })).rejects.toThrow('superseded');
  });
});
