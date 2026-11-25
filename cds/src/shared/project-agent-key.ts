export type ProjectAgentKeyIssuer = 'user' | 'agent' | 'unknown';
export const AGENT_KEY_EXPIRY_DAYS = [1, 7, 30, 90] as const;
export type AgentKeyExpiryDays = typeof AGENT_KEY_EXPIRY_DAYS[number];

export function isAgentKeyExpiryDays(value: unknown): value is AgentKeyExpiryDays {
  return AGENT_KEY_EXPIRY_DAYS.some(days => value === days);
}

/** Independent grants for one project. Higher levels include lower levels in the same workspace. */
export interface ProjectAgentKeyPermissions {
  projectAccess?: 'rw' | 'admin';
  planningAccess?: 'read' | 'propose';
  designAccess?: 'read' | 'feedback' | 'publish';
}

/** Older general-purpose keys have no explicit grants and keep their original access. */
export function isLegacyProjectAgentKey(key: ProjectAgentKeyPermissions): boolean {
  return key.projectAccess === undefined && key.planningAccess === undefined && key.designAccess === undefined;
}
