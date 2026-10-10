import { describe, expect, it, vi } from 'vitest';
import { BranchOperationCoordinator, pendingDeployBody } from '../../src/services/branch-operation-coordinator.js';
import type { BranchOperationRequest } from '../../src/services/branch-operation-coordinator.js';

const target = (profileId?: string): BranchOperationRequest => ({
  projectId: 'p', branchId: 'b', profileId, kind: profileId ? 'deploy-profile' : 'deploy',
  trigger: 'webhook', actor: 'original-actor', requestId: 'original-request', source: 'original-source',
  commitSha: 'b'.repeat(40), commitPinned: true, configHash: 'config-b',
});

function claim(profileId?: string) {
  const coordinator = new BranchOperationCoordinator();
  const active = coordinator.begin({ projectId: 'p', branchId: 'b', kind: 'deploy', trigger: 'manual' });
  coordinator.begin(target(profileId));
  const pending = coordinator.completeAll(active.lease!, 'completed')[0];
  const replay = { ...target(profileId), pendingReplay: { operationId: pending.operationId, generation: pending.generation } };
  return { coordinator, pending, replay };
}

describe('待办HTTP重放的身份与代次', () => {
  it('消费一次原操作身份和来源，不允许通过重放提高优先级或更换施动者', () => {
    const { coordinator, pending, replay } = claim();
    const accepted = coordinator.begin({ ...replay, trigger: 'manual', actor: 'replacement', source: 'replacement' });
    expect(accepted.status).toBe('started');
    expect(accepted.operationId).toBe(pending.operationId);
    expect(accepted.generation).toBe(pending.generation);
    expect(accepted.lease!.request).toMatchObject({ trigger: 'webhook', actor: 'original-actor', source: 'original-source' });
    expect(coordinator.begin(replay).status).toBe('rejected');
    expect(accepted.lease!.isCurrent()).toBe(true);
  });

  it('错误的范围、提交、配置、版本和一次性选项不能消费真实待办', () => {
    const { coordinator, replay } = claim('api');
    const mutations: Partial<BranchOperationRequest>[] = [
      { projectId: 'other' }, { profileId: 'web' }, { commitSha: 'c'.repeat(40) },
      { commitPinned: false }, { configHash: 'config-c' }, { versionId: 'other-version' }, { hasOneShotOptions: true },
      { pendingReplay: { ...replay.pendingReplay, generation: replay.pendingReplay.generation + 1 } },
      { pendingReplay: { operationId: 'unknown-operation', generation: replay.pendingReplay.generation } },
    ];
    for (const change of mutations) expect(coordinator.begin({ ...replay, ...change }).status).toBe('rejected');
    expect(coordinator.begin(replay).status).toBe('started');
  });

  it('新目标进入待办后，迟到重放不能覆盖它', () => {
    const { coordinator, replay } = claim();
    const web = coordinator.begin({ ...target('web'), trigger: 'manual' });
    const latest = coordinator.begin({ ...target(), commitSha: 'c'.repeat(40) });
    expect(latest.status).toBe('merged');
    expect(coordinator.begin(replay).status).toBe('rejected');
    expect(coordinator.getPendingWebhookDeploy('b')?.request.commitSha).toBe('c'.repeat(40));
    expect(web.lease!.isCurrent()).toBe(true);
  });

  it('一个服务的新目标不撤销其他服务的重放凭据', () => {
    const coordinator = new BranchOperationCoordinator();
    const active = coordinator.begin({ projectId: 'p', branchId: 'b', kind: 'deploy', trigger: 'manual' });
    coordinator.begin(target('api'));
    coordinator.begin(target('web'));
    const [api, web] = coordinator.completeAll(active.lease!, 'completed');
    coordinator.begin({ ...target('api'), trigger: 'manual', commitSha: 'c'.repeat(40) });
    expect(coordinator.begin({ ...web.request, pendingReplay: pendingDeployBody(web).pendingReplay as BranchOperationRequest['pendingReplay'] }).status).toBe('started');
    expect(coordinator.begin({ ...api.request, pendingReplay: pendingDeployBody(api).pendingReplay as BranchOperationRequest['pendingReplay'] }).status).toBe('rejected');
  });

  it('未点名提交的请求在重放时仍读取当时的HEAD，不把缓存SHA伪装成固定目标', () => {
    const coordinator = new BranchOperationCoordinator();
    const active = coordinator.begin({ projectId: 'p', branchId: 'b', kind: 'deploy', trigger: 'manual' });
    coordinator.begin({ ...target(), commitPinned: false });
    const pending = coordinator.completeAll(active.lease!, 'completed')[0];
    expect(pendingDeployBody(pending).commitSha).toBeUndefined();
    const accepted = coordinator.begin({ ...pending.request, commitSha: 'c'.repeat(40),
      pendingReplay: { operationId: pending.operationId, generation: pending.generation } });
    expect(accepted.status).toBe('started');
    expect(accepted.lease!.request.commitPinned).toBe(false);
  });

  it('过期或派发失败的凭据不能再启动部署', () => {
    const first = claim();
    first.coordinator.releasePendingReplay(first.pending, 'transport failed');
    expect(first.coordinator.begin(first.replay).status).toBe('rejected');
    const second = claim();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    try { expect(second.coordinator.begin(second.replay).status).toBe('rejected'); }
    finally { clock.mockRestore(); }
  });
});
