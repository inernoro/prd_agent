/**
 * 海鲜市场通用卡片组件
 *
 * 使用类型注册表实现不同配置类型的个性化展示。
 * 通用容器结构 + 类型专属预览渲染器。
 */

import React, { useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { GitFork, User, Hand } from 'lucide-react';
import { resolveAvatarUrl } from '@/lib/avatar';
import { systemDialog } from '@/lib/systemDialog';
import {
  CONFIG_TYPE_REGISTRY,
  type MixedMarketplaceItem,
  type ConfigTypeDefinition,
} from '@/lib/marketplaceTypes';

export interface MarketplaceCardProps {
  /** 混合市场项（包含 type 和 data） */
  item: MixedMarketplaceItem;
  /** Fork 下载回调 */
  onFork: (typeKey: string, id: string, customName?: string) => Promise<void>;
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
  const [localForking, setLocalForking] = useState(false);

  // 未注册的类型不渲染
  if (!typeDef) {
    console.warn(`[MarketplaceCard] Unknown type: ${item.type}`);
    return null;
  }

  const { icon: TypeIcon, color, PreviewRenderer } = typeDef;
  const displayName = typeDef.getDisplayName(item.data);

  const handleForkClick = async () => {
    setLocalForking(true);
    try {
      const result = await systemDialog.prompt({
        title: '拿来吧',
        message: '请为下载的配置命名',
        defaultValue: displayName,
        placeholder: '输入配置名称',
      });

      if (result !== null) {
        await onFork(item.type, item.data.id, result || displayName);
      }
    } finally {
      setLocalForking(false);
    }
  };

  return (
    <GlassCard className="p-0 overflow-hidden">
      <div className="flex flex-col h-full">
        {/* ========== 标题栏：通用结构 ========== */}
        <div className="p-2 pb-1 flex-shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1 flex items-center gap-1.5">
              {/* 类型图标 */}
              <TypeIcon
                size={14}
                className="flex-shrink-0"
                style={{ color: color.iconColor }}
              />
              {/* 标题 */}
              <div
                className="flex-1 font-semibold text-[13px] truncate"
                title={displayName}
                style={{ color: 'var(--text-primary)' }}
              >
                {displayName}
              </div>
            </div>
            {/* 类型标签 */}
            <span
              className="text-[9px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0"
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

        {/* ========== 预览区：委托给类型专属渲染器 ========== */}
        <div className="px-2 pb-1 flex-1 min-h-0">
          <PreviewRenderer item={item.data} />
        </div>

        {/* ========== 底栏：通用结构 ========== */}
        <div
          className="px-2 pb-2 pt-1.5 flex-shrink-0 border-t"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          {/* 单行布局：左侧元信息 + 右侧下载按钮 */}
          <div className="flex items-center justify-between gap-2">
            {/* 左侧：Fork次数 + 作者 + 日期 */}
            <div
              className="flex items-center gap-1 text-[10px] min-w-0"
              style={{ color: 'var(--text-muted)' }}
            >
              <GitFork size={11} className="flex-shrink-0" />
              <span className="flex-shrink-0">{item.data.forkCount} 次下载</span>
              <span className="opacity-60 flex-shrink-0">·</span>
              <img
                src={resolveAvatarUrl({ avatarFileName: item.data.ownerUserAvatar })}
                alt=""
                className="w-4 h-4 rounded-full object-cover flex-shrink-0"
                onError={(e) => {
                  // Fallback to default avatar on error
                  const target = e.target as HTMLImageElement;
                  target.style.display = 'none';
                  target.nextElementSibling?.classList.remove('hidden');
                }}
              />
              <div className="w-4 h-4 rounded-full bg-gray-600 items-center justify-center hidden flex-shrink-0">
                <User size={10} />
              </div>
              <span className="truncate">{item.data.ownerUserName || '未知用户'}</span>
              <span className="opacity-60 flex-shrink-0">·</span>
              <span className="flex-shrink-0">{new Date(item.data.createdAt).toLocaleDateString()}</span>
            </div>

            {/* 右侧：下载按钮 */}
            <Button
              size="xs"
              variant="secondary"
              disabled={forking || localForking}
              onClick={handleForkClick}
              className="flex-shrink-0"
            >
              <Hand size={12} />
              {(forking || localForking) ? '下载中...' : '拿来吧'}
            </Button>
          </div>
        </div>
      </div>
    </GlassCard>
  );
};

export default MarketplaceCard;
