import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { TRACKED_RECORDS_CHANGED_EVENT } from './productRecordTrackStorage';

/** 列表工具栏「仅看追踪」切换（与产品列表「收藏」一致交互） */
export function TrackedFilterToggle({
  active,
  onChange,
}: {
  active: boolean;
  onChange: (next: boolean) => void;
}) {
  const [, bump] = useState(0);
  useEffect(() => {
    const refresh = () => bump((v) => v + 1);
    window.addEventListener(TRACKED_RECORDS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(TRACKED_RECORDS_CHANGED_EVENT, refresh);
  }, []);

  return (
    <button
      type="button"
      onClick={() => onChange(!active)}
      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs border transition-colors ${
        active
          ? 'bg-amber-500/15 text-amber-200 border-amber-500/35'
          : 'text-white/50 border-white/10 hover:bg-white/5 hover:text-amber-200/90'
      }`}
      title={active ? '显示全部记录' : '仅显示已追踪记录'}
    >
      <Star size={12} className={active ? 'fill-amber-300 text-amber-300' : ''} />
      追踪
    </button>
  );
}
