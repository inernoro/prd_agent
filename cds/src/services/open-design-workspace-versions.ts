import { createHash } from 'node:crypto';
import type { OpenDesignWorkspaceVersionState, Project } from '../types.js';
import {
  AgentWorkspaceRuntimeError,
  type AgentWorkspaceRuntimeCapability,
} from './agent-workspace-session-runtime.js';
import type { StateService } from './state.js';

export type OpenDesignWorkspaceVersionChange =
  | { action: 'activate'; image: string; expectedImage: string }
  | { action: 'rollback'; expectedImage: string };

type VersionStates = Project['openDesignWorkspaceVersions'];

interface RunVersionAdmission {
  continuing: boolean;
  admittedImage?: string;
  previousImageDigest?: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Versions belong to one verified MAP origin. Image selection is committed before allocation. */
export class OpenDesignWorkspaceVersions {
  private readonly writes = new Map<string, Promise<void>>();
  private readonly beforeCommit = new Map<string, VersionStates>();
  private readonly checks = new Map<string, string>();
  private readonly failures = new Map<string, { image: string; reason: string }>();
  private readonly repository: string;

  constructor(
    private readonly state: Pick<StateService, 'getProject' | 'updateProject' | 'flush'>,
    readonly defaultImage: string,
    private readonly verifyImage: (image: string) => Promise<AgentWorkspaceRuntimeCapability>,
  ) {
    this.repository = defaultImage.split('@', 1)[0];
  }

  private isFixedImage(image: unknown): image is string {
    if (typeof image !== 'string') return false;
    const [repository, imageDigest, extra] = image.split('@');
    return repository === this.repository && /^sha256:[a-f0-9]{64}$/.test(imageDigest ?? '') && extra === undefined;
  }

  view(projectId: string, origin: string) {
    const scope = digest(origin);
    const key = `${projectId}:${scope}`;
    const states = this.beforeCommit.has(projectId)
      ? this.beforeCommit.get(projectId)
      : this.state.getProject(projectId)?.openDesignWorkspaceVersions;
    const version = states?.[scope];
    return {
      origin,
      activeImage: version?.activeImage ?? this.defaultImage,
      previousImage: version?.previousImage ?? null,
      changedAt: version?.changedAt ?? null,
      checkingImage: this.checks.get(key) ?? null,
      lastFailure: this.failures.get(key) ?? null,
      canUpdate: this.isFixedImage(this.defaultImage),
    };
  }

  private serialize<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.writes.get(projectId) ?? Promise.resolve()).then(operation);
    const settled = next.then(() => undefined, () => undefined);
    this.writes.set(projectId, settled);
    void settled.then(() => {
      if (this.writes.get(projectId) === settled) this.writes.delete(projectId);
    });
    return next;
  }

  private read(projectId: string, scope: string): { states: VersionStates; version: OpenDesignWorkspaceVersionState } {
    const project = this.state.getProject(projectId);
    if (!project) throw new AgentWorkspaceRuntimeError('project_not_found', 'CDS 项目已不存在', false);
    const states = project.openDesignWorkspaceVersions;
    const version = states?.[scope] ?? {
      baselineImage: this.defaultImage,
      activeImage: this.defaultImage,
      runImages: {},
    };
    return { states, version };
  }

  private async persist(projectId: string, states: VersionStates, scope: string, version: OpenDesignWorkspaceVersionState): Promise<void> {
    this.beforeCommit.set(projectId, states);
    try {
      this.state.updateProject(projectId, { openDesignWorkspaceVersions: { ...states, [scope]: version } });
      await this.state.flush();
    } catch {
      this.state.updateProject(projectId, { openDesignWorkspaceVersions: states });
      await this.state.flush().catch(() => undefined);
      throw new AgentWorkspaceRuntimeError('workspace_version_persist_failed', 'CDS 未能保存工作区版本，请重试', true);
    } finally {
      this.beforeCommit.delete(projectId);
    }
  }

  pin(projectId: string, origin: string, runId: string, admission: RunVersionAdmission): Promise<string> {
    const scope = digest(origin);
    const run = digest(runId);
    return this.serialize(projectId, async () => {
      const { states, version } = this.read(projectId, scope);
      const pinned = version.runImages[run];
      const priorImage = admission.previousImageDigest ? `${this.repository}@${admission.previousImageDigest}` : undefined;
      const hasPriorImage = priorImage && (
        priorImage === version.baselineImage || priorImage === version.activeImage
        || priorImage === version.previousImage || Object.values(version.runImages).includes(priorImage)
      );
      if ((pinned && priorImage && pinned !== priorImage) || (!pinned && admission.continuing && (
        priorImage ? !hasPriorImage : Boolean(version.changedAt)
      ))) {
        throw new AgentWorkspaceRuntimeError(
          'workspace_run_version_unconfirmed',
          '无法确认原任务使用的工作区版本，请恢复原会话记录后继续此任务',
          false,
        );
      }
      if (pinned) return pinned;
      const image = admission.continuing
        ? priorImage ?? version.baselineImage
        : admission.admittedImage ?? version.activeImage;
      if (!this.isFixedImage(image)) return image; // Compatibility for a node using a legacy tag.
      await this.persist(projectId, states, scope, {
        ...version,
        runImages: { ...version.runImages, [run]: image },
      });
      return image;
    });
  }

  async change(
    projectId: string,
    origin: string,
    change: OpenDesignWorkspaceVersionChange,
    scopeStillValid: () => boolean | Promise<boolean> = () => true,
  ) {
    const scope = digest(origin);
    const key = `${projectId}:${scope}`;
    const current = this.view(projectId, origin);
    if (current.checkingImage || current.activeImage !== change.expectedImage) {
      throw new AgentWorkspaceRuntimeError('workspace_version_conflict', '工作区版本已变化，请刷新后重试', false);
    }
    const image = change.action === 'rollback' ? current.previousImage : change.image;
    if (!this.isFixedImage(current.activeImage) || !this.isFixedImage(image)) {
      throw new AgentWorkspaceRuntimeError('workspace_version_image_invalid', '请选择同一运行时仓库的完整镜像摘要', false);
    }
    if (image === current.activeImage) return current;

    this.checks.set(key, image);
    this.failures.delete(key);
    try {
      const health = await this.verifyImage(image);
      if (!health.available || !health.resourcePolicyEnforcedPerSession) {
        const reason = health.reason ?? 'OpenDesign 工作区健康检查未通过';
        this.failures.set(key, { image, reason });
        throw new AgentWorkspaceRuntimeError('workspace_version_unhealthy', reason, true);
      }
      await this.serialize(projectId, async () => {
        const { states, version } = this.read(projectId, scope);
        if (version.activeImage !== change.expectedImage || !await scopeStillValid()) {
          throw new AgentWorkspaceRuntimeError('workspace_version_conflict', '工作区版本已变化，请刷新后重试', false);
        }
        await this.persist(projectId, states, scope, {
          ...version,
          activeImage: image,
          previousImage: version.activeImage,
          changedAt: new Date().toISOString(),
        });
      });
    } finally {
      this.checks.delete(key);
    }
    return this.view(projectId, origin);
  }
}
