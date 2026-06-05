import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, GraduationCap, BookOpen, Sparkles, Bell } from 'lucide-react';
import { PageHeader } from '@/components/design/PageHeader';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';
import { writeSpotlightPayload } from '@/components/daily-tips/TipsRotator';
import type { DailyTip, TutorialProgressItem, TutorialCategory } from '@/services/real/dailyTips';
import { trackTip } from '@/services/real/dailyTips';
import { difficultyMeta } from '@/components/daily-tips/difficultyMeta';

/**
 * 学习中心(诉求 11):一处看全部官方教程 + 自己的掌握进度,随时点「跟我做 / 重看」开讲。
 * 数据源 = GET /api/daily-tips/progress(BuildDefaultTips 的教程目录 SSOT)。
 * 「跟我做」复用 writeSpotlightPayload + 导航到教程所属页,根挂载的 SpotlightOverlay 接力高亮。
 */

const CATEGORY_META: Record<TutorialCategory, { label: string; hint: string; icon: typeof MapPin }> = {
  onboarding: { label: '本页教程', hint: '走一遍就上手,计入掌握度', icon: MapPin },
  task: { label: '快捷任务', hint: '常用操作的分步演示', icon: Sparkles },
  update: { label: '本周更新', hint: '新功能提醒', icon: Bell },
};

const CATEGORY_ORDER: TutorialCategory[] = ['onboarding', 'task', 'update'];

function estMinutes(steps: number): number {
  return steps > 0 ? Math.max(1, Math.round(steps * 0.5)) : 0;
}

export default function LearningCenterPage() {
  const navigate = useNavigate();
  const progress = useDailyTipsStore((s) => s.progress);
  const loadProgress = useDailyTipsStore((s) => s.loadProgress);

  useEffect(() => {
    void loadProgress({ force: true });
  }, [loadProgress]);

  const grouped = useMemo(() => {
    const out: Record<TutorialCategory, TutorialProgressItem[]> = { onboarding: [], task: [], update: [] };
    (progress?.items ?? []).forEach((it) => {
      (out[it.category] ?? out.task).push(it);
    });
    return out;
  }, [progress]);

  const total = progress?.total ?? 0;
  const learned = progress?.learned ?? 0;
  const pct = total > 0 ? Math.round((learned / total) * 100) : 0;
  const complete = total > 0 && learned >= total;

  // 经验 / 等级(完成任意教程累计经验,后端按难度计权)。
  const xp = progress?.xp ?? 0;
  const level = progress?.level ?? 1;
  const levelName = progress?.levelName ?? '新手';
  const xpToNext = progress?.xpToNext ?? 0;
  const levelFloorXp = progress?.levelFloorXp ?? 0;
  const nextLevelXp = progress?.nextLevelXp ?? 0;
  const maxed = xpToNext <= 0 || nextLevelXp <= levelFloorXp;
  const levelPct = maxed ? 100 : Math.round(((xp - levelFloorXp) / (nextLevelXp - levelFloorXp)) * 100);

  function start(item: TutorialProgressItem) {
    void trackTip(item.tipId, 'clicked');
    const tipLike: DailyTip = {
      id: item.tipId,
      kind: 'card',
      title: item.title,
      body: item.body ?? null,
      actionUrl: item.actionUrl,
      ctaText: item.ctaText ?? null,
      targetSelector: item.targetSelector ?? null,
      autoAction: item.autoAction ?? null,
      sourceId: item.sourceId,
      version: item.version,
    };
    writeSpotlightPayload(tipLike);
    navigate(item.actionUrl);
  }

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      <PageHeader title="学习中心" description="所有官方教程与你的掌握进度" />

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        {!progress ? (
          <MapSectionLoader text="正在加载教程进度…" />
        ) : (
          <div className="flex flex-col gap-5 pb-6">
            {/* 掌握度 + 等级总览 */}
            <div
              className="rounded-2xl p-5 flex items-center gap-5 flex-wrap"
              style={{ background: 'var(--bg-card, #1E1F20)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              <MasteryRing pct={pct} complete={complete} />
              <div className="min-w-0 flex-1" style={{ minWidth: 220 }}>
                <div className="text-[18px] font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  {complete ? '已毕业 · 全部本页教程已掌握' : `已掌握 ${learned} / ${total} 套本页教程`}
                  {complete && <GraduationCap size={18} className="text-emerald-400" />}
                </div>
                <div className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  {complete
                    ? '随时可以点「重看一遍」复习,或看看本周更新。'
                    : '点任意教程的「跟我做」, 跟着高亮一步步走完, 头像上的进度环会同步填满。'}
                </div>
              </div>

              {/* 等级 / 经验:完成越多经验越多 */}
              <div
                className="flex flex-col gap-2"
                style={{ minWidth: 200, paddingLeft: 16, borderLeft: '1px solid rgba(255,255,255,0.08)' }}
              >
                <div className="flex items-baseline gap-2">
                  <span
                    className="inline-flex items-center justify-center font-bold"
                    style={{
                      minWidth: 30, height: 30, padding: '0 8px', borderRadius: 8, fontSize: 13,
                      background: 'linear-gradient(135deg, rgba(168,85,247,0.28), rgba(99,102,241,0.20))',
                      border: '1px solid rgba(196,181,253,0.4)', color: '#c4b5fd',
                    }}
                  >
                    Lv.{level}
                  </span>
                  <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{levelName}</span>
                  <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>经验 {xp}</span>
                </div>
                <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${levelPct}%`, height: '100%', borderRadius: 999,
                      background: maxed ? '#34d399' : 'linear-gradient(90deg, #a78bfa, #818cf8)',
                      transition: 'width 600ms cubic-bezier(.4,0,.2,1)',
                    }}
                  />
                </div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {maxed ? '已达最高等级' : `距 Lv.${level + 1} 还差 ${xpToNext} 经验`}
                </div>
              </div>
            </div>

            {/* 分组教程列表 */}
            {CATEGORY_ORDER.map((cat) => {
              const list = grouped[cat];
              if (!list || list.length === 0) return null;
              const meta = CATEGORY_META[cat];
              const Icon = meta.icon;
              return (
                <section key={cat} className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <Icon size={15} className="text-indigo-300" />
                    <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {meta.label}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {meta.hint} · {list.length} 套
                    </span>
                  </div>
                  <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
                    {list.map((it) => (
                      <TutorialCard key={it.sourceId} item={it} onStart={() => start(it)} />
                    ))}
                  </div>
                </section>
              );
            })}

            {(progress?.items?.length ?? 0) === 0 && (
              <div className="text-center py-16" style={{ color: 'var(--text-muted)' }}>
                <BookOpen size={28} className="mx-auto mb-3 opacity-50" />
                <div className="text-[13px]">暂无官方教程</div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MasteryRing({ pct, complete }: { pct: number; complete: boolean }) {
  const size = 84;
  const stroke = 8;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct / 100);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <defs>
          <linearGradient id="masteryRingGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="100%" stopColor="#818cf8" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={complete ? '#34d399' : 'url(#masteryRingGrad)'}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 700ms cubic-bezier(.4,0,.2,1)' }}
        />
      </svg>
      <div
        style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}
      >
        <span className="text-[20px] font-bold" style={{ color: 'var(--text-primary)' }}>{pct}%</span>
      </div>
    </div>
  );
}

function TutorialCard({ item, onStart }: { item: TutorialProgressItem; onStart: () => void }) {
  const mins = estMinutes(item.steps);
  const diff = difficultyMeta(item.difficulty);
  return (
    <div
      className="rounded-xl p-4 flex flex-col gap-2.5"
      style={{
        background: 'var(--bg-card, #1E1F20)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderLeft: `3px solid ${item.learned ? 'rgba(52,211,153,0.85)' : 'rgba(167,139,250,0.95)'}`,
      }}
    >
      <div className="flex items-start gap-2">
        <span className="text-[13.5px] font-semibold flex-1 min-w-0" style={{ color: 'var(--text-primary)', lineHeight: 1.4 }}>
          {item.title}
        </span>
        <span
          className="inline-flex items-center shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold"
          style={{ background: diff.bg, color: diff.fg }}
        >
          {diff.label}
        </span>
        {item.learned && (
          <span
            className="inline-flex items-center gap-1 shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold"
            style={{ background: 'rgba(52,211,153,0.14)', color: 'rgba(52,211,153,0.95)' }}
          >
            <GraduationCap size={10} strokeWidth={2.6} />
            已学会
          </span>
        )}
      </div>
      {item.body && (
        <p className="text-[11.5px] leading-relaxed line-clamp-2" style={{ color: 'var(--text-muted)' }}>
          {item.body}
        </p>
      )}
      <div className="flex items-center justify-between gap-2 mt-1">
        <span className="text-[10.5px] font-mono" style={{ color: 'var(--text-muted)' }}>
          {item.steps} 步 · 约 {mins} 分钟 · {item.learned ? `已得 +${item.xpReward}` : `+${item.xpReward}`} 经验
        </span>
        <button
          type="button"
          onClick={onStart}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold cursor-pointer"
          style={{
            border: '1px solid rgba(167,139,250,0.4)',
            background: 'linear-gradient(135deg, rgba(168,85,247,0.22), rgba(99,102,241,0.16))',
            color: '#c4b5fd',
          }}
        >
          <MapPin size={12} />
          {item.learned ? '重看一遍' : '跟我做'}
        </button>
      </div>
    </div>
  );
}
