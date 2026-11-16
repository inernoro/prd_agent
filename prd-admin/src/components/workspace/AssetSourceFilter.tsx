import { useMemo } from 'react';
import './workspace.css';
export function AssetSourceFilter({
  items,
  value,
  onChange,
  compact = false,
}: {
  items: { source?: string | null }[];
  value: string;
  compact?: boolean;
  onChange: (value: string) => void;
}) {
  const sources = useMemo(() => {
    const counts = new Map<string, number>();
    items.forEach((item) => {
      const source = item.source || '未标注来源';
      counts.set(source, (counts.get(source) ?? 0) + 1);
    });
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [items]);
  if (compact)
    return (
      <select
        className="workspace-select"
        aria-label="按已载入资源来源筛选"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">全部来源 · {items.length}</option>
        {sources.map(([source, count]) => (
          <option key={source} value={source}>
            {source} · {count}
          </option>
        ))}
      </select>
    );
  return (
    <nav className="workspace-facets" aria-label="按已载入资源来源筛选">
      <span>来源</span>
      <button type="button" aria-pressed={!value} onClick={() => onChange('')}>
        全部 {items.length}
      </button>
      {sources.map(([source, count]) => (
        <button
          type="button"
          key={source}
          aria-pressed={value === source}
          onClick={() => onChange(source === value ? '' : source)}
        >
          {source} {count}
        </button>
      ))}
      <span>已载入范围</span>
    </nav>
  );
}
