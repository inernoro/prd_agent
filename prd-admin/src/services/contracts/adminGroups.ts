import type { ApiResponse } from '@/types/api';

export type InviteStatus = 'all' | 'valid' | 'expired';

export type AdminGroupOwner = {
  userId: string;
  username: string;
  displayName: string;
  role: 'PM' | 'DEV' | 'QA' | 'ADMIN';
};

export type AdminGroup = {
  groupId: string;
  groupName: string;
  owner?: AdminGroupOwner | null;
  memberCount: number;
  prdTitleSnapshot?: string | null;
  prdTokenEstimateSnapshot?: number | null;
  prdCharCountSnapshot?: number | null;
  inviteCode: string;
  inviteExpireAt?: string | null;
  maxMembers: number;
  createdAt: string;
  lastMessageAt?: string | null;
  messageCount: number;
  pendingGapCount: number;
};

export type PagedResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type GetAdminGroupsParams = {
  page: number;
  pageSize: number;
  search?: string;
  inviteStatus?: InviteStatus;
  sort?: 'recent' | 'created' | 'gaps' | 'messages';
};

export type GetAdminGroupsContract = (params: GetAdminGroupsParams) => Promise<ApiResponse<PagedResult<AdminGroup>>>;

export type AdminGroupMember = {
  userId: string;
  username: string;
  displayName: string;
  role: 'PM' | 'DEV' | 'QA' | 'ADMIN';
  joinedAt: string;
  isOwner: boolean;
};

export type GetAdminGroupMembersContract = (groupId: string) => Promise<ApiResponse<AdminGroupMember[]>>;
export type RemoveAdminGroupMemberContract = (groupId: string, userId: string) => Promise<ApiResponse<true>>;

export type RegenerateInviteResponse = { inviteCode: string; inviteLink: string; inviteExpireAt?: string | null };
export type RegenerateAdminGroupInviteContract = (groupId: string) => Promise<ApiResponse<RegenerateInviteResponse>>;

export type UpdateAdminGroupInput = {
  groupName?: string;
  inviteExpireAt?: string | null;
  maxMembers?: number;
};
export type UpdateAdminGroupContract = (groupId: string, input: UpdateAdminGroupInput) => Promise<ApiResponse<true>>;
export type DeleteAdminGroupContract = (groupId: string) => Promise<ApiResponse<true>>;

export type AdminGapStatus = 'pending' | 'resolved' | 'ignored';
export type AdminGapItem = {
  gapId: string;
  question: string;
  gapType: string;
  askedAt: string;
  status: AdminGapStatus;
  askedBy?: { userId: string; displayName: string; role: 'PM' | 'DEV' | 'QA' | 'ADMIN' } | null;
  suggestion?: string | null;
};

export type GetAdminGroupGapsParams = {
  status?: AdminGapStatus;
  page?: number;
  pageSize?: number;
};

export type GetAdminGroupGapsContract = (groupId: string, params?: GetAdminGroupGapsParams) => Promise<ApiResponse<PagedResult<AdminGapItem>>>;
export type UpdateAdminGapStatusContract = (groupId: string, gapId: string, status: AdminGapStatus) => Promise<ApiResponse<true>>;
export type GenerateAdminGapSummaryContract = (groupId: string) => Promise<ApiResponse<{ report: string; generatedAt: string; totalGaps: number }>>;

export type AdminMessage = {
  id: string;
  groupId: string;
  sessionId: string;
  senderId?: string | null;
  senderName?: string | null;
  senderRole?: 'PM' | 'DEV' | 'QA' | 'ADMIN' | null;
  role: 'User' | 'Assistant';
  content: string;
  llmRequestId?: string | null;
  viewRole?: 'PM' | 'DEV' | 'QA' | 'ADMIN' | null;
  timestamp: string;
  tokenUsage?: { input: number; output: number } | null;
};

export type GetAdminGroupMessagesParams = {
  page: number;
  pageSize: number;
  q?: string;
};

export type GetAdminGroupMessagesContract = (groupId: string, params: GetAdminGroupMessagesParams) => Promise<ApiResponse<PagedResult<AdminMessage>>>;

// 模拟发送消息
export type SimulateMessageInput = {
  groupId: string;
  content: string;
  triggerAiReply: boolean;
};
export type SimulateMessageResponse = {
  messageId: string;
  groupSeq: number;
  triggerAiReply: boolean;
};
export type SimulateMessageContract = (input: SimulateMessageInput) => Promise<ApiResponse<SimulateMessageResponse>>;

