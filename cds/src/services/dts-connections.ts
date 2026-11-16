import type { StateService } from './state.js';
import type { DtsConnection, DtsKind, DtsManagedService } from '../shared/dts.js';
import { DTS_KINDS } from '../shared/dts.js';
import { backupKindOf } from './infra-backup-schedule.js';
import { cdsEnvPrefix } from './infra-credential-env.js';
import { dtsReject } from './dts-policy.js';

export function dtsProjectEnvironment(state: StateService, projectId: string): Record<string, string> {
  return { ...state.getCdsEnvVars?.(projectId), ...state.getCustomEnv(projectId) };
}
/** Reuse the platform's service classification, template resolution and credential derivation. */
export function dtsManagedServices(state: StateService, projectId: string): DtsManagedService[] {
  const derived = state.getCdsEnvVars?.(projectId) ?? {};
  return (state.getInfraServicesForProject?.(projectId) ?? []).flatMap(service => {
    if (service.projectId !== projectId) return [];
    const kind = backupKindOf(service.dockerImage, { id: service.id, containerName: service.containerName });
    if (!kind || !DTS_KINDS.includes(kind as DtsKind)) return [];
    const uriEnv = `CDS_${cdsEnvPrefix(service.id)}_URL`;
    return [{ id: service.id, projectId, name: service.name, kind: kind as DtsKind, database: service.dbName ?? null,
      uriEnv, status: service.status, ready: service.status === 'running' && Boolean(derived[uriEnv]) }];
  });
}
/** A managed binding cannot be redirected to an unrelated custom variable or project. */
export function dtsConnectionEnvironment(state: StateService, c: DtsConnection): Record<string, string> {
  const env = dtsProjectEnvironment(state, c.projectId);
  if (!c.infraId) return env;
  const service = dtsManagedServices(state, c.projectId).find(s => s.id === c.infraId);
  if (!service || service.kind !== c.kind || service.uriEnv !== c.uriEnv || !service.ready) {
    dtsReject('managed_binding_unavailable', '已登记的项目数据服务发生变化或尚未就绪，请重新核对服务连接', 409);
  }
  // Project custom values may configure credential templates; they cannot override the derived endpoint itself.
  return { ...env, [c.uriEnv]: state.getCdsEnvVars(c.projectId)[c.uriEnv] };
}
