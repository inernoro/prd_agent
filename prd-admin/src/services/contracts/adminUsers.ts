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
export type UpdateUserAvatarContract = (userId: string, avatarFileName: string | null) => Promise<ApiResponse<{ userId: string; avatarFileName?: string | null; avatarUrl?: string | null; updatedAt?: string }>>;
export type UpdateUserDisplayNameContract = (userId: string, displayName: string) => Promise<ApiResponse<{ userId: string; displayName: string; updatedAt?: string }>>;
export type UnlockUserContract = (userId: string) => Promise<ApiResponse<true>>;

export type GenerateInviteCodesContract = (count: number) => Promise<ApiResponse<{ codes: string[] }>>;

export type ForceExpireTargets = Array<'admin' | 'desktop'>;
export type ForceExpireUserContract = (userId: string, targets: ForceExpireTargets) => Promise<ApiResponse<{ userId: string; targets: string[] }>>;

export type CreateAdminUserInput = {
  username: string;
  password: string;
  role: UserRole;
  displayName?: string;
};

export type CreateAdminUserResponse = {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
};

export type CreateAdminUserContract = (input: CreateAdminUserInput) => Promise<ApiResponse<CreateAdminUserResponse>>;

export type BulkCreateAdminUsersItem = CreateAdminUserInput;

export type BulkCreateAdminUsersResponse = {
  requestedCount: number;
  createdCount: number;
  failedCount: number;
  createdItems: CreateAdminUserResponse[];
  failedItems: Array<{ username: string; code: string; message: string }>;
};

export type BulkCreateAdminUsersContract = (items: BulkCreateAdminUsersItem[]) => Promise<ApiResponse<BulkCreateAdminUsersResponse>>;

// 用户简要资料（用于卡片悬浮展示）
export type UserProfileGroupItem = {
  groupId: string;
  name: string;
  memberCount: number;
};

export type UserProfileAgentUsageItem = {
  appKey: string;
  usageCount: number;
};

export type UserProfileResponse = {
  userId: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  userType: string;
  botKind?: string | null;
  avatarFileName?: string | null;
  avatarUrl?: string | null;
  createdAt: string;
  lastLoginAt?: string | null;
  lastActiveAt?: string | null;
  isLocked: boolean;
  groups: UserProfileGroupItem[];
  agentUsage: UserProfileAgentUsageItem[];
  /** 生成的图片总数（最近30天） */
  totalImageCount: number;
  /** 生图任务总数（最近30天） */
  totalRunCount: number;
};

export type GetUserProfileContract = (userId: string) => Promise<ApiResponse<UserProfileResponse>>;
