import { useEffect, useState } from 'react';

/** 只在导航/返回和宽度改变时定位一次；用户随后横滚不会被抢回。 */
export function useSettingsTabVisibility(activeTab: string) {
  const [rail, setRail] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!rail) return;
    let frame = 0;
    let width = rail.clientWidth;
    const locate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => rail.querySelector<HTMLElement>('[role="tab"][data-state="active"]')?.scrollIntoView({ block: 'nearest', inline: 'center' }));
    };
    locate();
    const observer = new ResizeObserver(() => { if (rail.clientWidth !== width) { width = rail.clientWidth; locate(); } });
    observer.observe(rail);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [activeTab, rail]);
  return setRail;
}
