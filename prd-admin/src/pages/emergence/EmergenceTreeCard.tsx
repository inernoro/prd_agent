import { useMemo } from 'react';
import { Sparkle, ArrowRight } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { getTreeVisual, hsla } from './emergenceFingerprint';

interface TreeSummary {
  id: string;
  title: string;
  description?: string;
  nodeCount: number;
  updatedAt: string;
}

interface Props {
  tree: TreeSummary;
  onOpen: (id: string) => void;
}

/**
 * 涌现树卡片 —— 极简排版流。
 * 唯一指纹是顶部一条扁平渐变色条（色相由标题哈希派生），无旋转轨道 / 无粒子。
 * 卡片高度固定，悬停只做表面浮起 + 提示淡入（绝对定位覆盖，零布局位移），
 * 修复历史问题：旧实现悬停时 max-h 撑高卡片，在 items-stretch 网格里挤动整行。
 */
export function EmergenceTreeCard({ tree, onOpen }: Props) {
  const v = useMemo(() => getTreeVisual(tree.title, tree.nodeCount, tree.updatedAt), [tree.title, tree.nodeCount, tree.updatedAt]);

  const days = Math.floor((Date.now() - new Date(tree.updatedAt).getTime()) / 86_400_000);
  const freshness =
    days <= 0 ? '今天' : days === 1 ? '昨天' : days < 7 ? `${days} 天前` : new Date(tree.updatedAt).toLocaleDateString();

  const progress = Math.min(100, (tree.nodeCount / 20) * 100);

  return (
    <GlassCard
      interactive
      padding="none"
      overflow="hidden"
      className="group relative flex flex-col overflow-hidden"
      style={{ height: 176 }}
      onClick={() => onOpen(tree.id)}
    >
      {/* 顶部指纹色条（扁平，无动效） */}
      <div
        aria-hidden
        style={{
          height: 4,
          flexShrink: 0,
          background: `linear-gradient(90deg, ${hsla(v.hue, 78, 60, 0.9)} 0%, ${hsla(v.hueSecondary, 72, 62, 0.9)} 100%)`,
        }}
      />

      {/* 正文 */}
      <div className="flex flex-col flex-1 min-h-0 p-4">
        <h3
          className="text-[14px] font-semibold leading-snug line-clamp-2"
          style={{ color: 'var(--text-primary)' }}
        >
          {tree.title}
        </h3>
        <p
          className="mt-1.5 text-[11px] leading-[1.55] line-clamp-2"
          style={{ color: 'var(--text-muted)' }}
        >
          {tree.description || '暂无描述'}
        </p>

        {/* 底部信息行 */}
        <div className="mt-auto pt-3 flex items-center gap-2.5">
          <span
            className="inline-flex items-center gap-1 text-[11px] font-medium tabular-nums"
            style={{ color: hsla(v.hue, 35, 78, 0.95) }}
          >
            <Sparkle size={11} style={{ color: hsla(v.hue, 70, 65, 0.9) }} />
            {tree.nodeCount}
          </span>
          <div
            className="flex-1 h-1 rounded-full overflow-hidden"
            style={{ background: 'rgba(255,255,255,0.06)' }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${progress}%`,
                background: `linear-gradient(90deg, ${hsla(v.hue, 78, 58, 0.85)}, ${hsla(v.hueSecondary, 72, 62, 0.85)})`,
              }}
            />
          </div>
          <span className="text-[10px] whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
            {freshness}
          </span>
        </div>
      </div>

      {/* 悬停提示：绝对定位覆盖在底部，opacity 淡入，不占布局、不挤网格 */}
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 py-1.5 text-[11px] font-semibold opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        style={{
          background: `linear-gradient(180deg, transparent, ${hsla(v.hue, 60, 18, 0.85)})`,
          color: hsla(v.hue, 70, 84, 0.95),
          pointerEvents: 'none',
        }}
      >
        进入探索 <ArrowRight size={11} />
      </div>
    </GlassCard>
  );
}
