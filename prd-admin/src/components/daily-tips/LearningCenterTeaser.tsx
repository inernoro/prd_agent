import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { GraduationCap, ArrowRight } from 'lucide-react';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';

/**
 * 首页顶部「教程中心」承接卡(用户 2026-06-04:挂在首页顶部,作为更新中心 / AI 大事件区旁的承接入口)。
 * 「只是承接」—— 卡内只展示等级 + 累计经验 + 本页教程掌握度 + 入口,点击进入独立的学习中心页
 * (/learning-center),不在首页内嵌整套教程目录。数据走 dailyTipsStore.progress(挂载自动拉一次)。
 */
export function LearningCenterTeaser() {
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

  return (
    <button
      type="button"
      onClick={() => navigate('/learning-center')}
      data-tour-id="home-learning-center"
      title="进入学习中心:看全部官方教程 + 你的等级与掌握进度"
      className="w-full text-left rounded-2xl flex items-center gap-4"
      style={{
        padding: '14px 18px',
        background:
          'linear-gradient(120deg, rgba(168,85,247,0.16), rgba(99,102,241,0.10) 55%, rgba(251,191,36,0.08))',
        border: '1px solid rgba(196,181,253,0.28)',
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
          <span
            className="inline-flex items-center font-bold"
            style={{
              padding: '1px 7px',
              borderRadius: 7,
              fontSize: 11,
              background: 'rgba(196,181,253,0.18)',
              border: '1px solid rgba(196,181,253,0.4)',
              color: '#c4b5fd',
            }}
          >
            Lv.{level} {levelName}
          </span>
          <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
            经验 {xp}
          </span>
        </div>
        <div className="text-[12px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
          {total > 0
            ? `已掌握 ${learned}/${total} 套本页教程 · 完成更多教程攒经验升级`
            : '跟着官方教程走一遍,边学边攒经验升级'}
        </div>
        {total > 0 && (
          <div
            className="mt-1.5"
            style={{ height: 5, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden', maxWidth: 320 }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: '100%',
                borderRadius: 999,
                background: 'linear-gradient(90deg,#a78bfa,#818cf8)',
                transition: 'width 600ms cubic-bezier(.4,0,.2,1)',
              }}
            />
          </div>
        )}
      </div>
      <span className="shrink-0 inline-flex items-center gap-1 text-[12px] font-semibold" style={{ color: '#c4b5fd' }}>
        进入学习中心
        <ArrowRight size={14} />
      </span>
    </button>
  );
}
