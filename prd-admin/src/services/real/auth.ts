import { ok, type ApiResponse } from '@/types/api';
import type { LoginContract, LoginResponse } from '@/services/contracts/auth';
import { apiRequest } from '@/services/real/apiClient';

type BackendLoginResponse = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: LoginResponse['user'];
};

export const loginReal: LoginContract = async (username, password): Promise<ApiResponse<LoginResponse>> => {
  const res = await apiRequest<BackendLoginResponse>('/api/v1/auth/login', {
    method: 'POST',
    auth: false,
    body: { username, password },
  });

  if (!res.success) return res;

  return ok({
    user: res.data.user,
    accessToken: res.data.accessToken,
  });
};


