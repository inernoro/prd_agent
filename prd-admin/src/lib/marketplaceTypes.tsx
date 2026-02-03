/**
 * 海鲜市场类型注册表
 *
 * 用于支持多种配置类型的扩展，新增类型只需在 CONFIG_TYPE_REGISTRY 中添加配置即可。
 *
 * @example 新增类型
 * ```typescript
 * // 1. 定义数据类型
 * export interface MarketplaceWorkflow extends MarketplaceItemBase {
 *   nodes: WorkflowNode[];
 *   connections: WorkflowConnection[];
 * }
 *
 * // 2. 在 CONFIG_TYPE_REGISTRY 中注册
 * workflow: {
 *   key: 'workflow',
 *   label: '工作流',
 *   icon: GitBranch,
 *   color: { ... },
 *   api: { listMarketplace: ..., fork: ... },
 *   getDisplayName: (item) => item.name,
 *   PreviewRenderer: WorkflowPreview,
 * }
 * ```
 */

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, Image as ImageIcon, Sparkles, type LucideIcon } from 'lucide-react';
import {
  listLiteraryPromptsMarketplace,
  publishLiteraryPrompt,
  unpublishLiteraryPrompt,
  forkLiteraryPrompt,
  listReferenceImageConfigsMarketplace,
  publishReferenceImageConfig,
  unpublishReferenceImageConfig,
  forkReferenceImageConfig,
  listWatermarksMarketplace,
  publishWatermark,
  unpublishWatermark,
  forkWatermark,
} from '@/services';
import type { ApiResponse } from '@/types/api';

// ============================================================================
// 基础类型定义
// ============================================================================

/**
 * 市场配置项基础字段（所有类型共有）
 */
export interface MarketplaceItemBase {
  id: string;
  forkCount: number;
  isPublic?: boolean;
  createdAt: string;
  updatedAt?: string;
  ownerUserId: string;
  ownerUserName: string;
  ownerUserAvatar?: string;
}

/**
 * 类型颜色配置
 */
export interface TypeColorConfig {
  bg: string;
  text: string;
  border: string;
  iconColor: string;
}

/**
 * 市场 API 配置
 */
export interface MarketplaceApiConfig {
  listMarketplace: (params: { keyword?: string; sort?: 'hot' | 'new' }) => Promise<ApiResponse<{ items: any[] }>>;
  publish: (params: { id: string }) => Promise<ApiResponse<any>>;
  unpublish: (params: { id: string }) => Promise<ApiResponse<any>>;
  fork: (params: { id: string; name?: string }) => Promise<ApiResponse<any>>;
}

/**
 * 配置类型定义
 */
export interface ConfigTypeDefinition<T extends MarketplaceItemBase = MarketplaceItemBase> {
  /** 类型唯一标识 */
  key: string;
  /** 显示名称 */
  label: string;
  /** 图标组件 */
  icon: LucideIcon;
  /** 颜色配置 */
  color: TypeColorConfig;
  /** API 配置 */
  api: MarketplaceApiConfig;
  /** 获取显示名称 */
  getDisplayName: (item: T) => string;
  /** 获取预览内容（可选，用于简单文本预览） */
  getPreviewText?: (item: T) => string;
  /** 预览渲染器组件 */
  PreviewRenderer: React.FC<{ item: T }>;
}

// ============================================================================
// 类型专属数据结构
// ============================================================================

export interface MarketplacePrompt extends MarketplaceItemBase {
  title: string;
  content: string;
  scenarioType?: string | null;
}

export interface MarketplaceRefImage extends MarketplaceItemBase {
  name: string;
  prompt?: string;
  imageUrl?: string;
}

export interface MarketplaceWatermark extends MarketplaceItemBase {
  name: string;
  text?: string;
  fontKey?: string;
  fontSizePx?: number;
  previewUrl?: string;
}

// ============================================================================
// 预览渲染器组件
// ============================================================================

/** 统一预览区高度 */
const PREVIEW_HEIGHT = '100px';

/**
 * 提示词预览：Markdown 渲染
 */
const PromptPreviewRenderer: React.FC<{ item: MarketplacePrompt }> = ({ item }) => (
  <div
    className="overflow-auto border rounded-[6px]"
    style={{
      borderColor: 'var(--border-subtle)',
      background: 'rgba(255,255,255,0.02)',
      height: PREVIEW_HEIGHT,
    }}
  >
    <style>{`
      .marketplace-prompt-md { font-size: 11px; line-height: 1.4; color: var(--text-secondary); padding: 6px 8px; }
      .marketplace-prompt-md h1,.marketplace-prompt-md h2,.marketplace-prompt-md h3 { color: var(--text-primary); font-weight: 600; margin: 4px 0 2px; }
      .marketplace-prompt-md h1 { font-size: 12px; }
      .marketplace-prompt-md h2 { font-size: 11px; }
      .marketplace-prompt-md h3 { font-size: 11px; }
      .marketplace-prompt-md p { margin: 2px 0; }
      .marketplace-prompt-md ul,.marketplace-prompt-md ol { margin: 2px 0; padding-left: 14px; }
      .marketplace-prompt-md li { margin: 1px 0; }
      .marketplace-prompt-md code { font-family: ui-monospace, monospace; font-size: 10px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); padding: 0 3px; border-radius: 3px; }
      .marketplace-prompt-md pre { background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.10); border-radius: 4px; padding: 4px 6px; overflow: auto; margin: 2px 0; }
      .marketplace-prompt-md pre code { background: transparent; border: 0; padding: 0; }
    `}</style>
    <div className="marketplace-prompt-md">
      {item.content ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {item.content}
        </ReactMarkdown>
      ) : (
        <div style={{ color: 'var(--text-muted)' }}>（内容为空）</div>
      )}
    </div>
  </div>
);

/**
 * 风格图预览：左右布局（文字 + 图片）
 * 风格图使用简单边框，非透明PNG无需象棋格背景
 */
const RefImagePreviewRenderer: React.FC<{ item: MarketplaceRefImage }> = ({ item }) => (
  <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) 100px', height: PREVIEW_HEIGHT }}>
    {/* 左侧：提示词预览 */}
    <div
      className="overflow-auto border rounded-[6px] p-2"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {item.prompt || '（无提示词）'}
      </div>
    </div>
    {/* 右侧：图片预览（简单边框，非透明图无需象棋格） */}
    <div
      className="flex items-center justify-center overflow-hidden rounded-[6px]"
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {item.imageUrl ? (
        <img src={item.imageUrl} alt={item.name} className="block w-full h-full object-cover" />
      ) : (
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>无图片</div>
      )}
    </div>
  </div>
);

/**
 * 水印预览：两栏布局（配置信息表 + 预览图）
 * 与"我的"页面水印卡片保持一致的样式
 */
const WatermarkPreviewRenderer: React.FC<{ item: MarketplaceWatermark }> = ({ item }) => (
  <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) 100px', height: PREVIEW_HEIGHT }}>
    {/* 左侧：配置信息 */}
    <div
      className="overflow-auto border rounded-[6px]"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      <div className="text-[11px] grid gap-1 grid-cols-1 p-2" style={{ color: 'var(--text-muted)' }}>
        <div className="grid items-center gap-2" style={{ gridTemplateColumns: '36px auto' }}>
          <span>文字</span>
          <span className="truncate" style={{ color: 'var(--text-primary)' }}>{item.text || '（空）'}</span>
        </div>
        {item.fontKey && (
          <div className="grid items-center gap-2" style={{ gridTemplateColumns: '36px auto' }}>
            <span>字体</span>
            <span className="truncate" style={{ color: 'var(--text-primary)' }}>{item.fontKey}</span>
          </div>
        )}
        {item.fontSizePx && (
          <div className="grid items-center gap-2" style={{ gridTemplateColumns: '36px auto' }}>
            <span>大小</span>
            <span style={{ color: 'var(--text-primary)' }}>{item.fontSizePx}px</span>
          </div>
        )}
      </div>
    </div>
    {/* 右侧：预览图 */}
    <div
      className="relative flex items-center justify-center overflow-hidden rounded-[6px]"
      style={{
        background: item.previewUrl
          ? 'repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50% / 12px 12px'
          : 'rgba(255,255,255,0.02)',
        border: item.previewUrl ? 'none' : '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {item.previewUrl ? (
        <img src={item.previewUrl} alt={item.name} className="block w-full h-full object-contain" />
      ) : (
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>无预览</div>
      )}
    </div>
  </div>
);

// ============================================================================
// 类型注册表
// ============================================================================

/**
 * 配置类型注册表
 *
 * 新增类型只需在此处添加配置，无需修改其他文件。
 */
export const CONFIG_TYPE_REGISTRY: Record<string, ConfigTypeDefinition<any>> = {
  prompt: {
    key: 'prompt',
    label: '提示词',
    icon: FileText,
    color: {
      bg: 'rgba(168, 85, 247, 0.12)',
      text: 'rgba(168, 85, 247, 0.95)',
      border: '1px solid rgba(168, 85, 247, 0.28)',
      iconColor: 'rgba(147, 197, 253, 0.85)',
    },
    api: {
      listMarketplace: listLiteraryPromptsMarketplace,
      publish: publishLiteraryPrompt,
      unpublish: unpublishLiteraryPrompt,
      fork: forkLiteraryPrompt,
    },
    getDisplayName: (item: MarketplacePrompt) => item.title,
    getPreviewText: (item: MarketplacePrompt) => item.content,
    PreviewRenderer: PromptPreviewRenderer,
  },

  refImage: {
    key: 'refImage',
    label: '风格图',
    icon: ImageIcon,
    color: {
      bg: 'rgba(236, 72, 153, 0.12)',
      text: 'rgba(236, 72, 153, 0.95)',
      border: '1px solid rgba(236, 72, 153, 0.28)',
      iconColor: 'rgba(236, 72, 153, 0.85)',
    },
    api: {
      listMarketplace: listReferenceImageConfigsMarketplace,
      publish: publishReferenceImageConfig,
      unpublish: unpublishReferenceImageConfig,
      fork: forkReferenceImageConfig,
    },
    getDisplayName: (item: MarketplaceRefImage) => item.name,
    getPreviewText: (item: MarketplaceRefImage) => item.prompt || '',
    PreviewRenderer: RefImagePreviewRenderer,
  },

  watermark: {
    key: 'watermark',
    label: '水印',
    icon: Sparkles,
    color: {
      bg: 'rgba(6, 182, 212, 0.12)',
      text: 'rgba(6, 182, 212, 0.95)',
      border: '1px solid rgba(6, 182, 212, 0.28)',
      iconColor: 'rgba(6, 182, 212, 0.85)',
    },
    api: {
      listMarketplace: listWatermarksMarketplace,
      publish: publishWatermark,
      unpublish: unpublishWatermark,
      fork: forkWatermark,
    },
    getDisplayName: (item: MarketplaceWatermark) => item.name,
    getPreviewText: (item: MarketplaceWatermark) => item.text || '',
    PreviewRenderer: WatermarkPreviewRenderer,
  },
};

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 获取所有已注册的类型键
 */
export function getRegisteredTypeKeys(): string[] {
  return Object.keys(CONFIG_TYPE_REGISTRY);
}

/**
 * 获取类型定义
 */
export function getTypeDefinition(typeKey: string): ConfigTypeDefinition | undefined {
  return CONFIG_TYPE_REGISTRY[typeKey];
}

/**
 * 获取所有类型的筛选选项
 */
export function getCategoryFilterOptions(): Array<{ key: string; label: string; icon?: LucideIcon }> {
  return [
    { key: 'all', label: '全部' },
    ...Object.values(CONFIG_TYPE_REGISTRY).map((typeDef) => ({
      key: typeDef.key,
      label: typeDef.label,
      icon: typeDef.icon,
    })),
  ];
}

/**
 * 混合市场项类型
 */
export interface MixedMarketplaceItem {
  type: string;
  data: MarketplaceItemBase;
}

/**
 * 合并多个类型的数据为混合列表
 */
export function mergeMarketplaceData(
  dataByType: Record<string, MarketplaceItemBase[]>,
  categoryFilter: string = 'all'
): MixedMarketplaceItem[] {
  const items: MixedMarketplaceItem[] = [];

  for (const [typeKey, typeData] of Object.entries(dataByType)) {
    if (categoryFilter === 'all' || categoryFilter === typeKey) {
      items.push(...typeData.map((data) => ({ type: typeKey, data })));
    }
  }

  return items;
}

/**
 * 对混合列表进行排序
 */
export function sortMarketplaceItems(
  items: MixedMarketplaceItem[],
  sortBy: 'hot' | 'new'
): MixedMarketplaceItem[] {
  return [...items].sort((a, b) => {
    if (sortBy === 'hot') {
      return b.data.forkCount - a.data.forkCount;
    } else {
      return new Date(b.data.createdAt).getTime() - new Date(a.data.createdAt).getTime();
    }
  });
}

/**
 * 对混合列表进行关键词过滤
 */
export function filterMarketplaceItems(
  items: MixedMarketplaceItem[],
  keyword: string
): MixedMarketplaceItem[] {
  if (!keyword.trim()) return items;

  const lowerKeyword = keyword.toLowerCase();

  return items.filter((item) => {
    const typeDef = CONFIG_TYPE_REGISTRY[item.type];
    if (!typeDef) return false;

    const displayName = typeDef.getDisplayName(item.data);
    const previewText = typeDef.getPreviewText?.(item.data) || '';

    return (
      displayName.toLowerCase().includes(lowerKeyword) ||
      previewText.toLowerCase().includes(lowerKeyword)
    );
  });
}
