import { useState, type ReactNode } from 'react';

/**
 * 首页作品广场风格的卡片：
 * - 自然比例（瀑布流），由 coverWidth/coverHeight 决定；
 *   未知时默认 16/10（适合封面卡）或可在调用处传 aspect。
 * - 封面图全 bleed；若 coverUrl 为空或加载失败，使用 id 哈希映射出的渐变背景兜底。
 * - 底部统一的渐变遮罩 + 白色文字叠加（NotebookLM 风格）。
 * - hover 微微放大 + 阴影。
 */

const FALLBACK_GRADIENTS = [
  'linear-gradient(135deg, #1a1a2e 0%, #16213e 40%, #0f3460 100%)',
  'linear-gradient(135deg, #2d1b69 0%, #11998e 100%)',
  'linear-gradient(135deg, #1f1c2c 0%, #928dab 100%)',
  'linear-gradient(135deg, #0f2027 0%, #203a43 40%, #2c5364 100%)',
  'linear-gradient(135deg, #1a002e 0%, #3d1f5c 50%, #5c3d7a 100%)',
  'linear-gradient(135deg, #141e30 0%, #243b55 100%)',
];

export function getFallbackGradient(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  return FALLBACK_GRADIENTS[Math.abs(hash) % FALLBACK_GRADIENTS.length];
}

export interface PlazaCardProps {
  id: string;
  title: string;
  coverUrl?: string | null;
  coverWidth?: number;
  coverHeight?: number;
  /** 封面 aspect 覆盖：如 '16/10'、'4/3'；未传则按 coverWidth/Height 推断 */
  aspect?: string;
  /** 封面上方的装饰（通常是 hover 显示的「取消公开」按钮） */
  topOverlay?: ReactNode;
  /** 封面底部 overlay 区的自定义内容（默认输出 title + meta） */
  bottomOverlay?: ReactNode;
  /** title 下的 meta（一行，如 "公开于 2026-03-28" 或 "11 篇"） */
  meta?: ReactNode;
  /** 无封面时 center 区显示的装饰元素（如大号引号或图标） */
  noCoverDecoration?: ReactNode;
  onClick?: () => void;
}

export function PlazaCard({
  id,
  title,
  coverUrl,
  coverWidth,
  coverHeight,
  aspect,
  topOverlay,
  bottomOverlay,
  meta,
  noCoverDecoration,
  onClick,
}: PlazaCardProps) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const hasCover = !!coverUrl && !imgError;

  const aspectRatio =
    aspect ?? (coverWidth && coverHeight ? `${coverWidth}/${coverHeight}` : '16/10');

  return (
    <div
      className="group w-full max-w-sm cursor-pointer"
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div
        className="relative w-full overflow-hidden rounded-xl transition-all duration-300 group-hover:scale-[1.02] group-hover:shadow-xl group-hover:shadow-black/30"
        style={{
          aspectRatio,
          background: hasCover ? '#0a0a0f' : getFallbackGradient(id),
        }}
      >
        {coverUrl && !imgError && (
          <img
            src={coverUrl}
            alt={title}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.06]"
            style={{ opacity: imgLoaded ? 1 : 0, transition: 'opacity 0.5s ease' }}
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
          />
        )}

        {!hasCover && noCoverDecoration && (
          <div className="pointer-events-none absolute inset-0 flex select-none items-center justify-center">
            {noCoverDecoration}
          </div>
        )}

        {/* 底部渐变遮罩（保证文字可读） */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: hasCover
              ? 'linear-gradient(180deg, rgba(0,0,0,0.02) 0%, rgba(0,0,0,0.12) 35%, rgba(0,0,0,0.72) 100%)'
              : 'linear-gradient(180deg, transparent 30%, rgba(0,0,0,0.4) 100%)',
          }}
        />

        {topOverlay && (
          <div
            className="absolute left-2 top-2 z-20 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            {topOverlay}
          </div>
        )}

        <div className="absolute inset-0 z-10 flex flex-col justify-end gap-1.5 p-3.5">
          {bottomOverlay ?? (
            <>
              <h3
                className="line-clamp-2 text-[15px] font-bold leading-snug drop-shadow-lg"
                style={{ color: '#fff', textShadow: '0 1px 6px rgba(0,0,0,0.5)' }}
              >
                {title || '未命名'}
              </h3>
              {meta && (
                <div className="flex items-center gap-2 text-[10px] text-white/60 drop-shadow">
                  {meta}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
