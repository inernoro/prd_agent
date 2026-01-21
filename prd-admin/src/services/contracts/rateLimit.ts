import type { ApiResponse } from '@/types/api';

export interface GlobalRateLimitConfig {
  maxRequestsPerMinute: number;
  maxConcurrentRequests: number;
}

export interface UserRateLimitConfig {
  userId: string;
  username: string;
  displayName?: string | null;
  isExempt: boolean;
  hasCustomConfig: boolean;
  maxRequestsPerMinute: number;
  maxConcurrentRequests: number;
  globalMaxRequestsPerMinute: number;
  globalMaxConcurrentRequests: number;
}

export interface ExemptUserItem {
  userId: string;
  username: string;
  displayName?: string | null;
}

export interface CustomConfigItem {
  userId: string;
  username: string;
  displayName?: string | null;
  maxRequestsPerMinute: number;
  maxConcurrentRequests: number;
}

export type GetGlobalRateLimitContract = () => Promise<ApiResponse<GlobalRateLimitConfig>>;

export type UpdateGlobalRateLimitContract = (
  maxRequestsPerMinute: number,
  maxConcurrentRequests: number
) => Promise<ApiResponse<GlobalRateLimitConfig>>;

export type GetUserRateLimitContract = (userId: string) => Promise<ApiResponse<UserRateLimitConfig>>;

export type UpdateUserRateLimitContract = (
  userId: string,
  data: {
    isExempt?: boolean;
    useCustomConfig?: boolean;
    maxRequestsPerMinute?: number;
    maxConcurrentRequests?: number;
  }
) => Promise<ApiResponse<UserRateLimitConfig>>;

export type GetExemptUsersContract = () => Promise<ApiResponse<{ items: ExemptUserItem[] }>>;

export type GetCustomConfigsContract = () => Promise<ApiResponse<{ items: CustomConfigItem[] }>>;
