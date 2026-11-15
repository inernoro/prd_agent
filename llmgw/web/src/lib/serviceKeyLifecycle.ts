import type { ServiceKeyItem } from './types';

export type KeyLifecycleIntent = { kind: 'revoke' | 'cutover'; id: string; name: string; predecessorId?: string | null; successorId?: string | null };
// Audited Program.cs exits before this endpoint's first mutation. ROTATION_CONFLICT is
// deliberately absent: another branch can return it after a different key was updated.
export const KEY_REVOKE_REJECTED = ['SERVICE_KEY_NOT_FOUND', 'SERVICE_KEY_ISSUANCE_PENDING', 'ROTATION_CLIENT_SWITCH_REQUIRED', 'ROTATION_OLD_KEY_REVOKE_REQUIRED'] as const;
export const KEY_CUTOVER_REJECTED = ['SERVICE_KEY_NOT_FOUND', 'ROTATION_EXPECTATION_REQUIRED', 'ROTATION_PAIR_CHANGED', 'ROTATION_STAGE_INVALID', 'ROTATION_SUCCESSOR_INVALID', 'ROTATION_SUCCESSOR_STAGE_INVALID'] as const;

/** Read-only postcondition, not attribution of this outcome to the lost response. */
export function keyLifecycleGoalObserved(intent: KeyLifecycleIntent, items: readonly ServiceKeyItem[]) {
  const target = items.find(item => item.id === intent.id);
  if (!target) return false;
  const next = items.find(item => item.id === intent.successorId);
  if (intent.kind === 'cutover') {
    if (!next || next.rotatesKeyId !== target.id || target.rotatedByKeyId !== next.id) return false;
    return target.enabled === true && target.rotationState === 'client-switched' && next.enabled === true && next.rotationState === 'client-switched'
      || target.enabled === false && target.rotationState === 'old-key-revoked' && next.enabled === true && next.rotationState === 'completed';
  }
  if (target.enabled) return false;
  if (intent.successorId) return Boolean(target.rotationState === 'old-key-revoked' && target.rotatedByKeyId === intent.successorId && next?.enabled && next.rotatesKeyId === target.id && next.rotationState === 'completed');
  if (intent.predecessorId) {
    const previous = items.find(item => item.id === intent.predecessorId);
    return Boolean(target.rotationState === 'revoked' && previous?.enabled && !previous.rotatedByKeyId && ['active', 'completed'].includes(previous.rotationState));
  }
  return target.rotationState === 'revoked';
}
