import { useEffect, useState } from 'react';
import { useIsSkinVariantUnavailable, useRemoteAssetsStore, useRemoteAssetUrlPair } from '../../stores/remoteAssetsStore';

export default function StartLoadOverlay(props: { open: boolean }) {
  const { open } = props;
  const { skinUrl, baseUrl } = useRemoteAssetUrlPair('icon.desktop.startLoad');
  const { skin, unavailable } = useIsSkinVariantUnavailable('icon.desktop.startLoad');
  const [stage, setStage] = useState<'skin' | 'base' | 'local'>(() => {
    if (unavailable) return 'base';
    return skinUrl && skinUrl !== baseUrl ? 'skin' : 'base';
  });

  useEffect(() => {
    if (!open) return;
    setStage(unavailable ? 'base' : (skinUrl && skinUrl !== baseUrl ? 'skin' : 'base'));
  }, [open, skinUrl, baseUrl, unavailable]);

  if (!open) return null;

  const currentSrc = stage === 'skin' ? skinUrl : stage === 'base' ? baseUrl : null;

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-background-light dark:bg-background-dark">
      {/* 与当前皮肤一致的背景遮罩：轻微玻璃感，避免“白屏突兀” */}
      <div className="absolute inset-0 ui-glass-panel opacity-70" aria-hidden="true" />

      <div className="relative flex items-center justify-center">
        {currentSrc ? (
          <img
            src={currentSrc}
            alt=""
            aria-hidden="true"
            width={160}
            height={160}
            className="block select-none pointer-events-none"
            onError={() => {
              if (stage === 'skin' && baseUrl && baseUrl !== skinUrl) {
                useRemoteAssetsStore.getState().markSkinVariantUnavailable('icon.desktop.startLoad', skin);
                setStage('base');
              }
              else setStage('local');
            }}
          />
        ) : (
          <div
            aria-hidden="true"
            className="rounded-full border-4 border-black/10 dark:border-white/10 border-t-black/40 dark:border-t-white/40 animate-spin"
            style={{ width: 88, height: 88 }}
          />
        )}
      </div>
    </div>
  );
}


