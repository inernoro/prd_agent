import type { ServiceState, ServiceRuntimeRef } from '../types.js';
const pendingPublication = new WeakMap<ServiceState, { runtime: ServiceRuntimeRef; token: symbol }>();

/** 临界保存期间路由继续读已确认身份；冷进程只读已经落盘的新身份。 */
export function pinServingRuntimeDuringCommit(service: ServiceState): () => void {
  const runtime = servingRuntime(service);
  if (!runtime) return () => {};
  const token = Symbol('runtime-publication');
  pendingPublication.set(service, { runtime: runtimeRef(runtime), token });
  return () => { if (pendingPublication.get(service)?.token === token) pendingPublication.delete(service); };
}

export function runtimeRef(service: ServiceRuntimeRef): ServiceRuntimeRef {
  return { containerName: service.containerName, hostPort: service.hostPort, networkName: service.networkName,
    containerId: service.containerId, creationIssued: service.creationIssued,
    connectedNetworks: service.connectedNetworks ? [...service.connectedNetworks] : undefined,
    aliasNetworks: service.aliasNetworks ? [...service.aliasNetworks] : undefined,
    deployedMode: service.deployedMode, deployedImage: service.deployedImage,
    sourceCheckoutPath: service.sourceCheckoutPath, sourceCommitSha: service.sourceCommitSha };
}

export function servingRuntime(service: ServiceState | undefined): ServiceRuntimeRef | null {
  if (!service) return null;
  if (['stopped', 'stopping'].includes(service.status)) return null;
  const runtime = pendingPublication.get(service)?.runtime || service.servingRuntime || (service.status === 'running' ? service : null);
  return runtime && runtime.hostPort > 0 ? runtime : null;
}

export function serviceRuntimeRefs(service: ServiceState): ServiceRuntimeRef[] {
  const refs = [service, service.servingRuntime, service.pendingRuntime, ...(service.retainedRuntimes || [])];
  const unique = new Map<string, ServiceRuntimeRef>();
  for (const value of refs) if (value?.containerName && !unique.has(value.containerName)) unique.set(value.containerName, value);
  return [...unique.values()];
}

export function preserveServingRuntime(service: ServiceState): void {
  if (!service.servingRuntime && service.status === 'running' && service.hostPort > 0) service.servingRuntime = runtimeRef(service);
}
