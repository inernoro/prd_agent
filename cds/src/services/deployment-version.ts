import crypto from 'node:crypto';
import type {
  BranchEntry,
  BuildProfile,
  DeploymentVersion,
  DeploymentVersionProfile,
} from '../types.js';
import type { StateService } from './state.js';

export interface CreateDeploymentVersionInput {
  projectId: string;
  branchId: string;
  commitSha: string;
  configHash: string;
  profiles: BuildProfile[];
  branch: BranchEntry;
  createdByRunId: string;
  migrations?: DeploymentVersion['migrations'];
  capabilities?: DeploymentVersion['capabilities'];
}

export class DeploymentVersionService {
  constructor(
    private readonly stateService: StateService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  computeConfigHash(profiles: BuildProfile[], effectiveEnv: Record<string, string>): string {
    const normalizedProfiles = profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      dockerImage: profile.dockerImage,
      command: profile.command || '',
      workDir: profile.workDir,
      containerWorkDir: profile.containerWorkDir || '',
      containerPort: profile.containerPort,
      env: profile.env || {},
      pathPrefixes: profile.pathPrefixes || [],
      subdomain: profile.subdomain || '',
      dependsOn: profile.dependsOn || [],
      readinessProbe: profile.readinessProbe || null,
      startupSignal: profile.startupSignal || '',
      activeDeployMode: profile.activeDeployMode || '',
      prebuiltImage: profile.prebuiltImage === true,
      entrypoint: profile.entrypoint,
      resources: profile.resources || null,
    })).sort((left, right) => left.id.localeCompare(right.id));
    return sha256(stableStringify({ profiles: normalizedProfiles, effectiveEnv }));
  }

  create(input: CreateDeploymentVersionInput): DeploymentVersion {
    const versionProfiles = input.profiles.map((profile) => this.captureProfile(profile, input.branch));
    const identity = {
      projectId: input.projectId,
      branchId: input.branchId,
      commitSha: input.commitSha,
      configHash: input.configHash,
      profiles: versionProfiles,
      migrations: input.migrations || [],
      capabilities: input.capabilities || [],
    };
    const id = `dv_${sha256(stableStringify(identity)).slice(0, 24)}`;
    const existing = this.stateService.getDeploymentVersion(id);
    if (existing) return existing;
    return this.stateService.addDeploymentVersion({
      id,
      ...identity,
      createdByRunId: input.createdByRunId,
      createdAt: this.now().toISOString(),
    });
  }

  get(id: string): DeploymentVersion | undefined {
    return this.stateService.getDeploymentVersion(id);
  }

  list(filters: { projectId?: string; branchId?: string; commitSha?: string } = {}): DeploymentVersion[] {
    return this.stateService.getDeploymentVersions(filters);
  }

  resolveRollbackTarget(branchId: string, requestedVersionId?: string): DeploymentVersion | undefined {
    const branch = this.stateService.getBranch(branchId);
    if (!branch) return undefined;
    const versions = this.stateService.getDeploymentVersions({ branchId });
    if (requestedVersionId) return versions.find((version) => version.id === requestedVersionId);
    return versions.find((version) =>
      version.id !== branch.currentVersionId
      && version.profiles.length > 0
      && version.profiles.every((profile) => profile.reusable),
    );
  }

  findReusable(input: {
    projectId: string;
    branchId: string;
    commitSha: string;
    configHash: string;
  }): DeploymentVersion | undefined {
    return this.stateService.getDeploymentVersions({
      projectId: input.projectId,
      branchId: input.branchId,
      commitSha: input.commitSha,
    }).find((version) =>
      version.configHash === input.configHash
      && version.profiles.length > 0
      && version.profiles.every((profile) => profile.reusable),
    );
  }

  assertReusable(version: DeploymentVersion): void {
    const blocked = version.profiles.filter((profile) => !profile.reusable);
    if (blocked.length === 0) return;
    throw new Error(blocked.map((profile) =>
      `${profile.profileId}: ${profile.reuseBlockedReason || '产物不可复用'}`,
    ).join('; '));
  }

  materializeProfiles(version: DeploymentVersion, currentProfiles: BuildProfile[]): BuildProfile[] {
    this.assertReusable(version);
    return version.profiles.map((snapshot) => {
      const current = currentProfiles.find((profile) => profile.id === snapshot.profileId);
      if (!current) {
        throw new Error(`当前项目缺少版本所需构建配置: ${snapshot.profileId}`);
      }
      return {
        ...current,
        name: snapshot.name,
        dockerImage: snapshot.artifactImage,
        command: snapshot.runtimeCommand,
        containerPort: snapshot.containerPort,
        containerWorkDir: snapshot.containerWorkDir,
        pathPrefixes: snapshot.pathPrefixes,
        subdomain: snapshot.subdomain,
        dependsOn: snapshot.dependsOn,
        readinessProbe: snapshot.readinessProbe,
        startupSignal: snapshot.startupSignal,
        activeDeployMode: snapshot.deployedMode,
        prebuiltImage: true,
        fallbackImage: undefined,
        sourceFallbackProfile: undefined,
      };
    });
  }

  private captureProfile(profile: BuildProfile, branch: BranchEntry): DeploymentVersionProfile {
    const service = branch.services[profile.id];
    const artifactImage = service?.deployedImage || profile.dockerImage;
    const actualMode = service?.deployedMode ?? profile.activeDeployMode ?? '';
    const reusable = profile.prebuiltImage === true && isImmutableImageReference(artifactImage);
    return {
      profileId: profile.id,
      name: profile.name,
      artifactImage,
      artifactKind: reusable ? 'prebuilt-image' : 'legacy-runtime',
      reusable,
      reuseBlockedReason: reusable
        ? undefined
        : profile.prebuiltImage === true
          ? '实际镜像不是 digest 或 sha-* 不可变引用'
          : 'legacy compose/source 将构建与启动写在同一 command，需 managed build/start 契约后才能复用',
      runtimeCommand: profile.command,
      containerPort: profile.containerPort,
      containerWorkDir: profile.containerWorkDir,
      pathPrefixes: profile.pathPrefixes,
      subdomain: profile.subdomain,
      dependsOn: profile.dependsOn,
      readinessProbe: profile.readinessProbe,
      startupSignal: profile.startupSignal,
      deployedMode: actualMode,
    };
  }
}

export function isImmutableImageReference(image: string): boolean {
  const normalized = image.trim();
  return /@sha256:[0-9a-f]{64}$/i.test(normalized)
    || /:sha-[0-9a-f]{7,40}$/i.test(normalized);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
