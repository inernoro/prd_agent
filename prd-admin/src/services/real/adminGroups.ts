import { apiRequest } from '@/services/real/apiClient';
import { ok } from '@/types/api';
import type {
  AdminGroup,
  AdminGroupMember,
  AdminMessage,
  AdminGapStatus,
  GetAdminGroupGapsContract,
  GetAdminGroupMembersContract,
  GetAdminGroupMessagesContract,
  GetAdminGroupsContract,
  GetAdminGroupsParams,
  PagedResult,
  RegenerateAdminGroupInviteContract,
  RegenerateInviteResponse,
  RemoveAdminGroupMemberContract,
  UpdateAdminGapStatusContract,
  UpdateAdminGroupContract,
  UpdateAdminGroupInput,
  DeleteAdminGroupContract,
  DeleteAdminGroupMessagesContract,
  GenerateAdminGapSummaryContract,
  SimulateMessageContract,
  SimulateMessageInput,
  SimulateMessageResponse,
  SimulateStreamMessagesContract,
  SimulateStreamMessagesInput,
  SimulateStreamMessagesResponse,
} from '@/services/contracts/adminGroups';

export const getAdminGroupsReal: GetAdminGroupsContract = async (params: GetAdminGroupsParams) => {
  const q = new URLSearchParams();
  q.set('page', String(params.page));
  q.set('pageSize', String(params.pageSize));
  if (params.search) q.set('search', params.search);
  if (params.inviteStatus) q.set('inviteStatus', params.inviteStatus);
  if (params.sort) q.set('sort', params.sort);
  return await apiRequest<PagedResult<AdminGroup>>(`/api/v1/admin/groups?${q.toString()}`);
};

export const getAdminGroupMembersReal: GetAdminGroupMembersContract = async (groupId: string) => {
  return await apiRequest<AdminGroupMember[]>(`/api/v1/admin/groups/${encodeURIComponent(groupId)}/members`);
};

export const removeAdminGroupMemberReal: RemoveAdminGroupMemberContract = async (groupId: string, userId: string) => {
  const res = await apiRequest<true>(`/api/v1/admin/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    emptyResponseData: true,
  });
  if (!res.success) return res;
  return ok(true);
};

export const regenerateAdminGroupInviteReal: RegenerateAdminGroupInviteContract = async (groupId: string) => {
  return await apiRequest<RegenerateInviteResponse>(`/api/v1/admin/groups/${encodeURIComponent(groupId)}/regenerate-invite`, {
    method: 'POST',
    body: {},
  });
};

export const updateAdminGroupReal: UpdateAdminGroupContract = async (groupId: string, input: UpdateAdminGroupInput) => {
  const res = await apiRequest<true>(`/api/v1/admin/groups/${encodeURIComponent(groupId)}`, {
    method: 'PUT',
    body: input,
    emptyResponseData: true,
  });
  if (!res.success) return res;
  return ok(true);
};

export const deleteAdminGroupReal: DeleteAdminGroupContract = async (groupId: string) => {
  const res = await apiRequest<true>(`/api/v1/admin/groups/${encodeURIComponent(groupId)}`, {
    method: 'DELETE',
    emptyResponseData: true,
  });
  if (!res.success) return res;
  return ok(true);
};

export const deleteAdminGroupMessagesReal: DeleteAdminGroupMessagesContract = async (groupId: string) => {
  const res = await apiRequest<true>(`/api/v1/admin/groups/${encodeURIComponent(groupId)}/messages`, {
    method: 'DELETE',
    emptyResponseData: true,
  });
  if (!res.success) return res;
  return ok(true);
};

export const getAdminGroupGapsReal: GetAdminGroupGapsContract = async (groupId: string, params) => {
  const q = new URLSearchParams();
  if (params?.status) q.set('status', params.status);
  if (params?.page) q.set('page', String(params.page));
  if (params?.pageSize) q.set('pageSize', String(params.pageSize));
  const qs = q.toString();
  return await apiRequest<PagedResult<any>>(`/api/v1/groups/${encodeURIComponent(groupId)}/gaps${qs ? `?${qs}` : ''}`);
};

export const updateAdminGapStatusReal: UpdateAdminGapStatusContract = async (groupId: string, gapId: string, status: AdminGapStatus) => {
  const res = await apiRequest<true>(`/api/v1/groups/${encodeURIComponent(groupId)}/gaps/${encodeURIComponent(gapId)}/status`, {
    method: 'PUT',
    body: { status: status === 'pending' ? 'Pending' : status === 'resolved' ? 'Resolved' : 'Ignored' },
    emptyResponseData: true,
  });
  if (!res.success) return res;
  return ok(true);
};

export const generateAdminGapSummaryReal: GenerateAdminGapSummaryContract = async (groupId: string) => {
  return await apiRequest<{ report: string; generatedAt: string; totalGaps: number }>(
    `/api/v1/groups/${encodeURIComponent(groupId)}/gaps/summary-report`,
    { method: 'POST', body: {} }
  );
};

export const getAdminGroupMessagesReal: GetAdminGroupMessagesContract = async (groupId: string, params) => {
  const q = new URLSearchParams();
  q.set('page', String(params.page));
  q.set('pageSize', String(params.pageSize));
  if (params.q) q.set('q', params.q);
  return await apiRequest<PagedResult<AdminMessage>>(`/api/v1/admin/groups/${encodeURIComponent(groupId)}/messages?${q.toString()}`);
};

export const simulateMessageReal: SimulateMessageContract = async (input: SimulateMessageInput) => {
  return await apiRequest<SimulateMessageResponse>('/api/v1/admin/lab/simulate-message', {
    method: 'POST',
    body: input,
  });
};

export const simulateStreamMessagesReal: SimulateStreamMessagesContract = async (input: SimulateStreamMessagesInput) => {
  return await apiRequest<SimulateStreamMessagesResponse>('/api/v1/admin/lab/simulate-stream-messages', {
    method: 'POST',
    body: input,
  });
};

