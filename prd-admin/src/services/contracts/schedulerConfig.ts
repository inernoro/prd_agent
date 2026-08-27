import type { ApiResponse } from '@/types/api';
import type { ModelSchedulerConfig } from '../../types/schedulerConfig';

/**
 * 模型调度配置只读契约。
 *
 * 2026-08-25 模型管理退场后，调度配置改由 LLM Gateway 控制台维护
 *（MAP 侧 `PUT api/mds/scheduler-config` 已 410），这里只保留读。
 */
export interface ISchedulerConfigService {
  /** 获取系统配置 */
  getConfig(): Promise<ApiResponse<ModelSchedulerConfig>>;

  /** 获取系统配置（别名） */
  getSchedulerConfig(): Promise<ApiResponse<ModelSchedulerConfig>>;
}
