import type { McpCapabilityDto } from '@/services/contracts/mcpConsole';
export type AccessLevel = 'none' | 'read' | 'write';
export function accessLevel(cap: McpCapabilityDto, scopes: string[]): AccessLevel {
  const held = new Set(scopes.map(scope => scope.toLowerCase()));
  if (cap.writeScope && held.has(cap.writeScope.toLowerCase())) return 'write';
  if (cap.readScope && held.has(cap.readScope.toLowerCase())) return 'read';
  return 'none';
}
/** Only replace this capability's scopes; retain independently granted interfaces. */
export function changeCapabilityAccess(scopes: string[], cap: McpCapabilityDto, level: AccessLevel): string[] {
  const owned = [cap.readScope, cap.writeScope].filter((s): s is string => !!s).map(s => s.toLowerCase());
  const next = scopes.filter(scope => !owned.includes(scope.toLowerCase()));
  if (level !== 'none' && cap.readScope) next.push(cap.readScope);
  if (level === 'write' && cap.writeScope) next.push(cap.writeScope);
  return Array.from(new Set(next));
}

/** 任务台 use 包含新增、建议和同步，不是只读权限。 */
export function accessLabel(cap: Pick<McpCapabilityDto, 'key' | 'writeScope'>, level: AccessLevel): string {
  if (level === 'none') return '未开放';
  if (cap.key === 'tasks') return level === 'read' ? '使用任务台' : '管理任务台';
  return level === 'read' ? (cap.writeScope ? '只读' : '可查询') : '可执行';
}
