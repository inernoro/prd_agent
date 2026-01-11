/**
 * 应用模型需求
 */
export interface AppModelRequirement {
  modelType: string;
  purpose: string;
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
