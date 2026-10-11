import type { BuildProfile } from '../types.js';
import type { AcceptanceResourceRun } from './acceptance-resource-run.js';

/** Narrow owned initialization proposal; never a general extra-services replacement. */
export function acceptanceResourceProfile(value: unknown, run: AcceptanceResourceRun, ownerToken: string): BuildProfile {
  const bad = () => { throw new Error('acceptance_creation_profile_invalid'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['dockerImage', 'containerPort', 'env', 'healthPath'].includes(key))) return bad();
  const image = raw.dockerImage, port = raw.containerPort;
  if (typeof image !== 'string' || image.length > 512 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(image)
    || !image.endsWith(':sha-' + run.targetSha) || !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return bad();
  const healthPath = raw.healthPath ?? '/health';
  if (typeof healthPath !== 'string' || healthPath.length > 128 || !/^\/[a-zA-Z0-9_./-]*$/.test(healthPath)
    || healthPath.startsWith('//') || healthPath.split('/').includes('..')) return bad();
  const inputEnv = raw.env ?? {};
  if (!inputEnv || typeof inputEnv !== 'object' || Array.isArray(inputEnv) || Object.keys(inputEnv).length > 64) return bad();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputEnv)) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || /ACCEPTANCE.*OWNER|OWNER.*TOKEN/.test(key)
      || typeof value !== 'string' || value.length > 4096 || value.includes(ownerToken) || value.includes('\0')
      || ['***', '***[masked]***', '****', '*****'].includes(value.trim())) return bad();
    env[key] = value;
  }
  if ((env.IMP_TARGET_SHA !== undefined && env.IMP_TARGET_SHA !== run.targetSha)
    || (env.IMP_HEALTH_RUN_ID !== undefined && env.IMP_HEALTH_RUN_ID !== run.isolationRunId)
    || env.CDS_FINALIZE_RUNTIME === 'true') return bad();
  env.IMP_TARGET_SHA = run.targetSha; env.IMP_HEALTH_RUN_ID = run.isolationRunId;
  return { id: run.profileId, projectId: run.projectId, name: run.profileId, workDir: '', command: '',
    dockerImage: image, containerPort: port as number, env, role: 'worker', prebuiltImage: true,
    prebuiltCommitPolicy: 'exact', activeDeployMode: 'express',
    deployModes: { express: { label: '极速版（验收初始化）', dockerImage: image, containerPort: port as number, prebuilt: true, commitPolicy: 'exact' } },
    readinessProbe: { path: healthPath, timeoutSeconds: 1200, intervalSeconds: 5 } };
}
