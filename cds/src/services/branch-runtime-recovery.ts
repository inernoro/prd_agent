import { randomUUID } from 'node:crypto';
import type { BranchEntry, BuildProfile, ServiceState } from '../types.js';
import type { ContainerService } from './container.js';
import type { StateService } from './state.js';
import { branchAppNetworkName } from './branch-network.js';
import { pinServingRuntimeDuringCommit, runtimeRef, servingRuntime } from './service-runtime.js';

/** 恢复已经创建的同一批容器，不重新创建数据库、不改写历史部署结果。 */
export async function recoverBranchRuntime(options: {
  entry: BranchEntry; profiles: BuildProfile[]; state: StateService;
  container: Pick<ContainerService, 'inspectOwnedRuntime' | 'connectReplacementPeer' | 'isolateReplacementPeer' | 'restartServiceInPlace' | 'waitForReadiness' | 'waitForStartupSignal'>;
  expectedCommitSha: string; expectedContainers: Record<string, string>; restartProfiles: string[];
  assertCurrent: (step: string) => void; onProgress?: (message: string) => void;
}): Promise<{ network: string; profiles: string[] }> {
  const { entry, profiles, state, container, assertCurrent } = options;
  const check = (step: string) => {
    assertCurrent(step);
    if (!/^[a-f0-9]{40}$/.test(options.expectedCommitSha) || entry.githubCommitSha !== options.expectedCommitSha)
      throw new Error('恢复目标提交已变化，拒绝操作');
    const ids = Object.keys(entry.services).sort();
    if (ids.join('|') !== Object.keys(options.expectedContainers).sort().join('|') || ids.join('|') !== profiles.map(p => p.id).sort().join('|'))
      throw new Error('恢复服务范围已变化，拒绝操作');
    for (const id of ids) if (!/^[a-f0-9]{64}$/.test(options.expectedContainers[id]) || entry.services[id].containerId !== options.expectedContainers[id])
      throw new Error(`恢复容器身份已变化: ${id}`);
  };
  check('runtime recovery preflight');
  if (options.restartProfiles.some(id => !profiles.some(p => p.id === id))) throw new Error('重启清单包含范围外服务');
  const original = new Map<string, ServiceState>();
  const candidates = new Map<string, ServiceState>();
  for (const profile of profiles) {
    const service = entry.services[profile.id];
    const actual = await container.inspectOwnedRuntime(entry, profile.id, runtimeRef(service));
    check(`runtime recovery identity ${profile.id}`);
    if (!actual || actual.containerId !== options.expectedContainers[profile.id]) throw new Error(`当前候选未运行或归属未确认: ${profile.id}`);
    original.set(profile.id, service);
    candidates.set(profile.id, { ...service, ...actual });
  }
  const network = `${branchAppNetworkName(entry.id).slice(0, 27)}-r-${randomUUID().replaceAll('-', '')}`;
  entry.replacementNetworks = [...new Set([...(entry.replacementNetworks || []), network])];
  state.save([{ kind: 'branches', id: entry.id }]); await state.flush();
  for (const profile of profiles) {
    check(`runtime recovery connect ${profile.id}`);
    options.onProgress?.(`核对并接续当前容器网络: ${profile.name}`);
    await container.connectReplacementPeer(entry, profile, candidates.get(profile.id)!, network, check);
  }
  // 所有当前容器先接入同一张独占网，再摘除它们的旧分支网；历史容器与共享网不动。
  for (const profile of profiles) {
    check(`runtime recovery isolate ${profile.id}`);
    await container.isolateReplacementPeer(entry, candidates.get(profile.id)!, network, check);
  }
  for (const id of options.restartProfiles) {
    check(`runtime recovery restart ${id}`);
    options.onProgress?.(`刷新应用连接: ${id}`);
    if (!await container.restartServiceInPlace(candidates.get(id)!.containerId!, undefined,
      { branchId: entry.id, projectId: entry.projectId, profileId: id, operation: 'runtime-recovery', source: 'branch-runtime-recovery', assertCurrent: check }))
      throw new Error(`应用原地重启失败: ${id}`);
  }
  for (const profile of profiles) {
    check(`runtime recovery readiness ${profile.id}`);
    const service = candidates.get(profile.id)!;
    options.onProgress?.(`验证实际就绪: ${profile.name}`);
    const ready = profile.startupSignal
      ? await container.waitForStartupSignal(service.containerName, profile.startupSignal, undefined, 120)
      : await container.waitForReadiness(service.hostPort,
        { ...profile.readinessProbe, timeoutSeconds: 120, intervalSeconds: 2 }, undefined, undefined, service.containerName);
    check(`runtime recovery ready ${profile.id}`);
    if (!ready) throw new Error(`当前容器未通过就绪验证: ${profile.id}`);
  }
  const previousStatus = entry.status, previousError = entry.errorMessage;
  const releases: Array<() => void> = [];
  try {
    for (const [id, service] of candidates) {
      const old = original.get(id)!;
      service.retainedRuntimes = [...(old.retainedRuntimes || []),
        ...(old.servingRuntime && old.servingRuntime.containerName !== service.containerName ? [runtimeRef(old.servingRuntime)] : []),
        ...(old.pendingRuntime && old.pendingRuntime.containerName !== service.containerName ? [runtimeRef(old.pendingRuntime)] : [])];
      service.servingRuntime = servingRuntime(old) || undefined;
      releases.push(pinServingRuntimeDuringCommit(service));
      service.servingRuntime = runtimeRef(service); service.pendingRuntime = undefined;
      service.status = 'running'; service.errorMessage = undefined;
      entry.services[id] = service;
    }
    entry.status = 'running'; entry.errorMessage = undefined;
    state.save([{ kind: 'branches', id: entry.id }]); await state.flush();
    check('runtime recovery publication');
  } catch (error) {
    for (const [id, service] of original) if (entry.services[id] === candidates.get(id)) entry.services[id] = service;
    entry.status = previousStatus; entry.errorMessage = previousError;
    state.save([{ kind: 'branches', id: entry.id }]);
    throw error;
  } finally { releases.forEach(release => release()); }
  return { network, profiles: profiles.map(p => p.id) };
}
