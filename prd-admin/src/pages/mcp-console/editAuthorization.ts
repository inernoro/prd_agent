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
