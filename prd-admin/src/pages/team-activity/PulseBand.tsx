/**
 * 团队脉搏聚合面板：动作总量（滚动数字 + 环比趋势）+ 模块能量条 + 24h 活跃热力 + 成员排行。
 * 聚合即导航：模块图例与排行成员均可点击下钻（再点一次取消），不是只能看的海报。
 * 只消费后端 /api/team-activity/stats 的聚合结果，天然不暴露具体工作内容；
 * 成员姓名受隐私脱敏开关控制。
 */
import { useEffect, useRef, useState } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { GlassCard } from '@/components/design';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { resolveAvatarUrl } from '@/lib/avatar';
import type { TeamActivityStatsData } from '@/services/contracts/teamActivity';
import { getModuleMeta } from './moduleMeta';
import { maskName, rotateHourlyToLocal, smoothAreaPath } from './pulse';

/** 数字滚动动效（ease-out cubic），让总量有「跳动的脉搏」体感 */
function useCountUp(value: number, duration = 700): number {
  const [display, setDisplay] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const next = Math.round(from + (value - from) * eased);
      setDisplay(next);
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return display;
}

const RANK_COLORS = ['#fbbf24', '#cbd5e1', '#fb923c'];

export function PulseBand({
  stats,
  loading,
  privacy,
  compareLabel,
  activeModule,
  activeActorId,
  onPickModule,
  onPickActor,
}: {
  stats: TeamActivityStatsData | null;
  loading: boolean;
  privacy: boolean;
  /** 环比文案（较昨日/较上周/较上月）；null 表示当前范围无环比 */
  compareLabel: string | null;
  activeModule: string;
  activeActorId: string;
  onPickModule: (key: string) => void;
  onPickActor: (actorId: string) => void;
}) {
  const total = useCountUp(stats?.total ?? 0);

  if (loading && !stats) {
    return (
      <GlassCard className="shrink-0">
        <div className="px-5 py-6">
          <MapSectionLoader text="脉搏汇总中…" />
        </div>
      </GlassCard>
    );
  }
  if (!stats) return null;

  const hourly = rotateHourlyToLocal(stats.hourlyUtc);
  const currentHour = new Date().getHours();
  const peakCount = Math.max(...hourly);
  const peakHour = hourly.indexOf(peakCount);
  const hourPath = smoothAreaPath(hourly, 240, 44, 3);
  const actorMax = Math.max(1, ...stats.actors.map((a) => a.count));
  const topActors = stats.actors.slice(0, 5);
  // 只有一个模块时比例条是零信息量像素（100% = 100%），直接不画，图例仍可点击下钻
  const showEnergyBar = stats.modules.length > 1;

  const prev = stats.previousTotal;
  const deltaPct =
    compareLabel != null && prev != null && prev > 0 ? Math.round(((stats.total - prev) / prev) * 100) : null;

  return (
    <GlassCard className="shrink-0">
      <div className="relative overflow-hidden">
        {/* 氛围光：低饱和径向渐变，给玻璃卡一点纵深，不参与交互 */}
        <div
          className="pointer-events-none absolute -top-24 -left-16 w-72 h-72 rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(34,211,238,0.07), transparent 70%)' }}
        />
        <div
          className="pointer-events-none absolute -bottom-28 right-12 w-80 h-80 rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(167,139,250,0.06), transparent 70%)' }}
        />
        <div
          className="relative px-5 py-4 grid gap-x-6 gap-y-4 items-stretch"
          style={{ gridTemplateColumns: 'minmax(150px, 190px) minmax(0, 1fr) minmax(210px, 260px)' }}
        >
        {/* 左：核心大数字 + 环比 */}
        <div className="flex flex-col justify-center gap-1 min-w-0">
          <div className="text-[11px] tracking-widest text-white/40">动作总量</div>
          <div
            className="text-[42px] leading-none font-bold tabular-nums bg-clip-text text-transparent"
            style={{ backgroundImage: 'linear-gradient(120deg, #22d3ee, #a78bfa)' }}
          >
            {total}
          </div>
          {compareLabel != null && prev != null ? (
            deltaPct != null ? (
              <div
                className="flex items-center gap-1 text-[11px] font-medium"
                style={{ color: deltaPct >= 0 ? '#6ee7b7' : 'rgba(255,255,255,0.45)' }}
              >
                {deltaPct >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                {compareLabel} {deltaPct >= 0 ? '+' : ''}
                {deltaPct}%（{prev} 条）
              </div>
            ) : (
              <div className="text-[11px] text-white/40">{compareLabel}无动作</div>
            )
          ) : null}
          <div className="text-[12px] text-white/50 pt-1">
            <span className="text-white/85 font-semibold tabular-nums">{stats.activeMembers}</span> 位成员活跃 ·{' '}
            <span className="text-white/85 font-semibold tabular-nums">{stats.modules.length}</span> 个模块
          </div>
        </div>

        {/* 中：模块能量条 + 时段热力 */}
        <div className="flex flex-col justify-center gap-3 min-w-0 border-l border-white/[0.06] pl-6">
          <div className="flex flex-col gap-1.5">
            <div className="text-[11px] tracking-widest text-white/40">模块能量（点击下钻）</div>
            {showEnergyBar ? (
              <div className="h-2.5 rounded-full overflow-hidden flex bg-white/[0.04]">
                {stats.modules.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    title={`${m.label} ${m.count} 条，点击筛选`}
                    onClick={() => onPickModule(m.key)}
                    className="h-full transition-all duration-700 cursor-pointer hover:opacity-80"
                    style={{
                      width: `${(m.count / Math.max(1, stats.total)) * 100}%`,
                      minWidth: m.count > 0 ? 4 : 0,
                      background: getModuleMeta(m.key).accent,
                    }}
                  />
                ))}
              </div>
            ) : null}
            <div className="flex items-center gap-x-2 gap-y-1 flex-wrap">
              {stats.modules.map((m) => {
                const meta = getModuleMeta(m.key);
                const active = activeModule === m.key;
                return (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => onPickModule(m.key)}
                    title={active ? '点击取消筛选' : `只看「${m.label}」`}
                    className="inline-flex items-center gap-1.5 px-2 h-[22px] rounded-full text-[11px] border transition-colors"
                    style={
                      active
                        ? { background: meta.soft, color: meta.accent, borderColor: meta.border }
                        : { background: 'rgba(255,255,255,0.03)', color: 'rgba(255,255,255,0.55)', borderColor: 'rgba(255,255,255,0.1)' }
                    }
                  >
                    <span className="w-2 h-2 rounded-full" style={{ background: meta.accent }} />
                    {m.label}
                    <span className="font-semibold tabular-nums" style={{ color: active ? meta.accent : 'rgba(255,255,255,0.85)' }}>
                      {m.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 活跃时段：平滑面积曲线（限宽，避免在超宽中栏被拉变形） */}
          <div className="flex flex-col gap-1" style={{ width: 'min(100%, 400px)' }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[11px] tracking-widest text-white/40">活跃时段</span>
                {stats.sampled ? <span className="text-[10px] text-white/30">（近 5000 条采样）</span> : null}
              </div>
              {peakCount > 0 ? (
                <span className="text-[10px] text-white/30 tabular-nums">
                  峰值 {peakHour}时 · {peakCount} 条
                </span>
              ) : null}
            </div>
            <div className="relative" style={{ height: 44 }}>
              <svg className="absolute inset-0 w-full h-full" viewBox="0 0 240 44" preserveAspectRatio="none" aria-hidden>
                <defs>
                  <linearGradient id="pulse-hour-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgba(34,211,238,0.4)" />
                    <stop offset="100%" stopColor="rgba(34,211,238,0.02)" />
                  </linearGradient>
                </defs>
                <path d={hourPath.area} fill="url(#pulse-hour-fill)" />
                <path d={hourPath.line} fill="none" stroke="#22d3ee" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              </svg>
              {/* 当前小时游标 */}
              <div
                className="absolute top-0 bottom-0 w-px bg-cyan-300/40"
                style={{ left: `${(currentHour / 23) * 100}%` }}
              />
              {/* 每小时 tooltip 热区 */}
              <div className="absolute inset-0 flex">
                {hourly.map((count, h) => (
                  <div key={h} className="flex-1" title={`${h}:00 — ${count} 条`} />
                ))}
              </div>
            </div>
            <div className="flex justify-between text-[10px] text-white/25 tabular-nums">
              <span>0时</span>
              <span>6时</span>
              <span>12时</span>
              <span>18时</span>
              <span>23时</span>
            </div>
          </div>
        </div>

        {/* 右：成员排行（点击下钻） */}
        <div className="flex flex-col justify-center gap-0.5 min-w-0 border-l border-white/[0.06] pl-6">
          <div className="text-[11px] tracking-widest text-white/40 pb-1">成员排行（点击下钻）</div>
          {topActors.length === 0 ? (
            <div className="text-[12px] text-white/35">该范围内暂无动作</div>
          ) : (
            topActors.map((a, idx) => {
              const active = activeActorId === a.actorId;
              return (
                <button
                  key={a.actorId}
                  type="button"
                  onClick={() => onPickActor(a.actorId)}
                  title={active ? '点击取消筛选' : `只看 TA 的动态`}
                  className={`flex items-center gap-2 min-w-0 w-full text-left rounded-md px-1 py-0.5 transition-colors ${
                    active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'
                  }`}
                >
                  <span
                    className="w-4 text-[11px] font-bold tabular-nums text-center shrink-0"
                    style={{ color: RANK_COLORS[idx] ?? 'rgba(255,255,255,0.3)' }}
                  >
                    {idx + 1}
                  </span>
                  <UserAvatar
                    src={resolveAvatarUrl({ avatarFileName: a.actorAvatarFileName })}
                    alt={a.actorName ?? ''}
                    className="w-5 h-5 rounded-full shrink-0 object-cover"
                  />
                  <span className="text-[12px] text-white/75 w-14 truncate shrink-0">
                    {privacy ? maskName(a.actorName || a.actorId) : a.actorName || a.actorId}
                  </span>
                  <span className="flex-1 h-1.5 rounded-full bg-white/[0.05] overflow-hidden min-w-0">
                    <span
                      className="block h-full rounded-full transition-all duration-700"
                      style={{
                        width: `${(a.count / actorMax) * 100}%`,
                        backgroundImage: 'linear-gradient(90deg, #22d3ee, #a78bfa)',
                      }}
                    />
                  </span>
                  <span className="text-[11px] text-white/55 tabular-nums w-8 text-right shrink-0">{a.count}</span>
                </button>
              );
            })
          )}
        </div>
        </div>
      </div>
    </GlassCard>
  );
}
