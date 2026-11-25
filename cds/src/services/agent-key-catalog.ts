/**
 * Agent Key 目录（2026-11-25，Agent Key 管理一期）。
 *
 * 把项目级 Key（cdsp_）和全局 Key（cdsg_）合成一张列表，并在服务端给出三件
 * 前端不该自己猜的事：
 *
 * 1. **签发来源**：用户签发 / AI Agent 签发 / 来源未记录。新 Key 读 issuedVia；
 *    存量 Key 只读结构化字段，其余如实标为未记录，**不解析标签文字**。
 * 2. **当前状态**：与鉴权同一判据（StateService.agentKeyUsability /
 *    globalAgentKeyUsability）。旧列表只看 revokedAt，把已过期、随主体停用的
 *    Key 报成「未吊销」。
 * 3. **范围与到期方式**：项目名、能否建项目、受限权限、永久 / 固定 / 滑动续期。
 *
 * 纯函数，不写状态；路由层只负责鉴权与筛选参数。
 */
import type { AgentKey, AgentKeyIssuedVia, GlobalAgentKey, Principal, Project } from '../types.js';
import { StateService } from './state.js';

/** 「即将过期」提示的窗口。固定到期日在这之内才提醒，避免新签的 7 天 Key 一出生就报警。 */
export const AGENT_KEY_EXPIRING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export type AgentKeySourceView =
  | { type: 'user'; via: 'console'; actor?: string }
  | {
    type: 'agent';
    via: Exclude<AgentKeyIssuedVia, 'console'> | 'user-credential';
    agentName?: string;
    approvedBy?: string;
    requestId?: string;
    credentialId?: string;
    parentKeyId?: string;
  }
  | { type: 'unknown'; recordedAccount?: string; claimedBy?: string; claimedAt?: string };

export type AgentKeyStatusCode =
  | 'active'
  | 'expiring'
  | 'expired'
  | 'revoked'
  | 'principal-disabled'
  | 'principal-missing'
  | 'grant-revoked'
  | 'grant-pending';

export type AgentKeyPermission =
  | 'full'
  | 'planning-read'
  | 'planning-propose'
  | 'design-read'
  | 'design-feedback'
  | 'design-publish';

export interface AgentKeyCatalogEntry {
  id: string;
  kind: 'project' | 'global';
  label: string;
  /** 项目级 Key 的归属项目；全局 Key 无。 */
  projectId?: string;
  access: {
    /** project = 指定项目；all = 全部项目（含以后新建的）；create = 只能创建新项目。 */
    scope: 'project' | 'all' | 'create';
    projects: Array<{ id: string; name: string; missing?: true }>;
    canCreateProjects: boolean;
    permission: AgentKeyPermission;
    /** 存量全局 Key 没有 access 字段，鉴权按全权解析；如实告诉用户。 */
    legacyFullAccess?: true;
    /** 一次性建项目授权：建成首个项目后自动吊销。 */
    oneTime?: true;
  };
  createdAt: string;
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
  /** never = 永久；fixed = 到点失效；sliding = 闲置到期，使用即续期。 */
  expiry: 'never' | 'fixed' | 'sliding';
  source: AgentKeySourceView;
  status: { code: AgentKeyStatusCode; usable: boolean };
}

export interface AgentKeyCatalogInput {
  state: StateService;
  /** 只看能访问该项目的 Key（项目级 + 覆盖它的全局 Key）。 */
  projectId?: string;
  now?: number;
}

function projectName(p: Project): string {
  return p.aliasName || p.name || p.slug || p.id;
}

function principalName(principals: readonly Principal[], id?: string): string | undefined {
  if (!id) return undefined;
  return principals.find((p) => p.id === id)?.name;
}

/** 签发来源的唯一判定。导出给单测；路由与前端都不另写一份。 */
export function deriveAgentKeySource(
  entry: Pick<AgentKey, 'issuedVia' | 'createdBy' | 'requesterAgentName' | 'accessRequestId' | 'issuedByCredentialId' | 'issuedByGlobalKeyId' | 'designAccessRequestId' | 'claimedBy' | 'claimedAt' | 'principalId'>,
  principals: readonly Principal[] = [],
): AgentKeySourceView {
  const agentName = entry.requesterAgentName || principalName(principals, entry.principalId);
  const withName = agentName ? { agentName } : {};
  switch (entry.issuedVia) {
    case 'console':
      return { type: 'user', via: 'console', ...(entry.createdBy ? { actor: entry.createdBy } : {}) };
    case 'machine-api':
      return { type: 'agent', via: 'machine-api', ...withName };
    case 'access-request':
      return {
        type: 'agent', via: 'access-request', ...withName,
        ...(entry.createdBy ? { approvedBy: entry.createdBy } : {}),
        ...(entry.accessRequestId ? { requestId: entry.accessRequestId } : {}),
      };
    case 'self-service':
      return {
        type: 'agent', via: 'self-service', ...withName,
        ...(entry.issuedByCredentialId ? { credentialId: entry.issuedByCredentialId } : {}),
      };
    case 'device-recovery':
      return {
        type: 'agent', via: 'device-recovery', ...withName,
        ...(entry.createdBy ? { approvedBy: entry.createdBy } : {}),
        ...(entry.issuedByCredentialId ? { credentialId: entry.issuedByCredentialId } : {}),
      };
    case 'project-create':
      return {
        type: 'agent', via: 'project-create', ...withName,
        ...(entry.issuedByGlobalKeyId ? { parentKeyId: entry.issuedByGlobalKeyId } : {}),
      };
    default:
      break;
  }
  // 存量 Key：只认结构化字段。issuedByCredentialId 只可能来自用户级凭据通道
  // （自助签发或设备接入），但存量数据分不清是哪一条，所以只说到这一层。
  if (entry.issuedByCredentialId) {
    return { type: 'agent', via: 'user-credential', ...withName, credentialId: entry.issuedByCredentialId };
  }
  // 设计权限只能经 Agent 申请、人批准获得（routes/access-requests.ts）。
  if (entry.designAccessRequestId) {
    return {
      type: 'agent', via: 'access-request', ...withName, requestId: entry.designAccessRequestId,
      ...(entry.createdBy ? { approvedBy: entry.createdBy } : {}),
    };
  }
  // createdBy 单独存在不足以判定：批准申请签发的存量 Key 也会写 createdBy。
  return {
    type: 'unknown',
    ...(entry.createdBy ? { recordedAccount: entry.createdBy } : {}),
    ...(entry.claimedBy ? { claimedBy: entry.claimedBy } : {}),
    ...(entry.claimedAt ? { claimedAt: entry.claimedAt } : {}),
  };
}

function statusOf(
  usability: { usable: true } | { usable: false; reason: string },
  expiresAt: string | undefined,
  now: number,
): AgentKeyCatalogEntry['status'] {
  if (!usability.usable) {
    const reason = usability.reason;
    const code: AgentKeyStatusCode = reason === 'revoked' ? 'revoked'
      : reason === 'expired' ? 'expired'
        : reason === 'grant-revoked' ? 'grant-revoked'
          : reason === 'grant-pending' ? 'grant-pending'
            : reason === 'principal-missing' ? 'principal-missing'
              : 'principal-disabled';
    return { code, usable: false };
  }
  const at = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isNaN(at) && at - now <= AGENT_KEY_EXPIRING_WINDOW_MS) return { code: 'expiring', usable: true };
  return { code: 'active', usable: true };
}

function permissionOf(entry: Pick<AgentKey, 'planningAccess' | 'designAccess'>): AgentKeyPermission {
  if (entry.planningAccess === 'read') return 'planning-read';
  if (entry.planningAccess === 'propose') return 'planning-propose';
  if (entry.designAccess === 'read') return 'design-read';
  if (entry.designAccess === 'feedback') return 'design-feedback';
  if (entry.designAccess === 'publish') return 'design-publish';
  return 'full';
}

function projectEntry(
  project: Project,
  entry: AgentKey,
  state: StateService,
  principals: readonly Principal[],
  now: number,
): AgentKeyCatalogEntry {
  return {
    id: entry.id,
    kind: 'project',
    label: entry.label,
    projectId: project.id,
    access: {
      scope: 'project',
      projects: [{ id: project.id, name: projectName(project) }],
      canCreateProjects: false,
      permission: permissionOf(entry),
    },
    createdAt: entry.createdAt,
    ...(entry.createdBy ? { createdBy: entry.createdBy } : {}),
    ...(entry.lastUsedAt ? { lastUsedAt: entry.lastUsedAt } : {}),
    ...(entry.revokedAt ? { revokedAt: entry.revokedAt } : {}),
    ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
    expiry: !entry.expiresAt ? 'never' : entry.expiryMode === 'fixed' ? 'fixed' : 'sliding',
    source: deriveAgentKeySource(entry, principals),
    status: statusOf(state.agentKeyUsability(project.id, entry, now), entry.expiresAt, now),
  };
}

function globalEntry(
  entry: GlobalAgentKey,
  projectsById: Map<string, Project>,
  principals: readonly Principal[],
  now: number,
): AgentKeyCatalogEntry {
  const access = StateService.resolveGlobalAgentKeyAccess(entry);
  const projects = access.projects === 'all' ? [] : access.projects.map((id) => {
    const p = projectsById.get(id);
    return p ? { id, name: projectName(p) } : { id, name: id, missing: true as const };
  });
  const scope: AgentKeyCatalogEntry['access']['scope'] = access.projects === 'all'
    ? 'all'
    : projects.length > 0 ? 'project' : 'create';
  return {
    id: entry.id,
    kind: 'global',
    label: entry.label,
    access: {
      scope,
      projects,
      canCreateProjects: access.canCreateProjects,
      permission: 'full',
      ...(entry.access ? {} : { legacyFullAccess: true as const }),
      ...(entry.oneTime ? { oneTime: true as const } : {}),
    },
    createdAt: entry.createdAt,
    ...(entry.createdBy ? { createdBy: entry.createdBy } : {}),
    ...(entry.lastUsedAt ? { lastUsedAt: entry.lastUsedAt } : {}),
    ...(entry.revokedAt ? { revokedAt: entry.revokedAt } : {}),
    ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
    expiry: entry.expiresAt ? 'fixed' : 'never',
    source: deriveAgentKeySource(entry, principals),
    status: statusOf(StateService.globalAgentKeyUsability(entry, now), entry.expiresAt, now),
  };
}

/** 合并后的 Key 列表，按签发时间倒序（最近签发的在最前）。 */
export function buildAgentKeyCatalog(input: AgentKeyCatalogInput): AgentKeyCatalogEntry[] {
  const now = input.now ?? Date.now();
  const { state } = input;
  const projects = state.getProjects();
  const projectsById = new Map(projects.map((p) => [p.id, p]));
  const principals = state.getPrincipals();
  const rows: AgentKeyCatalogEntry[] = [];
  for (const project of projects) {
    if (input.projectId && project.id !== input.projectId) continue;
    for (const entry of project.agentKeys || []) rows.push(projectEntry(project, entry, state, principals, now));
  }
  for (const entry of state.getGlobalAgentKeys()) {
    const row = globalEntry(entry, projectsById, principals, now);
    if (input.projectId && row.access.scope !== 'all'
      && !row.access.projects.some((p) => p.id === input.projectId)) continue;
    rows.push(row);
  }
  return rows.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
}

/**
 * 解析页面传来的固定到期时间。返回 undefined = 永久；返回 string = 规范化 ISO；
 * 返回 { error } = 拒绝（已过去、无法解析或超过 5 年）。
 */
export function parseRequestedKeyExpiry(
  raw: unknown,
  now: number = Date.now(),
): undefined | string | { error: string } {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return { error: '失效时间格式无效，请重新选择。' };
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return { error: '失效时间格式无效，请重新选择。' };
  if (at <= now + 60_000) return { error: '失效时间需要晚于当前时间。' };
  if (at > now + 5 * 366 * 24 * 60 * 60 * 1000) return { error: '失效时间最长 5 年；需要更久请选择永久。' };
  return new Date(at).toISOString();
}
