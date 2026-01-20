import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import { ok, type ApiResponse } from '@/types/api';
import type { AdminImpersonateContract, AdminImpersonateResponse } from '@/services/contracts/lab';

type BackendImpersonateResponse = AdminImpersonateResponse;

export const adminImpersonateReal: AdminImpersonateContract = async (
  userId: string,
  expiresInSeconds?: number
): Promise<ApiResponse<AdminImpersonateResponse>> => {
  const res = await apiRequest<BackendImpersonateResponse>(api.lab.impersonate(), {
    method: 'POST',
    body: { userId, expiresInSeconds },
  });
  if (!res.success) return res;
  return ok(res.data);
};


