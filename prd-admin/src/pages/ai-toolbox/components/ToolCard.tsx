import type { ToolboxItem } from '@/services';
import { useToolboxStore } from '@/stores/toolboxStore';
import { GlassCard } from '@/components/design/GlassCard';
import { Zap, Sparkles } from 'lucide-react';

interface ToolCardProps {
  item: ToolboxItem;
}

// 根据工具类型/图标返回不同的强调色色相
function getAccentHue(item: ToolboxItem): number {
  const iconHueMap: Record<string, number> = {
    '📋': 210, // 蓝色 - PRD
    '🎨': 330, // 粉色 - 视觉
    '✍️': 45,  // 橙色 - 文学
    '🐛': 0,   // 红色 - 缺陷
    '🔍': 180, // 青色 - 代码审查
    '🌐': 200, // 天蓝 - 翻译
    '📝': 50,  // 黄色 - 摘要
    '📊': 270, // 紫色 - 数据分析
    '🤖': 210, // 蓝色 - 默认机器人
    '💡': 45,  // 橙色
    '🎯': 0,   // 红色
    '🔧': 30,  // 橙黄
    '✨': 280, // 紫色
    '🚀': 210, // 蓝色
    '💬': 180, // 青色
    '⚡': 45,  // 橙色
  };
  return iconHueMap[item.icon] ?? 210;
}

export function ToolCard({ item }: ToolCardProps) {
  const { selectItem } = useToolboxStore();
  const accentHue = getAccentHue(item);

  return (
    <GlassCard
      variant="subtle"
      accentHue={accentHue}
      glow
      padding="none"
      interactive
      onClick={() => selectItem(item)}
      className="group"
    >
      <div className="p-4">
        {/* Icon with glow effect */}
        <div className="relative mb-4">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center text-3xl transition-all duration-300 group-hover:scale-110"
            style={{
              background: `linear-gradient(135deg, hsla(${accentHue}, 70%, 60%, 0.15) 0%, hsla(${accentHue}, 70%, 40%, 0.08) 100%)`,
              boxShadow: `0 4px 20px -4px hsla(${accentHue}, 70%, 50%, 0.3), inset 0 1px 0 0 rgba(255,255,255,0.1)`,
              border: `1px solid hsla(${accentHue}, 60%, 60%, 0.2)`,
            }}
          >
            {item.icon}
          </div>
          {/* Subtle glow behind icon */}
          <div
            className="absolute inset-0 -z-10 blur-xl opacity-50 group-hover:opacity-70 transition-opacity"
            style={{
              background: `radial-gradient(circle, hsla(${accentHue}, 70%, 50%, 0.4) 0%, transparent 70%)`,
            }}
          />
        </div>

        {/* Name */}
        <div
          className="font-semibold text-sm mb-1.5 truncate"
          style={{ color: 'var(--text-primary)' }}
        >
          {item.name}
        </div>

        {/* Description */}
        <div
          className="text-xs line-clamp-2 mb-3 leading-relaxed"
          style={{ color: 'var(--text-muted)', minHeight: '2.5em' }}
        >
          {item.description}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between">
          {/* Type badge */}
          <span
            className="text-xs px-2 py-1 rounded-full font-medium flex items-center gap-1"
            style={{
              background: item.type === 'builtin'
                ? `hsla(${accentHue}, 60%, 50%, 0.12)`
                : 'rgba(34, 197, 94, 0.12)',
              color: item.type === 'builtin'
                ? `hsla(${accentHue}, 70%, 65%, 1)`
                : 'rgb(34, 197, 94)',
              border: item.type === 'builtin'
                ? `1px solid hsla(${accentHue}, 60%, 50%, 0.2)`
                : '1px solid rgba(34, 197, 94, 0.2)',
            }}
          >
            {item.type === 'builtin' && <Sparkles size={10} />}
            {item.type === 'builtin' ? '内置' : '自定义'}
          </span>

          {/* Usage count */}
          {item.usageCount > 0 && (
            <span
              className="flex items-center gap-1 text-xs"
              style={{ color: 'var(--text-muted)' }}
            >
              <Zap size={10} style={{ color: `hsla(${accentHue}, 70%, 60%, 0.8)` }} />
              {item.usageCount}
            </span>
          )}
        </div>

        {/* Tags */}
        {item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t" style={{ borderColor: 'var(--glass-border, rgba(255,255,255,0.08))' }}>
            {item.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="text-xs px-2 py-0.5 rounded-md"
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  color: 'var(--text-muted)',
                  border: '1px solid rgba(255, 255, 255, 0.05)',
                }}
              >
                {tag}
              </span>
            ))}
            {item.tags.length > 3 && (
              <span
                className="text-xs px-2 py-0.5 rounded-md"
                style={{ color: 'var(--text-muted)' }}
              >
                +{item.tags.length - 3}
              </span>
            )}
          </div>
        )}
      </div>
    </GlassCard>
  );
}
