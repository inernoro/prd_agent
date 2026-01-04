import { useEffect, useMemo, useState } from 'react';
import { useSystemErrorStore } from '../../stores/systemErrorStore';

export default function SystemErrorModal() {
  const { isOpen, title, code, message, details, close } = useSystemErrorStore();
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    if (!isOpen) setShowDetails(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, close]);

  const hasDetails = Boolean(details && details.trim());

  const headerRight = useMemo(() => {
    if (!code) return null;
    return (
      <span className="text-xs font-mono px-2 py-1 rounded-md bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 text-text-secondary">
        {code}
      </span>
    );
  }, [code]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={close} />

      <div className="relative z-10 w-full max-w-lg mx-4 ui-glass-modal overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-black/10 dark:border-white/10 ui-glass-bar">
          <div className="min-w-0">
            <div className="text-lg font-semibold text-text-primary truncate">{title || '系统错误'}</div>
          </div>
          <div className="flex items-center gap-2">
            {headerRight}
            <button
              type="button"
              onClick={close}
              className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
              aria-label="关闭"
              title="关闭"
            >
              <svg className="w-5 h-5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div className="text-sm text-text-primary whitespace-pre-wrap break-words">{message || '请求失败'}</div>

          {hasDetails ? (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowDetails((v) => !v)}
                className="inline-flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary transition-colors"
              >
                <span className="font-medium">{showDetails ? '隐藏详情' : '查看详情'}</span>
                <svg
                  className={`w-4 h-4 transition-transform ${showDetails ? 'rotate-180' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {showDetails ? (
                <pre className="text-xs leading-relaxed whitespace-pre-wrap break-words p-3 rounded-lg bg-black/5 dark:bg-black/30 border border-black/10 dark:border-white/10 text-text-secondary max-h-[40vh] overflow-auto">
                  {details}
                </pre>
              ) : null}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={close}
              className="px-3 py-2 text-sm rounded-lg bg-black/5 text-text-secondary hover:bg-black/10 transition-colors dark:bg-white/10 dark:text-white dark:hover:bg-white/15"
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}



