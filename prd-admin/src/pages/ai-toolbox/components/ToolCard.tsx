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
      <div className="p-3">
        {/* Icon with glow effect - 更小更精致 */}
        <div className="relative mb-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-xl transition-all duration-300 group-hover:scale-110"
            style={{
              background: `linear-gradient(135deg, hsla(${accentHue}, 70%, 60%, 0.18) 0%, hsla(${accentHue}, 70%, 40%, 0.1) 100%)`,
              boxShadow: `0 3px 12px -3px hsla(${accentHue}, 70%, 50%, 0.35), inset 0 1px 0 0 rgba(255,255,255,0.12)`,
              border: `1px solid hsla(${accentHue}, 60%, 60%, 0.25)`,
            }}
          >
            {item.icon}
          </div>
          {/* Subtle glow behind icon */}
          <div
            className="absolute inset-0 -z-10 blur-lg opacity-40 group-hover:opacity-60 transition-opacity"
            style={{
              background: `radial-gradient(circle, hsla(${accentHue}, 70%, 50%, 0.5) 0%, transparent 70%)`,
            }}
          />
        </div>

        {/* Name - 更亮的字体 */}
        <div
          className="font-semibold text-[13px] mb-1 truncate"
          style={{ color: 'rgba(255, 255, 255, 0.95)' }}
        >
          {item.name}
        </div>

        {/* Description - 稍微亮一点 */}
        <div
          className="text-[11px] line-clamp-2 mb-2.5 leading-relaxed"
          style={{ color: 'rgba(255, 255, 255, 0.55)', minHeight: '2.2em' }}
        >
          {item.description}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between">
          {/* Type badge - 更小 */}
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full font-medium flex items-center gap-0.5"
            style={{
              background: item.type === 'builtin'
                ? `hsla(${accentHue}, 60%, 50%, 0.15)`
                : 'rgba(34, 197, 94, 0.15)',
              color: item.type === 'builtin'
                ? `hsla(${accentHue}, 70%, 70%, 1)`
                : 'rgb(74, 222, 128)',
              border: item.type === 'builtin'
                ? `1px solid hsla(${accentHue}, 60%, 50%, 0.25)`
                : '1px solid rgba(34, 197, 94, 0.25)',
            }}
          >
            {item.type === 'builtin' && <Sparkles size={8} />}
            {item.type === 'builtin' ? '内置' : '自定义'}
          </span>

          {/* Usage count */}
          {item.usageCount > 0 && (
            <span
              className="flex items-center gap-0.5 text-[10px]"
              style={{ color: 'rgba(255, 255, 255, 0.5)' }}
            >
              <Zap size={9} style={{ color: `hsla(${accentHue}, 70%, 65%, 0.9)` }} />
              {item.usageCount}
            </span>
          )}
        </div>

        {/* Tags - 更紧凑 */}
        {item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2.5 pt-2.5 border-t" style={{ borderColor: 'rgba(255, 255, 255, 0.06)' }}>
            {item.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  color: 'rgba(255, 255, 255, 0.55)',
                  border: '1px solid rgba(255, 255, 255, 0.04)',
                }}
              >
                {tag}
              </span>
            ))}
            {item.tags.length > 3 && (
              <span
                className="text-[10px] px-1.5 py-0.5"
                style={{ color: 'rgba(255, 255, 255, 0.4)' }}
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
