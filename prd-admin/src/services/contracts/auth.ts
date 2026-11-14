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

export type SyntheticLoginContract = (code: string) => Promise<ApiResponse<LoginResponse>>;

export type ResetPasswordResponse = {
  userId: string;
  resetAt: string;
};

export type ResetPasswordContract = (userId: string, newPassword: string, confirmPassword: string, accessToken?: string) => Promise<ApiResponse<ResetPasswordResponse>>;

/**
 * 自助改密：凭旧密码随时改，改完服务端会作废别处的会话，
 * 并把当前这一端换成一副新令牌（所以返回的是完整登录态，不是一个 ok）。
 */
export type ChangePasswordContract = (
  currentPassword: string,
  newPassword: string,
  confirmPassword: string,
) => Promise<ApiResponse<LoginResponse>>;
