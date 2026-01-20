import { ok, type ApiResponse } from '@/types/api';
import type { LoginContract, LoginResponse } from '@/services/contracts/auth';
import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';

type BackendLoginResponse = {
  accessToken: string;
  refreshToken: string;
  sessionKey: string;
  clientType: string;
  expiresIn: number;
  user: LoginResponse['user'];
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
  });
};
