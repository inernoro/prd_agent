import { useState, useEffect } from 'react';
import { useDesktopBrandingStore } from '../../stores/desktopBrandingStore';

export default function StartLoadOverlay(props: { open: boolean }) {
  const { open } = props;
  const getAssetUrl = useDesktopBrandingStore((s) => s.getAssetUrl);
  const [currentSrc, setCurrentSrc] = useState<string>('');

  useEffect(() => {
    // 直接从 branding 获取 start_load 资源 URL
    const url = getAssetUrl('start_load');
    setCurrentSrc(url || '');
  }, [getAssetUrl]);

  if (!open) return null;

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
              // 加载失败，清空 URL 显示 fallback spinner
              setCurrentSrc('');
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


