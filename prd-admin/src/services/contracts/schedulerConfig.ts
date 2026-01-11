import type { ApiResponse } from '@/types/api';
import type {
  ModelSchedulerConfig,
  UpdateSchedulerConfigRequest,
} from '../../types/schedulerConfig';

export interface ISchedulerConfigService {
  /**
   * 获取系统配置
   */
  getConfig(): Promise<ApiResponse<ModelSchedulerConfig>>;

  /**
   * 获取系统配置（别名）
   */
  getSchedulerConfig(): Promise<ApiResponse<ModelSchedulerConfig>>;

  /**
   * 更新系统配置
   */
  updateConfig(
    request: UpdateSchedulerConfigRequest
  ): Promise<ApiResponse<ModelSchedulerConfig>>;

  /**
   * 更新系统配置（别名）
   */
  updateSchedulerConfig(
    request: UpdateSchedulerConfigRequest
  ): Promise<ApiResponse<ModelSchedulerConfig>>;
}
