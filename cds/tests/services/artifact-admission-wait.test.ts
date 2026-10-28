import { describe, expect, it } from 'vitest';
import { BranchOperationCoordinator, pendingDeployBody } from '../../src/services/branch-operation-coordinator.js';
import { refreshArtifactWaiters, registerArtifactWaitRefresher, requestArtifactWaitRefresh } from '../../src/services/artifact-admission-wait.js';
import type { DeploymentInputSnapshot } from '../../src/services/deployment-input.js';
import type { ArtifactAdmission } from '../../src/services/artifact-admission.js';
import type { BranchEntry } from '../../src/types.js';

const target = 'b'.repeat(40);
const branch: BranchEntry = { id: 'b', projectId: 'p', branch: 'feature/b', worktreePath: '/tmp/b', status: 'running', createdAt: '2026-10-11', services: {} };
const waiting: ArtifactAdmission = { state: 'waiting', targetCommitSha: target, checkedAt: '', reason: 'missing', artifacts: [] };
function fixture() {
  const coordinator = new BranchOperationCoordinator();
  const request = { branchId: 'b', projectId: 'p', kind: 'deploy' as const, trigger: 'manual' as const, source: 'api.deploy-branch',
    actor: 'original-actor', commitSha: target, commitPinned: true, configHash: 'cfg' };
  const decision = coordinator.begin(request, { waitForArtifacts: true });
  const input: DeploymentInputSnapshot = { profiles: [{ id: 'api', name: 'API', dockerImage: `ghcr.io/owned/api:sha-${target}`,
    prebuiltImage: true, workDir: '.', command: '', containerPort: 3000 }], configuredEnv: { SECRET: 'private' },
    profileOverrides: undefined, ciTargetSha: target, targetCommitSha: target, configHash: 'cfg', artifactAdmission: waiting };
  coordinator.rememberDeploymentInput(decision.operationId, decision.generation, input);
  return { coordinator, request, decision, input };
}

describe('原任务的产物等待与领取', () => {
  it.each(['manual', 'webhook'] as const)('实时快照%s请求不排产物等待，不并入或覆盖在途操作', trigger => {
    const coordinator = new BranchOperationCoordinator();
    const request = { branchId: 'b', projectId: 'p', kind: 'deploy' as const, trigger,
      commitSha: target, commitPinned: true, configHash: 'cfg', hasOneShotOptions: true };
    expect(coordinator.begin(request, { waitForArtifacts: true, requireImmediate: true }).status).toBe('rejected');
    expect(coordinator.getArtifactWaiters()).toEqual([]); expect(coordinator.getActiveOperations()).toEqual([]);
    const active = coordinator.begin({ ...request, trigger: 'manual', hasOneShotOptions: false });
    expect(active.status).toBe('started');
    expect(coordinator.begin(request, { requireImmediate: true }).status).toBe('rejected');
    expect(coordinator.getPendingWebhookDeploy('b')).toBeUndefined(); expect(active.lease!.isCurrent()).toBe(true);
    coordinator.completeAll(active.lease!, 'completed');
    expect(coordinator.begin(request, { requireImmediate: true }).status).toBe('started');
  });
  it('未执行的原操作进入等待，不占分支执行租约且常规drain不能提前领取', () => {
    const { coordinator, decision, request } = fixture();
    expect(decision.status).toBe('merged'); expect(coordinator.getActiveOperations()).toHaveLength(0);
    expect(coordinator.drainReady()).toEqual([]);
    expect(coordinator.begin(request, { waitForArtifacts: true })).toMatchObject({ status: 'joined', operationId: decision.operationId, generation: decision.generation });
    expect(coordinator.getArtifactWaiters()).toHaveLength(1);
  });

  it('部分产物保持等待，全部确认后重放仍使用原身份、原范围、原来源和原配置', async () => {
    const { coordinator, decision } = fixture(); let available = false;
    const options = { coordinator, getBranch: () => branch, recheckMs: 0, containerService: {
      inspectDeploymentArtifacts: async (): Promise<ArtifactAdmission> => ({ ...waiting, state: available ? 'ready' : 'waiting' }) } };
    expect(await refreshArtifactWaiters(options)).toEqual([]);
    available = true; const [pending] = await refreshArtifactWaiters(options);
    expect(pending).toMatchObject({ operationId: decision.operationId, generation: decision.generation, request: { actor: 'original-actor', source: 'api.deploy-branch' } });
    expect(pendingDeployBody(pending).pendingReplay).toEqual({ operationId: decision.operationId, generation: decision.generation });
    const replay = { ...pending.request, pendingReplay: { operationId: pending.operationId, generation: pending.generation } };
    expect(coordinator.getDeploymentInputForReplay(replay)?.configuredEnv).toEqual({ SECRET: 'private' });
    expect(coordinator.begin(replay)).toMatchObject({ status: 'started', operationId: decision.operationId, generation: decision.generation });
    expect(await refreshArtifactWaiters(options)).toEqual([]);
  });

  it.each(['stop', 'new-target'] as const)('复核期间%s使旧目标失效，迟到成功不能恢复', async (action) => {
    const { coordinator, request, input } = fixture(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const round = refreshArtifactWaiters({ coordinator, getBranch: () => branch, containerService: {
      inspectDeploymentArtifacts: async (): Promise<ArtifactAdmission> => { entered(); await gate; return { ...waiting, state: 'ready' }; } } });
    await started;
    if (action === 'stop') coordinator.begin({ branchId: 'b', projectId: 'p', kind: 'stop', trigger: 'manual' });
    else {
      const newer = coordinator.begin({ ...request, commitSha: 'c'.repeat(40) }, { waitForArtifacts: true });
      coordinator.rememberDeploymentInput(newer.operationId, newer.generation, { ...input, targetCommitSha: 'c'.repeat(40),
        artifactAdmission: { ...waiting, targetCommitSha: 'c'.repeat(40) } });
    }
    release(); expect(await round).toEqual([]);
    expect(coordinator.getArtifactWaiters().some(item => item.pending.request.commitSha === target)).toBe(false);
  });

  it('复核结果不能借同一操作身份改写目标或已受理私有配置', () => {
    const { coordinator } = fixture(); const [{ pending }] = coordinator.getArtifactWaiters();
    expect(coordinator.updateArtifactWaiter(pending, { ...waiting, state: 'ready', targetCommitSha: 'c'.repeat(40) })).toBe(false);
    expect(coordinator.drainReady()).toEqual([]);
    expect(coordinator.getArtifactWaiters()[0].input.configuredEnv).toEqual({ SECRET: 'private' });
  });

  it('超过单轮上限时只复制有限私有输入，并在后续轮次覆盖其他任务', async () => {
    const { coordinator, input, request } = fixture();
    for (let index = 1; index < 20; index++) {
      const decision = coordinator.begin({ ...request, branchId: `b${index}` }, { waitForArtifacts: true });
      coordinator.rememberDeploymentInput(decision.operationId, decision.generation, input);
    }
    expect(coordinator.getArtifactWaiters()).toHaveLength(16);
    const visited: string[] = [];
    const options = { coordinator, getBranch: (id: string) => ({ ...branch, id }), recheckMs: 0,
      containerService: { inspectDeploymentArtifacts: async (): Promise<ArtifactAdmission> => waiting },
      inspect: async (pending: any): Promise<ArtifactAdmission> => { visited.push(pending.branchId); return waiting; } };
    await refreshArtifactWaiters(options); expect(visited).toHaveLength(16);
    await refreshArtifactWaiters(options); expect(new Set(visited).size).toBe(20);
  });

  it('周期调用合并成同一轮，实际派发仅一次，并保留重试间隔', async () => {
    const { coordinator } = fixture(); let checks = 0; let now = 100;
    const options = { coordinator, now: () => now, getBranch: () => branch, containerService: {
      inspectDeploymentArtifacts: async (): Promise<ArtifactAdmission> => { checks++; return waiting; } } };
    let rounds = 0;
    registerArtifactWaitRefresher(coordinator, async () => { rounds++; await refreshArtifactWaiters(options); });
    const first = requestArtifactWaitRefresh(coordinator); const second = requestArtifactWaitRefresh(coordinator);
    expect(first).toBe(second); await first; expect(rounds).toBe(1); expect(checks).toBe(1);
    await requestArtifactWaitRefresh(coordinator); expect(checks).toBe(1);
    now += 30_000; await requestArtifactWaitRefresh(coordinator); expect(checks).toBe(2);
  });
});
