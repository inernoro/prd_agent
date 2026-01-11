import type { ApiResponse } from '@/types/api';
import type {
  LLMAppCaller,
  CreateAppCallerRequest,
  UpdateAppCallerRequest,
  AppCallerStats,
} from '../../types/appCaller';

export interface IAppCallersService {
  /**
   * 获取应用列表
   */
  getAppCallers(
    page?: number,
    pageSize?: number
  ): Promise<
    ApiResponse<{
      items: LLMAppCaller[];
      total: number;
      page: number;
      pageSize: number;
    }>
  >;

  /**
   * 获取单个应用
   */
  getAppCaller(id: string): Promise<ApiResponse<LLMAppCaller>>;

  /**
   * 创建应用
   */
  createAppCaller(
    request: CreateAppCallerRequest
  ): Promise<ApiResponse<LLMAppCaller>>;

  /**
   * 更新应用
   */
  updateAppCaller(
    id: string,
    request: UpdateAppCallerRequest
  ): Promise<ApiResponse<LLMAppCaller>>;

  /**
   * 删除应用
   */
  deleteAppCaller(id: string): Promise<ApiResponse<{ id: string }>>;

  /**
   * 获取应用统计
   */
  getAppCallerStats(id: string): Promise<ApiResponse<AppCallerStats>>;

  /**
   * 全局扫描未注册的应用
   */
  scanApps(): Promise<
    ApiResponse<{ discovered: string[]; message: string }>
  >;

  /**
   * 全局扫描未注册的应用（别名）
   */
  scanAppCallers(): Promise<
    ApiResponse<{ discovered: string[]; message: string }>
  >;
}
