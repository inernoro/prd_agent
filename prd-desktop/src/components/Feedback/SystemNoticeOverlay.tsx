import { useEffect } from 'react';
import { useSystemNoticeStore } from '../../stores/systemNoticeStore';

function levelClass(level: string) {
  switch (level) {
    case 'error':
      return 'text-red-100 bg-red-500/15 ring-red-300/25';
    case 'warning':
      return 'text-amber-100 bg-amber-500/15 ring-amber-300/25';
    default:
      return 'text-white/80 bg-black/25 dark:bg-white/5 ring-white/10';
  }
}

export default function SystemNoticeOverlay() {
  const notices = useSystemNoticeStore((s) => s.notices);
  const remove = useSystemNoticeStore((s) => s.remove);

  // 自动过期清理：保持 UI 轻量，不污染消息流
  useEffect(() => {
    if (!notices || notices.length === 0) return;
    const now = Date.now();
    const nextExpireAt = Math.min(...notices.map((n) => n.expiresAt || now + 6000));
    const delay = Math.max(50, nextExpireAt - now);
    const t = window.setTimeout(() => {
      const now2 = Date.now();
      for (const n of notices) {
        if (n.expiresAt && n.expiresAt <= now2) remove(n.id);
      }
    }, delay);
    return () => window.clearTimeout(t);
  }, [notices, remove]);

  if (!notices || notices.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      <div className="flex flex-col items-center gap-2 px-4">
        {notices.slice(-2).map((n) => (
          <div
            key={n.id}
            className={`pointer-events-auto max-w-[86%] px-4 py-2 rounded-full text-[12px] leading-5 select-none backdrop-blur-sm ring-1 shadow-sm ${levelClass(n.level)}`}
            title={n.message}
          >
            {n.message}
          </div>
        ))}
      </div>
    </div>
  );
}


