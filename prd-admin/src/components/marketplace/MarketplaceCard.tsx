/**
 * 海鲜市场通用卡片组件
 *
 * 使用类型注册表实现不同配置类型的个性化展示。
 * 通用容器结构 + 类型专属预览渲染器。
 */

import React from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { GitFork, User, Hand } from 'lucide-react';
import {
  CONFIG_TYPE_REGISTRY,
  type MixedMarketplaceItem,
  type ConfigTypeDefinition,
} from '@/lib/marketplaceTypes';

export interface MarketplaceCardProps {
  /** 混合市场项（包含 type 和 data） */
  item: MixedMarketplaceItem;
  /** Fork 下载回调 */
  onFork: (typeKey: string, id: string) => Promise<void>;
  /** 是否正在下载 */
  forking?: boolean;
}

/**
 * 海鲜市场通用卡片组件
 */
export const MarketplaceCard: React.FC<MarketplaceCardProps> = ({
  item,
  onFork,
  forking = false,
}) => {
  const typeDef = CONFIG_TYPE_REGISTRY[item.type] as ConfigTypeDefinition | undefined;

  // 未注册的类型不渲染
  if (!typeDef) {
    console.warn(`[MarketplaceCard] Unknown type: ${item.type}`);
    return null;
  }

  const { icon: TypeIcon, color, PreviewRenderer } = typeDef;
  const displayName = typeDef.getDisplayName(item.data);

  return (
    <GlassCard className="p-0 overflow-hidden">
      <div className="flex flex-col h-full">
        {/* ========== 标题栏：通用结构 ========== */}
        <div className="p-2 pb-1 flex-shrink-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1 flex items-center gap-1.5">
              {/* 类型图标 */}
              <TypeIcon
                size={14}
                style={{ color: color.iconColor, flexShrink: 0 }}
              />
              {/* 标题 */}
              <div
                className="flex-1 font-semibold text-[13px]"
                title={displayName}
                style={{
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
              >
                {displayName}
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {/* 类型标签 */}
              <span
                className="text-[9px] px-1.5 py-0.5 rounded-full font-medium flex items-center gap-0.5"
                style={{
                  background: color.bg,
                  color: color.text,
                  border: color.border,
                }}
              >
                {typeDef.label}
              </span>
            </div>
          </div>
        </div>

        {/* ========== 预览区：委托给类型专属渲染器 ========== */}
        <div className="px-2 pb-1 flex-1 min-h-0">
          <PreviewRenderer item={item.data} />
        </div>

        {/* ========== 底栏：通用结构 ========== */}
        <div
          className="px-2 pb-2 pt-1 flex-shrink-0 border-t"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          {/* 元信息：Fork次数 + 作者 + 日期 */}
          <div
            className="flex items-center gap-1 mb-1.5 text-[10px]"
            style={{ color: 'var(--text-muted)' }}
          >
            <GitFork size={11} />
            <span>{item.data.forkCount} 次下载</span>
            <span className="opacity-60 mx-1">·</span>
            {item.data.ownerUserAvatar ? (
              <img
                src={item.data.ownerUserAvatar}
                alt=""
                className="w-4 h-4 rounded-full object-cover"
              />
            ) : (
              <div className="w-4 h-4 rounded-full bg-gray-600 flex items-center justify-center">
                <User size={10} />
              </div>
            )}
            <span>{item.data.ownerUserName || '未知用户'}</span>
            <span className="opacity-60">·</span>
            <span>{new Date(item.data.createdAt).toLocaleDateString()}</span>
          </div>

          {/* 下载按钮 */}
          <div className="flex justify-end">
            <Button
              size="xs"
              variant="secondary"
              disabled={forking}
              onClick={() => onFork(item.type, item.data.id)}
            >
              <Hand size={12} />
              {forking ? '下载中...' : '免费下载'}
            </Button>
          </div>
        </div>
      </div>
    </GlassCard>
  );
};

export default MarketplaceCard;
