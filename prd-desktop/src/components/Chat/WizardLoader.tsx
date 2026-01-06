import { useEffect, useMemo, useState } from 'react';
import { useDesktopBrandingStore } from '../../stores/desktopBrandingStore';

export type WizardLoaderProps = {
  className?: string;
  label?: string;
  /**
   * label 展示模式：
   * - inline：在动画右侧以“输入框同款基线”展示（默认）
   * - below：在动画下方左侧展示（用于消息气泡内，占据下方空白区）
   * - overlay：覆盖在动画下方（旧行为）
   */
  labelMode?: 'inline' | 'below' | 'overlay';
  /**
   * label 样式：
   * - pill：胶囊/控件风格（默认，历史行为）
   * - plain：纯文字（无边框/背景），字号继承父级（用于“思考中...”）
   */
  labelVariant?: 'pill' | 'plain';
  /** 控制整体大小（px） */
  size?: number;
};

export default function WizardLoader({
  className,
  label,
  labelMode = 'inline',
  labelVariant = 'pill',
  size = 120,
}: WizardLoaderProps) {
  const s = Math.max(40, Math.min(180, Number(size) || 120));
  const rootClass = `flex items-center gap-3 ${labelMode === 'below' ? 'flex-col items-start gap-2' : ''} ${className || ''}`.trim();
  const getAssetUrl = useDesktopBrandingStore((s) => s.getAssetUrl);
  const [currentSrc, setCurrentSrc] = useState<string>('');

  useEffect(() => {
    // 直接从 branding 获取 load 资源 URL
    const url = getAssetUrl('load');
    setCurrentSrc(url || '');
  }, [getAssetUrl]);

  const ariaLabel = useMemo(() => label || '处理中', [label]);
  const isPlain = labelVariant === 'plain';
  const labelEl = label
    ? (isPlain
      ? <div className="text-text-secondary text-[1em] leading-6">{label}</div>
      : (
        <div className="flex items-center h-9 px-3 rounded-xl ui-control">
          <span className="text-sm text-text-secondary">{label}</span>
        </div>
      ))
    : null;
  // below 模式原本用 minHeight 预留“气泡内空白区”，但在纯文字 variant 下会造成明显多余留白
  const belowMinHeightStyle = (labelMode === 'below' && !isPlain)
    ? { minHeight: `${Math.round(s + 56)}px` }
    : undefined;

  return (
    <div
      className={rootClass}
      style={belowMinHeightStyle}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <div className={labelMode === 'below' ? 'flex items-center gap-3' : ''}>
        <div className="relative flex items-center justify-center" style={{ width: `${s}px`, height: `${s}px` }}>
          {currentSrc ? (
            <img
              src={currentSrc}
              alt=""
              aria-hidden="true"
              width={s}
              height={s}
              className="block select-none pointer-events-none"
              style={{ imageRendering: 'auto' }}
              onError={() => {
                // 加载失败，清空 URL 显示 fallback spinner
                setCurrentSrc('');
              }}
            />
          ) : (
            <div
              aria-hidden="true"
              className="rounded-full border-4 border-black/10 dark:border-white/10 border-t-black/40 dark:border-t-white/40 animate-spin"
              style={{ width: `${s}px`, height: `${s}px` }}
            />
          )}
          {label && labelMode === 'overlay' ? (
            <div className="absolute left-0 right-0 -bottom-4 text-xs text-text-secondary truncate">{label}</div>
          ) : null}
        </div>
        {labelMode === 'inline' ? labelEl : null}
      </div>

      {labelMode === 'below' ? labelEl : null}
    </div>
  );
}


