/**
 * 分支生效环境变量的分层装配（唯一定义处）。
 *
 * 生效配置检查器（effective-config）与引用分区（references）都要回答「每个容器最终拿到什么、
 * 每个 key 来自哪一层」。此前这段装配只写在 effective-config 路由里；引用分区再抄一份就会漂移
 * （predicate-and-wiring-discipline 形状 3），所以抽到这里，两处共用。
 */
import type { BranchEntry, BuildProfile, EnvKeyProvenance, EnvSource } from '../types.js';
import type { StateService } from './state.js';
import { resolveEffectiveProfile } from './container.js';
import { resolveProfileRuntimeEnvWithProvenance, type EnvLayer } from './env-provenance.js';
import { branchEntrypointDepsFromState, resolveBranchEntrypointsEnv } from './preview-entrypoints.js';
import { cdsRefResolverDepsFromState, parseCdsRefs, resolveCdsRef } from './cross-project-refs.js';

export interface BranchEnvProfileResolution {
  baseline: BuildProfile;
  effective: BuildProfile;
  isExtra: boolean;
  hasOverride: boolean;
  profileLayers: EnvLayer[];
  /** 明文；输出到 API 前必须过 maskSecrets */
  provenance: EnvKeyProvenance[];
  /** 分支独立库没跟随的连接串（收敛 2） */
  perBranchDb?: { unfollowedUrls: Array<{ key: string; reason: string }> };
  envError?: string;
}

export interface BranchEnvResolution {
  customLayers: EnvLayer[];
  profiles: BranchEnvProfileResolution[];
}

export function resolveBranchEnvLayers(
  stateService: StateService,
  entry: BranchEntry,
  opts: { jwtIssuer: string; previewHost?: string },
): BranchEnvResolution {
  const projectId = entry.projectId || 'default';
  const project = stateService.getProject(projectId);
  const cdsEnv = stateService.getCdsEnvVars(projectId);
  const mirrorEnv = stateService.getMirrorEnvVars();
  const rawGlobal = project?.inheritGlobalEnv === true ? stateService.getCustomEnvScope('_global') : {};
  const rawProjectScoped = projectId === '_global' ? {} : stateService.getCustomEnvScope(projectId);
  const rawBranchScoped = stateService.getCustomEnvScope(entry.id);
  const derivedReserved: Record<string, string> = {};
  if (project) {
    derivedReserved.CDS_PROJECT_ID = project.id;
    derivedReserved.CDS_PROJECT_SLUG = project.slug;
  }
  const customLayers: EnvLayer[] = [
    { source: 'cds-builtin' as const, env: cdsEnv },
    { source: 'mirror' as const, env: mirrorEnv },
    { source: 'global' as const, env: rawGlobal },
    { source: 'project' as const, env: rawProjectScoped },
    { source: 'branch' as const, env: rawBranchScoped },
    { source: 'cds-derived' as const, env: derivedReserved },
  ].filter((l) => Object.keys(l.env).length > 0);

  const entrypointDeps = branchEntrypointDepsFromState(stateService, opts.previewHost);
  const refDeps = cdsRefResolverDepsFromState(stateService, opts.previewHost);
  const resolveRef = (raw: string): string | null => {
    const [ref] = parseCdsRefs(raw);
    return ref ? resolveCdsRef(refDeps, ref).url : null;
  };

  const extraIds = new Set((entry.extraProfiles || []).map((p) => p.id));
  const profiles = stateService.getEffectiveProfilesForBranch(entry).map((baseline): BranchEnvProfileResolution => {
    const isExtra = extraIds.has(baseline.id);
    const override = entry.profileOverrides?.[baseline.id];
    const effective = resolveEffectiveProfile(baseline, entry);
    const activeMode = override?.activeDeployMode !== undefined ? override.activeDeployMode : baseline.activeDeployMode;
    const modeEnv = (activeMode && baseline.deployModes?.[activeMode]?.env) || undefined;
    const profileLayers: EnvLayer[] = [
      { source: (isExtra ? 'extra-service' : 'profile') as EnvSource, env: baseline.env || {} },
      { source: 'branch-override' as const, env: override?.env || {} },
      { source: 'deploy-mode' as const, env: modeEnv || {} },
    ].filter((l) => Object.keys(l.env).length > 0);
    let provenance: EnvKeyProvenance[] = [];
    let perBranchDb: BranchEnvProfileResolution['perBranchDb'];
    let envError: string | undefined;
    try {
      const resolved = resolveProfileRuntimeEnvWithProvenance(entry, effective, customLayers, profileLayers, {
        jwtIssuer: opts.jwtIssuer,
        injectBullmqPrefix: process.env.CDS_BULLMQ_PREFIX_INJECTION !== '0',
        publishedEntrypoints: resolveBranchEntrypointsEnv(entry, entrypointDeps),
        resolveCdsRef: resolveRef,
      });
      provenance = resolved.provenance;
      perBranchDb = resolved.perBranchDb;
    } catch (err) {
      envError = (err as Error).message;
    }
    return {
      baseline, effective, isExtra,
      hasOverride: !!override && Object.keys(override).some((k) => k !== 'updatedAt' && k !== 'notes'),
      profileLayers, provenance, ...(perBranchDb ? { perBranchDb } : {}), ...(envError ? { envError } : {}),
    };
  });
  return { customLayers, profiles };
}
