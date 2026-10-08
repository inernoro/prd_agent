import type { StateService } from './state.js';
import { isAuthenticatedHuman, isHumanSystemOwner } from './human-auth.js';
import { hasActiveGrant } from './identity.js';
import type { BranchEntry, BuildProfile, Project } from '../types.js';
import { maskEnvRecord, maskCommandSecrets, maskBranchExtraProfilesEnv, maskSecretsInObject } from './secret-masker.js';
import type { UnifiedBranchResource } from './resources.js';

/** Stable link to the existing principal/grant model; never use a mutable login. */
export function humanPrincipalId(userId: string): string {
  return `human:${userId}`;
}

export function isScopedHuman(req: unknown): boolean {
  return !!req && isAuthenticatedHuman(req) && !isHumanSystemOwner(req);
}

const pendingGrantUpdates = new WeakMap<StateService, Map<string, { startedAt: string; reconciling: boolean }>>();

export function humanProjectGrantUpdateStatus(state: StateService, principalId: string) {
  return pendingGrantUpdates.get(state)?.get(principalId);
}

export function markHumanProjectGrantRecovery(state: StateService, principalId: string): void {
  const status = humanProjectGrantUpdateStatus(state, principalId);
  if (status) status.reconciling = true;
}

export function isHumanProjectGrantUpdatePending(state: StateService, principalId: string): boolean {
  return pendingGrantUpdates.get(state)?.has(principalId) === true;
}

/** A grant replacement is not usable until its persistence outcome is known. */
export function beginHumanProjectGrantUpdate(state: StateService, principalId: string): (() => void) | undefined {
  let pending = pendingGrantUpdates.get(state);
  if (!pending) { pending = new Map(); pendingGrantUpdates.set(state, pending); }
  if (pending.has(principalId)) return undefined;
  pending.set(principalId, { startedAt: new Date().toISOString(), reconciling: false });
  return () => { pending.delete(principalId); };
}

/** Complete log/diagnostic payloads reuse the established secret masker. */
export function logPayloadForHumanView<T>(req: unknown, payload: T): T {
  if (!isScopedHuman(req)) return payload;
  // Structured diagnostics can carry env maps, not just KEY=value strings.
  // Compose the existing text, env and CLI maskers; add no new secret grammar.
  return walk(maskSecretsInObject(payload)) as T;
  function walk(value: unknown): unknown {
    if (typeof value === 'string') return maskCommandSecrets(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      const strings = maskEnvRecord(Object.fromEntries(entries.filter(([, item]) => typeof item === 'string')));
      return Object.fromEntries(entries.map(([key, item]) => [key,
        typeof item === 'string' ? maskCommandSecrets(strings[key]) : walk(item),
      ]));
    }
    return value;
  }
}

export function supportsHumanProjectGrant(project: Project | undefined): project is Project {
  return !!project && (project.kind === 'git' || project.kind === 'manual');
}

export function canHumanAccessProject(req: unknown, state: StateService, projectId: string): boolean {
  if (!isScopedHuman(req)) return true;
  const user = (req as { cdsUser?: { id: string; status?: string } }).cdsUser;
  if (!user || user.status === 'disabled') return false;
  const principalId = humanPrincipalId(user.id);
  if (isHumanProjectGrantUpdatePending(state, principalId)) return false;
  if (state.getPrincipal(principalId)?.status === 'disabled') return false;
  const project = state.getProject(projectId);
  if (!supportsHumanProjectGrant(project)) return false;
  const canonical = project.id;
  return hasActiveGrant(state.getProjectGrants(), principalId, canonical);
}

/** Read-only member views never carry profile or alternate-mode secrets. */
export function profileForHumanView(req: unknown, profile: BuildProfile): BuildProfile {
  if (!isScopedHuman(req)) return profile;
  const visible = logPayloadForHumanView(req, profile);
  return {
    ...visible,
    env: visible.env ? maskEnvRecord(visible.env) : visible.env,
    command: maskCommandSecrets(visible.command),
    deployModes: visible.deployModes ? Object.fromEntries(Object.entries(visible.deployModes).map(([id, mode]) => [id, {
      ...mode, env: mode.env ? maskEnvRecord(mode.env) : mode.env,
      command: maskCommandSecrets(mode.command),
    }])) : visible.deployModes,
  };
}

/** Resource summaries are not permission to reveal database/cache credentials. */
export function resourceForHumanView(req: unknown, resource: UnifiedBranchResource): UnifiedBranchResource {
  if (!isScopedHuman(req)) return resource;
  const visible = logPayloadForHumanView(req, resource);
  return {
    ...visible,
    connectionString: undefined,
    externalAccess: { ...visible.externalAccess, connectionString: undefined },
    raw: 'command' in visible.raw ? {
      ...visible.raw, command: maskCommandSecrets(visible.raw.command),
    } : visible.raw,
  };
}

export function branchForHumanView<T extends BranchEntry>(req: unknown, branch: T): T {
  const profileMasked = maskBranchExtraProfilesEnv(branch);
  if (!isScopedHuman(req)) return profileMasked;
  const masked = logPayloadForHumanView(req, profileMasked);
  const resources = (masked as T & { resources?: UnifiedBranchResource[] }).resources;
  return {
    ...masked,
    ...(resources ? { resources: resources.map(resource => resourceForHumanView(req, resource)) } : {}),
    extraProfiles: masked.extraProfiles?.map(profile => profileForHumanView(req, profile)),
    profileOverrides: masked.profileOverrides ? Object.fromEntries(Object.entries(masked.profileOverrides).map(([id, override]) => [id, {
      ...override,
      ...(override.command !== undefined ? { command: maskCommandSecrets(override.command) } : {}),
    }])) : masked.profileOverrides,
  };
}
