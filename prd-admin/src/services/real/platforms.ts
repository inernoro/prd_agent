import type { GetPlatformsContract } from '@/services/contracts/platforms';
import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { Platform } from '@/types/admin';

// 2026-08-25 模型管理退场：上游平台的增删改搬到 LLM Gateway 控制台，MAP 侧写接口已 410。

export const getPlatformsReal: GetPlatformsContract = async () => {
  return await apiRequest<Platform[]>(api.mds.platforms.list());
};
