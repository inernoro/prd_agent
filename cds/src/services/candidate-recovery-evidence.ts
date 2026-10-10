import { createHash } from 'node:crypto';
import type { BranchEntry, DeploymentCandidateRecord } from '../types.js';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
const digest = (value: unknown) => 'sha256:' + createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

/** Freeze stop intent independently from mutable deployment/runtime status. No reason plaintext. */
export function candidateControlFingerprint(branch: BranchEntry): string {
  return digest([branch.lastStoppedAt ?? null, branch.lastStopSource ?? null, branch.lastStopReason ?? null, branch.currentVersionId ?? null]);
}

/** A receipt proves the original executor reached its final boundary, not that Daemon recovery succeeded. */
export function candidateSettlementFingerprint(record: DeploymentCandidateRecord): string {
  const { executorSettlement: _settlement, ...facts } = record;
  return digest(facts);
}
