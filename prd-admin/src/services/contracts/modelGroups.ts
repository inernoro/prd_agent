import type { ApiResponse } from '@/types/api';
import type { ModelGroup, ModelGroupHealthOverview } from '../../types/modelGroup';

/**
 * 模型池只读契约。
 *
 * 2026-08-25 模型管理退场后，模型池的增删改、绑定解绑、健康模拟与重置一律由
 * LLM Gateway 控制台承担（MAP 侧对应的 `api/mds/model-groups*` 写接口已 410）。
 * 这里只保留仍有活消费方的两条读：百宝箱快速创建向导挑池、模型池健康总览卡片。
 */
export interface IModelGroupsService {
  /** 获取模型分组列表 */
  getModelGroups(modelType?: string): Promise<ApiResponse<ModelGroup[]>>;

  /** 只读：模型池健康 + fallback 率告警总览（默认近 7 天） */
  getModelGroupHealthOverview(days?: number): Promise<ApiResponse<ModelGroupHealthOverview>>;
}
