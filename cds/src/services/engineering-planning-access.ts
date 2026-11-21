import type { Request } from 'express';
import type { PlanningActor } from '../shared/engineering-planning.js';
import type { CdsUser } from '../domain/auth.js';
import type { StateService } from './state.js';
import { canHumanAccessProject } from './human-project-access.js';
import { isAuthenticatedHuman } from './human-auth.js';
import { dtsCredentialAllowed } from './dts-access.js';

export function resolveEngineeringPlanningAccess(req: Request, state: StateService, projectId: string,
  workspace: 'planning' | 'design' = 'planning'): (PlanningActor & { gitPublishOnly?: true }) | null {
  const project = state.getProject(projectId);
  if (!project || project.id !== projectId || project.mirror) return null;
  const request = req as Request & {
    cdsProjectKey?: { projectId: string; keyId: string };
    cdsAccess?: unknown;
    cdsPrincipal?: unknown;
    _aiSession?: unknown;
    cdsUser?: CdsUser;
  };
  const key = request.cdsProjectKey;
  if (key) {
    if (key.projectId !== projectId || !dtsCredentialAllowed(state, { kind: 'project-key', id: key.keyId }, projectId)) return null;
    const credential = state.getAgentKeys(projectId).find(item => item.id === key.keyId);
    if (!credential) return null;
    if ((credential.designAccess && workspace !== 'design') || (credential.planningAccess && workspace !== 'planning')) return null;
    const identity = { kind: 'agent' as const, id: credential.principalId ?? `project-key:${credential.id}`, label: credential.label };
    if (credential.designAccess) {
      return credential.designAccess === 'publish' ? { ...identity, permissions: ['read', 'write'], gitPublishOnly: true }
        : { ...identity, permissions: ['read'] };
    }
    return {
      ...identity,
      permissions: credential.planningAccess === 'read' ? ['read'] : credential.planningAccess === 'propose'
        ? ['read', 'propose'] : ['read', 'propose', 'write'],
    };
  }
  if (request.cdsAccess || request.cdsPrincipal || request._aiSession || !isAuthenticatedHuman(req)
    || !request.cdsUser?.id || request.cdsUser.id === 'anonymous' || request.cdsUser.status === 'disabled'
    || !canHumanAccessProject(req, state, projectId)) return null;
  return {
    kind: 'human',
    id: request.cdsUser.id,
    label: request.cdsUser.name || request.cdsUser.username || request.cdsUser.id,
    permissions: ['read', 'propose', 'write', 'approve'],
  };
}
