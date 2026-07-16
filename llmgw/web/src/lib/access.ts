import type { TenantSession } from '@/lib/types';

export type TenantRole = 'owner' | 'admin' | 'developer' | 'viewer' | 'billing';

export type ConsoleCapability =
  | 'logsRead'
  | 'usageRead'
  | 'auditRead'
  | 'configWrite'
  | 'appCallerWrite'
  | 'serviceKeyWrite'
  | 'organizationWrite'
  | 'tenantOwner';

export type ConsolePage =
  | 'home'
  | 'logs'
  | 'appCallers'
  | 'promptPolicy'
  | 'routeConfig'
  | 'quickstart'
  | 'serviceKeys'
  | 'learn'
  | 'organization'
  | 'usage'
  | 'audits'
  | 'shadow'
  | 'governance'
  | 'settings';

const ALL_ROLES: readonly TenantRole[] = ['owner', 'admin', 'developer', 'viewer', 'billing'];

const CAPABILITY_ROLES: Record<ConsoleCapability, readonly TenantRole[]> = {
  logsRead: ['owner', 'admin', 'developer', 'viewer'],
  usageRead: ALL_ROLES,
  auditRead: ['owner', 'admin'],
  configWrite: ['owner', 'admin'],
  appCallerWrite: ['owner', 'admin', 'developer'],
  serviceKeyWrite: ['owner', 'admin', 'developer'],
  organizationWrite: ['owner', 'admin'],
  tenantOwner: ['owner'],
};

type PageRule = { capability?: ConsoleCapability; internalOnly?: boolean };

export const PAGE_ACCESS: Record<ConsolePage, PageRule> = {
  home: { capability: 'usageRead' },
  logs: { capability: 'logsRead' },
  appCallers: { capability: 'logsRead' },
  promptPolicy: { capability: 'configWrite' },
  routeConfig: { capability: 'logsRead' },
  quickstart: { capability: 'logsRead' },
  serviceKeys: { capability: 'serviceKeyWrite' },
  learn: {},
  organization: { capability: 'logsRead' },
  usage: { capability: 'usageRead' },
  audits: { capability: 'auditRead' },
  shadow: { capability: 'logsRead', internalOnly: true },
  governance: { capability: 'logsRead', internalOnly: true },
  settings: {},
};

export function isTenantRole(role: string | undefined): role is TenantRole {
  return ALL_ROLES.includes(role as TenantRole);
}

export function canUseCapability(role: string | undefined, capability: ConsoleCapability): boolean {
  return isTenantRole(role) && CAPABILITY_ROLES[capability].includes(role);
}

export function canCreateWildcardServiceKey(role: string | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export function canAccessPage(tenant: TenantSession | null | undefined, page: ConsolePage): boolean {
  if (!tenant || !isTenantRole(tenant.role)) return false;
  const rule = PAGE_ACCESS[page];
  if (rule.internalOnly && !tenant.isInternal) return false;
  return !rule.capability || canUseCapability(tenant.role, rule.capability);
}

export function roleLabel(role: string | undefined): string {
  return ({ owner: 'Owner', admin: 'Admin', developer: 'Developer', viewer: 'Viewer', billing: 'Billing' } as Record<string, string>)[role ?? ''] ?? '未知角色';
}
