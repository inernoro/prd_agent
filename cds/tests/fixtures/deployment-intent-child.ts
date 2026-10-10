import { StateService } from '../../src/services/state.js';
import { DeploymentRunService } from '../../src/services/deployment-run.js';
import { BranchOperationCoordinator, pendingDeployBody } from '../../src/services/branch-operation-coordinator.js';
import { captureDeploymentInput } from '../../src/services/deployment-input.js';
import type { BranchOperationRequest } from '../../src/services/branch-operation-coordinator.js';

// 父进程只操作本用例临时文件；SIGKILL 不触发 graceful shutdown 或测试内存共享。
const [, , file, mode] = process.argv;
const state = new StateService(file); state.load();
const runs = new DeploymentRunService(state, { idFactory: () => 'dr_child' });
const coordinator = new BranchOperationCoordinator();
if (mode === 'accept') {
  if (!state.getProject('p')) state.addProject({ id: 'p', name: 'P', slug: 'p' } as any);
  if (!state.getBranch('b')) state.addBranch({ id: 'b', projectId: 'p', branch: 'main', worktreePath: '/unused', status: 'idle', createdAt: new Date().toISOString(), services: {} });
  coordinator.begin({ projectId: 'p', branchId: 'b', kind: 'deploy', trigger: 'manual' });
  const request: BranchOperationRequest = { projectId: 'p', branchId: 'b', kind: 'deploy-profile', profileId: 'api',
    trigger: 'webhook', actor: 'original-agent', commitSha: 'b'.repeat(40), commitPinned: true, configHash: 'cfg' };
  const decision = coordinator.begin(request);
  const input = captureDeploymentInput(state.getBranch('b')!, [{ id: 'api', projectId: 'p', name: 'API', dockerImage: 'node', workDir: '.', containerPort: 3000, command: 'node original.js' }], { TOKEN: 'synthetic-child-secret' });
  input.configHash = 'cfg'; input.agentPrebuiltGated = true;
  const run = await runs.begin({ projectId: 'p', branchId: 'b', profileId: 'api', trigger: 'webhook', initialStatus: 'queued',
    operationId: decision.operationId, operationGeneration: decision.generation, commitSha: request.commitSha, configHash: 'cfg', executionInput: { request, input } });
  process.send?.({ phase: 'accepted', runId: run.id, operationId: run.operationId, generation: run.operationGeneration });
} else {
  const restored = runs.restoreQueued(coordinator);
  const pending = coordinator.drainReady()[0];
  if (mode === 'claim' && pending) {
    const request = { ...pending.request, pendingReplay: pendingDeployBody(pending).pendingReplay as BranchOperationRequest['pendingReplay'] };
    const input = coordinator.getDeploymentInputForReplay(request)!;
    const decision = coordinator.begin(request);
    if (decision.status !== 'started') throw new Error('Recovered intent was not claimable');
    await runs.claimQueued(restored[0].id);
    process.send?.({ phase: 'claimed', runId: restored[0].id, operationId: pending.operationId, generation: pending.generation,
      command: input.profiles[0].command, secretPreserved: input.configuredEnv.TOKEN === 'synthetic-child-secret',
      prebuiltGated: input.agentPrebuiltGated, runCount: runs.list().length });
  } else {
    runs.reconcileOrphanedByRestart(new Date('2099-01-01T00:00:00Z'));
    await runs.flush();
    process.send?.({ phase: 'restarted', restored: restored.length, pending: !!pending, runCount: runs.list().length, status: runs.get('dr_child')?.status });
  }
}
setInterval(() => {}, 1000);
