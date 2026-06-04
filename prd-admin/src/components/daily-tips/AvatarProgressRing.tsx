import { useEffect } from 'react';
import { GraduationCap } from 'lucide-react';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';

/**
 * 头像教程掌握度进度环(诉求 12)。包住头像,外圈用 SVG 画「已学会本页教程 / 全部本页教程」的占比;
 * 满环时右下角加一枚毕业帽角标。数据走 dailyTipsStore.progress(GET /api/daily-tips/progress),
 * 挂载时自动拉一次;markLearned 走乐观更新,环会立即推进。
 *
 * 用法:把原来的圆形头像 div 内容塞进 children,本组件负责外圈 + 角标 + 尺寸。
 */
export function AvatarProgressRing({
  size = 30,
  stroke = 2.5,
  children,
}: {
  size?: number;
  stroke?: number;
  children: React.ReactNode;
}) {
  const progress = useDailyTipsStore((s) => s.progress);
  const loadProgress = useDailyTipsStore((s) => s.loadProgress);

  useEffect(() => {
    void loadProgress();
  }, [loadProgress]);

  const total = progress?.total ?? 0;
  const learned = progress?.learned ?? 0;
  const pct = total > 0 ? Math.min(1, learned / total) : 0;
  const complete = total > 0 && learned >= total;

  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct);
  // SVG gradient id 必须唯一,避免多处实例(侧栏 + 移动端头部)共用一个 def 时只有一个生效。
  const gradId = `avatarRingGrad-${size}`;

  return (
    <div
      style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}
      title={total > 0 ? `教程掌握度 ${learned}/${total}${complete ? ' · 已毕业' : ''}` : '本页教程'}
    >
      <svg
        width={size}
        height={size}
        style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)', pointerEvents: 'none' }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#818cf8" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={stroke} />
        {total > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={complete ? '#34d399' : `url(#${gradId})`}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(.4,0,.2,1)' }}
          />
        )}
      </svg>
      <div style={{ position: 'absolute', inset: stroke + 1.5, borderRadius: 999, overflow: 'hidden' }}>
        {children}
      </div>
      {complete && (
        <div
          style={{
            position: 'absolute',
            right: -2,
            bottom: -2,
            width: 13,
            height: 13,
            borderRadius: 999,
            background: '#34d399',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 0 0 1.5px var(--bg-card, #1E1F20)',
          }}
        >
          <GraduationCap size={8} strokeWidth={3} color="#0b0b10" />
        </div>
      )}
    </div>
  );
}
