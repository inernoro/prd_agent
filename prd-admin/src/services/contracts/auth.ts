import type { ApiResponse } from '@/types/api';
import type { UserRole } from '@/types/admin';

export type LoginResponse = {
  user: {
    userId: string;
    username: string;
    displayName: string;
    role: UserRole;
    userType?: 'Human' | 'Bot' | string;
    botKind?: 'PM' | 'DEV' | 'QA' | string;
    avatarFileName?: string | null;
    avatarUrl?: string | null;
  };
  accessToken: string;
  refreshToken: string;
  sessionKey: string;
  /** 是否需要重置密码（首次登录时为 true） */
  mustResetPassword?: boolean;
};

export type LoginContract = (username: string, password: string) => Promise<ApiResponse<LoginResponse>>;

export type SsoLoginOption = {
  provider: 'miduo-planet' | string;
  label: string;
  baseUrl: string;
  appCode: string;
  redirectUri: string;
};

export type SsoOptionsResponse = {
  items: SsoLoginOption[];
  passwordLoginDisabled: boolean;
};

export type GetSsoOptionsContract = () => Promise<ApiResponse<SsoOptionsResponse>>;

export type MiduoPlanetLoginContract = (token: string) => Promise<ApiResponse<LoginResponse>>;

export type ResetPasswordResponse = {
  userId: string;
  resetAt: string;
};

export type ResetPasswordContract = (userId: string, newPassword: string, confirmPassword: string, accessToken?: string) => Promise<ApiResponse<ResetPasswordResponse>>;
