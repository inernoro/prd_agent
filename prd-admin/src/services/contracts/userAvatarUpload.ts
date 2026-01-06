import type { ApiResponse } from '@/types/api';

export type AdminUserAvatarUploadResponse = {
  userId: string;
  avatarFileName?: string | null;
  avatarUrl?: string | null;
  updatedAt?: string;
};

export type UploadUserAvatarContract = (input: { userId: string; file: File }) => Promise<ApiResponse<AdminUserAvatarUploadResponse>>;


