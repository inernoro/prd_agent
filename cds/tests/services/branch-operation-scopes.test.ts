import { describe, expect, it } from 'vitest';
import { BranchOperationCoordinator } from '../../src/services/branch-operation-coordinator.js';

describe('分支待办的项目与服务范围', () => {
  it('同服务只保留最新提交，其他服务的待办不会被覆盖', () => {
    const coordinator = new BranchOperationCoordinator();
    const active = coordinator.begin({ branchId: 'main', projectId: 'p1', kind: 'deploy', trigger: 'manual' });
    const enqueue = (profileId: string, commitSha: string) => coordinator.begin({
      branchId: 'main', projectId: 'p1', profileId, commitSha, kind: 'deploy-profile', trigger: 'webhook',
    });
    enqueue('api', 'a'.repeat(40));
    enqueue('web', 'b'.repeat(40));
    enqueue('api', 'c'.repeat(40));
    expect(coordinator.getPendingWebhookDeploy('main', 'web')?.request.commitSha).toBe('b'.repeat(40));
    const pending = coordinator.completeAll(active.lease!, 'completed');
    expect(pending.map(item => [item.request.profileId, item.request.commitSha, item.mergedCount]))
      .toEqual([['api', 'c'.repeat(40), 2], ['web', 'b'.repeat(40), 1]]);
    expect(coordinator.completeAll(active.lease!, 'completed')).toEqual([]);
  });

  it('相同分支名称属于不同项目时，活动操作与待办均独立', () => {
    const coordinator = new BranchOperationCoordinator();
    const first = coordinator.begin({ branchId: 'main', projectId: 'p1', kind: 'deploy', trigger: 'manual' });
    const second = coordinator.begin({ branchId: 'main', projectId: 'p2', kind: 'deploy', trigger: 'manual' });
    expect(second.status).toBe('started');
    for (const projectId of ['p1', 'p2']) coordinator.begin({ branchId: 'main', projectId, kind: 'deploy', trigger: 'webhook' });
    expect(coordinator.completeAll(first.lease!, 'completed').map(item => item.request.projectId)).toEqual(['p1']);
    expect(second.lease!.isCurrent()).toBe(true);
    expect(coordinator.completeAll(second.lease!, 'completed').map(item => item.request.projectId)).toEqual(['p2']);
  });

  it('两个服务的强制重建续约各自保留，互不覆盖', () => {
    const coordinator = new BranchOperationCoordinator();
    const force = (profileId: string) => coordinator.begin({ branchId: 'main', projectId: 'p1', profileId,
      kind: 'force-rebuild', trigger: 'manual', continueWith: 'deploy-profile' });
    const api = force('api');
    const web = force('web');
    coordinator.completeAll(api.lease!, 'completed');
    coordinator.completeAll(web.lease!, 'completed');
    const resume = (profileId: string) => coordinator.begin({ branchId: 'main', projectId: 'p1', profileId,
      kind: 'deploy-profile', trigger: 'manual' });
    expect(resume('api').operationId).toBe(api.operationId);
    expect(resume('web').operationId).toBe(web.operationId);
  });

  it('整分支停止会撤销该项目全部服务续约与待办，不影响另一项目', () => {
    const coordinator = new BranchOperationCoordinator();
    for (const profileId of ['api', 'web']) {
      const force = coordinator.begin({ branchId: 'main', projectId: 'p1', profileId,
        kind: 'force-rebuild', trigger: 'manual', continueWith: 'deploy-profile' });
      coordinator.completeAll(force.lease!, 'completed');
      coordinator.begin({ branchId: 'main', projectId: 'p1', profileId, kind: 'deploy-profile', trigger: 'webhook' });
    }
    const other = coordinator.begin({ branchId: 'main', projectId: 'p2', kind: 'deploy', trigger: 'manual' });
    coordinator.begin({ branchId: 'main', projectId: 'p2', kind: 'deploy', trigger: 'webhook' });
    const stop = coordinator.begin({ branchId: 'main', projectId: 'p1', kind: 'stop', trigger: 'manual' });
    expect(stop.status).toBe('started');
    expect(coordinator.completeAll(stop.lease!, 'completed')).toEqual([]);
    expect(other.lease!.isCurrent()).toBe(true);
    expect(coordinator.completeAll(other.lease!, 'completed')).toHaveLength(1);
  });
});
