import { randomUUID } from 'node:crypto';
import type { BranchEntry, BuildProfile, ServiceState } from '../types.js';
import type { ContainerService } from './container.js';
import type { StateService } from './state.js';
import { branchAppNetworkName } from './branch-network.js';
import { pinServingRuntimeDuringCommit, runtimeRef, servingRuntime } from './service-runtime.js';

/** 恢复已经创建的同一批容器，不重新创建数据库、不改写历史部署结果。 */
export async function recoverBranchRuntime(options: {
  entry: BranchEntry; profiles: BuildProfile[]; state: StateService;
  container: Pick<ContainerService, 'inspectOwnedRuntime' | 'connectReplacementPeer' | 'isolateReplacementPeer' | 'restartServiceInPlace' | 'waitForReadiness' | 'waitForStartupSignal' | 'cleanupUnusedReplacementNetworks'>;
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
  const prefix = `${branchAppNetworkName(entry.id).slice(0, 27)}-r-`;
  const networks = (service: Pick<ServiceState, 'networkName' | 'aliasNetworks' | 'connectedNetworks'>) => [service.networkName, ...(service.aliasNetworks || []), ...(service.connectedNetworks || [])].filter((name): name is string => Boolean(name));
  const servingNetworks = new Set([...original.values()].flatMap(service => {
    const active = servingRuntime(service);
    return active ? networks(active) : [];
  }));
  const protectedNetworks = new Set([...servingNetworks, ...[...candidates.values()].flatMap(networks)]);
  // 共同归属仍由connectReplacementPeer逐容器实读核验；同批恢复复用现网，不重复分配。
  const firstCandidate = candidates.values().next().value;
  const common = firstCandidate && networks(firstCandidate).find(name => name.startsWith(prefix)
    && /^[a-f0-9]{32}$/.test(name.slice(prefix.length)) && entry.replacementNetworks?.includes(name)
    && [...candidates.values()].every(service => networks(service).includes(name)));
  const network = common || `${prefix}${randomUUID().replaceAll('-', '')}`;
  let published = false;
  const cleanupNetworks = async (failed: boolean) => {
    check('runtime recovery network cleanup');
    const selected = failed ? (common ? [] : [network])
      : (entry.replacementNetworks || []).filter(name => !servingNetworks.has(name));
    if (!selected.length && failed) return;
    const view = { ...entry, replacementNetworks: selected,
      services: failed ? Object.fromEntries([...original].map(([id, service]) => [id, { ...service,
        connectedNetworks: [...new Set([...(service.connectedNetworks || []), ...(candidates.get(id)?.connectedNetworks || [])])],
        aliasNetworks: [...new Set([...(service.aliasNetworks || []), ...(candidates.get(id)?.aliasNetworks || [])])],
      }])) : entry.services };
    await container.cleanupUnusedReplacementNetworks(view, { branchId: entry.id, projectId: entry.projectId,
      operation: 'runtime-recovery', source: 'branch-runtime-recovery', assertCurrent: check });
    check('runtime recovery network cleanup confirmed');
    entry.replacementNetworks = entry.replacementNetworks?.filter(name => !selected.includes(name) || view.replacementNetworks.includes(name));
    state.save([{ kind: 'branches', id: entry.id }]); await state.flush();
    check('runtime recovery network cleanup persisted');
  };
  try {
    entry.replacementNetworks = [...new Set([...(entry.replacementNetworks || []), network])];
    state.save([{ kind: 'branches', id: entry.id }]); await state.flush();
    for (const profile of profiles) {
      check(`runtime recovery connect ${profile.id}`);
      options.onProgress?.(`核对并接续当前容器网络: ${profile.name}`);
      await container.connectReplacementPeer(entry, profile, candidates.get(profile.id)!, network, check);
    }
    // 未发布前旧入口仍可能通过共用数据库服务；这些网络和共享网均保持连接。
    for (const profile of profiles) {
      check(`runtime recovery isolate ${profile.id}`);
      await container.isolateReplacementPeer(entry, candidates.get(profile.id)!, network, check, [...protectedNetworks]);
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
      // 停止等继任操作会原位更新候选；已失去租约的恢复不得回写这些状态。
      try { assertCurrent('runtime recovery rollback'); }
      catch { throw error; }
      for (const [id, service] of original) if (entry.services[id] === candidates.get(id)) entry.services[id] = service;
      entry.status = previousStatus; entry.errorMessage = previousError;
      state.save([{ kind: 'branches', id: entry.id }]);
      throw error;
    } finally { releases.forEach(release => release()); }
    published = true;
    await cleanupNetworks(false);
    return { network, profiles: profiles.map(p => p.id) };
  } catch (error) {
    if (!published) {
      try { await cleanupNetworks(true); }
      catch { options.onProgress?.('恢复未完成，未确认网络仍保留回收责任，请查看当前操作结果'); }
    }
    throw error;
  }
}
