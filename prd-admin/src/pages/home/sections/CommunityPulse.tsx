import { Activity, Users, Zap, Trophy, Flame } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * CommunityPulse — 幕 · 活动脉搏（Community feature 注入）
 *
 * Retro-futurism 注入：终端 HUD 风格的"实时"数据面板 + 本周排行榜
 * - 左半：4 个大号数字 HUD stat（看似实时数据）
 * - 右半：Top 3 Agent 排行榜（Steam 排行榜美学）
 * - 全部纯 CSS，数字静态（后续可接真实 API）
 */

interface PulseStat {
  Icon: LucideIcon;
  label: string;
  value: string;
  accent: string;
  trend: string;
}

const STATS: PulseStat[] = [
  { Icon: Activity, label: 'ACTIVE AGENTS', value: '15', accent: '#34d399', trend: 'all online' },
  { Icon: Users, label: 'CONVERSATIONS · 24H', value: '2,341', accent: '#a855f7', trend: '+18% ↑' },
  { Icon: Zap, label: 'TOKENS PROCESSED', value: '4.2M', accent: '#00f0ff', trend: 'p95 · 62ms' },
  { Icon: Flame, label: 'MEDIA GENERATED', value: '387', accent: '#f43f5e', trend: 'last 7d' },
];

interface LeaderboardRow {
  rank: number;
  name: string;
  usage: string;
  delta: string;
  accent: string;
}

const LEADERBOARD: LeaderboardRow[] = [
  { rank: 1, name: '视觉设计师', usage: '1,247', delta: '+32%', accent: '#a855f7' },
  { rank: 2, name: 'PRD 分析师', usage: '892', delta: '+14%', accent: '#3b82f6' },
  { rank: 3, name: '文学创作者', usage: '654', delta: '+8%', accent: '#fb923c' },
  { rank: 4, name: '缺陷管理员', usage: '523', delta: '+22%', accent: '#10b981' },
  { rank: 5, name: '周报管理员', usage: '418', delta: '+5%', accent: '#06b6d4' },
];

export function CommunityPulse() {
  return (
    <section
      className="relative py-28 md:py-36 px-6"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="text-center mb-14">
          <div
            className="inline-flex items-center gap-2.5 px-3 py-1 mb-5 rounded border border-emerald-400/30 bg-emerald-400/5"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
            <span
              className="text-[12px] text-emerald-300"
              style={{ letterSpacing: '0.16em', textShadow: '0 0 8px rgba(52, 211, 153, 0.45)' }}
            >
              LIVE · PULSE
            </span>
          </div>
          <h2
            className="text-white font-medium"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(2rem, 5vw, 3.75rem)',
              lineHeight: 1.05,
              letterSpacing: '-0.03em',
              textShadow: '0 0 28px rgba(168, 85, 247, 0.25)',
            }}
          >
            整个平台，
            <br className="sm:hidden" />
            此时此刻在做什么
          </h2>
          <p className="mt-6 text-white/55 max-w-2xl mx-auto text-[15px] leading-relaxed">
            实时数据脉搏 + 本周 Agent 使用排行。参与越多，你的 Agent 越聪明。
          </p>
        </div>

        {/* Two-column: HUD stats + leaderboard */}
        <div className="grid lg:grid-cols-5 gap-6">
          {/* HUD stats (3 cols) */}
          <div className="lg:col-span-3 grid grid-cols-2 gap-4">
            {STATS.map((s) => (
              <StatCell key={s.label} stat={s} />
            ))}
          </div>

          {/* Leaderboard (2 cols) */}
          <div className="lg:col-span-2">
            <LeaderboardCard />
          </div>
        </div>
      </div>
    </section>
  );
}

function StatCell({ stat }: { stat: PulseStat }) {
  const { Icon, label, value, accent, trend } = stat;
  return (
    <div
      className="relative p-5 rounded-lg border overflow-hidden"
      style={{
        background: 'rgba(10, 10, 25, 0.45)',
        borderColor: `${accent}33`,
        boxShadow: `inset 0 0 24px ${accent}12, 0 0 32px -12px ${accent}66`,
      }}
    >
      {/* 顶边 scanline */}
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${accent}aa 50%, transparent 100%)`,
        }}
      />
      {/* 右上 HUD 角标 */}
      <div className="absolute top-3 right-3">
        <Icon className="w-4 h-4" style={{ color: accent, opacity: 0.7 }} />
      </div>
      {/* Label */}
      <div
        className="text-[10px] uppercase mb-3"
        style={{
          color: `${accent}cc`,
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.18em',
        }}
      >
        {label}
      </div>
      {/* Value */}
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
      {/* Trend */}
      <div
        className="mt-3 text-[11px]"
        style={{
          color: `${accent}`,
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.1em',
        }}
      >
        {trend}
      </div>
    </div>
  );
}

function LeaderboardCard() {
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
      {/* 顶边 scanline */}
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{
          background:
            'linear-gradient(90deg, transparent 0%, rgba(168, 85, 247, 0.8) 50%, transparent 100%)',
        }}
      />
      {/* Header */}
      <div className="flex items-center gap-2 mb-5">
        <Trophy className="w-4 h-4 text-purple-300" />
        <div
          className="text-[11px] text-purple-200 uppercase"
          style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.18em' }}
        >
          Weekly Leaderboard
        </div>
      </div>
      {/* Rows */}
      <div className="space-y-3">
        {LEADERBOARD.map((row) => (
          <LeaderboardRowItem key={row.rank} row={row} />
        ))}
      </div>
    </div>
  );
}

function LeaderboardRowItem({ row }: { row: LeaderboardRow }) {
  const { rank, name, usage, delta, accent } = row;
  const isTop = rank <= 3;
  return (
    <div className="flex items-center gap-3">
      {/* Rank number */}
      <div
        className="w-7 h-7 rounded flex items-center justify-center text-[12px] font-semibold shrink-0"
        style={{
          background: isTop ? `${accent}22` : 'rgba(255, 255, 255, 0.04)',
          border: isTop ? `1px solid ${accent}55` : '1px solid rgba(255, 255, 255, 0.08)',
          color: isTop ? accent : 'rgba(255, 255, 255, 0.5)',
          fontFamily: 'var(--font-mono)',
          textShadow: isTop ? `0 0 8px ${accent}88` : undefined,
        }}
      >
        {String(rank).padStart(2, '0')}
      </div>
      {/* Name + usage */}
      <div className="flex-1 min-w-0 flex items-baseline gap-2">
        <span
          className="text-[13px] text-white/90 truncate"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {name}
        </span>
        <span
          className="text-[10px] text-white/40"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          · {usage}
        </span>
      </div>
      {/* Delta */}
      <div
        className="text-[11px] shrink-0"
        style={{
          color: accent,
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.05em',
          textShadow: `0 0 6px ${accent}66`,
        }}
      >
        {delta}
      </div>
    </div>
  );
}
