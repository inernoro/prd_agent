import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { GraduationCap, ArrowRight } from 'lucide-react';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';

/**
 * 首页顶部「教程中心」承接卡(用户 2026-06-04:挂在首页顶部,作为更新中心 / AI 大事件区旁的承接入口)。
 * 「只是承接」—— 卡内只展示等级 + 累计经验 + 本页教程掌握度 + 入口,点击进入独立的学习中心页
 * (/learning-center),不在首页内嵌整套教程目录。数据走 dailyTipsStore.progress(挂载自动拉一次)。
 */
/**
 * 首页「教程中心」承接卡。「只是承接」—— 卡内只展示等级 + 累计经验 + 本页教程掌握度 + 入口，
 * 点击进入独立的学习中心页(/learning-center)，不在首页内嵌整套教程目录。数据走 dailyTipsStore.progress。
 * compact=true：窄栏紧凑竖版(置于搜索下方，避免顶部整条宽 banner 抢视觉，用户 2026-06-06)。
 */
export function LearningCenterTeaser({ compact = false }: { compact?: boolean } = {}) {
  const navigate = useNavigate();
  const progress = useDailyTipsStore((s) => s.progress);
  const loadProgress = useDailyTipsStore((s) => s.loadProgress);

  useEffect(() => {
    void loadProgress();
  }, [loadProgress]);

  const level = progress?.level ?? 1;
  const levelName = progress?.levelName ?? '新手';
  const xp = progress?.xp ?? 0;
  const total = progress?.total ?? 0;
  const learned = progress?.learned ?? 0;
  const pct = total > 0 ? Math.round((learned / total) * 100) : 0;

  const SHARED_BG =
    'linear-gradient(120deg, rgba(168,85,247,0.16), rgba(99,102,241,0.10) 55%, rgba(251,191,36,0.08))';
  const SHARED_BORDER = '1px solid rgba(196,181,253,0.28)';
  const lvBadge = (
    <span
      className="inline-flex items-center font-bold"
      style={{ padding: '1px 7px', borderRadius: 7, fontSize: 11, background: 'rgba(196,181,253,0.18)', border: '1px solid rgba(196,181,253,0.4)', color: '#c4b5fd' }}
    >
      Lv.{level} {levelName}
    </span>
  );
  const bar = total > 0 && (
    <div style={{ height: 5, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', borderRadius: 999, background: 'linear-gradient(90deg,#a78bfa,#818cf8)', transition: 'width 600ms cubic-bezier(.4,0,.2,1)' }} />
    </div>
  );

  // ── 紧凑竖版(搜索下方窄栏) ──
  if (compact) {
    return (
      <button
        type="button"
        onClick={() => navigate('/learning-center')}
        data-tour-id="home-learning-center"
        title="进入学习中心:看全部官方教程 + 你的等级与掌握进度"
        className="w-full text-left rounded-xl flex flex-col gap-1.5"
        style={{ padding: '11px 13px', background: SHARED_BG, border: SHARED_BORDER, cursor: 'pointer', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
      >
        <div className="flex items-center gap-2">
          <GraduationCap size={16} style={{ color: '#c4b5fd' }} />
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary,#fff)' }}>教程中心</span>
          <span className="ml-auto">{lvBadge}</span>
        </div>
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {total > 0 ? `已掌握 ${learned}/${total} 套 · 经验 ${xp}` : '跟着官方教程走一遍，攒经验升级'}
        </div>
        {bar}
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: '#c4b5fd' }}>
          进入学习中心
          <ArrowRight size={12} />
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => navigate('/learning-center')}
      data-tour-id="home-learning-center"
      title="进入学习中心:看全部官方教程 + 你的等级与掌握进度"
      className="w-full text-left rounded-2xl flex items-center gap-4"
      style={{
        padding: '14px 18px',
        background: SHARED_BG,
        border: SHARED_BORDER,
        cursor: 'pointer',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      <div
        className="shrink-0 inline-flex items-center justify-center rounded-xl"
        style={{ width: 42, height: 42, background: 'rgba(196,181,253,0.16)', border: '1px solid rgba(196,181,253,0.3)' }}
      >
        <GraduationCap size={22} style={{ color: '#c4b5fd' }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary,#fff)' }}>
            教程中心
          </span>
          {lvBadge}
          <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
            经验 {xp}
          </span>
        </div>
        <div className="text-[12px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
          {total > 0
            ? `已掌握 ${learned}/${total} 套本页教程 · 完成更多教程攒经验升级`
            : '跟着官方教程走一遍,边学边攒经验升级'}
        </div>
        {total > 0 && <div className="mt-1.5" style={{ maxWidth: 320 }}>{bar}</div>}
      </div>
      <span className="shrink-0 inline-flex items-center gap-1 text-[12px] font-semibold" style={{ color: '#c4b5fd' }}>
        进入学习中心
        <ArrowRight size={14} />
      </span>
    </button>
  );
}
