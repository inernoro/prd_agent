import type { ApiResponse } from '@/types/api';

export type AdminNoHeadAvatarUploadResponse = {
  key: string; // 固定 nohead.png
  path: string; // icon/backups/head/nohead.png
  url: string; // 可访问 URL（若后端能拼出）
  mime: string;
  sizeBytes: number;
};

export type UploadNoHeadAvatarContract = (input: { file: File }) => Promise<ApiResponse<AdminNoHeadAvatarUploadResponse>>;


