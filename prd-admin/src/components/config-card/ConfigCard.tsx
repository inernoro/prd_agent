import React from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { Share2, Check, Pencil, Trash2, XCircle, GitFork } from 'lucide-react';

/**
 * 通用配置卡片项接口
 */
export interface IConfigCardItem {
  id: string;
  name: string;
  isPublic?: boolean;
  forkCount?: number;
}

/**
 * 内容区布局类型
 */
export type ContentLayout = 'text-only' | 'text-image' | 'config-image';

/**
 * 配置卡片属性
 */
export interface ConfigCardProps<T extends IConfigCardItem> {
  item: T;

  // 状态
  isActive?: boolean;
  saving?: boolean;
  glow?: boolean;

  // 头部
  headerIcon?: React.ReactNode;
  headerBadges?: React.ReactNode;
  headerActions?: React.ReactNode;

  // 内容区
  contentLayout?: ContentLayout;
  contentHeight?: number;
  imageWidth?: number;

  // 内容渲染
  renderContent?: (item: T) => React.ReactNode;
  renderImage?: (item: T) => React.ReactNode;

  // 底部操作
  onSelect?: (item: T) => void;
  onEdit?: (item: T) => void;
  onDelete?: (item: T) => void;
  onPublish?: (item: T) => void;
  onUnpublish?: (item: T) => void;

  // 自定义底部
  footerLeft?: React.ReactNode;
  footerRight?: React.ReactNode;
  hideDefaultFooter?: boolean;
}

/**
 * 通用配置卡片组件
 *
 * 支持三种布局：
 * - text-only: 纯文本内容（提示词）
 * - text-image: 左文本 + 右图片（风格图）
 * - config-image: 左配置表 + 右图片（水印）
 */
export function ConfigCard<T extends IConfigCardItem>({
  item,
  isActive = false,
  saving = false,
  glow = false,
  headerIcon,
  headerBadges,
  headerActions,
  contentLayout = 'text-only',
  contentHeight = 100,
  imageWidth = 100,
  renderContent,
  renderImage,
  onSelect,
  onEdit,
  onDelete,
  onPublish,
  onUnpublish,
  footerLeft,
  footerRight,
  hideDefaultFooter = false,
}: ConfigCardProps<T>) {
  const showImage = contentLayout !== 'text-only' && renderImage;

  return (
    <GlassCard glow={glow} className="p-0 overflow-hidden">
      <div className="flex flex-col">
        {/* 头部 */}
        <div className="p-2 pb-1 flex-shrink-0">
          <div className="flex items-start justify-between gap-2">
            {/* 左侧：图标 + 标题 */}
            <div className="min-w-0 flex-1 flex items-center gap-1.5">
              {headerIcon}
              <div
                className="font-semibold text-[13px] truncate"
                style={{ color: 'var(--text-primary)' }}
                title={item.name}
              >
                {item.name}
              </div>
            </div>

            {/* 右侧：徽章 + 操作 */}
            <div className="flex items-center gap-1 flex-shrink-0">
              {headerBadges}
              {headerActions}
            </div>
          </div>
        </div>

        {/* 内容区 */}
        <div className="px-2 pb-1 flex-shrink-0">
          {showImage ? (
            <div
              className="grid gap-2"
              style={{
                gridTemplateColumns: `minmax(0, 1fr) ${imageWidth}px`,
                height: `${contentHeight}px`,
              }}
            >
              {/* 左侧内容 */}
              <div
                className="overflow-auto border rounded-[6px]"
                style={{
                  borderColor: 'rgba(255,255,255,0.08)',
                  background: 'rgba(255,255,255,0.02)',
                }}
              >
                {renderContent?.(item)}
              </div>

              {/* 右侧图片 */}
              <div className="flex-shrink-0">
                {renderImage(item)}
              </div>
            </div>
          ) : (
            <div
              className="overflow-auto border rounded-[6px]"
              style={{
                height: `${contentHeight}px`,
                borderColor: 'rgba(255,255,255,0.08)',
                background: 'rgba(255,255,255,0.02)',
              }}
            >
              {renderContent?.(item)}
            </div>
          )}
        </div>

        {/* 底部 */}
        {!hideDefaultFooter && (
          <div
            className="px-2 pb-2 pt-1 flex-shrink-0 border-t"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <div className="flex items-center justify-between">
              {/* 左侧：发布相关 */}
              <div className="flex items-center gap-2">
                {footerLeft ?? (
                  <>
                    {item.isPublic ? (
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => onUnpublish?.(item)}
                        disabled={saving}
                      >
                        <XCircle size={12} />
                        取消发布
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => onPublish?.(item)}
                        disabled={saving}
                      >
                        <Share2 size={12} />
                        发布
                      </Button>
                    )}
                    {typeof item.forkCount === 'number' && (
                      <span
                        className="text-[11px] flex items-center gap-1"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        <GitFork size={11} />
                        {item.forkCount}
                      </span>
                    )}
                  </>
                )}
              </div>

              {/* 右侧：选择/编辑/删除 */}
              <div className="flex items-center gap-1">
                {footerRight ?? (
                  <>
                    {onSelect && (
                      isActive ? (
                        <button
                          type="button"
                          className="inline-flex items-center justify-center gap-1.5 font-semibold h-[28px] px-3 rounded-[9px] text-[12px] transition-all duration-200 disabled:opacity-50"
                          style={{
                            background: 'rgba(34, 197, 94, 0.15)',
                            border: '1px solid rgba(34, 197, 94, 0.3)',
                            color: 'rgba(34, 197, 94, 0.95)',
                          }}
                          onClick={() => onSelect(item)}
                          disabled={saving}
                        >
                          <Check size={12} />
                          已选择
                        </button>
                      ) : (
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={() => onSelect(item)}
                          disabled={saving}
                        >
                          <Check size={12} />
                          选择
                        </Button>
                      )
                    )}
                    {onEdit && (
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => onEdit(item)}
                        disabled={saving}
                      >
                        <Pencil size={12} />
                        编辑
                      </Button>
                    )}
                    {onDelete && (
                      <Button
                        size="xs"
                        variant="danger"
                        onClick={() => onDelete(item)}
                        disabled={saving}
                      >
                        <Trash2 size={12} />
                        删除
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </GlassCard>
  );
}

/**
 * 徽章组件 - 当前选中状态
 */
export const ActiveBadge: React.FC = () => (
  <span
    className="text-[10px] px-1.5 py-0.5 rounded"
    style={{
      background: 'rgba(74, 222, 128, 0.15)',
      color: 'rgba(74, 222, 128, 0.95)',
      border: '1px solid rgba(74, 222, 128, 0.25)',
    }}
  >
    当前
  </span>
);

/**
 * 徽章组件 - 已公开状态
 */
export const PublicBadge: React.FC = () => (
  <span
    className="text-[10px] px-1.5 py-0.5 rounded"
    style={{
      background: 'rgba(96, 165, 250, 0.15)',
      color: 'rgba(96, 165, 250, 0.95)',
      border: '1px solid rgba(96, 165, 250, 0.25)',
    }}
  >
    已公开
  </span>
);

/**
 * 徽章组件 - 自定义标签
 */
export const TagBadge: React.FC<{
  label: string;
  color?: 'purple' | 'green' | 'blue' | 'orange';
}> = ({ label, color = 'purple' }) => {
  const colorMap = {
    purple: {
      bg: 'rgba(168, 85, 247, 0.15)',
      text: 'rgba(168, 85, 247, 0.95)',
      border: 'rgba(168, 85, 247, 0.25)',
    },
    green: {
      bg: 'rgba(74, 222, 128, 0.15)',
      text: 'rgba(74, 222, 128, 0.95)',
      border: 'rgba(74, 222, 128, 0.25)',
    },
    blue: {
      bg: 'rgba(96, 165, 250, 0.15)',
      text: 'rgba(96, 165, 250, 0.95)',
      border: 'rgba(96, 165, 250, 0.25)',
    },
    orange: {
      bg: 'rgba(251, 146, 60, 0.15)',
      text: 'rgba(251, 146, 60, 0.95)',
      border: 'rgba(251, 146, 60, 0.25)',
    },
  };
  const c = colorMap[color];

  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded"
      style={{
        background: c.bg,
        color: c.text,
        border: `1px solid ${c.border}`,
      }}
    >
      {label}
    </span>
  );
};

/**
 * 图片预览组件
 */
export const ImagePreview: React.FC<{
  src?: string | null;
  alt?: string;
  fallback?: React.ReactNode;
  onClick?: () => void;
  className?: string;
}> = ({ src, alt = 'Preview', fallback, onClick, className = '' }) => {
  const [error, setError] = React.useState(false);

  React.useEffect(() => {
    setError(false);
  }, [src]);

  const hasValidImage = src && !error;

  return (
    <div
      className={`relative flex items-center justify-center overflow-hidden rounded-[6px] h-full ${className}`}
      style={{
        background: hasValidImage
          ? 'repeating-conic-gradient(#3a3a3a 0% 25%, #2a2a2a 0% 50%) 50% / 12px 12px'
          : 'rgba(255,255,255,0.02)',
        border: hasValidImage ? 'none' : '1px solid rgba(255,255,255,0.08)',
        cursor: hasValidImage && onClick ? 'zoom-in' : 'default',
      }}
      onClick={hasValidImage ? onClick : undefined}
    >
      {hasValidImage ? (
        <img
          src={src}
          alt={alt}
          className="block w-full h-full object-contain"
          onError={() => setError(true)}
        />
      ) : (
        fallback ?? (
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            无预览
          </span>
        )
      )}
    </div>
  );
};
