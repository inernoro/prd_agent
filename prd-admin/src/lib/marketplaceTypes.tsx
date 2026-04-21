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

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { ExternalLink, FileText, Globe, Heart, Image as ImageIcon, Package, Sparkles, Tag as TagIcon, type LucideIcon } from 'lucide-react';
import { WatermarkDescriptionGrid } from '@/components/watermark/WatermarkDescriptionGrid';
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
  listMarketplaceSkills,
  forkMarketplaceSkill,
  favoriteMarketplaceSkill,
  unfavoriteMarketplaceSkill,
} from '@/services';
import type { ApiResponse } from '@/types/api';
import type { MarketplaceSkillDto } from '@/services/contracts/marketplaceSkills';

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

/**
 * 海鲜市场「技能」条目（zip 上传的社区技能包）
 * 对应后端 `MarketplaceSkillsController.ToDto` 产出的结构。
 */
export type MarketplaceSkill = MarketplaceSkillDto;

export interface MarketplaceWatermark extends MarketplaceItemBase {
  name: string;
  text?: string;
  fontKey?: string;
  fontSizePx?: number;
  anchor?: string;
  opacity?: number;
  offsetX?: number;
  offsetY?: number;
  iconEnabled?: boolean;
  borderEnabled?: boolean;
  backgroundEnabled?: boolean;
  roundedBackgroundEnabled?: boolean;
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
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
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
 * 使用共享的 WatermarkDescriptionGrid 组件，与"我的"页面水印卡片保持一致的样式
 */
const WatermarkPreviewRenderer: React.FC<{ item: MarketplaceWatermark }> = ({ item }) => (
  <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) 100px', height: PREVIEW_HEIGHT }}>
    {/* 左侧：配置信息 */}
    <WatermarkDescriptionGrid
      data={{
        text: item.text,
        fontKey: item.fontKey,
        fontSizePx: item.fontSizePx,
        opacity: item.opacity,
        anchor: item.anchor,
        offsetX: item.offsetX,
        offsetY: item.offsetY,
        iconEnabled: item.iconEnabled,
        borderEnabled: item.borderEnabled,
        backgroundEnabled: item.backgroundEnabled,
        roundedBackgroundEnabled: item.roundedBackgroundEnabled,
      }}
    />
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

/**
 * 技能预览（重设计）：封面图为主视觉，支持预览地址快捷访问。
 *
 * 布局：
 *   ┌──────────┬─────────────────────────┐
 *   │ 封面     │ 描述                    │
 *   │ 96×96    │ 标签…                   │
 *   │ (emoji兜底)│ 预览 ↗ · 收藏 ♥        │
 *   └──────────┴─────────────────────────┘
 *
 * - 有封面图 → 覆盖填充；无封面图 → 水波纹渐变 + 大 emoji
 * - 预览地址存在时显示可点击的「预览 ↗」标签（在封面角标 + 右侧行内各一处）
 */
const SkillPreviewRenderer: React.FC<{ item: MarketplaceSkill }> = ({ item }) => {
  const [favorited, setFavorited] = useState(item.isFavoritedByCurrentUser);
  const [favoriteCount, setFavoriteCount] = useState(item.favoriteCount);
  const [pending, setPending] = useState(false);

  const toggleFavorite = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (pending) return;
    setPending(true);
    const next = !favorited;
    setFavorited(next);
    setFavoriteCount((c) => (next ? c + 1 : Math.max(0, c - 1)));
    try {
      const res = next
        ? await favoriteMarketplaceSkill({ id: item.id })
        : await unfavoriteMarketplaceSkill({ id: item.id });
      if (!res.success) {
        setFavorited(!next);
        setFavoriteCount((c) => (next ? Math.max(0, c - 1) : c + 1));
      }
    } catch {
      setFavorited(!next);
      setFavoriteCount((c) => (next ? Math.max(0, c - 1) : c + 1));
    } finally {
      setPending(false);
    }
  };

  const tags = item.tags || [];
  const hasCover = !!item.coverImageUrl;
  const hasPreview = !!item.previewUrl;
  const previewHostLabel = (() => {
    if (!item.previewUrl) return '';
    if (item.previewSource === 'hosted_site') return '托管站点';
    try {
      return new URL(item.previewUrl).hostname;
    } catch {
      return '预览';
    }
  })();

  const stopAndOpen = (e: React.MouseEvent, url?: string | null) => {
    e.stopPropagation();
    e.preventDefault();
    if (!url) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div
      className="relative overflow-hidden rounded-[6px] flex"
      style={{
        height: PREVIEW_HEIGHT,
        background: 'rgba(255, 255, 255, 0.02)',
        border: '1px solid rgba(56, 189, 248, 0.22)',
      }}
    >
      {/* 左：封面图 / 兜底 emoji */}
      <div
        className="relative flex items-center justify-center overflow-hidden flex-shrink-0"
        style={{
          width: 96,
          height: '100%',
          background: hasCover
            ? `#0b1220 url(${item.coverImageUrl}) center/cover no-repeat`
            : 'linear-gradient(135deg, rgba(37, 99, 235, 0.24) 0%, rgba(14, 165, 233, 0.18) 50%, rgba(6, 182, 212, 0.18) 100%)',
          borderRight: '1px solid rgba(255, 255, 255, 0.06)',
        }}
      >
        {!hasCover && (
          <>
            <div
              className="absolute inset-0 pointer-events-none opacity-40"
              style={{
                backgroundImage:
                  'radial-gradient(circle at 85% 18%, rgba(125, 211, 252, 0.42), transparent 45%), radial-gradient(circle at 15% 85%, rgba(56, 189, 248, 0.32), transparent 50%)',
              }}
            />
            <span
              className="relative"
              style={{ fontSize: 40, lineHeight: 1, filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))' }}
            >
              {item.iconEmoji || '🧩'}
            </span>
          </>
        )}
        {/* 封面角标：预览地址存在时的快捷入口 */}
        {hasPreview && (
          <button
            type="button"
            onClick={(e) => stopAndOpen(e, item.previewUrl)}
            title={`打开预览：${item.previewUrl}`}
            className="absolute bottom-1 left-1 inline-flex items-center gap-0.5 px-1.5 rounded-full text-[9px] transition-all hover:scale-105"
            style={{
              height: 16,
              background: 'rgba(15, 23, 42, 0.78)',
              border: '1px solid rgba(125, 211, 252, 0.55)',
              color: 'rgba(186, 230, 253, 0.98)',
              backdropFilter: 'blur(4px)',
            }}
          >
            {item.previewSource === 'hosted_site' ? <Globe size={8} /> : <ExternalLink size={8} />}
            预览
          </button>
        )}
      </div>

      {/* 右：描述 + 标签 + 行内预览链 + 收藏计数 */}
      <div className="relative flex-1 min-w-0 flex flex-col p-2 gap-1">
        <div
          className="text-[11px] leading-[1.35] line-clamp-2"
          style={{ color: 'rgba(241, 245, 249, 0.94)' }}
          title={item.description}
        >
          {item.description || '（暂无详情）'}
        </div>

        {tags.length > 0 && (
          <div
            className="flex items-center gap-1 flex-wrap overflow-hidden"
            style={{ maxHeight: 18 }}
          >
            {tags.slice(0, 3).map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-0.5 px-1.5 rounded-full text-[9px]"
                style={{
                  background: 'rgba(56, 189, 248, 0.12)',
                  border: '1px solid rgba(56, 189, 248, 0.28)',
                  color: 'rgba(186, 230, 253, 0.95)',
                  height: 16,
                }}
              >
                <TagIcon size={8} />
                {t}
              </span>
            ))}
            {tags.length > 3 && (
              <span className="text-[9px]" style={{ color: 'rgba(186, 230, 253, 0.7)' }}>
                +{tags.length - 3}
              </span>
            )}
          </div>
        )}

        {/* 底部：预览地址 + 收藏 */}
        <div className="mt-auto flex items-center justify-between gap-2">
          {hasPreview ? (
            <button
              type="button"
              onClick={(e) => stopAndOpen(e, item.previewUrl)}
              title={item.previewUrl!}
              className="inline-flex items-center gap-1 px-1.5 rounded-[4px] text-[10px] transition-colors hover:bg-white/5 min-w-0"
              style={{
                height: 18,
                color: 'rgba(125, 211, 252, 0.92)',
                maxWidth: '70%',
              }}
            >
              {item.previewSource === 'hosted_site' ? (
                <Globe size={9} className="flex-shrink-0" />
              ) : (
                <ExternalLink size={9} className="flex-shrink-0" />
              )}
              <span className="truncate">{previewHostLabel}</span>
            </button>
          ) : (
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }} />
          )}

          <button
            type="button"
            onClick={toggleFavorite}
            disabled={pending}
            title={favorited ? '取消收藏' : '收藏'}
            className="flex items-center gap-1 px-1.5 rounded-full text-[10px] transition-all flex-shrink-0"
            style={{
              height: 18,
              background: favorited ? 'rgba(244, 63, 94, 0.22)' : 'rgba(255, 255, 255, 0.05)',
              border: `1px solid ${favorited ? 'rgba(244, 63, 94, 0.5)' : 'rgba(255, 255, 255, 0.12)'}`,
              color: favorited ? 'rgba(251, 113, 133, 0.98)' : 'rgba(226, 232, 240, 0.9)',
              cursor: pending ? 'wait' : 'pointer',
            }}
          >
            <Heart size={10} fill={favorited ? 'currentColor' : 'none'} />
            <span>{favoriteCount}</span>
          </button>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 类型注册表
// ============================================================================

/**
 * 配置类型注册表
 *
 * 新增类型只需在此处添加配置，无需修改其他文件。
 */
export const CONFIG_TYPE_REGISTRY: Record<string, ConfigTypeDefinition<any>> = {
  skill: {
    key: 'skill',
    label: '技能',
    icon: Package,
    color: {
      bg: 'rgba(56, 189, 248, 0.14)',
      text: 'rgba(125, 211, 252, 0.98)',
      border: '1px solid rgba(56, 189, 248, 0.35)',
      iconColor: 'rgba(125, 211, 252, 0.95)',
    },
    api: {
      listMarketplace: listMarketplaceSkills,
      // 技能「上传即公开」，MarketplacePage 只会调 listMarketplace + fork；publish / unpublish 是接口契约占位
      publish: async () => ({
        success: false,
        data: null,
        error: { code: 'NOT_SUPPORTED', message: '技能通过上传即公开，无需 publish' },
      } as ApiResponse<unknown>),
      unpublish: async () => ({
        success: false,
        data: null,
        error: { code: 'NOT_SUPPORTED', message: '通过删除技能来下架' },
      } as ApiResponse<unknown>),
      fork: forkMarketplaceSkill,
    },
    getDisplayName: (item: MarketplaceSkill) => item.title,
    getPreviewText: (item: MarketplaceSkill) => {
      const tagText = (item.tags || []).join(' ');
      return `${item.description || ''} ${tagText}`.trim();
    },
    PreviewRenderer: SkillPreviewRenderer,
  },

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
