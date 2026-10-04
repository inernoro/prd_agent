import type { StateService } from './state.js';
import { isAuthenticatedHuman, isHumanSystemOwner } from './human-auth.js';
import { hasActiveGrant } from './identity.js';
import type { BranchEntry, BuildProfile, Project } from '../types.js';
import { maskEnvRecord, maskCommandSecrets, maskBranchExtraProfilesEnv } from './secret-masker.js';

/** Stable link to the existing principal/grant model; never use a mutable login. */
export function humanPrincipalId(userId: string): string {
  return `human:${userId}`;
}

export function isScopedHuman(req: unknown): boolean {
  return isAuthenticatedHuman(req) && !isHumanSystemOwner(req);
}

export function supportsHumanProjectGrant(project: Project | undefined): project is Project {
  return !!project && (project.kind === 'git' || project.kind === 'manual');
}

export function canHumanAccessProject(req: unknown, state: StateService, projectId: string): boolean {
  if (!isScopedHuman(req)) return true;
  const user = (req as { cdsUser?: { id: string; status?: string } }).cdsUser;
  if (!user || user.status === 'disabled') return false;
  const principalId = humanPrincipalId(user.id);
  if (state.getPrincipal(principalId)?.status === 'disabled') return false;
  const project = state.getProject(projectId);
  if (!supportsHumanProjectGrant(project)) return false;
  const canonical = project.id;
  return hasActiveGrant(state.getProjectGrants(), principalId, canonical);
}

/** Read-only member views never carry profile or alternate-mode secrets. */
export function profileForHumanView(req: unknown, profile: BuildProfile): BuildProfile {
  if (!isScopedHuman(req)) return profile;
  return {
    ...profile,
    env: profile.env ? maskEnvRecord(profile.env) : profile.env,
    command: maskCommandSecrets(profile.command),
    deployModes: profile.deployModes ? Object.fromEntries(Object.entries(profile.deployModes).map(([id, mode]) => [id, {
      ...mode, env: mode.env ? maskEnvRecord(mode.env) : mode.env,
      command: maskCommandSecrets(mode.command),
    }])) : profile.deployModes,
  };
}

export function branchForHumanView<T extends BranchEntry>(req: unknown, branch: T): T {
  const masked = maskBranchExtraProfilesEnv(branch);
  if (!isScopedHuman(req)) return masked;
  return {
    ...masked,
    extraProfiles: masked.extraProfiles?.map(profile => profileForHumanView(req, profile)),
    profileOverrides: masked.profileOverrides ? Object.fromEntries(Object.entries(masked.profileOverrides).map(([id, override]) => [id, {
      ...override,
      ...(override.command !== undefined ? { command: maskCommandSecrets(override.command) } : {}),
    }])) : masked.profileOverrides,
  };
}
