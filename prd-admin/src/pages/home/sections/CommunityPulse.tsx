import { Activity, Users, Zap, Trophy, Flame, Radio } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Reveal } from '../components/Reveal';
import { SectionHeader } from '../components/SectionHeader';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * CommunityPulse — 幕 · 活动脉搏（Community feature）
 *
 * 数据（label/trend/agent name）走 i18n；visual meta（icon/color）本地 map。
 */

interface StatVisual {
  Icon: LucideIcon;
  value: string;
  accent: string;
}

const STAT_VISUALS: Record<string, StatVisual> = {
  active: { Icon: Activity, value: '15', accent: '#34d399' },
  convos: { Icon: Users, value: '2,341', accent: '#a855f7' },
  tokens: { Icon: Zap, value: '4.2M', accent: '#00f0ff' },
  media: { Icon: Flame, value: '387', accent: '#f43f5e' },
};

const ROW_VISUALS: Record<string, { usage: string; accent: string; rank: number }> = {
  visual: { usage: '1,247', accent: '#a855f7', rank: 1 },
  prd: { usage: '892', accent: '#3b82f6', rank: 2 },
  literary: { usage: '654', accent: '#fb923c', rank: 3 },
  defect: { usage: '523', accent: '#10b981', rank: 4 },
  report: { usage: '418', accent: '#06b6d4', rank: 5 },
};

export function CommunityPulse() {
  const { t } = useLanguage();
  const titleParts = t.pulse.title.split('\n');

  return (
    <section
      className="relative py-28 md:py-36 px-6"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-16 md:mb-20">
          <SectionHeader
            Icon={Radio}
            eyebrow={t.pulse.eyebrow}
            accent="#34d399"
            title={
              <>
                {titleParts[0]}
                {titleParts.length > 1 && (
                  <>
                    <br className="sm:hidden" />
                    <span className="hidden sm:inline"> </span>
                    {titleParts[1]}
                  </>
                )}
              </>
            }
            subtitle={t.pulse.subtitle}
          />
        </div>

        <div className="grid lg:grid-cols-5 gap-6">
          {/* HUD stats */}
          <div className="lg:col-span-3 grid grid-cols-2 gap-4">
            {t.pulse.stats.map((s, i) => {
              const visual = STAT_VISUALS[s.id];
              if (!visual) return null;
              return (
                <Reveal key={s.id} delay={i * 80} offset={20}>
                  <StatCell label={s.label} trend={s.trend} visual={visual} />
                </Reveal>
              );
            })}
          </div>

          {/* Leaderboard */}
          <div className="lg:col-span-2">
            <Reveal delay={120} offset={20}>
              <LeaderboardCard title={t.pulse.leaderboard} rows={t.pulse.rows} />
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}

function StatCell({
  label,
  trend,
  visual,
}: {
  label: string;
  trend: string;
  visual: StatVisual;
}) {
  const { Icon, value, accent } = visual;
  return (
    <div
      className="relative p-5 rounded-lg border overflow-hidden"
      style={{
        background: 'rgba(10, 10, 25, 0.45)',
        borderColor: `${accent}33`,
        boxShadow: `inset 0 0 24px ${accent}12, 0 0 32px -12px ${accent}66`,
      }}
    >
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${accent}aa 50%, transparent 100%)`,
        }}
      />
      <div className="absolute top-3 right-3">
        <Icon className="w-4 h-4" style={{ color: accent, opacity: 0.7 }} />
      </div>
      <div
        className="text-[10px] uppercase mb-3"
        style={{
          color: `${accent}cc`,
          fontFamily: 'var(--font-terminal)',
          letterSpacing: '0.18em',
        }}
      >
        {label}
      </div>
      <div
        className="font-medium text-white"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'clamp(2.25rem, 4.5vw, 3.5rem)',
          lineHeight: 1,
          letterSpacing: '-0.03em',
          textShadow: `0 0 20px ${accent}55`,
        }}
      >
        {value}
      </div>
      <div
        className="mt-3 text-[11px]"
        style={{
          color: accent,
          fontFamily: 'var(--font-terminal)',
          letterSpacing: '0.1em',
        }}
      >
        {trend}
      </div>
    </div>
  );
}

function LeaderboardCard({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ id: string; name: string; delta: string }>;
}) {
  return (
    <div
      className="relative p-5 rounded-lg border overflow-hidden h-full"
      style={{
        background: 'rgba(10, 10, 25, 0.45)',
        borderColor: 'rgba(168, 85, 247, 0.25)',
        boxShadow:
          'inset 0 0 32px rgba(168, 85, 247, 0.06), 0 0 48px -16px rgba(168, 85, 247, 0.5)',
      }}
    >
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{
          background:
            'linear-gradient(90deg, transparent 0%, rgba(168, 85, 247, 0.8) 50%, transparent 100%)',
        }}
      />
      <div className="flex items-center gap-2 mb-5">
        <Trophy className="w-4 h-4 text-purple-300" />
        <div
          className="text-[11px] text-purple-200 uppercase"
          style={{ fontFamily: 'var(--font-terminal)', letterSpacing: '0.18em' }}
        >
          {title}
        </div>
      </div>
      <div className="space-y-3">
        {rows.map((row) => {
          const visual = ROW_VISUALS[row.id];
          if (!visual) return null;
          return (
            <LeaderboardRowItem
              key={row.id}
              rank={visual.rank}
              name={row.name}
              usage={visual.usage}
              delta={row.delta}
              accent={visual.accent}
            />
          );
        })}
      </div>
    </div>
  );
}

function LeaderboardRowItem({
  rank,
  name,
  usage,
  delta,
  accent,
}: {
  rank: number;
  name: string;
  usage: string;
  delta: string;
  accent: string;
}) {
  const isTop = rank <= 3;
  return (
    <div className="flex items-center gap-3">
      <div
        className="w-7 h-7 rounded flex items-center justify-center text-[12px] font-semibold shrink-0"
        style={{
          background: isTop ? `${accent}22` : 'rgba(255, 255, 255, 0.04)',
          border: isTop ? `1px solid ${accent}55` : '1px solid rgba(255, 255, 255, 0.08)',
          color: isTop ? accent : 'rgba(255, 255, 255, 0.5)',
          fontFamily: 'var(--font-terminal)',
          textShadow: isTop ? `0 0 8px ${accent}88` : undefined,
        }}
      >
        {String(rank).padStart(2, '0')}
      </div>
      <div className="flex-1 min-w-0 flex items-baseline gap-2">
        <span
          className="text-[13px] text-white/90 truncate"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {name}
        </span>
        <span
          className="text-[10px] text-white/40"
          style={{ fontFamily: 'var(--font-terminal)' }}
        >
          · {usage}
        </span>
      </div>
      <div
        className="text-[11px] shrink-0"
        style={{
          color: accent,
          fontFamily: 'var(--font-terminal)',
          letterSpacing: '0.05em',
          textShadow: `0 0 6px ${accent}66`,
        }}
      >
        {delta}
      </div>
    </div>
  );
}
