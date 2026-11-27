export const ARTIFACT_VERIFICATION_SOURCE = 'artifact-verification';

export const ARTIFACT_VERIFICATION_STEPS = ['daemon', 'reserve', 'pull', 'receipt', 'inspect', 'compare'] as const;
export type ArtifactVerificationStep = (typeof ARTIFACT_VERIFICATION_STEPS)[number];

export const ARTIFACT_VERIFICATION_SIGNALS = [
  'deadline', 'pull-slot-limit', 'image-budget', 'pull-never-started', 'pull-result-unknown', 'receipt-unconfirmed',
] as const;
export type ArtifactVerificationSignal = (typeof ARTIFACT_VERIFICATION_SIGNALS)[number];

export const ARTIFACT_WAIT_REASONS = [
  'target-unresolved', 'image-unresolved', 'missing', 'access-denied',
  'verification-unavailable', 'revision-mismatch', 'platform-mismatch', 'cache-budget',
] as const;
export type ArtifactWaitReason = (typeof ARTIFACT_WAIT_REASONS)[number];

export interface ArtifactVerificationProbe {
  stepsMs: Partial<Record<ArtifactVerificationStep, number>>;
  lastStep?: ArtifactVerificationStep;
  signals?: ArtifactVerificationSignal[];
  pullRequests: number;
  pullsSucceeded: number;
  reusedImages: number;
}

export interface ArtifactVerificationEventDetails extends Partial<ArtifactVerificationProbe> {
  runId: string;
  executorId: string;
  retry: boolean;
  requiredProfiles: number;
  executionMs: number;
  elapsedSinceAcceptedMs: number;
  outcome: 'ready' | 'waiting' | 'interrupted';
  reason?: ArtifactWaitReason;
}
