import type { ApiResponse } from '@/types/api';
import type {
  LLMAppCaller,
  CreateAppCallerRequest,
  UpdateAppCallerRequest,
  AppCallerStats,
} from '../../types/appCaller';

/**
 * 模型解析结果中的统计数据
 */
export interface ResolvedModelStats {
  /** 请求次数 */
  requestCount: number;
  /** 平均耗时（毫秒） */
  avgDurationMs: number | null;
  /** 首字延迟（毫秒） */
  avgTtfbMs: number | null;
  /** 总输入Token */
  totalInputTokens: number | null;
  /** 总输出Token */
  totalOutputTokens: number | null;
  /** 成功次数 */
  successCount: number | null;
  /** 失败次数 */
  failCount: number | null;
}

/**
 * 配置的模型信息（用于展示降级前的预期值）
 */
export interface ConfiguredModelInfo {
  /** 模型 ID */
  modelId: string;
  /** 平台 ID */
  platformId: string;
  /** 健康状态 */
  healthStatus: string;
  /** 是否可用 */
  isAvailable: boolean;
}

/**
 * 配置的模型池信息（降级前）
 */
export interface ConfiguredPoolInfo {
  /** 模型池 ID */
  poolId: string | null;
  /** 模型池名称 */
  poolName: string | null;
  /** 模型列表 */
  models: ConfiguredModelInfo[] | null;
}

/**
 * 模型解析结果（后端统一返回）
 */
export interface ResolvedModelInfo {
  /** 模型来源：pool（模型池）、legacy（传统配置） */
  source: 'pool' | 'legacy';
  /** 模型池ID（如果来自模型池） */
  modelGroupId: string | null;
  /** 模型池名称（如果来自模型池） */
  modelGroupName: string | null;
  /** 是否为该类型的默认模型池 */
  isDefaultForType: boolean;
  /** 平台ID */
  platformId: string;
  /** 平台名称 */
  platformName: string;
  /** 模型ID（实际调用名） */
  modelId: string;
  /** 模型显示名称 */
  modelDisplayName: string | null;
  /** 健康状态 */
  healthStatus: string;
  /** 统计数据（appCallerCode + model 组合的近 7 天统计） */
  stats: ResolvedModelStats | null;

  // ========== 降级/回退信息 ==========
  /** 是否发生了降级/回退 */
  isFallback?: boolean;
  /** 降级原因描述 */
  fallbackReason?: string | null;
  /** 原始配置的模型池信息（降级前） */
  configuredPool?: ConfiguredPoolInfo | null;
}

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

  /**
   * 批量解析应用实际会调用的模型
   * 按优先级查找：1.专属模型池 2.默认模型池 3.传统配置模型
   */
  resolveModels(
    items: { appCallerCode: string; modelType: string }[]
  ): Promise<ApiResponse<Record<string, ResolvedModelInfo | null>>>;
}
