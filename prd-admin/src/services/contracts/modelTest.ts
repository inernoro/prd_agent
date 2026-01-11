import type { ApiResponse } from '@/types/api';
import type {
  ModelTestStub,
  UpsertTestStubRequest,
  SimulateDowngradeRequest,
  SimulateRecoverRequest,
  GroupMonitoring,
} from '../../types/modelTest';

export interface IModelTestService {
  /**
   * 获取所有测试桩
   */
  getTestStubs(): Promise<ApiResponse<ModelTestStub[]>>;

  /**
   * 创建或更新测试桩
   */
  upsertTestStub(
    request: UpsertTestStubRequest
  ): Promise<ApiResponse<ModelTestStub>>;

  /**
   * 删除测试桩
   */
  deleteTestStub(id: string): Promise<ApiResponse<{ id: string }>>;

  /**
   * 清空所有测试桩
   */
  clearTestStubs(): Promise<
    ApiResponse<{ deletedCount: number; message: string }>
  >;

  /**
   * 模拟降权
   */
  simulateDowngrade(
    request: SimulateDowngradeRequest
  ): Promise<ApiResponse<object>>;

  /**
   * 模拟恢复
   */
  simulateRecover(
    request: SimulateRecoverRequest
  ): Promise<ApiResponse<object>>;

  /**
   * 手动触发健康检查
   */
  triggerHealthCheck(): Promise<ApiResponse<{ message: string }>>;

  /**
   * 获取分组监控数据
   */
  getGroupMonitoring(groupId: string): Promise<ApiResponse<GroupMonitoring>>;
}
