import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';

/**
 * 首页顶部「教程中心」承接卡。「只是承接」—— 卡内只展示等级 + 累计经验 + 本页教程掌握度 + 入口，
 * 点击进入独立的学习中心页(/learning-center)，不在首页内嵌整套教程目录。数据走 dailyTipsStore.progress。
 *
 * 等级→帽子（2026-06-23 用户要求）：后端 LevelTable 共 7 级（新手/入门/进阶/熟手/高手/大师/宗师）。
 * 每一级对应一顶配色递进的学士帽（`HAT_TIERS` + `<LevelHat/>` 内联 SVG，禁止 emoji）：
 * 低阶素色、中阶亮色、高阶（大师/宗师）加皇冠，构成「升级解锁不同帽子」的收集感。
 * 提供三套承接卡视觉（variant A/B/C）供选型，选定后保留其一。
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

const LOCKED_TIER: HatTier = { name: '未解锁', board: '#3f3f46', cap: '#27272a', tassel: '#52525b', glow: 'transparent', crown: false };

/** 等级学士帽（内联 SVG）。每级配色递进，大师/宗师戴皇冠；locked 时灰化表示未解锁。 */
function LevelHat({ level, size = 34, locked = false }: { level: number; size?: number; locked?: boolean }) {
  const t = locked ? LOCKED_TIER : hatTier(level);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 44"
      fill="none"
      style={{ filter: locked ? 'none' : `drop-shadow(0 2px 6px ${t.glow})`, opacity: locked ? 0.4 : 1 }}
    >
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

type Variant = 'A' | 'B' | 'C';

export function LearningCenterTeaser({
  compact = false,
  variant = 'A',
  tourAnchor = true,
}: { compact?: boolean; variant?: Variant; tourAnchor?: boolean } = {}) {
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

  const SHARED_BG =
    'linear-gradient(120deg, rgba(168,85,247,0.16), rgba(99,102,241,0.10) 55%, rgba(251,191,36,0.08))';
  const SHARED_BORDER = '1px solid rgba(196,181,253,0.28)';

  const go = () => navigate('/learning-center');
  // 同页若并列多张承接卡(设计选型对比),只让其中一张承载页面教程锚点,
  // 否则 document.querySelector 只会命中第一张,其余两张共享同一 anchor(Bugbot)。
  const anchorId = tourAnchor ? 'home-learning-center' : undefined;
  const cardBase = {
    background: SHARED_BG,
    border: SHARED_BORDER,
    cursor: 'pointer',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
  } as const;

  const bar = (
    <div style={{ height: 5, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
      <div
        style={{
          width: `${total > 0 ? pct : 0}%`,
          height: '100%',
          borderRadius: 999,
          background: `linear-gradient(90deg, ${tier.cap}, ${tier.board})`,
          transition: 'width 600ms cubic-bezier(.4,0,.2,1)',
        }}
      />
    </div>
  );

  // ── 非紧凑（旧宽版，暂保留兼容）──
  if (!compact) {
    return (
      <button type="button" onClick={go} data-tour-id={anchorId} className="w-full text-left rounded-2xl flex items-center gap-4" style={{ padding: '14px 18px', ...cardBase }}>
        <div className="shrink-0 inline-flex items-center justify-center rounded-xl" style={{ width: 46, height: 46, background: 'rgba(196,181,253,0.16)', border: '1px solid rgba(196,181,253,0.3)' }}>
          <LevelHat level={level} size={30} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary,#fff)' }}>教程中心</span>
            <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>Lv.{level} {levelName} · 经验 {xp}</span>
          </div>
          <div className="text-[12px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>
            {total > 0 ? `已掌握 ${learned}/${total} 套本页教程` : '跟着官方教程走一遍，攒经验升级'}
          </div>
          {total > 0 && <div className="mt-1.5" style={{ maxWidth: 320 }}>{bar}</div>}
        </div>
        <span className="shrink-0 inline-flex items-center gap-1 text-[12px] font-semibold" style={{ color: '#c4b5fd' }}>进入学习中心<ArrowRight size={14} /></span>
      </button>
    );
  }

  // ── 效果 A：徽章环（帽子嵌进环形进度圈，最克制）──
  if (variant === 'A') {
    const R = 19;
    const C = 2 * Math.PI * R;
    const dash = total > 0 ? (pct / 100) * C : 0;
    return (
      <button type="button" onClick={go} data-tour-id={anchorId} title="进入学习中心" className="w-full text-left rounded-xl flex items-center gap-3" style={{ padding: '11px 13px', ...cardBase }}>
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

  // ── 效果 B：等级横幅（游戏化段位条，帽子 + 大号 Lv + XP chip + 进度条）──
  if (variant === 'B') {
    return (
      <button type="button" onClick={go} data-tour-id={anchorId} title="进入学习中心" className="w-full text-left rounded-xl flex items-center gap-3" style={{ padding: '11px 13px', ...cardBase }}>
        <div className="shrink-0 inline-flex items-center justify-center rounded-lg" style={{ width: 44, height: 44, background: `${tier.board}1f`, border: `1px solid ${tier.board}55` }}>
          <LevelHat level={level} size={30} />
        </div>
        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[15px] font-bold leading-none" style={{ color: 'var(--text-primary,#fff)' }}>Lv.{level}</span>
            <span className="text-[12px] font-semibold" style={{ color: tier.tassel }}>{levelName}</span>
            <span className="ml-auto inline-flex items-center font-bold" style={{ padding: '1px 6px', borderRadius: 6, fontSize: 10, background: `${tier.board}22`, border: `1px solid ${tier.board}44`, color: tier.tassel }}>XP {xp}</span>
          </div>
          {bar}
          <div className="flex items-center gap-1 text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
            <span>{total > 0 ? `已掌握 ${learned}/${total} 套` : '攒经验升级'}</span>
            <span className="ml-auto inline-flex items-center gap-0.5 font-semibold" style={{ color: '#c4b5fd' }}>进入学习中心<ArrowRight size={11} /></span>
          </div>
        </div>
      </button>
    );
  }

  // ── 效果 C：帽子阶梯（7 顶帽子收集进度，已解锁高亮 / 未解锁灰化，最强游戏感）──
  return (
    <button type="button" onClick={go} data-tour-id={anchorId} title="进入学习中心" className="w-full text-left rounded-xl flex flex-col gap-2" style={{ padding: '11px 13px', ...cardBase }}>
      <div className="flex items-center gap-2">
        <LevelHat level={level} size={22} />
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary,#fff)' }}>教程中心</span>
        <span className="ml-auto inline-flex items-center font-bold" style={{ padding: '1px 7px', borderRadius: 7, fontSize: 11, background: `${tier.board}26`, border: `1px solid ${tier.board}55`, color: tier.tassel }}>Lv.{level} {levelName}</span>
      </div>
      <div className="flex items-center justify-between" style={{ gap: 2 }} aria-label="等级帽子收集进度">
        {HAT_TIERS.map((_, i) => {
          const lv = i + 1;
          const unlocked = lv <= level;
          const isCurrent = lv === level;
          return (
            <span
              key={lv}
              className="inline-flex items-center justify-center rounded-md"
              style={{
                width: 28,
                height: 26,
                background: isCurrent ? `${tier.board}22` : 'transparent',
                boxShadow: isCurrent ? `inset 0 0 0 1px ${tier.board}66` : 'none',
              }}
            >
              <LevelHat level={lv} size={18} locked={!unlocked} />
            </span>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1">{bar}</div>
        <span className="shrink-0 inline-flex items-center gap-0.5 text-[10.5px] font-semibold" style={{ color: '#c4b5fd' }}>学习中心<ArrowRight size={11} /></span>
      </div>
    </button>
  );
}
