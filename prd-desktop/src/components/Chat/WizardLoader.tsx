import { useEffect, useMemo, useState } from 'react';
import { useIsSkinVariantUnavailable, useRemoteAssetsStore, useRemoteAssetUrlPair } from '../../stores/remoteAssetsStore';

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
  const { skinUrl, baseUrl } = useRemoteAssetUrlPair('icon.desktop.load');
  const { skin, unavailable } = useIsSkinVariantUnavailable('icon.desktop.load');
  const [stage, setStage] = useState<'skin' | 'base' | 'local'>(() => {
    if (unavailable) return 'base';
    return skinUrl && skinUrl !== baseUrl ? 'skin' : 'base';
  });

  // 当 URL 发生变化（etag/lastModified 更新、baseUrl/skin 变更）时，重新按优先级尝试远端资源
  useEffect(() => {
    setStage(unavailable ? 'base' : (skinUrl && skinUrl !== baseUrl ? 'skin' : 'base'));
  }, [skinUrl, baseUrl, unavailable]);

  const ariaLabel = useMemo(() => label || '处理中', [label]);
  const currentSrc = stage === 'skin' ? skinUrl : stage === 'base' ? baseUrl : null;

  return (
    <div
      className={rootClass}
      style={labelMode === 'below' ? { minHeight: `${Math.round(s + 56)}px` } : undefined}
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
                if (stage === 'skin' && baseUrl && baseUrl !== skinUrl) {
                  // 皮肤资源缺失：记住并直接跳过，避免下次再次先撞 404 再回退
                  useRemoteAssetsStore.getState().markSkinVariantUnavailable('icon.desktop.load', skin);
                  setStage('base');
                } else {
                  setStage('local');
                }
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


