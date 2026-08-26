import type { ApiResponse } from '@/types/api';
import type { LLMConfig } from '@/types/admin';

/**
 * 旧 LLM 配置只读契约。
 *
 * 2026-08-25 模型管理退场：创建 / 更新 / 删除 / 激活改由 LLM Gateway 控制台承担，
 * MAP 侧 `api/mds/llm-configs*` 写端点已统一 410。
 */
export type GetLLMConfigsContract = () => Promise<ApiResponse<LLMConfig[]>>;
