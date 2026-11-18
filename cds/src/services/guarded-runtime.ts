import type { BranchEntry, ServiceState } from '../types.js';
import type { ContainerService } from './container.js';
import { runtimeRef } from './service-runtime.js';
import { confirmedRunningRevisionSha } from './running-version.js';

export interface RuntimeCapacityGuard {
  expectedMaxHotBranches: number;
  expectedCommitSha: string;
  expectedContainers?: Record<string, string>;
  expectedImage?: string;
  yieldFirst: true;
}

/** Opt-in only. No fallback to names, queued replay, source compilation or replacement containers. */
export function parseRuntimeCapacityGuard(value: unknown): RuntimeCapacityGuard | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('运行保护条件不完整，尚未执行');
  const g = value as RuntimeCapacityGuard;
  if (Object.keys(g).some(k => !['expectedMaxHotBranches', 'expectedCommitSha', 'expectedContainers', 'expectedImage', 'yieldFirst'].includes(k))
    || !Number.isInteger(g.expectedMaxHotBranches) || g.expectedMaxHotBranches < 1 || g.expectedMaxHotBranches > 10000
    || g.yieldFirst !== true || !/^[a-f0-9]{40}$/.test(g.expectedCommitSha || ''))
    throw new Error('运行保护条件不完整，尚未执行');
  if (g.expectedContainers !== undefined && (!g.expectedContainers || typeof g.expectedContainers !== 'object'
    || Array.isArray(g.expectedContainers) || Object.keys(g.expectedContainers).length > 50
    || Object.values(g.expectedContainers).some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))))
    throw new Error('必须提供逐服务完整容器身份');
  if (g.expectedImage !== undefined && (typeof g.expectedImage !== 'string' || !/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(g.expectedImage)))
    throw new Error('必须提供不可变镜像身份');
  return structuredClone(g);
}

export function captureGuardedRuntime(entry: BranchEntry, guard: RuntimeCapacityGuard, mode: 'deploy' | 'stop' | 'restart') {
  if (entry.archive || Object.keys(entry.replicaSets || {}).length
    || entry.githubCommitSha !== guard.expectedCommitSha)
    throw new Error('分支、提交或副本范围已变化，尚未执行');
  const services = Object.values(entry.services);
  if (mode !== 'deploy' && (!guard.expectedContainers || !services.length
    || Object.keys(guard.expectedContainers).sort().join('|') !== services.map(s => s.profileId).sort().join('|')))
    throw new Error('容器范围不完整，尚未执行');
  if (mode !== 'deploy' && !guard.expectedImage) throw new Error('必须核对本批容器的不可变镜像');
  for (const service of services) {
    const originalRefs = [service.servingRuntime, service.pendingRuntime, ...(service.retainedRuntimes || [])].filter(Boolean);
    if (service.staticWeb || !/^[a-f0-9]{64}$/.test(service.containerId || '')
      || originalRefs.some(ref => ref!.containerName !== service.containerName || ref!.containerId !== service.containerId)
      || (guard.expectedContainers && guard.expectedContainers[service.profileId] !== service.containerId)
      || (guard.expectedImage && service.deployedImage !== guard.expectedImage))
      throw new Error('容器身份、镜像或附加运行范围不符，尚未执行');
    // Parse the retained descriptor through the existing revision authority.
    // The cloned status is never stored or presented as proof that a stopped runtime is running.
    if (mode !== 'deploy' && confirmedRunningRevisionSha({ ...entry,
      services: { [service.profileId]: { ...service, status: 'running' } } }) !== guard.expectedCommitSha)
      throw new Error('容器实际来源提交不符或未知，尚未执行');
    if (mode === 'restart' && service.status !== 'stopped') throw new Error('仅允许全部停止的同批容器恢复');
    if (mode === 'stop' && !['running', 'stopped'].includes(service.status)) throw new Error('当前仍有未决容器操作，尚未停止');
  }
  const config = () => JSON.stringify([entry.projectId, entry.githubCommitSha, entry.profileOverrides,
    entry.extraProfiles, entry.excludedProjectProfileIds, mode === 'deploy' ? null : entry.lastDeploymentRunId]);
  const baseline = config();
  const runtimeIdentity = (service: ServiceState) => JSON.stringify([runtimeRef(service), service.servingRuntime,
    service.pendingRuntime, service.retainedRuntimes]);
  const frozen = new Map(services.map(service => [service.profileId, {
    service, id: service.containerId, identity: runtimeIdentity(service),
  }]));
  const assertCurrent = () => {
    if (entry.archive || Object.keys(entry.replicaSets || {}).length || config() !== baseline)
      throw new Error('准确运行配置已变化，停止本次操作');
    if (mode === 'deploy') return; // The deployment's existing immutable input/lease controls new service publication.
    if (Object.keys(entry.services).sort().join('|') !== [...frozen.keys()].sort().join('|'))
      throw new Error('容器集合已变化，停止本次操作');
    for (const [id, saved] of frozen) {
      const current = entry.services[id];
      if (current !== saved.service || current.containerId !== saved.id || runtimeIdentity(current) !== saved.identity)
        throw new Error('容器身份已变化，停止本次操作');
    }
  };
  return { services: services as ServiceState[], assertCurrent,
    async inspectAll(container: Pick<ContainerService, 'inspectGuardedRuntime'>, assertLease: () => void) {
      assertCurrent(); assertLease();
      for (const service of services) {
        const actual = await container.inspectGuardedRuntime(entry, service.profileId, runtimeRef(service),
          guard.expectedImage!, guard.expectedCommitSha, service.status === 'running');
        assertLease(); assertCurrent();
        if (!actual || actual.containerId !== frozen.get(service.profileId)!.id)
          throw new Error('准确容器不存在或归属不符，尚未操作');
      }
    },
  };
}
