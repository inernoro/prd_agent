import { randomUUID } from 'node:crypto';
import type { BranchEntry, BuildProfile, ServiceState, ServiceRuntimeRef, OperationLogContainerSnapshot } from '../types.js';
import type { StateService } from './state.js';
import { ContainerRemovalPrerequisiteError, computeProfileAliases, type ContainerService } from './container.js';
import { branchAppNetworkName } from './branch-network.js';
import { runtimeRef, serviceRuntimeRefs, servingRuntime, pinServingRuntimeDuringCommit } from './service-runtime.js';
import { archiveBranchContainerLogs } from './container-log-archiver.js';
import { resolveBranchEnvLayers } from './branch-env-layers.js';

function staticConsumerAliases(entry: BranchEntry, profileId: string, state: StateService): Set<string> {
  const project = entry.projectId ? state.getProject(entry.projectId) : undefined;
  return new Set(computeProfileAliases(profileId, [entry.projectId, project?.slug].filter((value): value is string => Boolean(value))));
}
function referencesStaticAlias(value: string, aliases: Set<string>): boolean {
  return [...value.matchAll(/https?:\/\/([a-z0-9_.-]+)(?=[:/]|$)/gi)].some(match => aliases.has(match[1]));
}
/** Browser-only is an explicit deployment contract, never inferred from a shared network. */
export function assertBrowserOnlyStaticConsumers(entry: BranchEntry, profileId: string, state: StateService): void {
  const aliases = staticConsumerAliases(entry, profileId, state);
  for (const { effective: peer, provenance, envError } of resolveBranchEnvLayers(state, entry, { jwtIssuer: '' }).profiles) {
    if (peer.id === profileId) continue;
    if (envError) throw new Error(`服务 ${peer.id} 的运行环境无法完整解析，请核对后再选择仅浏览器静态模式`);
    const references = [...(peer.calls || []), ...(peer.dependsOn || [])];
    const internalUrl = provenance.some(({ value }) => referencesStaticAlias(value, aliases));
    if (internalUrl || references.some(target => aliases.has(target))) throw new Error(`服务 ${peer.id} 仍声明依赖该前端容器地址，请迁移依赖后再选择仅浏览器静态模式`);
  }
}

export function reserveServiceReplacements(options: {
  entry: BranchEntry; profileIds: readonly string[]; state: StateService; portStart: number; operationId?: string;
  staticProfileIds?: readonly string[];
}): void {
  const { entry, state, profileIds } = options;
  if (!profileIds.some(id => entry.services[id]?.servingRuntime)) return;
  const generation = options.operationId || randomUUID().replaceAll('-', '');
  const staticIds = new Set(options.staticProfileIds);
  if (entry.replacementOperationId !== generation) {
    entry.replacementOperationId = generation;
    entry.replacementNetwork = profileIds.some(id => !staticIds.has(id))
      ? `${branchAppNetworkName(entry.id).slice(0, 27)}-r-${randomUUID().replaceAll('-', '')}` : undefined;
    if (entry.replacementNetwork) entry.replacementNetworks = [...new Set([...(entry.replacementNetworks || []), entry.replacementNetwork])];
  }
  for (const id of profileIds) {
    const service = entry.services[id];
    if (!service) continue;
    const isStatic = staticIds.has(id);
    if (!service.servingRuntime) { service.networkName = isStatic ? undefined : entry.replacementNetwork; service.runtimeKind = isStatic ? 'static' : undefined; continue; }
    if (service.pendingRuntime && (service.pendingRuntime.runtimeKind === 'static') === isStatic
      && service.pendingRuntime.networkName === (isStatic ? undefined : entry.replacementNetwork) && !service.pendingRuntime.creationIssued) continue;
    if (service.pendingRuntime) service.retainedRuntimes = [...(service.retainedRuntimes || []), runtimeRef(service.pendingRuntime)];
    service.pendingRuntime = { containerName: `${service.containerName.slice(0, 92)}-r-${randomUUID().replaceAll('-', '')}`,
      hostPort: state.allocatePort(options.portStart), networkName: isStatic ? undefined : entry.replacementNetwork, runtimeKind: isStatic ? 'static' : undefined };
  }
  state.save([{ kind: 'branches', id: entry.id }]);
}

/** 容器环境解析使用本轮已预约身份，入口仍从原Entry的servingRuntime读取。 */
export function replacementLaunchEntry(entry: BranchEntry): BranchEntry {
  return { ...entry, services: Object.fromEntries(Object.entries(entry.services).map(([id, service]) =>
    [id, service.pendingRuntime && (service.pendingRuntime.runtimeKind === 'static' || service.pendingRuntime.networkName === entry.replacementNetwork)
      ? { ...service, ...service.pendingRuntime } : service])) };
}

/** 候选是独立对象；迟到旧操作不能借共享ServiceState改掉更新操作的容器身份。 */
export async function prepareServiceReplacement(options: {
  entry: BranchEntry; service: ServiceState; profile: BuildProfile; state: StateService;
  container: Pick<ContainerService, 'inspectOwnedRuntime' | 'connectReplacementPeer' | 'removeOwnedRuntime' | 'cleanupUnusedReplacementNetworks'>; portStart: number; operationId?: string; assertCurrent?: (step: string) => void;
}): Promise<ServiceState> {
  const { entry, service, state, container, profile, assertCurrent } = options;
  if (profile.staticWeb?.browserOnly) assertBrowserOnlyStaticConsumers(entry, profile.id, state);
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
  const reserved = service.pendingRuntime && (service.pendingRuntime.runtimeKind === 'static') === Boolean(profile.staticWeb)
    && (profile.staticWeb || service.pendingRuntime.networkName === entry.replacementNetwork) && !service.pendingRuntime.creationIssued
    ? service.pendingRuntime : undefined;
  if (!reserved && service.pendingRuntime && service.pendingRuntime.containerName !== service.containerName) {
    service.retainedRuntimes = [...(service.retainedRuntimes || []), runtimeRef(service.pendingRuntime)];
  }
  if (!actual || service.containerName !== actual.containerName) service.retainedRuntimes = [...(service.retainedRuntimes || []), runtimeRef(service)];
  if (profile.staticWeb) {
    const candidate: ServiceState = { profileId: profile.id,
      containerName: reserved?.containerName || `${service.containerName.slice(0, 92)}-r-${randomUUID().replaceAll('-', '')}`,
      hostPort: reserved?.hostPort ?? state.allocatePort(options.portStart), status: 'building', runtimeKind: 'static' };
    service.pendingRuntime = runtimeRef(candidate);
    state.save([{ kind: 'branches', id: entry.id }]); await state.flush();
    return candidate;
  }
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

class OldServingRuntimeUnavailable extends Error {}

/** 本轮整体失败后收回未发布候选；已确认旧入口、其他轮次及已发布依赖保持。 */
export async function abortUnpublishedServiceReplacements(options: {
  entry: BranchEntry; profileIds: readonly string[]; state: StateService;
  container: Pick<ContainerService, 'inspectOwnedRuntime' | 'removeOwnedRuntime'>;
  operationId?: string; operationGeneration?: number;
  assertCurrent?: (step: string) => void;
}): Promise<void> {
  const { entry, profileIds, state, container, assertCurrent } = options;
  if (!entry.replacementNetwork && !profileIds.some(id => entry.services[id]?.runtimeKind === 'static' || entry.services[id]?.pendingRuntime?.runtimeKind === 'static')) return;
  for (const id of profileIds) {
    const service = entry.services[id], active = service?.servingRuntime;
    if (!service || !active) continue;
    const candidates = serviceRuntimeRefs(service).filter(runtime => runtime.containerName !== active.containerName
      && ((runtime.staticWeb && (runtime === service || runtime === service.pendingRuntime))
        || (entry.replacementNetwork && runtime.networkName === entry.replacementNetwork)) && Boolean(runtime.containerId));
    if (!candidates.length) continue;
    assertCurrent?.('before failed replacement old identity');
    const confirmedActive = await container.inspectOwnedRuntime(entry, id, active);
    assertCurrent?.('after failed replacement old identity');
    if (!confirmedActive) continue;
    for (const candidate of candidates) {
      // 名称不同也可能仍携带旧CID；当前实际入口身份绝不能作为失败候选删除。
      if (candidate.containerId && candidate.containerId === confirmedActive.containerId) continue;
      // 同网段已有发布角色可能仍消费它；没有发布任何角色时才整体撤销候选。
      if (candidate.networkName && Object.values(entry.services).some(peer => peer !== service
        && servingRuntime(peer)?.networkName === candidate.networkName)) continue;
      try {
        await container.removeOwnedRuntime(entry, id, runtimeRef(candidate), { branchId: entry.id, projectId: entry.projectId,
          operationId: options.operationId, operationGeneration: options.operationGeneration,
          profileId: id, operation: 'failed-unpublished-runtime', source: 'service-replacement',
          requiredRunningContainerId: confirmedActive.containerId,
          beforeRemove: async () => {
            const current = await container.inspectOwnedRuntime(entry, id, active);
            assertCurrent?.('after failed replacement old liveness');
            if (!current || current.containerId !== confirmedActive.containerId || service.servingRuntime !== active) {
              throw new OldServingRuntimeUnavailable('旧入口已失效或身份变化，保留未发布候选');
            }
          },
          assertCurrent: () => assertCurrent?.('failed replacement cleanup command') });
      } catch (error) {
        assertCurrent?.('after failed replacement cleanup guard');
        if (error instanceof OldServingRuntimeUnavailable || error instanceof ContainerRemovalPrerequisiteError) continue;
        throw error;
      }
      assertCurrent?.('after failed replacement cleanup');
      if (service.containerName === candidate.containerName) Object.assign(service, runtimeRef(active));
      if (service.pendingRuntime?.containerName === candidate.containerName) service.pendingRuntime = undefined;
      service.retainedRuntimes = service.retainedRuntimes?.filter(runtime => runtime.containerName !== candidate.containerName);
      state.save([{ kind: 'branches', id: entry.id }]); await state.flush();
      assertCurrent?.('after failed replacement cleanup persistence');
    }
  }
}

function publicationIdentity(entry: BranchEntry): string {
  return JSON.stringify(Object.entries(entry.services).map(([id, service]) =>
    [id, service.status, runtimeRef(service), service.servingRuntime, service.pendingRuntime]));
}

async function runningConsumersDoNotReference(profileId: string, published: ReadonlyMap<string, ServiceRuntimeRef | null>,
  container: Pick<ContainerService, 'getEnv'>, aliases: Set<string>, check: (step: string) => void): Promise<boolean> {
  for (const [id, peer] of published) {
    if (id === profileId || peer?.staticWeb) continue;
    if (!peer?.containerId || !/^[a-f0-9]{64}$/.test(peer.containerId)) return false;
    let env: string;
    check('before running consumer environment');
    try { env = await container.getEnv(peer.containerId); }
    catch { check('after unreadable consumer environment'); return false; }
    check('after running consumer environment');
    if (referencesStaticAlias(env, aliases)) return false;
  }
  return true;
}

/** 连接旧网络不代表仍依赖旧版本；消费者必须已能通过服务别名访问当前版本。 */
async function retireReplacedRuntimes(options: Parameters<typeof commitServiceReplacements>[0]): Promise<void> {
  const { entry, state, container } = options;
  const identity = publicationIdentity(entry);
  const check = (step: string) => {
    options.assertCurrent?.(step);
    if (publicationIdentity(entry) !== identity) throw new Error('当前服务身份已变化，停止回收旧版本');
  };
  const published = new Map<string, ServiceRuntimeRef | null>();
  for (const [id, service] of Object.entries(entry.services)) {
    const active = servingRuntime(service);
    if (!active) continue;
    // 以 Docker 的实际别名和连网为准，不能拿持久化的历史拓扑当作可达证明。
    published.set(id, await container.inspectOwnedRuntime(entry, id, active));
    check('after retirement serving identity');
  }
  const protectedRefs = [...Object.values(entry.services).flatMap(service =>
    [service, service.servingRuntime, service.pendingRuntime]), ...published.values()]
    .filter((ref): ref is ServiceRuntimeRef => Boolean(ref));
  const isProtected = (runtime: ServiceRuntimeRef) => protectedRefs.some(ref =>
    ref.containerName === runtime.containerName || Boolean(ref.containerId && ref.containerId === runtime.containerId));
  for (const [id, service] of Object.entries(entry.services)) {
    const active = published.get(id);
    if (!active || (!active.staticWeb && !active.aliasNetworks?.length)) continue;
    for (const old of [...(service.retainedRuntimes || [])]) {
      if ((!old.staticWeb && !old.networkName) || isProtected(old)) continue;
      const confirmed = await container.inspectOwnedRuntime(entry, id, active);
      check('after retirement replacement liveness');
      if (!confirmed || confirmed.containerId !== active.containerId) continue;
      const actual = await container.inspectOwnedRuntime(entry, id, old, false);
      check('after retirement retained identity');
      if (actual && (isProtected(actual) || (!actual.staticWeb && !actual.aliasNetworks?.length))) continue;
      if (confirmed.staticWeb?.browserOnly) {
        assertBrowserOnlyStaticConsumers(entry, id, state);
        const aliases = staticConsumerAliases(entry, id, state); aliases.add((actual || old).containerName);
        if (!await runningConsumersDoNotReference(id, published, container, aliases, check)) continue;
      }
      const referenced = actual && !actual.staticWeb && !confirmed.staticWeb?.browserOnly && [...published].some(([peerId, peer]) => {
        if (peerId === id || peer?.staticWeb) return false;
        if (!peer) return true; // 当前消费者未确认运行时，保留其可能依赖的旧版本。
        const networks = [peer.networkName, ...(peer.connectedNetworks || [])];
        return networks.some(network => actual.aliasNetworks!.includes(network!))
          && !networks.some(network => confirmed.aliasNetworks?.includes(network!));
      });
      if (referenced) continue;
      check('before old runtime retirement');
      await container.removeOwnedRuntime(entry, id, actual || old, { branchId: entry.id, projectId: entry.projectId,
        operationId: options.operationId, operationGeneration: options.operationGeneration,
        profileId: id, operation: 'ready-runtime-retirement', source: 'service-replacement',
        assertCurrent: () => check('old runtime retirement command') });
      check('after old runtime retirement');
      service.retainedRuntimes = service.retainedRuntimes?.filter(runtime => runtime.containerName !== old.containerName);
      state.save([{ kind: 'branches', id: entry.id }]); await state.flush();
      check('after old runtime retirement persistence');
    }
  }
}

/** 全部点名服务就绪后才切入口；持久化失败恢复旧指针，旧容器尚未回收。 */
export async function commitServiceReplacements(options: {
  entry: BranchEntry; profileIds: readonly string[]; state: StateService; container: Pick<ContainerService, 'inspectOwnedRuntime' | 'connectReplacementPeer' | 'removeOwnedRuntime' | 'cleanupUnusedReplacementNetworks' | 'getLogs' | 'getEnv'>;
  operationId?: string; operationGeneration?: number;
  assertCurrent?: (step: string) => void;
  onFailureDiagnostics?: (snapshots: OperationLogContainerSnapshot[]) => void;
}): Promise<void> {
  const { entry, profileIds, state, container, assertCurrent } = options;
  const selected = profileIds.map(id => entry.services[id]).filter((service): service is ServiceState => Boolean(service));
  if (selected.some(service => service.status !== 'running')) {
    if (selected.some(service => service.status === 'error')) {
      const archived = await archiveBranchContainerLogs({ stateService: state, containerService: container,
        branch: entry, source: 'deploy-error', profileIds: new Set(profileIds), assertCurrent });
      assertCurrent?.('before failed replacement archive persistence');
      options.onFailureDiagnostics?.(archived.map(snapshot => ({ ...snapshot, source: 'deploy-error', tailLines: 500 })));
      state.save(); await state.flush();
      assertCurrent?.('after failed replacement archive persistence');
      await abortUnpublishedServiceReplacements(options);
    }
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
  await retireReplacedRuntimes(options);
  await container.cleanupUnusedReplacementNetworks(entry, { branchId: entry.id, projectId: entry.projectId,
    operationId: options.operationId, operationGeneration: options.operationGeneration,
    assertCurrent: () => assertCurrent?.('unused replacement network cleanup') });
  entry.replacementNetwork = undefined;
  entry.replacementOperationId = undefined;
  state.save([{ kind: 'branches', id: entry.id }]); await state.flush();
}
