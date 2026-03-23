import { useUpdateStore } from '../../stores/updateStore';

/**
 * 右下角浮层通知：静默下载完成后提示用户点击安装更新。
 * 仅在 phase === 'ready' && !isDismissed 时显示。
 */
export default function UpdateNotification() {
  const phase = useUpdateStore((s) => s.phase);
  const version = useUpdateStore((s) => s.version);
  const isDismissed = useUpdateStore((s) => s.isDismissed);
  const installUpdate = useUpdateStore((s) => s.installUpdate);
  const dismiss = useUpdateStore((s) => s.dismiss);
  const updateSource = useUpdateStore((s) => s.updateSource);

  if (phase !== 'ready' || isDismissed) return null;

  const isAccelerated = updateSource === 'accelerated';

  return (
    <div className="fixed bottom-4 right-4 z-50 animate-slide-in-right">
      <div className="relative max-w-xs rounded-xl backdrop-blur-xl bg-black/40 dark:bg-white/10 ring-1 ring-white/15 shadow-2xl p-4">
        {/* 关闭按钮 */}
        <button
          onClick={dismiss}
          className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-full text-white/50 hover:text-white/90 hover:bg-white/10 transition-colors"
          title="稍后再说"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
            <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
          </svg>
        </button>

        {/* 图标 + 标题 */}
        <div className="flex items-start gap-3 pr-6">
          <div className={`mt-0.5 flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${isAccelerated ? 'bg-amber-500/20' : 'bg-cyan-500/20'}`}>
            {isAccelerated ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-amber-400">
                <path d="M11.983 1.907a.75.75 0 00-1.292-.657l-8.5 9.5A.75.75 0 002.75 12h6.572l-1.305 6.093a.75.75 0 001.292.657l8.5-9.5A.75.75 0 0017.25 8h-6.572l1.305-6.093z" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-cyan-400">
                <path fillRule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clipRule="evenodd" />
              </svg>
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-medium text-white/90">
                新版本已就绪
              </p>
              {isAccelerated && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/25 text-amber-300 border border-amber-500/30">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-2.5 h-2.5">
                    <path d="M11.983 1.907a.75.75 0 00-1.292-.657l-8.5 9.5A.75.75 0 002.75 12h6.572l-1.305 6.093a.75.75 0 001.292.657l8.5-9.5A.75.75 0 0017.25 8h-6.572l1.305-6.093z" />
                  </svg>
                  极速下载
                </span>
              )}
            </div>
            <p className="text-xs text-white/50 mt-0.5 truncate">
              v{version} 已下载完成
            </p>
          </div>
        </div>

        {/* 安装按钮 */}
        <button
          onClick={installUpdate}
          className={`mt-3 w-full py-2.5 px-3 text-sm font-semibold rounded-lg text-white transition-all flex items-center justify-center gap-1.5 shadow-lg ${
            isAccelerated
              ? 'bg-amber-500 hover:bg-amber-400 shadow-amber-500/30 hover:shadow-amber-500/50'
              : 'bg-cyan-500 hover:bg-cyan-400 shadow-cyan-500/30 hover:shadow-cyan-500/50'
          }`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M10 17a.75.75 0 01-.75-.75V5.612L5.29 9.77a.75.75 0 01-1.08-1.04l5.25-5.5a.75.75 0 011.08 0l5.25 5.5a.75.75 0 11-1.08 1.04l-3.96-4.158V16.25A.75.75 0 0110 17z" clipRule="evenodd" />
          </svg>
          安装并重启
        </button>
      </div>

      {/* slide-in 动画（内联样式，避免依赖全局 CSS） */}
      <style>{`
        @keyframes slideInRight {
          from { opacity: 0; transform: translateX(24px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .animate-slide-in-right {
          animation: slideInRight 0.3s ease-out;
        }
      `}</style>
    </div>
  );
}
