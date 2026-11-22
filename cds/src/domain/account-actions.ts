import type { CdsAccountRole, CdsUser } from './auth.js';

export const ACCOUNT_ACTIONS = ['reset-password', 'disable-user', 'revoke-sessions', 'revoke-admin', 'unlink-github', 'unlink-google'] as const;
export type AccountAction = typeof ACCOUNT_ACTIONS[number] | 'rotate-system-password' | 'recover-identity' | 'historical-account-event';

export type AccountActionState = 'pending' | 'verified' | 'executing' | 'completed' | 'rejected' | 'cancelled' | 'failed' | 'expired';

export interface AccountActionRequest {
  id: string;
  action: AccountAction;
  status: AccountActionState;
  targetId: string;
  targetName: string;
  targetRole: CdsAccountRole;
  targetStatus: CdsUser['status'];
  /** Revision of the authentication state at the time of the request. */
  targetRevision?: string;
  affectedSessions: number;
  scope?: 'all-system-sessions';
  reason: string;
  requestedByAccountId: string;
  requestedBy: string;
  requestedVia?: 'agent';
  proposalCredentialId?: string;
  createdAt: string;
  expiresAt: string;
  approvedByAccountId?: string;
  approvedBy?: string;
  approvedAt?: string;
  executedByAccountId?: string;
  decidedAt?: string;
  decisionReason?: string;
  failureCode?: string;
  verification?: { byAccountId: string; by: string; at: string; evidence: string };
  backfill?: { occurredAt: string; evidence: string; priorApproval: 'missing' | 'verified' };
  notifiedAt?: string;
}

export interface AccountActionStore {
  insert(request: AccountActionRequest): Promise<void>;
  get(id: string): Promise<AccountActionRequest | null>;
  list(filter: AccountActionFilter, limit: number): Promise<AccountActionRequest[]>;
  transition(request: AccountActionRequest, from: AccountActionState): Promise<boolean>;
}

export interface AccountActionFilter {
  targetId?: string;
  requestedByAccountId?: string;
  action?: AccountAction;
  from?: string;
  until?: string;
}

export const ACCOUNT_ACTION_LABELS: Record<AccountAction, string> = {
  'reset-password': '重置口令',
  'disable-user': '停用账号',
  'revoke-sessions': '退出全部会话',
  'revoke-admin': '撤销管理员',
  'rotate-system-password': '变更系统账号口令',
  'recover-identity': '恢复登录身份',
  'historical-account-event': '历史账号事件补录',
  'unlink-github': '解除 GitHub 绑定',
  'unlink-google': '解除 Google 绑定',
};

export type AccountSecurityChange = Pick<CdsUser,
  'sessionRevision' | 'lastAccountAction' | 'sessionRevocationNotices' | 'invitationHash' | 'invitationExpiresAt' | 'invitationForRecovery'> &
  Partial<Pick<CdsUser, 'status' | 'isAdministrator' | 'passwordHash' | 'passwordSalt'>>;
