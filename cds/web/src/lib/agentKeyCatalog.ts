/**
 * Agent Key 目录的前端类型与「这把 Key 能做什么」说明（2026-11-25，Agent Key 管理一期）。
 *
 * 数据契约镜像 cds/src/services/agent-key-catalog.ts：来源与状态由服务端判定，
 * 这里只负责把它们翻成人话。
 *
 * describeAgentKey 是唯一的说明生成函数：签发前的实时预览、签发后的回执、列表
 * 详情三处都调用它，所以用户签发前读到的内容，就是签发后记录里写的内容。
 */

export type AgentKeyScope = 'project' | 'all' | 'create';
export type AgentKeyPermission =
  | 'full'
  | 'planning-read'
  | 'planning-propose'
  | 'design-read'
  | 'design-feedback'
  | 'design-publish';
export type AgentKeyExpiry = 'never' | 'fixed' | 'sliding';

export type AgentKeySource =
  | { type: 'user'; via: 'console'; actor?: string }
  | {
    type: 'agent';
    via: 'machine-api' | 'access-request' | 'self-service' | 'device-recovery' | 'project-create' | 'user-credential';
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

export interface AgentKeyAccessView {
  scope: AgentKeyScope;
  projects: Array<{ id: string; name: string; missing?: true }>;
  canCreateProjects: boolean;
  permission: AgentKeyPermission;
  legacyFullAccess?: true;
  oneTime?: true;
}

export interface AgentKeyCatalogEntry {
  id: string;
  kind: 'project' | 'global';
  label: string;
  projectId?: string;
  access: AgentKeyAccessView;
  createdAt: string;
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
  expiry: AgentKeyExpiry;
  source: AgentKeySource;
  status: { code: AgentKeyStatusCode; usable: boolean };
}

/** 列表行的稳定身份：项目 Key 的 8 位编号只在项目内唯一。 */
export function agentKeyRowId(entry: Pick<AgentKeyCatalogEntry, 'kind' | 'projectId' | 'id'>): string {
  return entry.kind === 'project' ? `project:${entry.projectId}:${entry.id}` : `global:${entry.id}`;
}

/** 校验接口返回，字段对不上就拒绝显示，不把半截数据当成有效状态。 */
export function isAgentKeyCatalogEntry(value: unknown): value is AgentKeyCatalogEntry {
  const v = value as Partial<AgentKeyCatalogEntry> | null;
  return Boolean(v && typeof v.id === 'string' && (v.kind === 'project' || v.kind === 'global')
    && typeof v.createdAt === 'string' && v.access && Array.isArray(v.access.projects)
    && v.source && typeof v.source.type === 'string' && v.status && typeof v.status.code === 'string');
}

export const PERMISSION_OPTIONS: Array<{ value: AgentKeyPermission; label: string; detail: string }> = [
  { value: 'full', label: '项目完整读写', detail: '部署与重启分支、修改构建配置和项目环境变量、管理本项目的 Agent Key' },
  { value: 'planning-read', label: '工程规划只读', detail: '只能读取本项目的工程规划与债务' },
  { value: 'planning-propose', label: '工程规划提案', detail: '读取工程规划，并提交待人工处理的提案' },
  { value: 'design-read', label: '设计稿只读', detail: '只能读取本项目的私有设计稿' },
  { value: 'design-feedback', label: '设计实施反馈', detail: '读取设计稿，并提交实施反馈' },
  { value: 'design-publish', label: '设计稿件发布', detail: '读取设计稿，并发布经 Git 校验的稿件' },
];

const CAN: Record<AgentKeyPermission, string[]> = {
  full: [
    '部署、重启、停止分支，查看部署记录与容器日志',
    '修改构建配置与项目环境变量',
    '为同一项目签发、吊销 Agent Key',
  ],
  'planning-read': ['读取工程规划与债务'],
  'planning-propose': ['读取工程规划与债务', '提交工程规划提案（由人处理后生效）'],
  'design-read': ['读取私有设计稿'],
  'design-feedback': ['读取私有设计稿', '提交设计实施反馈'],
  'design-publish': ['读取私有设计稿', '提交设计实施反馈', '发布经 Git 校验的设计稿件'],
};

export interface AgentKeyDescription {
  scope: string;
  can: string[];
  cannot: string[];
  expiry: string;
  risk: { level: 'low' | 'mid' | 'high'; label: string; reason: string };
}

export interface DescribeInput {
  access: AgentKeyAccessView;
  expiry: AgentKeyExpiry;
  expiresAt?: string;
}

const DAY = 86_400_000;

export function formatKeyDateTime(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function describeExpiry(expiry: AgentKeyExpiry, expiresAt: string | undefined, now: number = Date.now()): string {
  if (expiry === 'never' || !expiresAt) return '永久有效，直到被吊销';
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return '到期时间无法读取，请重新读取列表';
  if (at <= now) return `已于 ${formatKeyDateTime(at)} 失效`;
  const days = Math.ceil((at - now) / DAY);
  if (expiry === 'sliding') return `闲置 30 天自动失效，每次使用自动续期（目前到 ${formatKeyDateTime(at)}）`;
  return `${formatKeyDateTime(at)} 自动失效（还剩 ${days} 天）`;
}

/** 唯一说明函数：签发预览、回执、列表详情共用。 */
export function describeAgentKey(input: DescribeInput, totalProjects?: number, now: number = Date.now()): AgentKeyDescription {
  const { access } = input;
  const names = access.projects.map((p) => (p.missing ? `${p.name}（项目已不存在）` : p.name));
  let scope: string;
  if (access.scope === 'project') {
    scope = names.length === 0 ? '尚未选择项目' : names.length === 1 ? `只能访问 ${names[0]}` : `只能访问 ${names.length} 个指定项目：${names.join('、')}`;
  } else if (access.scope === 'all') {
    scope = `可访问全部现有项目${typeof totalProjects === 'number' ? `（当前 ${totalProjects} 个）` : ''}，以后新建的项目也包括在内`;
  } else {
    scope = '不能访问任何现有项目，只能创建新项目。每建一个项目，CDS 会另发一把只能用于该项目的 Key';
  }
  if (access.scope !== 'create' && access.canCreateProjects) scope += '；也可以创建新项目';

  const can: string[] = [];
  const cannot: string[] = [];
  if (access.legacyFullAccess) {
    can.push('旧版全权：读写、配置并部署全部项目，也能创建项目（签发时还没有授权范围）');
  } else if (access.scope === 'create') {
    can.push('创建新项目');
    can.push('每建一个项目，拿到该项目的完整读写 Key');
  } else {
    can.push(...CAN[access.permission]);
    if (access.canCreateProjects) can.push('创建新项目');
  }

  if (access.scope === 'project' && access.projects.length > 0) cannot.push('不能访问其他项目');
  if (access.scope === 'create') cannot.push('不能读取或修改任何现有项目');
  if (access.permission !== 'full') cannot.push('不能部署分支，不能修改构建配置或环境变量');
  cannot.push('不能签发或吊销全局 Key');
  if (access.permission === 'full' || access.legacyFullAccess) cannot.push('写数据库时，每次都要等系统所有者批准');
  if (access.oneTime) cannot.push('建成第一个项目后自动吊销，只能用一次');

  const readOnly = access.permission === 'planning-read' || access.permission === 'design-read';
  const submitOnly = access.permission === 'planning-propose' || access.permission === 'design-feedback';
  let risk: AgentKeyDescription['risk'];
  if (access.scope === 'all' || access.legacyFullAccess) {
    risk = { level: 'high', label: '高风险', reason: '能改动全部项目，泄露后影响整个 CDS' };
  } else if (access.scope === 'create' || access.canCreateProjects) {
    risk = { level: 'mid', label: '中风险', reason: '能创建新项目' };
  } else if (readOnly || submitOnly) {
    risk = { level: 'low', label: '低风险', reason: readOnly ? '只读' : '只能提交待人工处理的内容' };
  } else {
    risk = { level: 'mid', label: '中风险', reason: access.permission === 'full' ? '能部署并修改这个项目' : '能发布设计稿件' };
  }

  return { scope, can, cannot, expiry: describeExpiry(input.expiry, input.expiresAt, now), risk };
}

export function sourceLabel(source: AgentKeySource): string {
  if (source.type === 'user') return '用户签发';
  if (source.type === 'agent') return 'AI Agent 签发';
  return '来源未记录';
}

/** 来源的一句话说明，列表行与详情共用。 */
export function sourceSentence(source: AgentKeySource): string {
  if (source.type === 'user') return source.actor ? `${source.actor} 在页面签发` : '在页面签发';
  if (source.type === 'agent') {
    const agent = source.agentName || 'Agent';
    switch (source.via) {
      case 'access-request': return `${agent} 申请，${source.approvedBy ? `${source.approvedBy} ` : ''}批准`;
      case 'self-service': return `${agent} 用用户凭据自助签发`;
      case 'device-recovery': return `${agent} 设备接入，${source.approvedBy ? `${source.approvedBy} ` : ''}批准`;
      case 'project-create': return `${agent} 建项目时获得`;
      case 'user-credential': return '经用户凭据签发，具体通道未记录';
      default: return '通过接口签发，没有人工会话';
    }
  }
  return source.recordedAccount ? `签发时未记录来源，账号字段为 ${source.recordedAccount}` : '签发时未记录来源';
}

/** 来源链：详情里逐步讲清这把 Key 是怎么来的。 */
export function sourceSteps(source: AgentKeySource): string[] {
  if (source.type === 'user') return [`${source.actor || '已登录用户'} 在 CDS 页面签发`];
  if (source.type === 'unknown') {
    const steps = ['这把 Key 签发时，系统还没有记录签发来源。不会根据名称推测来源。'];
    if (source.recordedAccount) steps.push(`记录里的账号字段是 ${source.recordedAccount}，但无法确认是本人签发还是批准了 Agent 申请。`);
    if (source.claimedBy) steps.push(`归属已由 ${source.claimedBy} 人工核对${source.claimedAt ? `（${formatKeyDateTime(source.claimedAt)}）` : ''}；核对的是归属，签发来源仍未记录。`);
    return steps;
  }
  const agent = source.agentName || 'Agent';
  switch (source.via) {
    case 'access-request':
      return [
        `${agent} 发起接入申请${source.requestId ? `（申请编号 ${source.requestId}）` : ''}`,
        `${source.approvedBy || '有权限的用户'} 在 CDS 页面批准`,
        'CDS 签发这把 Key，由 CLI 直接保存到项目本地',
      ];
    case 'self-service':
      return [
        `${agent} 使用用户凭据${source.credentialId ? ` ${source.credentialId}` : ''} 为已授权项目自助签发`,
        '该用户凭据被吊销或主体停用时，这把 Key 同时失效',
      ];
    case 'device-recovery':
      return [
        `${agent} 发起设备接入`,
        `${source.approvedBy || '管理员'} 在用户管理批准`,
        '设备收到用户凭据和这把项目 Key',
      ];
    case 'project-create':
      return [
        `${agent} 使用“仅创建新项目”的 Key${source.parentKeyId ? ` ${source.parentKeyId}` : ''} 创建了项目`,
        'CDS 自动签发这把只能用于该项目的 Key',
      ];
    case 'user-credential':
      return [`经用户凭据${source.credentialId ? ` ${source.credentialId}` : ''} 签发；是自助签发还是设备接入，签发时没有记录`];
    default:
      return ['调用方没有人工登录会话（例如 bootstrap 静态 Key），通过接口签发'];
  }
}

export const STATUS_TEXT: Record<AgentKeyStatusCode, string> = {
  active: '有效',
  expiring: '即将过期',
  expired: '已过期',
  revoked: '已吊销',
  'principal-disabled': '所属主体已停用',
  'principal-missing': '所属主体不存在',
  'grant-revoked': '项目授权已收回',
  'grant-pending': '授权保存中',
};

export function statusText(entry: Pick<AgentKeyCatalogEntry, 'status' | 'expiresAt'>, now: number = Date.now()): string {
  if (entry.status.code === 'expiring' && entry.expiresAt) {
    const left = Date.parse(entry.expiresAt) - now;
    if (left > 0) return left < DAY ? `${Math.max(1, Math.round(left / 3_600_000))} 小时后过期` : `${Math.ceil(left / DAY)} 天后过期`;
  }
  return STATUS_TEXT[entry.status.code];
}

/** 列表行里的范围与权限缩写。 */
export function accessShort(access: AgentKeyAccessView): string {
  const scope = access.scope === 'all' ? '全部项目' : access.scope === 'create' ? '仅创建新项目' : access.projects.map((p) => p.name).join('、') || '未选项目';
  if (access.legacyFullAccess) return `${scope} · 旧版全权`;
  if (access.scope === 'create') return scope;
  const permission = PERMISSION_OPTIONS.find((p) => p.value === access.permission)?.label || '完整读写';
  return `${scope} · ${permission}${access.canCreateProjects ? ' · 可建项目' : ''}`;
}

export type ExpiryChoice = 'never' | '1' | '7' | '30' | '90' | 'date';

/** 页面上选的有效期 → 提交给接口的 expiresAt（undefined = 永久）。指定日期取当天 23:59。 */
export function expiryChoiceToIso(choice: ExpiryChoice, date: string, now: number = Date.now()): string | undefined | null {
  if (choice === 'never') return undefined;
  if (choice === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const at = new Date(`${date}T23:59:00`).getTime();
    return Number.isNaN(at) || at <= now ? null : new Date(at).toISOString();
  }
  return new Date(now + Number(choice) * DAY).toISOString();
}
