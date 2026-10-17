import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactAdmissionError, inspectDeploymentArtifacts, type ArtifactCheckStage } from '../../src/services/artifact-admission.js';
import { DeploymentPhaseBudget, DeploymentPhaseTimeoutError, DEPLOYMENT_PHASE_WAIT_TIMEOUT_MS, deploymentPhaseBudget } from '../../src/services/deployment-phase-budget.js';
import { ContainerService } from '../../src/services/container.js';
import { MockShellExecutor } from '../../src/services/shell-executor.js';
import type { BranchEntry, BuildProfile, CdsConfig, ServiceState } from '../../src/types.js';

const target = 'b'.repeat(40);
const profile: BuildProfile = { id: 'web', name: 'web', workDir: '.', command: '', containerPort: 8080,
  dockerImage: 'owned/web@sha256:' + 'c'.repeat(64), prebuiltImage: true, localArtifact: true };
function fixture(stage: ArtifactCheckStage) {
  const shell = new MockShellExecutor();
  shell.addResponsePattern(/docker network /, () => ({ stdout: '', stderr: '', exitCode: 0 }));
  const secret = 'DO_NOT_EXPOSE_REGISTRY_CREDENTIAL';
  shell.addResponsePattern(/docker info/, () => stage === 'daemon'
    ? { stdout: '', stderr: secret, exitCode: 1 }
    : { stdout: JSON.stringify({ Architecture: 'amd64', OSType: 'linux' }), stderr: '', exitCode: 0 });
  shell.addResponsePattern(/docker image inspect/, () => stage === 'inspect'
    ? { stdout: '', stderr: secret, exitCode: 1 }
    : { stdout: JSON.stringify([{ Id: stage === 'content-id' ? 'invalid' : 'sha256:' + 'd'.repeat(64),
      Os: 'linux', Architecture: stage === 'platform' ? 'arm64' : 'amd64',
      Config: { Labels: { 'org.opencontainers.image.revision': stage === 'revision' ? 'unknown' : stage === 'component-proof' ? 'a'.repeat(40) : target } } }]), stderr: '', exitCode: 0 });
  const records: any[] = [];
  const service = new ContainerService(shell, { dockerNetwork: 'owned', sharedEnv: {}, repoRoot: '/tmp',
    worktreeBase: '/tmp', jwt: { secret: 'synthetic', issuer: 'owned' } } as CdsConfig, undefined,
  { record: event => records.push(event) });
  const runtime: ServiceState = { profileId: 'web', containerName: 'owned-web', hostPort: 12345, status: 'building' };
  const entry: BranchEntry = { id: 'owned', projectId: 'owned', branch: 'owned', status: 'building', worktreePath: '/tmp',
    createdAt: new Date().toISOString(), githubCommitSha: target, services: { web: runtime } };
  return { shell, secret, service, records, runtime, entry };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('产物复核失败证据', () => {
  it.each([
    ['daemon', 'verification-unavailable'], ['inspect', 'verification-unavailable'],
    ['revision', 'revision-mismatch'], ['platform', 'platform-mismatch'],
    ['content-id', 'verification-unavailable'], ['component-proof', 'revision-mismatch'],
  ] as const)('%s 保留拒绝原因、操作身份，不运行容器或公开原始输出', async (stage, reason) => {
    const f = fixture(stage);
    await expect(f.service.runService(f.entry, profile, f.runtime, undefined, undefined,
      { artifactCommitSha: target, operationId: 'owned-operation', requestId: 'owned-request', actor: 'owned-operator', trigger: 'manual' })).rejects.toBeInstanceOf(ArtifactAdmissionError);
    expect(f.records).toContainEqual(expect.objectContaining({ action: 'deployment.artifact.rejected',
      operationId: 'owned-operation', requestId: 'owned-request', profileId: 'web', operationActor: 'owned-operator', operationTrigger: 'manual',
      details: { artifactAdmission: { reason, stage, targetCommitSha: target, checkedAt: expect.any(String) } } }));
    expect(JSON.stringify(f.records)).not.toContain(f.secret);
    expect(f.shell.commands.some(command => /^docker (run|create|pull|commit) /.test(command))).toBe(false);
  });
  it('完整产物准入中的仓库拒绝保持 pull 步骤，不能退化为允许启动', async () => {
    const f = fixture('pull');
    f.shell.addResponsePatternFirst(/docker pull/, () => ({ stdout: '', stderr: 'unauthorized: ' + f.secret, exitCode: 1 }));
    const result = await inspectDeploymentArtifacts(f.shell, [{ ...profile, localArtifact: false }], target);
    expect(result).toMatchObject({ state: 'waiting', reason: 'access-denied', stage: 'pull', artifacts: [] });
    expect(JSON.stringify(result)).not.toContain(f.secret);
  });
  it('未知发起人和入口保持空值，不由操作编号猜测身份', async () => {
    const f = fixture('daemon');
    await expect(f.service.runService(f.entry, profile, f.runtime, undefined, undefined,
      { artifactCommitSha: target, operationId: 'opaque-operation' })).rejects.toBeInstanceOf(ArtifactAdmissionError);
    expect(f.records).toContainEqual(expect.objectContaining({ action: 'deployment.artifact.rejected',
      operationId: 'opaque-operation', operationActor: null, operationTrigger: null }));
  });
});

describe('阶段等待超时证据与容量门禁', () => {
  it('等待队列已满不宣称未经核实的旧服务可用', async () => {
    const budget = new DeploymentPhaseBudget(() => 0);
    const controllers = Array.from({ length: 64 }, () => new AbortController());
    const pending = controllers.map(controller => budget.acquire('start', { projectId: 'owned' }, { signal: controller.signal }).catch(() => undefined));
    try {
      const error = await budget.acquire('start', { projectId: 'owned' }).catch(value => value);
      expect(error.message).toContain('部署阶段等待已满');
      expect(error.message).not.toContain('旧服务保持可用');
    } finally { controllers.forEach(controller => controller.abort()); await Promise.all(pending); }
  });
  it('只读准入快照解释实际缺口，不释放预约或改变队列', async () => {
    const budget = new DeploymentPhaseBudget(() => 2000);
    budget.reserveKnownMemory('other-runtime', 768, { projectId: 'other-project' });
    const abort = new AbortController();
    const pending = budget.acquire('start', { projectId: 'owned' }, { memoryMB: 512, signal: abort.signal }).catch(() => undefined);
    const before = budget.memorySnapshot();
    try {
      expect(budget.snapshot().start.queued[0].memoryAdmission).toEqual({
        availableMemoryMB: 2000, headroomMB: 1024, reservedMemoryMB: 768,
        requestedMemoryMB: 512, requiredMemoryMB: 2304, deficitMemoryMB: 304, allowed: false,
      });
      expect(budget.memorySnapshot()).toEqual(before);
      expect(budget.snapshot().start.active).toEqual([]);
      expect(JSON.stringify(budget.snapshot().start.queued[0].memoryAdmission)).not.toContain('other-project');
    } finally { abort.abort(); await pending; }
  });
  it('准入证据排除自己的预约，保留其他真实启动占位', async () => {
    let available = 10000;
    const budget = new DeploymentPhaseBudget(() => available, { start: 1 });
    budget.reserveKnownMemory('own', 512, {});
    const release = await budget.acquire('start', {}, { memoryMB: 256 });
    available = 1500;
    const abort = new AbortController();
    const pending = budget.acquire('start', {}, { reservationKey: 'own', memoryMB: 512, signal: abort.signal }).catch(() => undefined);
    try {
      expect(budget.snapshot().start.queued[0].memoryAdmission).toMatchObject({
        reservedMemoryMB: 256, requiredMemoryMB: 1792, deficitMemoryMB: 292, allowed: false,
      });
    } finally { abort.abort(); await pending; release(); }
  });
  it.each(['memory-headroom', 'pid-headroom', 'cpu-startup-capacity', 'phase-capacity'] as const)
  ('保留 %s 根因，不清理其他任务预约或放大限额', async reason => {
    vi.useFakeTimers();
    const budget = new DeploymentPhaseBudget(() => reason === 'memory-headroom' ? 1000 : 10000,
      { start: 1, pull: 1 }, 1024, () => reason === 'pid-headroom' ? 0 : Infinity,
      () => ({ load1: 0, cores: 18, ratio: 0, saturated: false }));
    const phase = reason === 'phase-capacity' ? 'pull' : 'start';
    let release: (() => void) | undefined;
    if (reason === 'phase-capacity') release = await budget.acquire('pull', { projectId: 'other-project' });
    if (reason === 'cpu-startup-capacity') {
      const first = await budget.acquire('start', { projectId: 'other-project' }, { reservationKey: 'other-runtime' }); first();
    }
    const failure = budget.acquire(phase, { projectId: 'owned' }, { reservationKey: 'owned-runtime', memoryMB: 512 }).catch(error => error);
    vi.advanceTimersByTime(DEPLOYMENT_PHASE_WAIT_TIMEOUT_MS + 1000);
    const error = await failure;
    expect(error).toBeInstanceOf(DeploymentPhaseTimeoutError);
    expect(error.diagnostics).toMatchObject({ phase, reason, waitedMs: expect.any(Number), limit: 1 });
    expect(JSON.stringify(error.diagnostics)).not.toMatch(/other-project|other-runtime/);
    expect(error.message).toContain('部署阶段等待超时');
    expect(error.message).not.toContain('旧服务保持可用');
    expect(budget.memorySnapshot().some(r => r.key === 'owned-runtime')).toBe(false);
    if (reason === 'cpu-startup-capacity') {
      expect(budget.memorySnapshot().map(r => r.key)).toEqual(['other-runtime']); budget.releaseMemory('other-runtime');
    }
    release?.();
  });
  it('就绪阶段超时记录可检索事件，保留原始错误与未确认回收的预约', async () => {
    const f = fixture('pull');
    const error = new DeploymentPhaseTimeoutError({ phase: 'ready', reason: 'phase-capacity', waitedMs: 1200001, active: 3,
      limit: 3, requestedMemoryMB: 0, reservedMemoryMB: 512, availableMemoryMB: null, requestedPids: 0, reservedPids: 64, availablePids: null });
    f.shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    vi.spyOn(f.service as any, 'waitForContainerAlive').mockResolvedValue(undefined);
    await f.service.runService(f.entry, profile, f.runtime, undefined, undefined,
      { artifactCommitSha: target, operationId: 'owned-operation', requestId: 'ready-request', actor: 'ready-operator', trigger: 'webhook' });
    vi.spyOn(deploymentPhaseBudget, 'run').mockRejectedValueOnce(error);
    await expect(f.service.waitForReadiness(12345, undefined, undefined, undefined, 'owned-web')).rejects.toBe(error);
    expect(f.records).toContainEqual(expect.objectContaining({ action: 'deployment.phase.wait-timeout', operationId: 'owned-operation',
      requestId: 'ready-request', operationActor: 'ready-operator', operationTrigger: 'webhook',
      details: { phaseWait: error.diagnostics } }));
    expect(deploymentPhaseBudget.memorySnapshot().map(r => r.key)).toContain('owned-web');
  });
  it('真实 runService 启动准入失败保留操作身份，不能发出 Docker 创建命令', async () => {
    const f = fixture('pull');
    f.shell.addResponsePattern(/.*/, () => ({ stdout: '', stderr: '', exitCode: 0 }));
    const error = new DeploymentPhaseTimeoutError({ phase: 'start', reason: 'memory-headroom', waitedMs: 1200001,
      active: 0, limit: 3, requestedMemoryMB: 512, reservedMemoryMB: 512, availableMemoryMB: 1500,
      requestedPids: 64, reservedPids: 64, availablePids: null });
    vi.spyOn(deploymentPhaseBudget, 'acquire').mockRejectedValueOnce(error);
    await expect(f.service.runService(f.entry, profile, f.runtime, undefined, undefined,
      { artifactCommitSha: target, operationId: 'owned-operation', requestId: 'owned-request', actor: 'owned-operator', trigger: 'manual' })).rejects.toBe(error);
    expect(f.records).toContainEqual(expect.objectContaining({ action: 'deployment.phase.wait-timeout',
      operationId: 'owned-operation', requestId: 'owned-request', operationActor: 'owned-operator', operationTrigger: 'manual',
      details: { phaseWait: error.diagnostics } }));
    expect(f.shell.commands.some(command => /^docker (run|create) /.test(command))).toBe(false);
  });
});
