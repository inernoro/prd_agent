import type { GatewayAppCaller } from './types';

/** IDs are authoritative. A caller code alone is not an identity across request types. */
export function appCallerDetailCandidates(items: GatewayAppCaller[], id: string, code: string, requestType: string) {
  if (id) return items.filter(item => item.id === id);
  if (!code) return [];
  return items.filter(item => item.appCallerCode.toLowerCase() === code.toLowerCase()
    && (!requestType || item.requestType.toLowerCase() === requestType.toLowerCase()));
}
export function callerManagementState(status: string) {
  const key = (status || '').toLowerCase();
  if (['discovered', 'configured', 'active'].includes(key)) return { label: '允许调用', tone: 'neutral' as const };
  if (key === 'disabled') return { label: '已停用', tone: 'warning' as const };
  if (key === 'archived') return { label: '已归档', tone: 'neutral' as const };
  return { label: '状态未知', tone: 'warning' as const };
}
