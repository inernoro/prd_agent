import type { ServiceState, ServiceRuntimeRef } from '../types.js';

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
  if (['idle', 'stopped', 'stopping'].includes(service.status)) return null;
  const runtime = service.servingRuntime || (service.status === 'running' ? service : null);
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
