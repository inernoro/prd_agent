import { ok, type ApiResponse } from '@/types/api';
import type { LoginContract, LoginResponse, ResetPasswordContract, ResetPasswordResponse } from '@/services/contracts/auth';
import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';

type BackendLoginResponse = {
  accessToken: string;
  refreshToken: string;
  sessionKey: string;
  clientType: string;
  expiresIn: number;
  user: LoginResponse['user'];
  mustResetPassword?: boolean;
};

export const loginReal: LoginContract = async (username, password): Promise<ApiResponse<LoginResponse>> => {
  const res = await apiRequest<BackendLoginResponse>(api.auth.login(), {
    method: 'POST',
    auth: false,
    body: { username, password, clientType: 'admin' },
  });

  if (!res.success) return res;

  return ok({
    user: res.data.user,
    accessToken: res.data.accessToken,
    refreshToken: res.data.refreshToken,
    sessionKey: res.data.sessionKey,
    mustResetPassword: res.data.mustResetPassword,
  });
};

export const resetPasswordReal: ResetPasswordContract = async (userId, newPassword, confirmPassword): Promise<ApiResponse<ResetPasswordResponse>> => {
  return apiRequest<ResetPasswordResponse>(api.auth.resetPassword(), {
    method: 'POST',
    auth: false,
    body: { userId, newPassword, confirmPassword },
  });
};
