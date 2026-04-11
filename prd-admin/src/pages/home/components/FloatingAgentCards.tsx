import { useEffect, useRef } from 'react';
import { ImageIcon, PenLine, FileText, Video } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * 悬浮 Agent 活动卡 — 首屏四角各放一张 frosted glass 卡，
 * 让 Hero 不再只有一个孤零零的标题，而是"AI 正在运转"的活物。
 *
 * 动效分层：
 *   1. parallax-anchor  —— 鼠标视差（越深的卡移得越多）
 *   2. float-anchor     —— 上下呼吸漂浮（独立 keyframe，不同相位）
 *   3. card             —— 玻璃卡本体，内含 pulse dot + 进度条
 *
 * 性能：mousemove 写入 CSS 变量，零 React re-render；全部 transform 在 GPU。
 * 响应式：lg 断点以下隐藏，给移动端留纯净的标题空间。
 */

interface AgentCard {
  id: string;
  name: string;
  activity: string;
  Icon: LucideIcon;
  tint: string;
  pos: React.CSSProperties;
  depth: number;     // 0.5 - 1.5，越大鼠标视差越强
  progress: number;  // 0 - 100
  floatDelay: number;
}

const CARDS: AgentCard[] = [
  {
    id: 'visual',
    name: '视觉 Agent',
    activity: '正在生成 · 海报 #24',
    Icon: ImageIcon,
    tint: '#a855f7',
    pos: { top: '15%', left: '3%' },
    depth: 1.2,
    progress: 68,
    floatDelay: 0,
  },
  {
    id: 'literary',
    name: '文学 Agent',
    activity: '润色中 · 段落 3 / 7',
    Icon: PenLine,
    tint: '#fb923c',
    pos: { top: '20%', right: '4%' },
    depth: 0.8,
    progress: 42,
    floatDelay: 0.8,
  },
  {
    id: 'prd',
    name: 'PRD Agent',
    activity: '已分析 28 页 · 转写中',
    Icon: FileText,
    tint: '#3b82f6',
    pos: { bottom: '18%', left: '4%' },
    depth: 1.0,
    progress: 84,
    floatDelay: 1.4,
  },
  {
    id: 'video',
    name: '视频 Agent',
    activity: '渲染中 · 72 %',
    Icon: Video,
    tint: '#f43f5e',
    pos: { bottom: '22%', right: '3%' },
    depth: 1.3,
    progress: 72,
    floatDelay: 2.2,
  },
];

export function FloatingAgentCards() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const nx = (e.clientX / window.innerWidth - 0.5) * 2;
      const ny = (e.clientY / window.innerHeight - 0.5) * 2;
      if (rootRef.current) {
        rootRef.current.style.setProperty('--mx', nx.toFixed(3));
        rootRef.current.style.setProperty('--my', ny.toFixed(3));
      }
    };
    window.addEventListener('mousemove', handler, { passive: true });
    return () => window.removeEventListener('mousemove', handler);
  }, []);

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 pointer-events-none hidden lg:block"
      style={{ '--mx': '0', '--my': '0' } as React.CSSProperties}
      aria-hidden
    >
      {CARDS.map((card) => {
        const { Icon } = card;
        return (
          <div
            key={card.id}
            className="absolute parallax-anchor"
            style={{
              ...card.pos,
              ['--depth' as string]: card.depth,
            } as React.CSSProperties}
          >
            <div
              className="float-anchor"
              style={{ animationDelay: `${card.floatDelay}s` }}
            >
              <div
                className="relative"
                style={{
                  width: '252px',
                  padding: '16px 18px',
                  borderRadius: '20px',
                  background:
                    'linear-gradient(135deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.02) 100%)',
                  backdropFilter: 'blur(24px) saturate(1.4)',
                  WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  boxShadow: `0 24px 60px -20px ${card.tint}66, 0 0 80px -30px ${card.tint}44, inset 0 1px 0 rgba(255,255,255,0.14)`,
                }}
              >
                {/* Header row */}
                <div className="flex items-center gap-3 mb-2.5">
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                    style={{
                      background: `linear-gradient(135deg, ${card.tint}40 0%, ${card.tint}10 100%)`,
                      border: `1px solid ${card.tint}55`,
                      boxShadow: `0 0 20px -4px ${card.tint}`,
                    }}
                  >
                    <Icon className="w-4 h-4" style={{ color: card.tint }} />
                  </div>
                  <span
                    className="text-[13px] font-medium text-white/95 truncate"
                    style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.01em' }}
                  >
                    {card.name}
                  </span>
                  <span
                    className="ml-auto w-1.5 h-1.5 rounded-full shrink-0"
                    style={{
                      background: card.tint,
                      boxShadow: `0 0 8px ${card.tint}`,
                      animation: 'pulse-dot 1.5s ease-in-out infinite',
                    }}
                  />
                </div>

                {/* Activity line */}
                <div
                  className="text-[11px] text-white/60 mb-3"
                  style={{ fontFamily: 'var(--font-body)', letterSpacing: '0.02em' }}
                >
                  {card.activity}
                </div>

                {/* Progress bar */}
                <div className="h-[3px] rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${card.progress}%`,
                      background: `linear-gradient(90deg, ${card.tint}40, ${card.tint})`,
                      boxShadow: `0 0 10px ${card.tint}80`,
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        );
      })}

      <style>{`
        .parallax-anchor {
          transform: translate3d(
            calc(var(--mx, 0) * 28px * var(--depth, 1)),
            calc(var(--my, 0) * 20px * var(--depth, 1)),
            0
          );
          transition: transform 0.8s cubic-bezier(0.2, 0.9, 0.2, 1);
          will-change: transform;
        }
        .float-anchor {
          animation: float-y 6s ease-in-out infinite;
          will-change: transform;
        }
        @keyframes float-y {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-10px); }
        }
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.55; transform: scale(1.4); }
        }
      `}</style>
    </div>
  );
}
