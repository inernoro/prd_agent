import type { Request } from 'express';
import type { AgentKeyAccess } from '../types.js';
import type { CdsUser } from '../domain/auth.js';

export interface ClusterMapConnection {
  id: string;
  projectId: string;
  scopes: string[];
  partnerBaseUrl: string;
}

/** Only server-to-server validation can install this context; headers cannot. */
export interface ClusterIdentityContext {
  clusterId: string;
  authorityNodeId: string;
  nodeId: string;
  user?: CdsUser;
  humanProjects?: string[];
  basicHuman?: boolean;
  session?: { createdAt: string; expiresAt: string };
  aiSession?: { id: string; agentName: string; token: string; approvedAt: string; expiresAt: string };
  projectKey?: { projectId: string; keyId: string };
  access?: { keyId: string; access: AgentKeyAccess };
  principal?: { principalId: string; credentialId: string };
  principalProjects?: string[];
  mapConnection?: ClusterMapConnection;
}

const contexts = new WeakMap<object, ClusterIdentityContext>();
export function trustedClusterIdentity(req: unknown): ClusterIdentityContext | undefined {
  return req && typeof req === 'object' ? contexts.get(req) : undefined;
}

export function installClusterIdentity(req: Request, context: ClusterIdentityContext): void {
  contexts.set(req, context);
  Object.assign(req, {
    cdsUser: context.user,
    cdsSession: context.session,
    _cdsCookieAuth: !!context.user,
    _cdsBasicHumanAuth: context.basicHuman === true,
    _aiSession: context.aiSession,
    cdsProjectKey: context.projectKey,
    cdsAccess: context.access,
    cdsPrincipal: context.principal,
    cdsSsoIdentity: context.user?.authProvider === 'sso' ? {
      subject: context.user.id.replace(/^sso:/, ''), username: context.user.username || context.user.githubLogin,
      displayName: context.user.name || context.user.username || context.user.githubLogin, email: context.user.email,
    } : undefined,
  });
}
