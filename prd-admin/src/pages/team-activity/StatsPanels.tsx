/**
 * 团队动态控制台两侧统计面板（左：成员统计；右：分类统计）。
 * 只消费后端 /api/team-activity/stats 聚合结果；聚合即导航——模块与成员均可点击下钻（再点取消）。
 * 成员姓名受隐私脱敏开关控制，对象/模块/动作类型为聚合数据，天然不暴露工作内容明细。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { GlassCard } from '@/components/design';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { resolveAvatarUrl } from '@/lib/avatar';
import type { TeamActivityStatsData } from '@/services/contracts/teamActivity';
import { getModuleMeta } from './moduleMeta';
import { getActionIcon } from './actionIcons';
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
      setDisplay(Math.round(from + (value - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return display;
}

const RANK_COLORS = ['#fbbf24', '#cbd5e1', '#fb923c'];

function PanelCard({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <GlassCard className="shrink-0">
      <div className="px-4 py-3.5 flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] tracking-widest text-white/40">{title}</span>
          {extra}
        </div>
        {children}
      </div>
    </GlassCard>
  );
}

/** 左栏：团队脉搏总量 + 成员排行 */
export function MemberStatsPanel({
  stats,
  loading,
  privacy,
  compareLabel,
  activeActorId,
  onPickActor,
}: {
  stats: TeamActivityStatsData | null;
  loading: boolean;
  privacy: boolean;
  compareLabel: string | null;
  activeActorId: string;
  onPickActor: (actorId: string) => void;
}) {
  const total = useCountUp(stats?.total ?? 0);

  if (loading && !stats) {
    return (
      <GlassCard className="shrink-0">
        <div className="px-4 py-6">
          <MapSectionLoader text="统计中…" />
        </div>
      </GlassCard>
    );
  }
  if (!stats) return null;

  const prev = stats.previousTotal;
  const deltaPct =
    compareLabel != null && prev != null && prev > 0 ? Math.round(((stats.total - prev) / prev) * 100) : null;
  const actorMax = Math.max(1, ...stats.actors.map((a) => a.count));

  return (
    <>
      <PanelCard title="团队脉搏">
        <div className="flex flex-col gap-1">
          <div
            className="text-[38px] leading-none font-bold tabular-nums bg-clip-text text-transparent"
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
          <div className="text-[12px] text-white/50 pt-0.5">
            <span className="text-white/85 font-semibold tabular-nums">{stats.activeMembers}</span> 位成员活跃 ·{' '}
            <span className="text-white/85 font-semibold tabular-nums">{stats.modules.length}</span> 个模块
          </div>
        </div>
      </PanelCard>

      <PanelCard title="成员排行" extra={<span className="text-[10px] text-white/30">点击下钻</span>}>
        {stats.actors.length === 0 ? (
          <div className="text-[12px] text-white/35">该范围内暂无动作</div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {stats.actors.map((a, idx) => {
              const active = activeActorId === a.actorId;
              return (
                <button
                  key={a.actorId}
                  type="button"
                  onClick={() => onPickActor(a.actorId)}
                  title={active ? '点击取消筛选' : '只看 TA 的动态'}
                  className={`flex items-center gap-2 min-w-0 w-full text-left rounded-md px-1 py-1 transition-colors ${
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
                  <span className="flex-1 min-w-0 flex flex-col gap-1">
                    <span className="text-[12px] text-white/75 truncate leading-none">
                      {privacy ? maskName(a.actorName || a.actorId) : a.actorName || a.actorId}
                    </span>
                    <span className="block h-1 rounded-sm bg-white/[0.05] overflow-hidden">
                      <span
                        className="block h-full rounded-sm transition-all duration-700"
                        style={{
                          width: `${(a.count / actorMax) * 100}%`,
                          backgroundImage: 'linear-gradient(90deg, #22d3ee, #a78bfa)',
                        }}
                      />
                    </span>
                  </span>
                  <span className="text-[11px] text-white/55 tabular-nums w-8 text-right shrink-0">{a.count}</span>
                </button>
              );
            })}
          </div>
        )}
      </PanelCard>
    </>
  );
}

/** 右栏：模块分布 + 动作类型 + 活跃时段 */
export function CategoryStatsPanel({
  stats,
  loading,
  activeModule,
  onPickModule,
}: {
  stats: TeamActivityStatsData | null;
  loading: boolean;
  activeModule: string;
  onPickModule: (key: string) => void;
}) {
  if (loading && !stats) {
    return (
      <GlassCard className="shrink-0">
        <div className="px-4 py-6">
          <MapSectionLoader text="统计中…" />
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
  const actionMax = Math.max(1, ...stats.actions.map((a) => a.count));

  return (
    <>
      <PanelCard title="模块分布" extra={<span className="text-[10px] text-white/30">点击下钻</span>}>
        {stats.modules.length === 0 ? (
          <div className="text-[12px] text-white/35">该范围内暂无动作</div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {stats.modules.map((m) => {
              const meta = getModuleMeta(m.key);
              const active = activeModule === m.key;
              const pct = Math.round((m.count / Math.max(1, stats.total)) * 100);
              return (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => onPickModule(m.key)}
                  title={active ? '点击取消筛选' : `只看「${m.label}」`}
                  className={`flex items-center gap-2 min-w-0 w-full text-left rounded-md px-1 py-1 transition-colors ${
                    active ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: meta.accent }} />
                  <span className="flex-1 min-w-0 flex flex-col gap-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-[12px] text-white/75 truncate leading-none">{m.label}</span>
                      <span className="text-[10px] text-white/35 tabular-nums shrink-0">{pct}%</span>
                    </span>
                    <span className="block h-1 rounded-sm bg-white/[0.05] overflow-hidden">
                      <span
                        className="block h-full rounded-sm transition-all duration-700"
                        style={{ width: `${pct}%`, background: meta.accent }}
                      />
                    </span>
                  </span>
                  <span className="text-[11px] text-white/55 tabular-nums w-8 text-right shrink-0">{m.count}</span>
                </button>
              );
            })}
          </div>
        )}
      </PanelCard>

      <PanelCard title="动作类型">
        {stats.actions.length === 0 ? (
          <div className="text-[12px] text-white/35">该范围内暂无动作</div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {stats.actions.map((a) => {
              const meta = getModuleMeta(a.module);
              const ActionIcon = getActionIcon(a.action);
              return (
                <div key={a.action} className="flex items-center gap-2 min-w-0 px-1 py-1 rounded-md">
                  <span
                    className="w-[18px] h-[18px] rounded flex items-center justify-center shrink-0"
                    style={{ background: meta.soft }}
                  >
                    <ActionIcon size={10} style={{ color: meta.accent }} />
                  </span>
                  <span className="flex-1 min-w-0 text-[12px] text-white/70 truncate">{a.label}</span>
                  <span className="w-16 h-1 rounded-sm bg-white/[0.05] overflow-hidden shrink-0">
                    <span
                      className="block h-full rounded-sm transition-all duration-700"
                      style={{ width: `${(a.count / actionMax) * 100}%`, background: meta.accent }}
                    />
                  </span>
                  <span className="text-[11px] text-white/55 tabular-nums w-8 text-right shrink-0">{a.count}</span>
                </div>
              );
            })}
          </div>
        )}
      </PanelCard>

      <PanelCard
        title="活跃时段"
        extra={
          peakCount > 0 ? (
            <span className="text-[10px] text-white/30 tabular-nums">
              峰值 {peakHour}时 · {peakCount} 条{stats.sampled ? '（采样）' : ''}
            </span>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-1">
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
            <div
              className="absolute top-0 bottom-0 w-px bg-cyan-300/40"
              style={{ left: `${(currentHour / 23) * 100}%` }}
            />
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
      </PanelCard>
    </>
  );
}
