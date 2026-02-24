import { GlassCard } from '@/components/design/GlassCard';
import CountUp from '@/components/reactbits/CountUp';

type Accent = 'default' | 'green' | 'gold' | 'blue' | 'purple';

const accentColors: Record<Accent, { text: string; glow: string; hue?: number }> = {
  default: { text: 'var(--text-primary)', glow: 'transparent' },
  green: { text: 'var(--accent-green)', glow: 'rgba(34,197,94,0.08)', hue: 142 },
  gold: { text: 'var(--accent-gold)', glow: 'rgba(214,178,106,0.08)' },
  blue: { text: 'rgba(59,130,246,0.95)', glow: 'rgba(59,130,246,0.08)', hue: 217 },
  purple: { text: 'rgba(168,85,247,0.95)', glow: 'rgba(168,85,247,0.08)', hue: 270 },
};

export function KpiCard({
  title,
  value,
  suffix,
  loading,
  accent = 'default',
  trend,
  trendLabel,
  animated = false,
}: {
  title: string;
  value: number | string;
  suffix?: string;
  loading?: boolean;
  accent?: Accent;
  trend?: 'up' | 'down' | 'neutral';
  trendLabel?: string;
  animated?: boolean;
}) {
  const display = typeof value === 'number' ? value.toLocaleString() : value;
  const colors = accentColors[accent];

  return (
    <GlassCard
      className="min-h-[100px]"
      glow
      variant={accent === 'gold' ? 'gold' : 'default'}
      accentHue={colors.hue}
      animated={animated}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          {title}
        </div>
        {/* 装饰性光点 */}
        <div
          className="h-2 w-2 rounded-full shrink-0 mt-0.5"
          style={{
            background: colors.text,
            boxShadow: accent !== 'default' ? `0 0 8px 2px ${colors.glow}` : 'none',
            opacity: loading ? 0.3 : 1,
          }}
        />
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <div
          className="text-[28px] font-bold tracking-[-0.03em] leading-none tabular-nums min-h-[28px]"
          style={{ color: colors.text }}
        >
          {loading ? (
            <span
              className="inline-block w-16 h-7 rounded-lg animate-pulse"
              style={{ background: 'rgba(255,255,255,0.06)' }}
            />
          ) : animated && typeof value === 'number' ? (
            <CountUp to={value} duration={2} separator="," />
          ) : (
            display
          )}
        </div>
        {suffix && !loading && (
          <div className="text-[13px] font-medium" style={{ color: 'var(--text-muted)' }}>
            {suffix}
          </div>
        )}
      </div>
      {(trend || trendLabel) && !loading && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium">
          {trend === 'up' && (
            <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" style={{ color: 'var(--accent-green)' }}>
              <path d="M6 2v8M6 2L3 5M6 2l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
          {trend === 'down' && (
            <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" style={{ color: 'rgba(239,68,68,0.85)' }}>
              <path d="M6 10V2M6 10l-3-3M6 10l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
          <span style={{ color: trend === 'up' ? 'var(--accent-green)' : trend === 'down' ? 'rgba(239,68,68,0.85)' : 'var(--text-muted)' }}>
            {trendLabel}
          </span>
        </div>
      )}
    </GlassCard>
  );
}

