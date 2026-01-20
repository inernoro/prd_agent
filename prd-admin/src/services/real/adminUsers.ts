import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import { ok, type ApiResponse } from '@/types/api';
import type {
  GetUsersContract,
  GenerateInviteCodesContract,
  CreateAdminUserContract,
  BulkCreateAdminUsersContract,
  UpdateUserPasswordContract,
  UpdateUserAvatarContract,
  UpdateUserDisplayNameContract,
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

  const res = await apiRequest<BackendPagedUsers>(`${api.users.list()}?${q.toString()}`);
  if (!res.success) return res as unknown as ApiResponse<PagedResult<AdminUser>>;
  return ok({ items: res.data.items ?? [], total: res.data.total ?? 0 });
};

export const updateUserRoleReal: UpdateUserRoleContract = async (userId: string, role: UserRole): Promise<ApiResponse<true>> => {
  const res = await apiRequest<unknown>(api.users.role(userId), {
    method: 'PUT',
    body: { role },
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const updateUserStatusReal: UpdateUserStatusContract = async (userId: string, status: UserStatus): Promise<ApiResponse<true>> => {
  const res = await apiRequest<unknown>(api.users.status(userId), {
    method: 'PUT',
    body: { status },
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const updateUserPasswordReal: UpdateUserPasswordContract = async (userId: string, password: string): Promise<ApiResponse<true>> => {
  const res = await apiRequest<unknown>(api.users.password(userId), {
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
    api.users.avatar(userId),
    {
      method: 'PUT',
      body: { avatarFileName: avatarFileName || null },
    }
  );
  return res;
};

export const updateUserDisplayNameReal: UpdateUserDisplayNameContract = async (
  userId: string,
  displayName: string
): Promise<ApiResponse<{ userId: string; displayName: string; updatedAt?: string }>> => {
  const name = (displayName ?? '').trim();
  const res = await apiRequest<{ userId: string; displayName: string; updatedAt?: string }>(
    api.users.displayName(userId),
    {
      method: 'PUT',
      body: { displayName: name },
    }
  );
  return res;
};

export const unlockUserReal: UnlockUserContract = async (userId: string): Promise<ApiResponse<true>> => {
  const res = await apiRequest<unknown>(api.users.unlock(userId), {
    method: 'POST',
    body: {},
  });
  if (!res.success) return res as unknown as ApiResponse<true>;
  return ok(true);
};

export const generateInviteCodesReal: GenerateInviteCodesContract = async (count: number): Promise<ApiResponse<{ codes: string[] }>> => {
  const res = await apiRequest<{ codes: string[] }>(api.users.inviteCodes(), {
    method: 'POST',
    body: { count: Math.max(1, Math.min(50, Math.floor(count || 1))) },
  });
  if (!res.success) return res;
  return ok({ codes: res.data.codes ?? [] });
};

export const initializeUsersReal = async (): Promise<ApiResponse<{ deletedCount: number; adminUserId: string; botUserIds: string[] }>> => {
  const res = await apiRequest<{ deletedCount: number; adminUserId: string; botUserIds: string[] }>(api.users.initialize(), {
    method: 'POST',
  });
  if (!res.success) return res;
  return ok({ deletedCount: res.data.deletedCount ?? 0, adminUserId: res.data.adminUserId ?? '', botUserIds: res.data.botUserIds ?? [] });
};

export const forceExpireUserReal: ForceExpireUserContract = async (
  userId: string,
  targets: ForceExpireTargets
): Promise<ApiResponse<{ userId: string; targets: string[] }>> => {
  const ts = Array.isArray(targets) ? targets : [];
  const res = await apiRequest<{ userId: string; targets: string[] }>(
    api.users.forceExpire(userId),
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
  const res = await apiRequest<CreateAdminUserResponse>(api.users.list(), {
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
  const res = await apiRequest<BulkCreateAdminUsersResponse>(api.users.bulk(), {
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
