import { randomUUID } from 'node:crypto';
import type { BranchEntry, BuildProfile, ServiceState } from '../types.js';
import type { StateService } from './state.js';
import type { ContainerService } from './container.js';
import { branchAppNetworkName } from './branch-network.js';
import { runtimeRef, serviceRuntimeRefs, servingRuntime, pinServingRuntimeDuringCommit } from './service-runtime.js';

export function reserveServiceReplacements(options: {
  entry: BranchEntry; profileIds: readonly string[]; state: StateService; portStart: number; operationId?: string;
}): void {
  const { entry, state, profileIds } = options;
  if (!profileIds.some(id => entry.services[id]?.servingRuntime)) return;
  const generation = options.operationId || randomUUID().replaceAll('-', '');
  if (entry.replacementOperationId !== generation) {
    entry.replacementOperationId = generation;
    entry.replacementNetwork = `${branchAppNetworkName(entry.id).slice(0, 27)}-r-${randomUUID().replaceAll('-', '')}`;
    entry.replacementNetworks = [...new Set([...(entry.replacementNetworks || []), entry.replacementNetwork])];
  }
  for (const id of profileIds) {
    const service = entry.services[id];
    if (!service) continue;
    if (!service.servingRuntime) { service.networkName = entry.replacementNetwork; continue; }
    if (service.pendingRuntime && service.pendingRuntime.networkName === entry.replacementNetwork && !service.pendingRuntime.creationIssued) continue;
    if (service.pendingRuntime) service.retainedRuntimes = [...(service.retainedRuntimes || []), runtimeRef(service.pendingRuntime)];
    service.pendingRuntime = { containerName: `${service.containerName.slice(0, 92)}-r-${randomUUID().replaceAll('-', '')}`,
      hostPort: state.allocatePort(options.portStart), networkName: entry.replacementNetwork };
  }
  state.save([{ kind: 'branches', id: entry.id }]);
}

/** 容器环境解析使用本轮已预约身份，入口仍从原Entry的servingRuntime读取。 */
export function replacementLaunchEntry(entry: BranchEntry): BranchEntry {
  return { ...entry, services: Object.fromEntries(Object.entries(entry.services).map(([id, service]) =>
    [id, service.pendingRuntime && service.pendingRuntime.networkName === entry.replacementNetwork
      ? { ...service, ...service.pendingRuntime } : service])) };
}

/** 候选是独立对象；迟到旧操作不能借共享ServiceState改掉更新操作的容器身份。 */
export async function prepareServiceReplacement(options: {
  entry: BranchEntry; service: ServiceState; profile: BuildProfile; state: StateService;
  container: Pick<ContainerService, 'inspectOwnedRuntime' | 'connectReplacementPeer' | 'removeOwnedRuntime' | 'cleanupUnusedReplacementNetworks'>; portStart: number; operationId?: string; assertCurrent?: (step: string) => void;
}): Promise<ServiceState> {
  const { entry, service, state, container, profile, assertCurrent } = options;
  if (!service.servingRuntime && !service.pendingRuntime) return service;
  assertCurrent?.('before candidate prepare');
  const approved = servingRuntime(service);
  const actual = approved ? await container.inspectOwnedRuntime(entry, profile.id, approved) : null;
  assertCurrent?.('after old runtime identity');
  if (!actual) {
    assertCurrent?.('after old runtime check');
    service.servingRuntime = undefined;
    state.save([{ kind: 'branches', id: entry.id }]);
    if (!service.pendingRuntime) return service;
  }
  service.servingRuntime = actual || undefined;
  const reserved = service.pendingRuntime && service.pendingRuntime.networkName === entry.replacementNetwork && !service.pendingRuntime.creationIssued
    ? service.pendingRuntime : undefined;
  if (!reserved && service.pendingRuntime && service.pendingRuntime.containerName !== service.containerName) {
    service.retainedRuntimes = [...(service.retainedRuntimes || []), runtimeRef(service.pendingRuntime)];
  }
  if (!actual || service.containerName !== actual.containerName) service.retainedRuntimes = [...(service.retainedRuntimes || []), runtimeRef(service)];
  const generation = options.operationId || entry.replacementOperationId || randomUUID().replaceAll('-', '');
  const network = entry.replacementOperationId === generation && entry.replacementNetwork
    ? entry.replacementNetwork : `${branchAppNetworkName(entry.id).slice(0, 27)}-r-${randomUUID().replaceAll('-', '')}`;
  entry.replacementNetwork = network;
  entry.replacementNetworks = [...new Set([...(entry.replacementNetworks || []), network])];
  entry.replacementOperationId = generation;
  const candidate: ServiceState = { profileId: profile.id, containerName: `${service.containerName.slice(0, 92)}-r-${randomUUID().replaceAll('-', '')}`,
    hostPort: reserved?.hostPort ?? state.allocatePort(options.portStart), status: 'building', networkName: network, ...reserved };
  service.pendingRuntime = runtimeRef(candidate);
  state.save([{ kind: 'branches', id: entry.id }]); await state.flush();
  for (const peerProfile of state.getEffectiveProfilesForBranch(entry)) {
    if (peerProfile.id === profile.id) continue;
    const peer = entry.services[peerProfile.id], active = servingRuntime(peer);
    if (peer?.pendingRuntime?.networkName === network || peer?.networkName === network) continue;
    if (!peer || !active || active.networkName === network || active.connectedNetworks?.includes(network)) continue;
    const ownedPeer = await container.inspectOwnedRuntime(entry, peerProfile.id, active);
    if (!ownedPeer) throw new Error('依赖旧服务当前不可用，旧入口保持原版本');
    Object.assign(active, ownedPeer);
    const live = { ...peer, ...ownedPeer };
    await container.connectReplacementPeer(entry, peerProfile, live, network, assertCurrent);
    assertCurrent?.('after candidate peer connect');
    active.connectedNetworks = [...(live.connectedNetworks || [])];
    active.aliasNetworks = [...(live.aliasNetworks || [])];
  }
  state.save([{ kind: 'branches', id: entry.id }]); await state.flush();
  return candidate;
}

export function preserveReplacementNames(entry: BranchEntry, candidate: ServiceState): string[] {
  return Object.values(entry.services).flatMap(service => serviceRuntimeRefs(service))
    .filter(runtime => runtime.containerName !== candidate.containerName).map(runtime => runtime.containerName);
}

/** 本轮整体失败后收回未发布候选；已确认旧入口、其他轮次及已发布依赖保持。 */
export async function abortUnpublishedServiceReplacements(options: {
  entry: BranchEntry; profileIds: readonly string[]; state: StateService;
  container: Pick<ContainerService, 'inspectOwnedRuntime' | 'removeOwnedRuntime'>;
  operationId?: string; operationGeneration?: number;
  assertCurrent?: (step: string) => void;
}): Promise<void> {
  const { entry, profileIds, state, container, assertCurrent } = options;
  if (!entry.replacementNetwork) return;
  for (const id of profileIds) {
    const service = entry.services[id], active = service?.servingRuntime;
    if (!service || !active) continue;
    const candidates = serviceRuntimeRefs(service).filter(runtime => runtime.containerName !== active.containerName
      && runtime.networkName === entry.replacementNetwork && (runtime.creationIssued || runtime.containerId));
    if (!candidates.length) continue;
    assertCurrent?.('before failed replacement old identity');
    const confirmedActive = await container.inspectOwnedRuntime(entry, id, active);
    if (!confirmedActive) continue;
    assertCurrent?.('after failed replacement old identity');
    for (const candidate of candidates) {
      // 名称不同也可能仍携带旧CID；当前实际入口身份绝不能作为失败候选删除。
      if (candidate.containerId && candidate.containerId === confirmedActive.containerId) continue;
      // 同网段已有发布角色可能仍消费它；没有发布任何角色时才整体撤销候选。
      if (Object.values(entry.services).some(peer => peer !== service
        && servingRuntime(peer)?.networkName === candidate.networkName)) continue;
      await container.removeOwnedRuntime(entry, id, runtimeRef(candidate), { branchId: entry.id, projectId: entry.projectId,
        operationId: options.operationId, operationGeneration: options.operationGeneration,
        profileId: id, operation: 'failed-unpublished-runtime', source: 'service-replacement',
        assertCurrent: () => assertCurrent?.('failed replacement cleanup command') });
      assertCurrent?.('after failed replacement cleanup');
      if (service.containerName === candidate.containerName) Object.assign(service, runtimeRef(active));
      if (service.pendingRuntime?.containerName === candidate.containerName) service.pendingRuntime = undefined;
      service.retainedRuntimes = service.retainedRuntimes?.filter(runtime => runtime.containerName !== candidate.containerName);
      state.save([{ kind: 'branches', id: entry.id }]); await state.flush();
      assertCurrent?.('after failed replacement cleanup persistence');
    }
  }
}

/** 全部点名服务就绪后才切入口；持久化失败恢复旧指针，旧容器尚未回收。 */
export async function commitServiceReplacements(options: {
  entry: BranchEntry; profileIds: readonly string[]; state: StateService; container: Pick<ContainerService, 'inspectOwnedRuntime' | 'connectReplacementPeer' | 'removeOwnedRuntime' | 'cleanupUnusedReplacementNetworks'>;
  operationId?: string; operationGeneration?: number;
  assertCurrent?: (step: string) => void;
}): Promise<void> {
  const { entry, profileIds, state, container, assertCurrent } = options;
  const selected = profileIds.map(id => entry.services[id]).filter((service): service is ServiceState => Boolean(service));
  if (selected.some(service => service.status !== 'running')) {
    if (selected.some(service => service.status === 'error')) await abortUnpublishedServiceReplacements(options);
    return;
  }
  const changed = selected.filter(service => service.servingRuntime && service.servingRuntime.containerName !== service.containerName);
  if (!changed.length && !selected.some(service => service.retainedRuntimes?.length)) return;
  assertCurrent?.('before runtime cutover persistence');
  await state.flush();
  assertCurrent?.('after candidate persistence before cutover');
  const previous = changed.map(service => ({ service, active: service.servingRuntime!, retained: service.retainedRuntimes }));
  const pins = changed.map(service => pinServingRuntimeDuringCommit(service));
  const nextPointers = new Map(changed.map(service => [service, runtimeRef(service)]));
  for (const { service, active } of previous) {
    service.retainedRuntimes = [...(service.retainedRuntimes || []), runtimeRef(active)];
    service.servingRuntime = nextPointers.get(service);
  }
  try {
    state.save([{ kind: 'branches', id: entry.id }]); await state.flush();
    assertCurrent?.('after runtime cutover persistence');
  } catch (error) {
    for (const old of previous) if (old.service.servingRuntime === nextPointers.get(old.service)) {
      old.service.servingRuntime = old.active; old.service.retainedRuntimes = old.retained;
    }
    state.save([{ kind: 'branches', id: entry.id }]);
    throw error;
  } finally {
    for (const release of pins) release();
  }
  // 仍被未替换服务连接的旧版本保留；每个已声明网络关系都计入实际容量。
  for (const service of Object.values(entry.services)) {
    for (const old of [...(service.retainedRuntimes || [])]) {
      const aliases = old.aliasNetworks || (old.networkName ? [old.networkName] : []);
      const referenced = Object.values(entry.services).some(peer => {
        if (peer === service) return false;
        const active = servingRuntime(peer);
        return active && [...(active.aliasNetworks || []), ...(active.networkName ? [active.networkName] : [])].some(network => aliases.includes(network));
      });
      if (referenced || !old.networkName) continue;
      assertCurrent?.('before old runtime retirement');
      await container.removeOwnedRuntime(entry, service.profileId, old, { branchId: entry.id, projectId: entry.projectId,
        operationId: options.operationId, operationGeneration: options.operationGeneration,
        profileId: service.profileId, operation: 'ready-runtime-retirement', source: 'service-replacement',
        assertCurrent: () => assertCurrent?.('old runtime retirement command') });
      service.retainedRuntimes = service.retainedRuntimes?.filter(runtime => runtime.containerName !== old.containerName);
    }
  }
  await container.cleanupUnusedReplacementNetworks(entry, { branchId: entry.id, projectId: entry.projectId,
    operationId: options.operationId, operationGeneration: options.operationGeneration,
    assertCurrent: () => assertCurrent?.('unused replacement network cleanup') });
  entry.replacementNetwork = undefined;
  entry.replacementOperationId = undefined;
  state.save([{ kind: 'branches', id: entry.id }]); await state.flush();
}
