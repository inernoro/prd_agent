import type { BranchEntry } from '../types.js';
import type { BranchOperationCoordinator, PendingWebhookDeploy } from './branch-operation-coordinator.js';
import { BranchOperationSupersededError } from './branch-operation-coordinator.js';
import type { DeploymentInputSnapshot } from './deployment-input.js';
import { deploymentInputBranch } from './deployment-input.js';
import { resolveEffectiveProfile, type ContainerService } from './container.js';
import type { ArtifactAdmission } from './artifact-admission.js';

interface WaitRefreshState {
  running?: Promise<PendingWebhookDeploy[]>;
  lastChecks: Map<string, number>;
  cursor: number;
}
const refreshStates = new WeakMap<BranchOperationCoordinator, WaitRefreshState>();

/** 只做有界复核；等待期间没有分支执行租约，不能依靠旧lease授权命令。 */
export function refreshArtifactWaiters(options: {
  coordinator: BranchOperationCoordinator;
  containerService: Pick<ContainerService, 'inspectDeploymentArtifacts'>;
  getBranch: (id: string) => BranchEntry | undefined;
  inspect?: (pending: PendingWebhookDeploy, input: DeploymentInputSnapshot, branch: BranchEntry, assertCurrent: () => void) => Promise<ArtifactAdmission>;
  onChecked?: (pending: PendingWebhookDeploy, previous: ArtifactAdmission, result: ArtifactAdmission) => void;
  now?: () => number;
  recheckMs?: number;
  limit?: number;
}): Promise<PendingWebhookDeploy[]> {
  const { coordinator } = options;
  let state = refreshStates.get(coordinator);
  if (!state) { state = { lastChecks: new Map(), cursor: 0 }; refreshStates.set(coordinator, state); }
  if (state.running) return state.running;
  const round = state;
  const keyOf = (pending: PendingWebhookDeploy) => JSON.stringify([pending.operationId, pending.generation]);
  const now = options.now || (() => performance.now());
  const promise = (async () => {
    const keys = coordinator.getArtifactWaiterKeys();
    const live = new Set(keys);
    for (const key of round.lastChecks.keys()) if (!live.has(key)) round.lastChecks.delete(key);
    const limit = Math.max(1, Math.min(16, options.limit || 16));
    const start = keys.length ? round.cursor % keys.length : 0;
    const waiters = coordinator.getArtifactWaiters(limit, start);
    round.cursor = start + waiters.length;
    for (let offset = 0; offset < waiters.length; offset++) {
      const item = waiters[offset];
      const key = keyOf(item.pending);
      if (round.lastChecks.has(key) && now() - round.lastChecks.get(key)! < (options.recheckMs ?? 30_000)) continue;
      round.lastChecks.set(key, now());
      const assertCurrent = () => {
        const branch = options.getBranch(item.pending.branchId);
        if (!coordinator.isArtifactWaiterCurrent(item.pending) || !branch
          || (branch.projectId || 'default') !== (item.pending.request.projectId || 'default')) {
          throw new BranchOperationSupersededError(item.pending.operationId, item.pending.branchId, 'artifact-admission');
        }
      };
      try {
        assertCurrent();
        const branch = options.getBranch(item.pending.branchId)!;
        const profiles = item.input.profiles.filter(profile => !item.pending.request.profileId || profile.id === item.pending.request.profileId)
          .map(profile => resolveEffectiveProfile(profile, deploymentInputBranch(item.input, branch)));
        const result = options.inspect
          ? await options.inspect(item.pending, item.input, branch, assertCurrent)
          : await options.containerService.inspectDeploymentArtifacts(profiles, item.input.artifactAdmission!.targetCommitSha, assertCurrent);
        assertCurrent();
        if (coordinator.updateArtifactWaiter(item.pending, result)) options.onChecked?.(item.pending, item.input.artifactAdmission!, result);
      } catch {
        // 资格变化不恢复旧任务；读取错误保留原等待，不能猜成ready或启动源码编译。
      }
    }
    return coordinator.drainReady(undefined, undefined, limit);
  })();
  round.running = promise;
  void promise.finally(() => { if (round.running === promise) round.running = undefined; });
  return promise;
}


const registeredRefreshers = new WeakMap<BranchOperationCoordinator, () => Promise<void>>();
const registeredRounds = new WeakMap<BranchOperationCoordinator, Promise<void>>();

export function registerArtifactWaitRefresher(coordinator: BranchOperationCoordinator, refresh: () => Promise<void>): void {
  registeredRefreshers.set(coordinator, refresh);
}

/** 初次受理与周期巡检共享同一轮，派发回执只消费一次。 */
export function requestArtifactWaitRefresh(coordinator: BranchOperationCoordinator): Promise<void> {
  const active = registeredRounds.get(coordinator);
  if (active) return active;
  const refresh = registeredRefreshers.get(coordinator);
  if (!refresh) return Promise.resolve();
  const round = Promise.resolve().then(refresh).catch(() => {});
  registeredRounds.set(coordinator, round);
  void round.finally(() => { if (registeredRounds.get(coordinator) === round) registeredRounds.delete(coordinator); });
  return round;
}
