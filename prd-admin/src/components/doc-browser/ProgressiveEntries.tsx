import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';

/** 每层分批挂载；定位末尾文档时直接显示附近一批，不挂载此前数千行。 */
export function ProgressiveEntries<T>({ items, render, itemKey, revealIndex = -1 }: {
  items: T[];
  render: (item: T, index: number) => ReactNode;
  itemKey: (item: T, index: number) => string;
  revealIndex?: number;
}) {
  const [range, setRange] = useState({ start: 0, end: 100 });
  const sentinel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (revealIndex < 0) return;
    setRange(previous => {
      if (revealIndex >= previous.start && revealIndex < previous.end) return previous;
      const start = Math.floor(revealIndex / 100) * 100;
      return { start, end: start + 100 };
    });
  }, [revealIndex]);
  useEffect(() => {
    setRange(previous => previous.start > 0 && previous.start >= items.length ? { start: 0, end: 100 } : previous);
  }, [items.length]);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setRange(previous => ({ ...previous, end: previous.end + 100 }));
    }, { rootMargin: '100px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [range.end, items.length]);
  return <>
    {range.start > 0 && <div className="flex items-center justify-between px-3 py-2 text-[11px] text-token-muted">
      <button type="button" onClick={() => setRange(previous => ({ ...previous, start: Math.max(0, previous.start - 100) }))}>
        加载前面的条目（{range.start} 条）
      </button>
      <button type="button" onClick={() => setRange({ start: 0, end: 100 })}>从头浏览</button>
    </div>}
    {items.slice(range.start, range.end).map((item, offset) => {
      const index = range.start + offset;
      return <Fragment key={itemKey(item, index)}>{render(item, index)}</Fragment>;
    })}
    {range.end < items.length && <button ref={sentinel} type="button"
      onClick={() => setRange(previous => ({ ...previous, end: previous.end + 100 }))}
      className="w-full px-3 py-2 text-[11px] text-token-muted hover-text-primary"
      aria-label={`加载更多条目，还剩 ${items.length - range.end} 条`}>
      加载更多（还剩 {items.length - range.end} 条）
    </button>}
  </>;
}
