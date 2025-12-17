import type { ApiResponse } from '@/types/api';
import type { UserRole } from '@/types/admin';

export type AdminImpersonateResponse = {
  accessToken: string;
  expiresIn: number;
  user: { userId: string; username: string; displayName: string; role: UserRole };
};

export type AdminImpersonateContract = (userId: string, expiresInSeconds?: number) => Promise<ApiResponse<AdminImpersonateResponse>>;

