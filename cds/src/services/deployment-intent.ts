import type { DeploymentRun, PersistedDeploymentIntent } from '../types.js';
import type { BranchOperationRequest } from './branch-operation-coordinator.js';
import type { DeploymentInputSnapshot } from './deployment-input.js';
import { sealToken, unsealToken } from '../infra/secret-seal.js';
import { createHash } from 'node:crypto';

export interface DeploymentExecutionInput {
  request: BranchOperationRequest;
  input: DeploymentInputSnapshot;
}

export function captureDeploymentIntent(run: DeploymentRun, execution: DeploymentExecutionInput): PersistedDeploymentIntent {
  if (!run.operationId || !Number.isSafeInteger(run.operationGeneration)) throw new Error('Deployment intent requires operation identity');
  const request = { ...execution.request, pendingReplay: null };
  const payload = JSON.stringify(execution.input);
  return {
    schema: 1, runId: run.id, operationId: run.operationId, generation: run.operationGeneration!,
    admissionGeneration: run.operationAdmissionGeneration ?? run.operationGeneration!,
    request, inputDigest: digest(request, payload), inputPayload: sealToken(payload),
  };
}

/** 私有恢复记录与公开 run 必须是同一个真实目标，损坏或密钥不可读时拒绝恢复。 */
export function readDeploymentIntent(run: DeploymentRun, intent: PersistedDeploymentIntent): DeploymentInputSnapshot {
  const request = intent.request;
  if (intent.schema !== 1 || intent.runId !== run.id || intent.operationId !== run.operationId
    || intent.generation !== run.operationGeneration || !Number.isSafeInteger(intent.generation)
    || intent.admissionGeneration !== (run.operationAdmissionGeneration ?? run.operationGeneration)
    || request.branchId !== run.branchId || (request.projectId || 'default') !== run.projectId
    || (request.profileId || undefined) !== run.profileId
    || request.kind !== (run.profileId ? 'deploy-profile' : 'deploy')
    || (request.configHash || undefined) !== run.configHash
    || (request.commitPinned && request.commitSha?.toLowerCase() !== run.commitSha?.toLowerCase())
    || request.versionId || request.hasOneShotOptions) throw new Error('Deployment intent target mismatch');
  const payload = unsealToken(intent.inputPayload);
  if (intent.inputDigest !== digest(request, payload)) throw new Error('Deployment intent content mismatch');
  const input = JSON.parse(payload) as DeploymentInputSnapshot;
  if (!input || !Array.isArray(input.profiles) || !input.profiles.every((profile) => profile && typeof profile.id === 'string')
    || !input.configuredEnv || typeof input.configuredEnv !== 'object' || Array.isArray(input.configuredEnv)
    || !Object.values(input.configuredEnv).every((value) => typeof value === 'string')
    || input.configHash !== run.configHash) throw new Error('Deployment intent input invalid');
  return input;
}

function digest(request: BranchOperationRequest, payload: string): string {
  return createHash('sha256').update(JSON.stringify(request)).update('\n').update(payload).digest('hex');
}
