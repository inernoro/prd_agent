/** 挂在 Exchange（虚拟平台）下的模型条目 */
export interface ExchangeModel {
  modelId: string;
  displayName?: string | null;
  /** chat / vision / generation / tts / asr / embedding */
  modelType: string;
  description?: string | null;
  enabled: boolean;
}

/** 模型中继 (Exchange) 配置 · 作为虚拟平台 */
export interface ModelExchange {
  id: string;
  /** 虚拟平台名称（用户自定义，如 "我的 Gemini"） */
  name: string;
  /** 挂在该中继下的模型列表（新数据主要使用此字段） */
  models: ExchangeModel[];
  /** 【旧字段 · 兼容】单模型场景的主别名 */
  modelAlias?: string;
  /** 【旧字段 · 兼容】附加别名列表 */
  modelAliases?: string[];
  targetUrl: string;
  apiKeyMasked: string;
  targetAuthScheme: string;
  transformerType: string;
  transformerConfig?: Record<string, unknown>;
  enabled: boolean;
  description?: string;
  createdAt: string;
  updatedAt: string;
  /** 该 Exchange 在模型池等地引用时的 PlatformId（= Exchange 自身 Id） */
  platformId: string;
  /** 虚拟平台名（= Exchange.Name） */
  platformName: string;
  /** 固定为 "exchange"，用于前端区分虚拟平台 */
  platformKind?: 'exchange';
  isVirtualPlatform?: boolean;
  /** 兼容字段：旧模型池条目可能存 "__exchange__" */
  legacyPlatformId?: string;
}

/** 提交到后端的 ExchangeModel 条目 */
export interface ExchangeModelInput {
  modelId: string;
  displayName?: string;
  modelType?: string;
  description?: string;
  enabled?: boolean;
}

/** 创建 Exchange 请求 */
export interface CreateExchangeRequest {
  name: string;
  /** 新接口主推：挂在虚拟平台下的模型列表 */
  models?: ExchangeModelInput[];
  /** 【兼容字段】单模型场景主别名 */
  modelAlias?: string;
  /** 【兼容字段】附加别名列表 */
  modelAliases?: string[];
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
  models?: ExchangeModelInput[];
  modelAlias?: string;
  modelAliases?: string[];
  targetUrl?: string;
  targetApiKey?: string;
  targetAuthScheme?: string;
  transformerType?: string;
  transformerConfig?: Record<string, unknown>;
  enabled?: boolean;
  description?: string;
}

/** ModelType 可选值 + 中文展示 */
export const MODEL_TYPE_OPTIONS = [
  { value: 'chat', label: '对话 (chat)' },
  { value: 'vision', label: '视觉 (vision)' },
  { value: 'generation', label: '图片生成 (generation)' },
  { value: 'tts', label: '语音合成 (tts)' },
  { value: 'asr', label: '语音识别 (asr)' },
  { value: 'embedding', label: '向量嵌入 (embedding)' },
] as const;

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

/** Exchange 测试结果 */
export interface ExchangeTestResult {
  /** 原始标准请求 (格式化 JSON) */
  standardRequest: string;
  /** 转换后的请求 (格式化 JSON) */
  transformedRequest: string | null;
  /** 目标 API 的原始响应 (格式化 JSON) */
  rawResponse: string | null;
  /** 转换后的标准响应 (格式化 JSON) */
  transformedResponse: string | null;
  /** 错误信息 */
  error: string | null;
  /** HTTP 状态码 */
  httpStatus: number | null;
  /** 耗时 (ms) */
  durationMs: number | null;
  /** 是否为预览模式 */
  isDryRun?: boolean;
}

/** 认证方案选项 */
export const AUTH_SCHEME_OPTIONS = [
  { value: 'Bearer', label: 'Bearer (Authorization: Bearer {key})' },
  { value: 'Key', label: 'Key (Authorization: Key {key})' },
  { value: 'XApiKey', label: 'x-api-key (Header: x-api-key)' },
  { value: 'x-goog-api-key', label: 'x-goog-api-key (Google Gemini 原生)' },
  { value: 'DoubaoAsr', label: '豆包 ASR (X-Api-App-Key + X-Api-Access-Key)' },
] as const;

/** Exchange 导入模板定义 */
export interface ExchangeTemplate {
  /** 模板 ID */
  id: string;
  /** 模板名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 预设 Exchange 配置（除 API Key 外）— 包含 models 列表（新）或 modelAlias（旧） */
  preset: Omit<CreateExchangeRequest, 'targetApiKey'>;
  /** API Key 输入提示 */
  apiKeyPlaceholder: string;
  /** API Key 格式说明 */
  apiKeyHint: string;
}
