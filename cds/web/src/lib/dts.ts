import { apiRequest } from './api';
import type { DtsConnection, DtsManagedService, DtsPlan, DtsRun, DtsPolicy } from '../../../src/shared/dts';
export type { DtsConnection, DtsMode } from '../../../src/shared/dts';
export type Plan = Omit<DtsPlan, 'keys' | 'redisEntries' | 'rabbitObjects' | 'approvedBy'>;
export type Run = Omit<DtsRun, 'actor' | 'engine' | 'plan'> & { plan: Plan };
export type Policy = Omit<DtsPolicy, 'actor'>;
export interface Capabilities { projectId: string; configured: boolean; configureAllowed: boolean; executeAllowed: boolean; engineVersion: string; connectors: { kind: string; verified: boolean; message: string }[] }
export function dtsApi<T>(projectId: string, path: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' = 'GET', body?: unknown, signal?: AbortSignal) {
  return apiRequest<T>(`/api/dts${path}?${new URLSearchParams({ projectId })}`, { method, body, signal });
}
export async function loadDts(projectId: string, signal: AbortSignal) {
  const [capabilities, c, r, p] = await Promise.all([
    dtsApi<Capabilities>(projectId, '/capabilities', 'GET', undefined, signal),
    dtsApi<{ connections: DtsConnection[]; services?: DtsManagedService[] }>(projectId, '/connections', 'GET', undefined, signal),
    dtsApi<{ runs: Run[] }>(projectId, '/runs', 'GET', undefined, signal),
    dtsApi<{ policies: Policy[] }>(projectId, '/policies', 'GET', undefined, signal),
  ]);
  return { capabilities, connections: c.connections, services: c.services ?? [], runs: r.runs, policies: p.policies };
}
