import type { ApiResponse } from '@/types/api';
import type {
  ModelGroup,
  ModelGroupForApp,
  CreateModelGroupRequest,
  UpdateModelGroupRequest,
  ModelGroupMonitoringData,
  PoolPrediction,
} from '../../types/modelGroup';

export interface IModelGroupsService {
  /**
   * 获取模型分组列表
   */
  getModelGroups(modelType?: string): Promise<ApiResponse<ModelGroup[]>>;

  /**
   * 按应用标识获取模型分组列表（按优先级排序：专属池 > 默认池 > 传统配置）
   */
  getModelGroupsForApp(appCallerCode: string | null, modelType: string): Promise<ApiResponse<ModelGroupForApp[]>>;

  /**
   * 获取单个模型分组
   */
  getModelGroup(id: string): Promise<ApiResponse<ModelGroup>>;

  /**
   * 创建模型分组
   */
  createModelGroup(
    request: CreateModelGroupRequest
  ): Promise<ApiResponse<ModelGroup>>;

  /**
   * 更新模型分组
   */
  updateModelGroup(
    id: string,
    request: UpdateModelGroupRequest
  ): Promise<ApiResponse<ModelGroup>>;

  /**
   * 删除模型分组
   */
  deleteModelGroup(id: string): Promise<ApiResponse<{ id: string }>>;

  /**
   * 获取分组监控数据
   */
  getGroupMonitoring(groupId: string): Promise<ApiResponse<ModelGroupMonitoringData>>;

  /**
   * 模拟降权
   */
  simulateDowngrade(
    groupId: string,
    modelId: string,
    platformId: string,
    failureCount: number
  ): Promise<ApiResponse<void>>;

  /**
   * 模拟恢复
   */
  simulateRecover(
    groupId: string,
    modelId: string,
    platformId: string,
    successCount: number
  ): Promise<ApiResponse<void>>;

  /**
   * 预测下一次请求的调度路径
   */
  predictNextDispatch(groupId: string): Promise<ApiResponse<PoolPrediction>>;

  /**
   * 重置单个模型的健康状态为 Healthy
   */
  resetModelHealth(groupId: string, modelId: string): Promise<ApiResponse<void>>;

  /**
   * 重置模型池中所有模型的健康状态
   */
  resetAllModelsHealth(groupId: string): Promise<ApiResponse<void>>;
}
