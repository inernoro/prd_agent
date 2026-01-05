import { apiRequest } from '@/services/real/apiClient';
import { ok, type ApiResponse } from '@/types/api';
import type {
  GetUsersContract,
  GenerateInviteCodesContract,
  CreateAdminUserContract,
  BulkCreateAdminUsersContract,
  UpdateUserPasswordContract,
  UpdateUserAvatarContract,
  UpdateUserRoleContract,
  UpdateUserStatusContract,
  UnlockUserContract,
  ForceExpireUserContract,
  ForceExpireTargets,
  GetUsersParams,
  CreateAdminUserInput,
  CreateAdminUserResponse,
  BulkCreateAdminUsersItem,
  BulkCreateAdminUsersResponse,
} from '@/services/contracts/adminUsers';
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

export const updateUserPasswordReal: UpdateUserPasswordContract = async (userId: string, password: string): Promise<ApiResponse<true>> => {
  const res = await apiRequest<unknown>(`/api/v1/admin/users/${encodeURIComponent(userId)}/password`, {
    method: 'PUT',
    body: { password },
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const updateUserAvatarReal: UpdateUserAvatarContract = async (
  userId: string,
  avatarFileName: string | null
): Promise<ApiResponse<{ userId: string; avatarFileName?: string | null; updatedAt?: string }>> => {
  const res = await apiRequest<{ userId: string; avatarFileName?: string | null; updatedAt?: string }>(
    `/api/v1/admin/users/${encodeURIComponent(userId)}/avatar`,
    {
      method: 'PUT',
      body: { avatarFileName: avatarFileName || null },
    }
  );
  return res;
};

export const unlockUserReal: UnlockUserContract = async (userId: string): Promise<ApiResponse<true>> => {
  const res = await apiRequest<unknown>(`/api/v1/admin/users/${encodeURIComponent(userId)}/unlock`, {
    method: 'POST',
    body: {},
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

export const forceExpireUserReal: ForceExpireUserContract = async (
  userId: string,
  targets: ForceExpireTargets
): Promise<ApiResponse<{ userId: string; targets: string[] }>> => {
  const ts = Array.isArray(targets) ? targets : [];
  const res = await apiRequest<{ userId: string; targets: string[] }>(
    `/api/v1/admin/users/${encodeURIComponent(userId)}/force-expire`,
    {
      method: 'POST',
      body: { targets: ts },
    }
  );
  return res;
};

function newIdempotencyKey() {
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
  const uuid = c?.randomUUID?.();
  if (uuid) return uuid;
  return `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export const createUserReal: CreateAdminUserContract = async (input: CreateAdminUserInput): Promise<ApiResponse<CreateAdminUserResponse>> => {
  const res = await apiRequest<CreateAdminUserResponse>(`/api/v1/admin/users`, {
    method: 'POST',
    body: {
      username: (input.username ?? '').trim(),
      password: input.password ?? '',
      role: input.role,
      displayName: input.displayName,
    },
    headers: { 'Idempotency-Key': newIdempotencyKey() },
  });
  return res;
};

export const bulkCreateUsersReal: BulkCreateAdminUsersContract = async (
  items: BulkCreateAdminUsersItem[]
): Promise<ApiResponse<BulkCreateAdminUsersResponse>> => {
  const arr = Array.isArray(items) ? items : [];
  const res = await apiRequest<BulkCreateAdminUsersResponse>(`/api/v1/admin/users/bulk`, {
    method: 'POST',
    body: {
      items: arr.map((it) => ({
        username: (it.username ?? '').trim(),
        password: it.password ?? '',
        role: it.role,
        displayName: it.displayName,
      })),
    },
    headers: { 'Idempotency-Key': newIdempotencyKey() },
  });
  return res;
};


