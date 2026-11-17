export interface ReleaseConflictCheck {
  projectId: string;
  mainSha: string;
  candidateSha: string;
  checkedAt: string;
  status: 'clean' | 'conflicts' | 'unknown';
  conflicts: string[];
  changedPaths: string[];
  includesBaseline: boolean;
  reason?: string;
}

export interface ReleaseAuthorization {
  id: string;
  projectId: string;
  targetId: string;
  branchId: string;
  branchName: string;
  kind: 'single' | 'debug';
  action: 'release' | 'rollback';
  rollbackReleaseId?: string;
  deploymentVersionId?: string;
  candidateSha: string;
  basisSha: string;
  baselineReleaseId: string | null;
  mainSha: string;
  targetFingerprint: string;
  projectFingerprint: string;
  allowedPaths: string[];
  requestedBy: string;
  scheduledJobId?: string;
  scheduledJobFingerprint?: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
  decidedBy?: string;
  decidedAt?: string;
  decisionReason?: string;
  consumedBy?: string;
  decisions?: Array<{ action: 'approved' | 'rejected' | 'revoked'; by: string; at: string; reason: string }>;
  conflictCheck: ReleaseConflictCheck;
}

export interface ReleaseGovernanceReceipt {
  authorizationId: string;
  kind: 'single' | 'debug';
  action: 'release' | 'rollback';
  rollbackReleaseId?: string;
  deploymentVersionId?: string;
  requestedBy: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  targetFingerprint: string;
  projectFingerprint: string;
  baselineReleaseId: string | null;
  mainSha: string;
  candidateSha: string;
  checkedAt: string;
  allowedPaths: string[];
}

export interface ReleaseGovernanceAttempt {
  id: string;
  projectId: string;
  targetId: string;
  branchId: string;
  candidateSha: string;
  operator: string;
  at: string;
  authorizationId?: string;
  releaseId?: string;
  result: 'accepted' | 'denied';
  reason: string;
}

export interface ReleaseMergeBack {
  id: string;
  projectId: string;
  targetId: string;
  sourceSha: string;
  repository: string;
  number: number;
  url: string;
  owner: string;
  state: 'open' | 'closed' | 'merged' | 'unknown';
  headSha: string;
  baseRef: string;
  mergedAt?: string;
  mergeCommitSha?: string;
  checkedAt: string;
  linkedBy: string;
  reason?: string;
}

export interface ReleaseGovernanceState {
  checks?: Record<string, ReleaseConflictCheck & { targetId: string }>;
  authorizations: Record<string, ReleaseAuthorization>;
  attempts: ReleaseGovernanceAttempt[];
  mergeBacks: Record<string, ReleaseMergeBack>;
}
