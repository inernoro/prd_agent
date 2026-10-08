import type { StateService } from './state.js';
import { isAuthenticatedHuman, isHumanSystemOwner, type HumanAuthContext } from './human-auth.js';
import { hasActiveGrant } from './identity.js';
import type { BranchEntry, BuildProfile, Project, CdsState } from '../types.js';
import { maskEnvRecord, maskCommandSecrets, maskBranchExtraProfilesEnv, maskSecretsInObject } from './secret-masker.js';
import type { UnifiedBranchResource } from './resources.js';

/** Stable link to the existing principal/grant model; never use a mutable login. */
export function humanPrincipalId(userId: string): string {
  return `human:${userId}`;
}

export function isScopedHuman(req: unknown): boolean {
  // Ticket SSO is synthesized by verified authentication middleware, not a
  // persisted account that the owner can grant. Preserve its existing project
  // access without treating it as a system owner or creating a new role map.
  return !!req && isAuthenticatedHuman(req) && !isHumanSystemOwner(req)
    && (req as HumanAuthContext).cdsUser?.authProvider !== 'sso';
}

const pendingGrantUpdates = new WeakMap<StateService, Map<string, { startedAt: string; reconciling: boolean }>>();
type AccessRecovery = NonNullable<CdsState['humanAccessRecovery']>[string];
export type FinishHumanAccessUpdate = () => Promise<boolean>;

export function humanProjectGrantUpdateStatus(state: StateService, principalId: string) {
  return pendingGrantUpdates.get(state)?.get(principalId);
}

export function markHumanProjectGrantRecovery(state: StateService, principalId: string): void {
  const status = humanProjectGrantUpdateStatus(state, principalId);
  if (status) status.reconciling = true;
}

export function isHumanProjectGrantUpdatePending(state: StateService, principalId: string): boolean {
  return pendingGrantUpdates.get(state)?.has(principalId) === true || !!state.getHumanAccessRecoveries()[principalId];
}

/** A grant replacement is not usable until its persistence outcome is known. */
export function beginHumanProjectGrantUpdate(state: StateService, principalId: string,
  mode?: AccessRecovery['mode']): FinishHumanAccessUpdate | undefined {
  if (isHumanProjectGrantUpdatePending(state, principalId)) return undefined;
  const record = mode ? { startedAt: new Date().toISOString(), mode,
    grants: structuredClone(state.getProjectGrants().filter(g => g.principalId === principalId)),
    principal: state.getPrincipal(principalId) ? structuredClone(state.getPrincipal(principalId)!) : undefined,
  } : undefined;
  if (record) state.setHumanAccessRecovery(principalId, record);
  return registerHumanAccessUpdate(state, principalId, record);
}

function registerHumanAccessUpdate(state: StateService, principalId: string, record?: AccessRecovery): FinishHumanAccessUpdate {
  let pending = pendingGrantUpdates.get(state);
  if (!pending) { pending = new Map(); pendingGrantUpdates.set(state, pending); }
  const status = { startedAt: record?.startedAt || new Date().toISOString(), reconciling: false };
  pending.set(principalId, status);
  const release: FinishHumanAccessUpdate = async () => {
    if (pending.get(principalId) !== status) return true;
    if (!record) { pending.delete(principalId); return true; }
    let writing: Promise<void> | undefined;
    try {
      state.setHumanAccessRecovery(principalId, undefined);
      state.save();
      writing = state.flush();
      await boundedHumanAccessFlush(writing);
      pending.delete(principalId);
      return true;
    } catch {
      // Access snapshot is already confirmed safe. Keep the journal/gate until
      // its cleanup is confirmed too; a late cleanup cannot grant unsafe data.
      state.setHumanAccessRecovery(principalId, record);
      status.reconciling = true;
      const restored = (writing || Promise.resolve()).catch(() => {}).then(async () => {
        state.save(); await state.flush();
      });
      reconcileHumanAccessRestore(state, restored, release);
      return false;
    }
  };
  return release;
}

/** Startup restores only the interrupted principal, before any authorization. */
export function recoverInterruptedHumanAccessUpdates(state: StateService): void {
  for (const [principalId, record] of Object.entries(state.getHumanAccessRecoveries())) {
    const release = registerHumanAccessUpdate(state, principalId, record);
    markHumanProjectGrantRecovery(state, principalId);
    if (record.mode === 'grants') {
      const grants = state.getProjectGrants();
      for (let i = grants.length - 1; i >= 0; i--) {
        if (grants[i].principalId === principalId) grants.splice(i, 1);
      }
      grants.push(...structuredClone(record.grants));
      const principals = state.getPrincipals();
      const index = principals.findIndex(p => p.id === principalId);
      if (record.principal) {
        if (index < 0) state.addPrincipal(structuredClone(record.principal));
        else principals[index] = structuredClone(record.principal);
      } else if (index >= 0) principals.splice(index, 1);
    } else {
      const principal = state.getPrincipal(principalId);
      if (principal) { principal.status = 'disabled'; principal.disabledAt = record.startedAt; }
    }
    let restored: Promise<void>;
    try { state.save(); restored = state.flush(); }
    catch { restored = Promise.reject(new Error('interrupted access restore failed')); }
    reconcileHumanAccessRestore(state, restored, release);
  }
}

export async function boundedHumanAccessFlush(pending: Promise<void>): Promise<void> {
  const value = Number(process.env.CDS_GRANT_FLUSH_TIMEOUT_MS);
  const waitMs = Number.isFinite(value) && value >= 10 && value <= 120_000 ? value : 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('human access persistence wait expired')), waitMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Keep the gate until the serialized write chain confirms a safe snapshot. */
export function reconcileHumanAccessRestore(state: StateService, pending: Promise<void>, release: () => void | Promise<unknown>): void {
  void pending.then(release, () => {
    const reference = new WeakRef(state);
    const timer = setTimeout(() => {
      const live = reference.deref();
      if (!live) return;
      try { live.save(); reconcileHumanAccessRestore(live, live.flush(), release); }
      catch { reconcileHumanAccessRestore(live, Promise.reject(new Error('restore save failed')), release); }
    }, Number(process.env.CDS_GRANT_RECONCILE_MS) >= 20
      ? Math.min(Number(process.env.CDS_GRANT_RECONCILE_MS), 30_000) : 5_000);
    timer.unref();
  });
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
