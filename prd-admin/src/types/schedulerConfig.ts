/**
 * 模型调度器系统配置
 */
export interface ModelSchedulerConfig {
  id: string;
  consecutiveFailuresToDegrade: number;
  consecutiveFailuresToUnavailable: number;
  healthCheckIntervalMinutes: number;
  healthCheckTimeoutSeconds: number;
  healthCheckPrompt: string;
  autoRecoveryEnabled: boolean;
  recoverySuccessThreshold: number;
  statsWindowMinutes: number;
  updatedAt: string;
}

/**
 * 更新调度器配置请求
 */
export interface UpdateSchedulerConfigRequest {
  consecutiveFailuresToDegrade?: number;
  consecutiveFailuresToUnavailable?: number;
  healthCheckIntervalMinutes?: number;
  healthCheckTimeoutSeconds?: number;
  healthCheckPrompt?: string;
  autoRecoveryEnabled?: boolean;
  recoverySuccessThreshold?: number;
  statsWindowMinutes?: number;
}
