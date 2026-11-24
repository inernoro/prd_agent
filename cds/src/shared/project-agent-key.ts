export type ProjectAgentKeyIssuer = 'user' | 'agent' | 'unknown';

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
