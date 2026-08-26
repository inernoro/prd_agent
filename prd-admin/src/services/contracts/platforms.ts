import type { ApiResponse } from '@/types/api';
import type { Platform } from '@/types/admin';

/**
 * 上游平台只读契约。
 *
 * 2026-08-25 模型管理退场：新增 / 编辑 / 删除上游改由 LLM Gateway 控制台承担，
 * MAP 侧 `api/mds/platforms*` 的写端点已统一 410，对应的写契约与实现一并移除。
 * 读仍然保留——实验台、竞技场、视觉创作都还要按平台展示模型目录。
 */
export type GetPlatformsContract = () => Promise<ApiResponse<Platform[]>>;
