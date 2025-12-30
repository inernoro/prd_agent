import type { ApiResponse } from '@/types/api';
import type { AdminUser, PagedResult, UserRole, UserStatus } from '@/types/admin';

export type GetUsersParams = {
  page: number;
  pageSize: number;
  search?: string;
  role?: UserRole;
  status?: UserStatus;
};

export type GetUsersContract = (params: GetUsersParams) => Promise<ApiResponse<PagedResult<AdminUser>>>;
export type UpdateUserRoleContract = (userId: string, role: UserRole) => Promise<ApiResponse<true>>;
export type UpdateUserStatusContract = (userId: string, status: UserStatus) => Promise<ApiResponse<true>>;
export type UpdateUserPasswordContract = (userId: string, password: string) => Promise<ApiResponse<true>>;
export type UnlockUserContract = (userId: string) => Promise<ApiResponse<true>>;

export type GenerateInviteCodesContract = (count: number) => Promise<ApiResponse<{ codes: string[] }>>;

export type ForceExpireTargets = Array<'admin' | 'desktop'>;
export type ForceExpireUserContract = (userId: string, targets: ForceExpireTargets) => Promise<ApiResponse<{ userId: string; targets: string[] }>>;
