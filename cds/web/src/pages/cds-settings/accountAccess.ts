import { apiRequest, type CdsAuthPublicStatus, type CdsPublicUser } from '@/lib/api';

export const accountLoginMethods = [
  ['github', 'GitHub'],
  ['google', 'Google'],
  ['sso', '单点登录'],
  ['local', '个人口令'],
] as const;

type AccountLoginMethod = typeof accountLoginMethods[number][0];
export type AvailableAccountLogins = Record<AccountLoginMethod, boolean>;

export function availableAccountLogins(
  loginMethods: CdsAuthPublicStatus['loginMethods'], accountProviders?: CdsAuthPublicStatus['accountProviders'],
): AvailableAccountLogins {
  return { github: loginMethods.github, google: accountProviders?.google === true, sso: loginMethods.sso, local: loginMethods.local };
}

export function hasAccountLogin(user: CdsPublicUser, method: AccountLoginMethod): boolean {
  switch (method) {
    case 'github': return user.linkedLogins ? Boolean(user.linkedLogins.github) : user.authProvider === 'github';
    case 'google': return Boolean(user.linkedLogins?.google);
    case 'sso': return user.authProvider === 'sso';
    case 'local': return user.hasPassword ?? user.authProvider === 'local';
  }
}

export const accountViews = [
  ['members', '成员'],
  ['approvals', '待批申请'],
  ['recovery', '身份恢复'],
  ['system', '系统账号'],
  ['keys', 'Key 通知'],
  ['matrix', '权限矩阵'],
] as const;

export type AccountView = typeof accountViews[number][0];

export function readAccountView(search: URLSearchParams): AccountView {
  return accountViews.find(([value]) => value === search.get('accountView'))?.[0] ?? 'members';
}

export const actionLabels = {
  'reset-password': '重置口令',
  'disable-user': '停用账号',
  'revoke-sessions': '退出全部会话',
  'revoke-admin': '撤销管理员',
  'rotate-system-password': '变更系统口令',
  'recover-identity': '恢复登录身份',
  'historical-account-event': '历史账号事件补录',
  'unlink-github': '解除 GitHub 绑定',
  'unlink-google': '解除 Google 绑定',
} as const;

export type AccountAction = keyof typeof actionLabels;

export const actionStateLabels = {
  pending: '待确认',
  verified: '已核实',
  executing: '正在执行',
  completed: '已执行',
  rejected: '已退回',
  cancelled: '已撤回',
  failed: '执行失败',
  expired: '已过期',
} as const;

export interface AccountActionEntry {
  id: string;
  action: AccountAction;
  status: keyof typeof actionStateLabels;
  targetId: string;
  targetName: string;
  affectedSessions: number;
  managementMode?: 'offline';
  scope?: 'all-system-sessions';
  reason?: string;
  requestedByAccountId?: string;
  requestedBy?: string;
  requestedVia?: 'agent';
  createdAt: string;
  expiresAt?: string;
  approvedBy?: string;
  approvedByAccountId?: string;
  approvedAt?: string;
  executedByAccountId?: string;
  decidedAt?: string;
  decisionReason?: string;
  failureCode?: string;
  verification?: { byAccountId: string; by: string; at: string; evidence: string };
  backfill?: { occurredAt: string; evidence: string; priorApproval: 'missing' | 'verified' };
}

const api = '/api/auth/account-actions';

export async function requestAccountAction(action: AccountAction, targetId: string, reason: string): Promise<AccountActionEntry> {
  return (await apiRequest<{ request: AccountActionEntry }>(api, { method: 'POST', body: { action, targetId, reason } })).request;
}

export async function listAccountActions(signal?: AbortSignal): Promise<AccountActionEntry[]> {
  return (await apiRequest<{ requests: AccountActionEntry[] }>(api, { signal })).requests;
}

export async function decideAccountAction(
  id: string,
  decision: 'confirm' | 'reject' | 'cancel',
  body: { targetName?: string; newPassword?: string; reason?: string },
): Promise<AccountActionEntry> {
  return (await apiRequest<{ request: AccountActionEntry }>(`${api}/${encodeURIComponent(id)}/${decision}`, { method: 'POST', body })).request;
}

export async function listAccountActionAudit(query: URLSearchParams, signal?: AbortSignal): Promise<AccountActionEntry[]> {
  return (await apiRequest<{ records: AccountActionEntry[] }>(`/api/auth/account-action-audit?${query}`, { signal })).records;
}
