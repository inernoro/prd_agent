import type { ApiResponse } from '@/types/api';
import type { Model } from '@/types/admin';

/**
 * 模型目录只读契约。
 *
 * 2026-08-25 模型管理退场：模型的增删改、用途标记（主 / 意图 / 视觉 / 生图）与优先级
 * 改由 LLM Gateway 控制台承担，MAP 侧 `api/mds` 写端点已统一 410，对应写契约一并移除。
 *
 * `api/mds` 那三个适配器信息读契约同期删除——它们零消费方：视觉创作走的是
 * `api/visual-agent/image-gen/adapter-info`，只复用下面的 ModelAdapterInfo 数据类型。
 */
export type GetModelsContract = () => Promise<ApiResponse<Model[]>>;

export type ModelAdapterSizeConstraint = {
  type: 'whitelist' | 'range' | 'aspect_ratio' | 'adaptive';
  description: string;
};

export type ModelAdapterLimitations = {
  mustBeDivisibleBy?: number | null;
  maxWidth?: number | null;
  maxHeight?: number | null;
  minWidth?: number | null;
  minHeight?: number | null;
  maxPixels?: number | null;
  notes: string[];
};

/** 尺寸选项（后端按分辨率分组返回） */
export type SizeOptionFromBackend = {
  size: string;
  aspectRatio: string;
};

export type ModelAdapterInfo = {
  matched: boolean;
  modelId: string;
  modelName?: string;
  adapterName?: string;
  displayName?: string;
  provider?: string;
  officialDocUrl?: string;
  lastUpdated?: string;
  sizeConstraint?: ModelAdapterSizeConstraint;
  /** 按分辨率分组的尺寸选项（1k/2k/4k），前端直接使用 */
  sizesByResolution?: Record<string, SizeOptionFromBackend[]>;
  sizeParamFormat?: string;
  /** true 表示该模型没有尺寸选择语义；与“尺寸通过 prompt 传输”不同 */
  sizesNotApplicable?: boolean;
  limitations?: ModelAdapterLimitations;
  supportsImageToImage?: boolean;
  supportsInpainting?: boolean;
  /** 自适应模型：true 表示尺寸不通过 API 字段传输 */
  isAdaptive?: boolean;
};
