import type { StateService } from './state.js';
import { credentialUsability, hasActiveGrant } from './identity.js';
import type { DtsActor } from '../shared/dts.js';

/** Recheck the live identity graph on every dispatch and recovery, including parent revocation. */
export function dtsCredentialAllowed(state: StateService, actor: DtsActor, projectId: string): boolean {
  if (actor.kind === 'principal') {
    const c = state.getUserCredentials().find(c => c.id === actor.id);
    return Boolean(c && credentialUsability(c, state.getPrincipal(c.principalId), Date.now(), true).usable
      && (!c.projectIds || c.projectIds.includes(projectId)) && hasActiveGrant(state.getProjectGrants(), c.principalId, projectId));
  }
  if (actor.kind !== 'project-key') return false;
  const k = state.getAgentKeys(projectId).find(k => k.id === actor.id);
  if (!k || k.scope !== 'rw' || !credentialUsability(k, k.principalId ? state.getPrincipal(k.principalId) : undefined, Date.now(), Boolean(k.principalId)).usable) return false;
  if (k.principalId && !hasActiveGrant(state.getProjectGrants(), k.principalId, projectId)) return false;
  if (k.issuedByCredentialId) {
    const parent = state.getUserCredentials().find(c => c.id === k.issuedByCredentialId);
    if (!parent || parent.principalId !== k.principalId || !credentialUsability(parent, state.getPrincipal(parent.principalId), Date.now(), true).usable
      || (parent.projectIds && !parent.projectIds.includes(projectId))) return false;
  }
  return true;
}
