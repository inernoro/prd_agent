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
 * 调度策略类型
 */
export enum PoolStrategyType {
  FailFast = 0,
  Race = 1,
  Sequential = 2,
  RoundRobin = 3,
  WeightedRandom = 4,
  LeastLatency = 5,
}

/**
 * 模型分组
 */
export interface ModelGroup {
  id: string;
  name: string;
  /** 对外暴露的模型名字（允许重复，用于匹配调用方期望的模型） */
  code: string;
  /** 优先级（数字越小优先级越高，默认50） */
  priority: number;
  /** 后端：模型类型（chat/intent/vision/image-gen/...） */
  modelType: string;
  /** 后端：是否为该类型默认分组 */
  isDefaultForType: boolean;
  /** 调度策略类型 */
  strategyType: PoolStrategyType;
  models: ModelGroupItem[];
  description?: string;
  createdAt: string;
  updatedAt: string;
  /** 兼容字段：用 isDefaultForType 近似映射 */
  isSystemGroup?: boolean;
}

/**
 * 按应用标识获取的模型分组（包含来源标记）
 */
export interface ModelGroupForApp extends ModelGroup {
  /** 解析类型：DedicatedPool(专属池)、DefaultPool(默认池)、DirectModel(传统配置) */
  resolutionType: 'DedicatedPool' | 'DefaultPool' | 'DirectModel';
  /** 是否为该应用的专属模型池 */
  isDedicated: boolean;
  /** 是否为该类型的默认模型池 */
  isDefault: boolean;
  /** 是否为传统配置模型（isImageGen 等标记） */
  isLegacy: boolean;
}

/**
 * 创建模型分组请求
 */
export interface CreateModelGroupRequest {
  name: string;
  /** 对外暴露的模型名字（允许重复） */
  code?: string;
  /** 优先级（数字越小优先级越高，默认50） */
  priority?: number;
  modelType: string;
  isDefaultForType?: boolean;
  /** 调度策略类型 */
  strategyType?: PoolStrategyType;
  description?: string;
  /** 后端创建会初始化为空 */
  models?: ModelGroupItem[];
}

/**
 * 更新模型分组请求
 */
export interface UpdateModelGroupRequest {
  name?: string;
  /** 对外暴露的模型名字（允许重复） */
  code?: string;
  /** 优先级（数字越小优先级越高） */
  priority?: number;
  modelType?: string;
  description?: string;
  models?: ModelGroupItem[];
  isDefaultForType?: boolean;
  /** 调度策略类型 */
  strategyType?: PoolStrategyType;
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
 * 调度预测 - 端点预测步骤
 */
export interface PredictionStep {
  order: number;
  endpointId: string;
  modelId: string;
  action: 'request' | 'parallel' | 'fallback' | 'rotate' | 'weighted' | 'standby';
  label: string;
  isTarget: boolean;
  weight?: number;
  probability?: number;
}

/**
 * 调度预测 - 端点信息
 */
export interface PredictionEndpoint {
  endpointId: string;
  modelId: string;
  platformId: string;
  platformName: string;
  priority: number;
  healthStatus: string;
  isAvailable: boolean;
  healthScore: number;
  consecutiveFailures: number;
  index: number;
}

/**
 * 调度预测结果
 */
export interface PoolPrediction {
  poolId: string;
  poolName: string;
  strategy: string;
  strategyDescription: string;
  allEndpoints: PredictionEndpoint[];
  prediction: {
    type: string;
    description: string;
    steps: PredictionStep[];
  };
}

/**
 * 模型类型常量
 */
export const ModelTypes = {
  Chat: 'chat',
  Intent: 'intent',
  Vision: 'vision',
  ImageGen: 'generation',
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
