/**
 * 应用模型需求
 */
export interface AppModelRequirement {
  modelType: string;
  purpose: string;
  /** 绑定的模型池ID列表（支持多个模型池） */
  modelGroupIds: string[];
  /** @deprecated 兼容旧字段，请使用 modelGroupIds */
  modelGroupId?: string;
  isRequired: boolean;
}

/**
 * 应用调用者
 */
export interface LLMAppCaller {
  id: string;
  appCode: string;
  displayName: string;
  description?: string;
  modelRequirements: AppModelRequirement[];
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  lastCalledAt?: string;
  isAutoRegistered: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 创建应用请求
 */
export interface CreateAppCallerRequest {
  appCode: string;
  displayName?: string;
  description?: string;
  modelRequirements?: AppModelRequirement[];
}

/**
 * 更新应用请求
 */
export interface UpdateAppCallerRequest {
  displayName?: string;
  description?: string;
  modelRequirements?: AppModelRequirement[];
}

/**
 * 应用统计信息
 */
export interface AppCallerStats {
  appCode: string;
  displayName: string;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  successRate: number;
  lastCalledAt?: string;
  modelRequirements: AppModelRequirement[];
}
