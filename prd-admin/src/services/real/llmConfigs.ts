import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { ApiResponse } from '@/types/api';
import type { GetLLMConfigsContract } from '@/services/contracts/llmConfigs';
import type { LLMConfig } from '@/types/admin';

// 2026-08-25 模型管理退场：旧 LLM 配置的增删改与激活搬到 LLM Gateway 控制台，MAP 侧写接口已 410。

export const getLLMConfigsReal: GetLLMConfigsContract = async (): Promise<ApiResponse<LLMConfig[]>> => {
  return await apiRequest<LLMConfig[]>(api.mds.llmConfigs.list());
};

