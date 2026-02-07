/** 模型中继 (Exchange) 配置 */
export interface ModelExchange {
  id: string;
  name: string;
  modelAlias: string;
  targetUrl: string;
  apiKeyMasked: string;
  targetAuthScheme: string;
  transformerType: string;
  transformerConfig?: Record<string, unknown>;
  enabled: boolean;
  description?: string;
  createdAt: string;
  updatedAt: string;
  /** 虚拟平台 ID（用于模型池引用） */
  platformId: string;
  /** 虚拟平台名称 */
  platformName: string;
}

/** 创建 Exchange 请求 */
export interface CreateExchangeRequest {
  name: string;
  modelAlias: string;
  targetUrl: string;
  targetApiKey?: string;
  targetAuthScheme?: string;
  transformerType?: string;
  transformerConfig?: Record<string, unknown>;
  enabled: boolean;
  description?: string;
}

/** 更新 Exchange 请求 */
export interface UpdateExchangeRequest {
  name?: string;
  modelAlias?: string;
  targetUrl?: string;
  targetApiKey?: string;
  targetAuthScheme?: string;
  transformerType?: string;
  transformerConfig?: Record<string, unknown>;
  enabled?: boolean;
  description?: string;
}

/** 转换器类型选项 */
export interface TransformerTypeOption {
  value: string;
  label: string;
}

/** 供模型池选择的 Exchange 精简项 */
export interface ExchangeForPool {
  modelId: string;
  platformId: string;
  platformName: string;
  displayName: string;
  transformerType: string;
}

/** 认证方案选项 */
export const AUTH_SCHEME_OPTIONS = [
  { value: 'Bearer', label: 'Bearer (Authorization: Bearer {key})' },
  { value: 'Key', label: 'Key (Authorization: Key {key})' },
  { value: 'XApiKey', label: 'x-api-key (Header: x-api-key)' },
] as const;
