import loadGif from '../../assets/load.gif';

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
  /** 控制整体大小（px） */
  size?: number;
};

export default function WizardLoader({
  className,
  label,
  labelMode = 'inline',
  size = 120,
}: WizardLoaderProps) {
  const s = Math.max(40, Math.min(180, Number(size) || 120));
  const rootClass = `flex items-center gap-3 ${labelMode === 'below' ? 'flex-col items-start gap-2' : ''} ${className || ''}`.trim();

  return (
    <div
      className={rootClass}
      style={labelMode === 'below' ? { minHeight: `${Math.round(s + 56)}px` } : undefined}
      aria-label={label || '处理中'}
      title={label || '处理中'}
    >
      <div className={labelMode === 'below' ? 'flex items-center gap-3' : ''}>
        <div className="relative flex items-center justify-center" style={{ width: `${s}px`, height: `${s}px` }}>
          <img
            src={loadGif}
            alt=""
            aria-hidden="true"
            width={s}
            height={s}
            className="block select-none pointer-events-none"
            style={{ imageRendering: 'auto' }}
          />
          {label && labelMode === 'overlay' ? (
            <div className="absolute left-0 right-0 -bottom-4 text-xs text-text-secondary truncate">{label}</div>
          ) : null}
        </div>
        {label && labelMode === 'inline' ? (
          <div className="flex items-center h-9 px-3 rounded-xl ui-control">
            <span className="text-sm text-text-secondary">{label}</span>
          </div>
        ) : null}
      </div>

      {label && labelMode === 'below' ? (
        <div className="flex items-center h-9 px-3 rounded-xl ui-control">
          <span className="text-sm text-text-secondary">{label}</span>
        </div>
      ) : null}
    </div>
  );
}


