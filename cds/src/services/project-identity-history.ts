import { createHash, randomUUID } from 'node:crypto';
import type { Project, ProjectIdentityRecord, ProjectIdentitySnapshot } from '../types.js';
import { establishAgentOperationContext } from './agent-operation-context.js';

export interface ProjectIdentityActor {
  actor: string;
  requestId?: string;
  slugSource?: 'explicit' | 'repository' | 'name';
}

export function projectIdentityVersion(project: Project): string {
  return project.identityHistory?.at(-1)?.id || '';
}

/** 摘要携带版本，完整设置记录只通过独立分页接口读取。 */
export function projectIdentityResponse(project: Project) {
  const { identityHistory: _history, ...summary } = project;
  return { ...summary, identityVersion: projectIdentityVersion(project) };
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
  // 镜像重复读取时保留本函数生成的安全展示值，不对指纹再次求指纹。
  if (/^\[仓库地址已脱敏：指纹 [a-f0-9]{16}\]$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    // SCP 格式也去掉用户名，与 URL 的 userinfo 脱敏保持一致。
    const scp = /^[\w.-]+@([\w.-]+):([\w./-]+)$/.exec(raw);
    return scp ? `${scp[1]}:${scp[2]}`
      : `[仓库地址已脱敏：指纹 ${createHash('sha256').update(raw).digest('hex').slice(0, 16)}]`;
  }
}

export function projectIdentitySnapshot(project: Project): ProjectIdentitySnapshot {
  return {
    name: project.name,
    displayName: project.aliasName || project.name,
    slug: project.slug,
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
  return before.gitRepoUrl !== after.gitRepoUrl ||
    JSON.stringify(projectIdentitySnapshot(before)) !== JSON.stringify(projectIdentitySnapshot(after));
}

/** 对外只显示一个 slug，旧快照中的原始字段仍留在存储中用于兼容取证。 */
export function publicIdentityRecord(record: ProjectIdentityRecord): ProjectIdentityRecord {
  const snapshot = (value: ProjectIdentitySnapshot): ProjectIdentitySnapshot => ({
    name: value.name, displayName: value.displayName,
    slug: value.slug || value.previewIdentifier || value.originalIdentifier || '', repository: value.repository,
  });
  return { ...record, before: record.before ? snapshot(record.before) : undefined, after: snapshot(record.after) };
}

/** 旧父实例镜像的导入边界；正常配置不保留 aliasSlug。 */
export function importLegacyProjectSlug(project: Project): Project {
  const legacy = project as Project & { aliasSlug?: string };
  if (!Object.hasOwn(legacy, 'aliasSlug')) return project;
  const next = { ...project, identityHistory: [...(project.identityHistory || [
    identityRecord(project, 'baseline', { actor: 'system:history-baseline' }),
  ])] };
  next.slug = legacy.aliasSlug?.trim().toLowerCase() || project.slug;
  delete (next as Project & { aliasSlug?: string }).aliasSlug;
  next.identityHistory.push(identityRecord(next, 'migrated', { actor: 'system:single-project-slug' }, projectIdentitySnapshot(project)));
  return next;
}
