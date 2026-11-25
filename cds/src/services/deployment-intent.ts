import type { DeploymentRun, PersistedDeploymentIntent } from '../types.js';
import type { BranchOperationRequest } from './branch-operation-coordinator.js';
import type { DeploymentInputSnapshot } from './deployment-input.js';
import { isSealingEnabled, sealToken, unsealToken } from '../infra/secret-seal.js';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface DeploymentExecutionInput {
  request: BranchOperationRequest;
  input: DeploymentInputSnapshot;
}

export function captureDeploymentIntent(run: DeploymentRun, execution: DeploymentExecutionInput, keyDirectory?: string): PersistedDeploymentIntent {
  if (!run.operationId || !Number.isSafeInteger(run.operationGeneration)) throw new Error('Deployment intent requires operation identity');
  const request = { ...execution.request, pendingReplay: null };
  const payload = JSON.stringify(execution.input);
  const useNodeKey = Boolean(keyDirectory && !isSealingEnabled());
  const inputPayload = useNodeKey ? sealToken(payload, deploymentIntentKey(keyDirectory!, true)) : sealToken(payload);
  return {
    schema: 1, runId: run.id, operationId: run.operationId, generation: run.operationGeneration!,
    admissionGeneration: run.operationAdmissionGeneration ?? run.operationGeneration!,
    request, inputDigest: digest(request, payload), inputPayload,
    ...(useNodeKey ? { keyScope: 'node' as const } : {}),
  };
}

/** 私有记录必须对应同一次部署。保护镜像只读已受理的目标，不授予自动重放资格。 */
export function readDeploymentIntent(run: DeploymentRun, intent: PersistedDeploymentIntent,
  purpose: 'replay' | 'image-protection' = 'replay', keyDirectory?: string): DeploymentInputSnapshot {
  const request = intent.request;
  if (intent.schema !== 1 || intent.runId !== run.id || intent.operationId !== run.operationId
    || intent.generation !== run.operationGeneration || !Number.isSafeInteger(intent.generation)
    || intent.admissionGeneration !== (run.operationAdmissionGeneration ?? run.operationGeneration)
    || request.branchId !== run.branchId || (request.projectId || 'default') !== run.projectId
    || (request.profileId || undefined) !== run.profileId
    || request.kind !== (run.profileId ? 'deploy-profile' : 'deploy')
    || (request.configHash || undefined) !== run.configHash
    || (request.commitPinned && request.commitSha?.toLowerCase() !== run.commitSha?.toLowerCase())
    || (request.versionId && request.versionId !== run.versionId)
    || (purpose === 'replay' && (request.versionId || request.hasOneShotOptions))) throw new Error('Deployment intent target mismatch');
  if (intent.keyScope === 'node' && !keyDirectory) throw new Error('Deployment intent has no local key directory');
  const payload = intent.keyScope === 'node'
    ? unsealToken(intent.inputPayload, deploymentIntentKey(keyDirectory!, false))
    : unsealToken(intent.inputPayload);
  if (intent.inputDigest !== digest(request, payload)) throw new Error('Deployment intent content mismatch');
  const input = JSON.parse(payload) as DeploymentInputSnapshot;
  if (!input || !Array.isArray(input.profiles) || !input.profiles.every((profile) => profile && typeof profile.id === 'string')
    || !input.configuredEnv || typeof input.configuredEnv !== 'object' || Array.isArray(input.configuredEnv)
    || !Object.values(input.configuredEnv).every((value) => typeof value === 'string')
    || input.configHash !== run.configHash) throw new Error('Deployment intent input invalid');
  return input;
}

function deploymentIntentKey(directory: string, create: boolean): Buffer {
  const keyPath = path.join(directory, 'deployment-intent.key');
  if (create && !fs.existsSync(keyPath)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.deployment-intent-${randomBytes(12).toString('hex')}`);
    try {
      fs.writeFileSync(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 });
      try { fs.linkSync(temporary, keyPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  const fd = fs.openSync(keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size !== 32) throw new Error('Deployment intent key is unavailable');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function digest(request: BranchOperationRequest, payload: string): string {
  return createHash('sha256').update(JSON.stringify(request)).update('\n').update(payload).digest('hex');
}
