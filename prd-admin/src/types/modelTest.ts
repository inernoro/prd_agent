/**
 * 故障模式
 */
export enum FailureMode {
  None = 0,
  Random = 1,
  AlwaysFail = 2,
  Timeout = 3,
  Intermittent = 4,
  SlowResponse = 5,
  ConnectionReset = 6,
}

/**
 * 故障模式显示名称
 */
export const FailureModeLabels: Record<FailureMode, string> = {
  [FailureMode.None]: '无故障',
  [FailureMode.Random]: '随机失败',
  [FailureMode.AlwaysFail]: '始终失败',
  [FailureMode.Timeout]: '超时',
  [FailureMode.Intermittent]: '间歇性故障',
  [FailureMode.SlowResponse]: '慢响应',
  [FailureMode.ConnectionReset]: '断线重连',
};

/**
 * 模型测试桩
 */
export interface ModelTestStub {
  id: string;
  modelId: string;
  platformId: string;
  enabled: boolean;
  failureMode: FailureMode;
  failureRate: number; // 0-100
  latencyMs: number;
  errorMessage?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 创建/更新测试桩请求
 */
export interface UpsertTestStubRequest {
  modelId: string;
  platformId: string;
  enabled: boolean;
  failureMode: FailureMode;
  failureRate: number;
  latencyMs: number;
  errorMessage?: string;
  description?: string;
}

/**
 * 模拟降权请求
 */
export interface SimulateDowngradeRequest {
  groupId: string;
  modelId: string;
  platformId: string;
  failureCount: number;
}

/**
 * 模拟恢复请求
 */
export interface SimulateRecoverRequest {
  groupId: string;
  modelId: string;
  platformId: string;
  successCount: number;
}

/**
 * 分组监控数据
 */
export interface GroupMonitoring {
  groupId: string;
  groupName: string;
  modelType: string;
  models: ModelMonitoring[];
}

/**
 * 模型监控数据
 */
export interface ModelMonitoring {
  modelId: string;
  platformId: string;
  priority: number;
  healthStatus: string;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastFailedAt?: string;
  lastSuccessAt?: string;
  healthScore: number; // 0-100
}
