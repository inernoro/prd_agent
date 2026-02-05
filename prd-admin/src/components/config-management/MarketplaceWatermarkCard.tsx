/**
 * 通用海鲜市场水印卡片组件
 * 文学创作和视觉创作共用
 */

import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { WatermarkDescriptionGrid } from '@/components/watermark/WatermarkDescriptionGrid';
import { Hand, User, Droplet } from 'lucide-react';
import type { MarketplaceWatermarkConfig } from '@/services/contracts/watermark';
import type { MarketplaceCardContext } from './ConfigManagementDialogBase';

interface MarketplaceWatermarkCardProps {
  config: MarketplaceWatermarkConfig;
  ctx: MarketplaceCardContext;
  onFork: () => Promise<boolean>;
}

export function MarketplaceWatermarkCard({ config, ctx, onFork }: MarketplaceWatermarkCardProps) {
  // 格式化日期
  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  };

  return (
    <GlassCard className="p-0 overflow-hidden">
      <div className="flex flex-col">
        {/* 标题区 */}
        <div className="p-2 pb-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1 flex items-center gap-1.5">
              <Droplet size={14} style={{ color: 'rgba(147, 197, 253, 0.85)', flexShrink: 0 }} />
              <div
                className="flex-1 font-semibold text-[13px]"
                style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
              >
                {config.name}
              </div>
            </div>
            {/* 类型标签 */}
            <span
              className="text-[9px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0"
              style={{
                background: 'rgba(168, 85, 247, 0.12)',
                color: 'rgba(168, 85, 247, 0.95)',
                border: '1px solid rgba(168, 85, 247, 0.28)',
              }}
            >
              水印
            </span>
          </div>
        </div>

        {/* 配置详情 + 预览图（与 WatermarkSettingsPanel 保持一致：100px 高度） */}
        <div className="px-2 pb-1">
          <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) 100px', height: '100px' }}>
            <WatermarkDescriptionGrid
              data={{
                text: config.text,
                fontKey: config.fontKey,
                fontSizePx: config.fontSizePx,
                opacity: config.opacity,
                anchor: config.anchor,
                offsetX: config.offsetX,
                offsetY: config.offsetY,
                positionMode: config.positionMode,
                iconEnabled: config.iconEnabled,
                borderEnabled: config.borderEnabled,
                backgroundEnabled: config.backgroundEnabled,
                roundedBackgroundEnabled: config.roundedBackgroundEnabled,
              }}
            />
            <div
              className="flex items-center justify-center overflow-hidden rounded-[6px]"
              style={{
                background: config.previewUrl
                  ? 'repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50% / 12px 12px'
                  : 'rgba(255,255,255,0.02)',
                border: config.previewUrl ? 'none' : '1px solid rgba(255,255,255,0.08)',
              }}
            >
              {config.previewUrl ? (
                <img
                  src={config.previewUrl}
                  alt={config.name}
                  className="block w-full h-full object-contain"
                />
              ) : (
                <div className="text-[11px]" style={{ color: 'rgba(233,209,156,0.7)' }}>无预览</div>
              )}
            </div>
          </div>
        </div>

        {/* 底部操作区 */}
        <div className="px-2 pb-2 pt-1">
          <div className="flex items-center justify-between">
            {/* 下载次数 + 作者 + 日期 */}
            <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
              <span
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-full"
                style={{
                  background: 'rgba(59, 130, 246, 0.12)',
                  color: 'rgba(59, 130, 246, 0.95)',
                  border: '1px solid rgba(59, 130, 246, 0.28)',
                }}
              >
                <Hand size={10} />
                {config.forkCount} 次下载
              </span>
              {/* 作者信息 */}
              {config.ownerUserAvatar ? (
                <img src={config.ownerUserAvatar} alt="" className="w-4 h-4 rounded-full object-cover" />
              ) : (
                <div className="w-4 h-4 rounded-full bg-gray-600 flex items-center justify-center">
                  <User size={10} />
                </div>
              )}
              <span>{config.ownerUserName || '未知用户'}</span>
              {/* 日期 */}
              {config.createdAt && (
                <span>{formatDate(config.createdAt)}</span>
              )}
            </div>
            {/* 拿来吧按钮 */}
            <Button
              size="xs"
              variant="secondary"
              onClick={() => void ctx.onFork(config.id, onFork)}
              disabled={ctx.saving || ctx.forkingId === config.id}
            >
              <Hand size={12} />
              {ctx.forkingId === config.id ? '下载中...' : '拿来吧'}
            </Button>
          </div>
        </div>
      </div>
    </GlassCard>
  );
}
