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
};

export type LoginContract = (username: string, password: string) => Promise<ApiResponse<LoginResponse>>;
