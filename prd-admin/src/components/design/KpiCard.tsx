import { GlassCard } from '@/components/design/GlassCard';
import CountUp from '@/components/reactbits/CountUp';

type Accent = 'default' | 'green' | 'emerald' | 'gold' | 'blue' | 'purple' | 'cyan' | 'indigo';

const accentColors: Record<Accent, { text: string; glow: string; hue?: number; gradient: string; pulse: string }> = {
  default: { text: 'var(--text-primary)', glow: 'transparent', gradient: 'transparent', pulse: 'rgba(255,255,255,0.4)' },
  green: { text: '#34d399', glow: 'rgba(52,211,153,0.12)', hue: 160, gradient: 'linear-gradient(135deg, rgba(52,211,153,0.15) 0%, rgba(16,185,129,0.05) 100%)', pulse: '#34d399' },
  emerald: { text: '#34d399', glow: 'rgba(52,211,153,0.12)', hue: 155, gradient: 'linear-gradient(135deg, rgba(52,211,153,0.15) 0%, rgba(16,185,129,0.05) 100%)', pulse: '#34d399' },
  gold: { text: '#f2d59b', glow: 'rgba(242,213,155,0.12)', gradient: 'linear-gradient(135deg, rgba(242,213,155,0.15) 0%, rgba(214,178,106,0.05) 100%)', pulse: '#f2d59b' },
  blue: { text: '#60a5fa', glow: 'rgba(96,165,250,0.12)', hue: 217, gradient: 'linear-gradient(135deg, rgba(96,165,250,0.15) 0%, rgba(59,130,246,0.05) 100%)', pulse: '#60a5fa' },
  purple: { text: '#a78bfa', glow: 'rgba(167,139,250,0.12)', hue: 270, gradient: 'linear-gradient(135deg, rgba(167,139,250,0.15) 0%, rgba(139,92,246,0.05) 100%)', pulse: '#a78bfa' },
  cyan: { text: '#22d3ee', glow: 'rgba(34,211,238,0.12)', hue: 188, gradient: 'linear-gradient(135deg, rgba(34,211,238,0.15) 0%, rgba(6,182,212,0.05) 100%)', pulse: '#22d3ee' },
  indigo: { text: '#818cf8', glow: 'rgba(129,140,248,0.12)', hue: 234, gradient: 'linear-gradient(135deg, rgba(129,140,248,0.15) 0%, rgba(99,102,241,0.05) 100%)', pulse: '#818cf8' },
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
  icon,
}: {
  title: string;
  value: number | string;
  suffix?: string;
  loading?: boolean;
  accent?: Accent;
  trend?: 'up' | 'down' | 'neutral';
  trendLabel?: string;
  animated?: boolean;
  icon?: React.ReactNode;
}) {
  const display = typeof value === 'number' ? value.toLocaleString() : value;
  const colors = accentColors[accent];

  return (
    <GlassCard
      className="min-h-[100px] group"
      glow
      variant={accent === 'gold' ? 'gold' : 'default'}
      accentHue={colors.hue}
      animated={animated}
    >
      {/* Gradient overlay for visual depth */}
      <div
        className="absolute inset-0 rounded-[16px] pointer-events-none opacity-60 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: colors.gradient }}
      />
      {/* Left accent bar */}
      {accent !== 'default' && (
        <div
          className="absolute left-0 top-3 bottom-3 w-[2px] rounded-full"
          style={{
            background: `linear-gradient(180deg, ${colors.text}, transparent)`,
            opacity: 0.5,
          }}
        />
      )}
      <div className="relative">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {icon && (
              <span style={{ color: colors.text, opacity: 0.7 }}>{icon}</span>
            )}
            <div className="text-[11px] font-medium tracking-wider" style={{ color: 'var(--text-muted)' }}>
              {title}
            </div>
          </div>
          {/* Pulse indicator */}
          <div className="relative shrink-0 mt-0.5">
            <div
              className="h-2 w-2 rounded-full"
              style={{
                background: colors.text,
                opacity: loading ? 0.3 : 0.9,
              }}
            />
            {accent !== 'default' && !loading && (
              <div
                className="absolute inset-0 h-2 w-2 rounded-full animate-ping"
                style={{
                  background: colors.pulse,
                  opacity: 0.3,
                  animationDuration: '3s',
                }}
              />
            )}
          </div>
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
              <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" style={{ color: '#34d399' }}>
                <path d="M6 2v8M6 2L3 5M6 2l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            {trend === 'down' && (
              <svg className="w-3 h-3" viewBox="0 0 12 12" fill="none" style={{ color: 'rgba(248,113,113,0.9)' }}>
                <path d="M6 10V2M6 10l-3-3M6 10l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            <span style={{ color: trend === 'up' ? '#34d399' : trend === 'down' ? 'rgba(248,113,113,0.9)' : 'var(--text-muted)' }}>
              {trendLabel}
            </span>
          </div>
        )}
      </div>
    </GlassCard>
  );
}
