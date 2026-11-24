import type { LegacyKeyCutoverData } from './types';
export type LegacyPolicyWrite = {
  expectedPolicyRevision: number;
  status: 'observing' | 'ready' | 'revoked';
  deadlineAt: string;
  allowedAppCallerCodes: string[];
  successorServiceKeyIds: string[];
  requiredSuccessorObservations: number;
};
// Each code is returned before this endpoint's first write. Audit failures are not rejections.
export const LEGACY_POLICY_REJECTED = ['LEGACY_KEY_NOT_APPLICABLE', 'LEGACY_POLICY_REVISION_REQUIRED', 'INVALID_LEGACY_POLICY_REVISION', 'INVALID_LEGACY_CUTOVER_STATUS', 'LEGACY_DEADLINE_REQUIRED', 'LEGACY_CALLER_INVENTORY_REQUIRED', 'LEGACY_SUCCESSOR_INVALID', 'LEGACY_SUCCESSOR_SCOPE_INCOMPLETE', 'LEGACY_REVOCATION_FINAL', 'LEGACY_DUAL_KEY_OBSERVATION_REQUIRED', 'LEGACY_POLICY_CONFLICT'] as const;
export const LEGACY_POLICY_NEEDS_READ = ['LEGACY_POLICY_REVISION_REQUIRED', 'INVALID_LEGACY_POLICY_REVISION', 'LEGACY_POLICY_CONFLICT', 'LEGACY_REVOCATION_FINAL'] as const;
const members = (items: readonly string[], exact = false) => [...new Set(items.map(x => exact ? x.trim() : x.trim().toLowerCase()))].sort().join('\n');
/** A current complete policy goal, not proof of which request or audit produced it. */
export function legacyPolicyGoalObserved(write: LegacyPolicyWrite, current: LegacyKeyCutoverData) {
  return current.applicable && Number.isSafeInteger(current.policyRevision) && current.policyRevision >= write.expectedPolicyRevision
    && current.status === write.status && Boolean(current.deadlineAt)
    && Date.parse(current.deadlineAt!) === Date.parse(write.deadlineAt)
    && members(current.allowedAppCallerCodes) === members(write.allowedAppCallerCodes)
    && members(current.successorServiceKeyIds, true) === members(write.successorServiceKeyIds, true)
    && current.requiredSuccessorObservations === write.requiredSuccessorObservations;
}
