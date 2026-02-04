import type { ToolboxItem } from '@/services';
import { useToolboxStore } from '@/stores/toolboxStore';
import { Zap } from 'lucide-react';

interface ToolCardProps {
  item: ToolboxItem;
}

export function ToolCard({ item }: ToolCardProps) {
  const { selectItem } = useToolboxStore();

  return (
    <button
      onClick={() => selectItem(item)}
      className="group p-4 rounded-xl border text-left transition-all hover:scale-[1.02] hover:shadow-lg"
      style={{
        background: 'var(--bg-elevated)',
        borderColor: 'var(--border-default)',
      }}
    >
      {/* Icon */}
      <div
        className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl mb-3 transition-transform group-hover:scale-110"
        style={{ background: 'var(--bg-base)' }}
      >
        {item.icon}
      </div>

      {/* Name */}
      <div
        className="font-medium text-sm mb-1 truncate"
        style={{ color: 'var(--text-primary)' }}
      >
        {item.name}
      </div>

      {/* Description */}
      <div
        className="text-xs line-clamp-2 mb-3"
        style={{ color: 'var(--text-muted)', minHeight: '2.5em' }}
      >
        {item.description}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between">
        {/* Type badge */}
        <span
          className="text-xs px-2 py-0.5 rounded-full"
          style={{
            background: item.type === 'builtin' ? 'var(--accent-primary)/10' : 'var(--status-success)/10',
            color: item.type === 'builtin' ? 'var(--accent-primary)' : 'var(--status-success)',
          }}
        >
          {item.type === 'builtin' ? '内置' : '自定义'}
        </span>

        {/* Usage count */}
        {item.usageCount > 0 && (
          <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            <Zap size={10} />
            {item.usageCount}
          </span>
        )}
      </div>

      {/* Tags */}
      {item.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {item.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
