import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';

/**
 * 首页顶部「教程中心」承接卡（徽章环样式）。「只是承接」—— 卡内只展示等级 + 累计经验 +
 * 本页教程掌握度 + 入口，点击进入独立的学习中心页(/learning-center)，不内嵌整套教程目录。
 * 数据走 dailyTipsStore.progress（挂载自动拉一次）。
 *
 * 等级→帽子（2026-06-23 用户确认保留「徽章环」一套）：后端 LevelTable 共 7 级（新手/入门/进阶/
 * 熟手/高手/大师/宗师）。每级对应一顶配色递进的学士帽（`HAT_TIERS` + `<LevelHat/>` 内联 SVG，
 * 禁止 emoji）：低阶素色、中阶亮色、高阶（大师/宗师）加皇冠，嵌进环形进度圈。
 */

// ── 等级帽子分级表（index 0 = 1 级，对齐后端 LevelTable）──
type HatTier = { name: string; board: string; cap: string; tassel: string; glow: string; crown: boolean };
const HAT_TIERS: HatTier[] = [
  { name: '新手', board: '#64748b', cap: '#475569', tassel: '#cbd5e1', glow: 'rgba(100,116,139,0.45)', crown: false },
  { name: '入门', board: '#10b981', cap: '#059669', tassel: '#6ee7b7', glow: 'rgba(16,185,129,0.45)', crown: false },
  { name: '进阶', board: '#0ea5e9', cap: '#0284c7', tassel: '#7dd3fc', glow: 'rgba(14,165,233,0.45)', crown: false },
  { name: '熟手', board: '#8b5cf6', cap: '#7c3aed', tassel: '#c4b5fd', glow: 'rgba(139,92,246,0.45)', crown: false },
  { name: '高手', board: '#f59e0b', cap: '#d97706', tassel: '#fcd34d', glow: 'rgba(245,158,11,0.5)', crown: false },
  { name: '大师', board: '#f97316', cap: '#ea580c', tassel: '#fdba74', glow: 'rgba(249,115,22,0.55)', crown: true },
  { name: '宗师', board: '#fbbf24', cap: '#f59e0b', tassel: '#fff7cd', glow: 'rgba(251,191,36,0.65)', crown: true },
];

function hatTier(level: number): HatTier {
  return HAT_TIERS[Math.min(Math.max(level - 1, 0), HAT_TIERS.length - 1)];
}

/** 等级学士帽（内联 SVG）。每级配色递进，大师/宗师戴皇冠。 */
function LevelHat({ level, size = 26 }: { level: number; size?: number }) {
  const t = hatTier(level);
  return (
    <svg width={size} height={size} viewBox="0 0 48 44" fill="none" style={{ filter: `drop-shadow(0 2px 6px ${t.glow})` }}>
      {t.crown && <path d="M16 9 L19 3.5 L24 8 L29 3.5 L32 9 Z" fill={t.tassel} stroke={t.board} strokeWidth="0.8" strokeLinejoin="round" />}
      {/* 帽兜 */}
      <path d="M14 19 L14 27 C14 31.5 34 31.5 34 27 L34 19 Z" fill={t.cap} />
      {/* 帽板 */}
      <polygon points="24,11 45,19 24,27 3,19" fill={t.board} />
      {/* 顶纽 */}
      <circle cx="24" cy="19" r="2" fill={t.tassel} />
      {/* 流苏 */}
      <path d="M24 19 L40 21 L40 31" stroke={t.tassel} strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <circle cx="40" cy="33.5" r="2.4" fill={t.tassel} />
    </svg>
  );
}

export function LearningCenterTeaser({ tourAnchor = true }: { tourAnchor?: boolean } = {}) {
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
  const tier = hatTier(level);

  // 同页若并列多张承接卡时只让其中一张承载页面教程锚点（document.querySelector 只会命中第一张）。
  const anchorId = tourAnchor ? 'home-learning-center' : undefined;

  const R = 19;
  const C = 2 * Math.PI * R;
  const dash = total > 0 ? (pct / 100) * C : 0;

  return (
    <button
      type="button"
      onClick={() => navigate('/learning-center')}
      data-tour-id={anchorId}
      title="进入学习中心：看全部官方教程 + 你的等级与掌握进度"
      className="w-full text-left rounded-xl flex items-center gap-3"
      style={{
        padding: '11px 13px',
        background: 'linear-gradient(120deg, rgba(168,85,247,0.16), rgba(99,102,241,0.10) 55%, rgba(251,191,36,0.08))',
        border: '1px solid rgba(196,181,253,0.28)',
        cursor: 'pointer',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      <div className="relative shrink-0" style={{ width: 46, height: 46 }}>
        <svg width={46} height={46} viewBox="0 0 46 46" style={{ transform: 'rotate(-90deg)' }}>
          <circle cx={23} cy={23} r={R} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth={3} />
          <circle cx={23} cy={23} r={R} fill="none" stroke={tier.board} strokeWidth={3} strokeLinecap="round" strokeDasharray={`${dash} ${C}`} style={{ transition: 'stroke-dasharray 600ms cubic-bezier(.4,0,.2,1)' }} />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center"><LevelHat level={level} size={26} /></span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary,#fff)' }}>教程中心</span>
          <span className="text-[11px] font-bold" style={{ color: tier.tassel }}>Lv.{level}</span>
        </div>
        <div className="text-[11px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
          {levelName} · 经验 {xp}{total > 0 ? ` · ${learned}/${total} 套` : ''}
        </div>
      </div>
      <ArrowRight size={14} className="shrink-0" style={{ color: '#c4b5fd' }} />
    </button>
  );
}
