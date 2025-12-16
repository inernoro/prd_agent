import { apiRequest } from '@/services/real/apiClient';
import { ok, type ApiResponse } from '@/types/api';
import type { GetUsersContract, GenerateInviteCodesContract, UpdateUserRoleContract, UpdateUserStatusContract, GetUsersParams } from '@/services/contracts/adminUsers';
import type { AdminUser, PagedResult, UserRole, UserStatus } from '@/types/admin';

type BackendPagedUsers = {
  items: AdminUser[];
  total: number;
  page?: number;
  pageSize?: number;
};

export const getUsersReal: GetUsersContract = async (params: GetUsersParams): Promise<ApiResponse<PagedResult<AdminUser>>> => {
  const q = new URLSearchParams();
  q.set('page', String(params.page));
  q.set('pageSize', String(params.pageSize));
  if (params.search) q.set('search', params.search);
  if (params.role) q.set('role', params.role);
  if (params.status) q.set('status', params.status);

  const res = await apiRequest<BackendPagedUsers>(`/api/v1/admin/users?${q.toString()}`);
  if (!res.success) return res as unknown as ApiResponse<PagedResult<AdminUser>>;
  return ok({ items: res.data.items ?? [], total: res.data.total ?? 0 });
};

export const updateUserRoleReal: UpdateUserRoleContract = async (userId: string, role: UserRole): Promise<ApiResponse<true>> => {
  const res = await apiRequest<unknown>(`/api/v1/admin/users/${encodeURIComponent(userId)}/role`, {
    method: 'PUT',
    body: { role },
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const updateUserStatusReal: UpdateUserStatusContract = async (userId: string, status: UserStatus): Promise<ApiResponse<true>> => {
  const res = await apiRequest<unknown>(`/api/v1/admin/users/${encodeURIComponent(userId)}/status`, {
    method: 'PUT',
    body: { status },
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const generateInviteCodesReal: GenerateInviteCodesContract = async (count: number): Promise<ApiResponse<{ codes: string[] }>> => {
  const res = await apiRequest<{ codes: string[] }>(`/api/v1/admin/users/invite-codes`, {
    method: 'POST',
    body: { count: Math.max(1, Math.min(50, Math.floor(count || 1))) },
  });
  if (!res.success) return res;
  return ok({ codes: res.data.codes ?? [] });
};


