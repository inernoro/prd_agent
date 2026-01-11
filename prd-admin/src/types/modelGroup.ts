/**
 * 模型健康状态
 */
export enum ModelHealthStatus {
  Healthy = 'Healthy',
  Degraded = 'Degraded',
  Unavailable = 'Unavailable',
}

/**
 * 模型分组中的模型项
 */
export interface ModelGroupItem {
  modelId: string;
  platformId: string;
  priority: number;
  healthStatus: ModelHealthStatus;
  lastFailedAt?: string;
  lastSuccessAt?: string;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

/**
 * 模型分组
 */
export interface ModelGroup {
  id: string;
  name: string;
  code: string;
  isSystemGroup: boolean;
  models: ModelGroupItem[];
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 创建模型分组请求
 */
export interface CreateModelGroupRequest {
  name: string;
  code: string;
  description?: string;
  models?: ModelGroupItem[];
}

/**
 * 更新模型分组请求
 */
export interface UpdateModelGroupRequest {
  name?: string;
  description?: string;
  models?: ModelGroupItem[];
}

/**
 * 模型监控数据（用于分组监控）
 */
export interface ModelGroupMonitoringData {
  groupId: string;
  groupName: string;
  models: Array<{
    modelId: string;
    platformId: string;
    priority: number;
    healthStatus: ModelHealthStatus;
    consecutiveFailures: number;
    consecutiveSuccesses: number;
    healthScore: number;
    lastFailedAt?: string;
    lastSuccessAt?: string;
  }>;
}

/**
 * 模型类型常量
 */
export const ModelTypes = {
  Chat: 'chat',
  Intent: 'intent',
  Vision: 'vision',
  ImageGen: 'image-gen',
  Code: 'code',
  LongContext: 'long-context',
  Embedding: 'embedding',
  Rerank: 'rerank',
} as const;

export type ModelType = (typeof ModelTypes)[keyof typeof ModelTypes];

/**
 * 模型类型显示名称映射
 */
export const ModelTypeLabels: Record<ModelType, string> = {
  [ModelTypes.Chat]: '对话',
  [ModelTypes.Intent]: '意图',
  [ModelTypes.Vision]: '视觉',
  [ModelTypes.ImageGen]: '生图',
  [ModelTypes.Code]: '代码',
  [ModelTypes.LongContext]: '长文本',
  [ModelTypes.Embedding]: '嵌入',
  [ModelTypes.Rerank]: '重排',
};

/**
 * 健康状态显示名称映射
 */
export const HealthStatusLabels: Record<ModelHealthStatus, string> = {
  [ModelHealthStatus.Healthy]: '健康',
  [ModelHealthStatus.Degraded]: '降权',
  [ModelHealthStatus.Unavailable]: '不可用',
};

/**
 * 健康状态颜色映射
 */
export const HealthStatusColors: Record<ModelHealthStatus, string> = {
  [ModelHealthStatus.Healthy]: 'text-green-400',
  [ModelHealthStatus.Degraded]: 'text-yellow-400',
  [ModelHealthStatus.Unavailable]: 'text-red-400',
};
