import type {
  GetModelsContract,
  GetModelAdapterInfoContract,
  GetModelsAdapterInfoBatchContract,
  GetAdapterInfoByModelNameContract,
  ModelAdapterInfo,
  ModelAdapterInfoBrief,
} from '@/services/contracts/models';
import { apiRequest } from '@/services/real/apiClient';
import { api } from '@/services/api';
import type { Model } from '@/types/admin';

// 2026-08-25 模型管理退场：模型的增删改、用途标记（主/意图/视觉/生图）与优先级
// 全部搬到 LLM Gateway 控制台，MAP 侧对应写接口已 410。这里只留读。

export const getModelsReal: GetModelsContract = async () => {
  return await apiRequest<Model[]>(api.mds.models());
};

export const getModelAdapterInfoReal: GetModelAdapterInfoContract = async (modelId: string) => {
  return await apiRequest<ModelAdapterInfo>(api.mds.adapterInfo(modelId));
};

export const getModelsAdapterInfoBatchReal: GetModelsAdapterInfoBatchContract = async (modelIds: string[]) => {
  return await apiRequest<Record<string, ModelAdapterInfoBrief>>(api.mds.adapterInfoBatch(), {
    method: 'POST',
    body: modelIds,
  });
};

/** 根据平台侧模型名直接获取适配信息（无需查询数据库） */
export const getAdapterInfoByModelNameReal: GetAdapterInfoByModelNameContract = async (modelName: string) => {
  return await apiRequest<ModelAdapterInfo>(api.mds.adapterInfoByModelName(modelName));
};

