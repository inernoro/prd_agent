import { randomUUID } from 'node:crypto';
import type { Project, ProjectIdentityRecord, ProjectIdentitySnapshot } from '../types.js';
import { buildPreviewUrlForProject } from './comment-template.js';
import { establishAgentOperationContext } from './agent-operation-context.js';

export interface ProjectIdentityActor {
  actor: string;
  requestId?: string;
  slugSource?: 'explicit' | 'repository' | 'name';
}

/** 操作者取自已认证账号或凭据归属；不把调用方自报的 header 当成已验证身份。 */
export function projectIdentityActorFromRequest(req: unknown): ProjectIdentityActor {
  const request = req as { cdsUser?: { id?: string }; cdsProjectKey?: { keyId?: string }; cdsAccess?: { keyId?: string } };
  const keyId = request.cdsProjectKey?.keyId || request.cdsAccess?.keyId;
  return {
    actor: request.cdsUser?.id ? `user:${request.cdsUser.id}` : keyId ? `agent:${keyId}` : 'unknown',
    requestId: establishAgentOperationContext(req).requestId,
  };
}

function safeRepository(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    // SCP-style Git remotes are valid; never retain arbitrary credential-bearing text.
    return /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(raw) ? raw : '[仓库地址未记录：无法安全脱敏]';
  }
}

export function projectIdentitySnapshot(project: Project): ProjectIdentitySnapshot {
  return {
    name: project.name,
    displayName: project.aliasName || project.name,
    previewIdentifier: buildPreviewUrlForProject('', '', project).projectIdentity.slug,
    originalIdentifier: project.slug,
    repository: safeRepository(project.gitRepoUrl),
  };
}

export function identityRecord(
  project: Project,
  kind: ProjectIdentityRecord['kind'],
  context: ProjectIdentityActor,
  before?: ProjectIdentitySnapshot,
): ProjectIdentityRecord {
  return {
    id: randomUUID(), at: new Date().toISOString(), kind,
    ...context, before, after: projectIdentitySnapshot(project),
  };
}

export function identityChanged(before: Project, after: Project): boolean {
  return JSON.stringify(projectIdentitySnapshot(before)) !== JSON.stringify(projectIdentitySnapshot(after));
}
