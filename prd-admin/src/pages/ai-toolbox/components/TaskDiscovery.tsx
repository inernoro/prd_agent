import { useMemo } from 'react';
import { useToolboxStore } from '@/stores/toolboxStore';
import type { ToolboxItem } from '@/services';
import '@/components/workspace/workspace.css';

/** 标签来自可见工具；最近使用来自用户真实访问记录。 */
export function TaskDiscovery({
  items,
  compact = false,
}: {
  items: ToolboxItem[];
  compact?: boolean;
}) {
  const activeTag = useToolboxStore((s) => s.activeTagFilter);
  const setTag = useToolboxStore((s) => s.setActiveTagFilter);
  const recent = useToolboxStore((s) => s.recentlyUsedIds);
  const select = useToolboxStore((s) => s.selectItem);
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    items.forEach((item) =>
      new Set(item.tags).forEach((tag) =>
        counts.set(tag, (counts.get(tag) ?? 0) + 1),
      ),
    );
    return [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10);
  }, [items]);
  const recentItems = recent
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is ToolboxItem => Boolean(item))
    .slice(0, 4);
  if (compact)
    return (
      <select
        className="workspace-select shrink-0"
        aria-label="按任务发现工具"
        value={activeTag || ''}
        onChange={(event) => setTag(event.target.value || null)}
      >
        <option value="">全部任务</option>
        {tags.map(([tag, count]) => (
          <option key={tag} value={tag}>
            {tag} · {count}
          </option>
        ))}
      </select>
    );
  return (
    <section
      className="map-workspace task-discovery"
      aria-label="按任务发现工具"
    >
      <div className="task-discovery-tags">
        <strong>按任务发现</strong>
        <div className="ws-tabs">
          <button
            type="button"
            aria-pressed={!activeTag}
            onClick={() => setTag(null)}
          >
            全部任务
          </button>
          {tags.map(([tag, count]) => (
            <button
              key={tag}
              type="button"
              aria-pressed={tag === activeTag}
              onClick={() => setTag(tag === activeTag ? null : tag)}
            >
              {tag}
              <small>{count}</small>
            </button>
          ))}
        </div>
      </div>
      {recentItems.length > 0 && (
        <div className="task-discovery-recent">
          <span>最近使用</span>
          {recentItems.map((item) => (
            <button type="button" key={item.id} onClick={() => select(item)}>
              {item.name}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
