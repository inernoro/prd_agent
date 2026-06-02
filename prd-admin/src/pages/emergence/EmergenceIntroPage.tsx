import { TreePine, ArrowRight } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { TipsEntryButton } from '@/components/daily-tips/TipsEntryButton';

interface Props {
  onStart: () => void;
  onCreateFirst: () => void;
  hasTrees: boolean;
}

// 单一强调渐变：贯穿标题强调词 / 序号 / 视觉描边，给克制排版一个统一的高光语言
const ACCENT = 'linear-gradient(135deg, #818cf8 0%, #c084fc 48%, #fbbf24 100%)';

const STEPS = [
  { n: '01', title: '种下种子', desc: '上传文档、粘贴想法，或选一篇已有文档作为锚点' },
  { n: '02', title: '探索生长', desc: '点节点「探索」，AI 基于锚点在系统内派生可落地的子功能' },
  { n: '03', title: '涌现组合', desc: '节点 ≥ 3 后触发涌现，AI 交叉组合发现意料之外的新可能' },
];

const DIMENSIONS = [
  { label: '系统内', desc: '基于已有能力做减法' },
  { label: '跨系统', desc: 'A、B 组合自然产生 C' },
  { label: '幻想未来', desc: '放宽约束，标注假设' },
];

/**
 * 涌现介绍页 —— claude-code 式：克制但有设计。
 * 双栏 hero（文案 + 静态线条生长视觉）、统一强调渐变、surface 卡片化三步序列。
 * 不用旋转轨道 / 浮动粒子（噪音），靠排版层次与一个精致焦点元素建立设计感。
 */
export function EmergenceIntroPage({ onStart, onCreateFirst, hasTrees }: Props) {
  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden">
      <div className="relative mx-auto w-full max-w-[1120px] px-8 py-16">
        <div className="absolute top-4 right-8 z-10"><TipsEntryButton compact /></div>
        {/* 头顶柔光（单一、低饱和，暗/亮主题都成立） */}
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={{
            top: -80,
            left: '8%',
            width: 560,
            height: 360,
            background: 'radial-gradient(closest-side, rgba(168,85,247,0.16), transparent 72%)',
            filter: 'blur(8px)',
          }}
        />

        {/* ── Hero：左文案 / 右生长视觉 ── */}
        <section className="relative grid items-center gap-12 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            {/* 眉标 */}
            <div className="mb-6 flex items-center gap-3">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: ACCENT }}
              />
              <span
                className="text-[11px] font-mono uppercase tracking-[0.22em]"
                style={{ color: 'var(--text-muted)' }}
              >
                AI 涌现探索器
              </span>
              <span className="h-px flex-1 max-w-[120px]" style={{ background: 'var(--border-subtle, rgba(255,255,255,0.08))' }} />
            </div>

            {/* 主标题 */}
            <h1
              data-tour-id="emergence-hero-title"
              className="font-semibold tracking-tight"
              style={{ fontSize: 'clamp(32px, 4.6vw, 52px)', lineHeight: 1.1, color: 'var(--text-primary)' }}
            >
              从一颗
              <span
                className="bg-clip-text"
                style={{
                  backgroundImage: ACCENT,
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                }}
              >
                种子
              </span>
              ，<br />长出整棵可能性之树
            </h1>

            <p
              className="mt-6 max-w-[480px] text-[14px] leading-[1.75]"
              style={{ color: 'var(--text-muted)' }}
            >
              上传一段文档作为锚点，AI 沿着「系统内 → 跨系统 → 幻想未来」三个维度持续生长，
              把模糊的方向变成一份具体的功能列表。
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button variant="primary" size="md" data-tour-id="emergence-seed-input" onClick={onCreateFirst}>
                <TreePine size={14} /> 种下第一颗种子
              </Button>
              {hasTrees && (
                <Button variant="secondary" size="md" onClick={onStart}>
                  查看我的涌现树 <ArrowRight size={14} />
                </Button>
              )}
            </div>
          </div>

          {/* 静态线条生长视觉 —— 一颗种子向上分叉成节点，描边走强调渐变 */}
          <div className="hidden justify-center lg:flex" aria-hidden>
            <GrowthVisual />
          </div>
        </section>

        {/* 分隔 */}
        <div className="my-14 h-px w-full" style={{ background: 'var(--border-subtle, rgba(255,255,255,0.07))' }} />

        {/* 三步序列 —— surface 卡片，序号走强调渐变 */}
        <div data-tour-id="emergence-steps" className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="surface rounded-2xl p-6">
              <span
                className="block text-[26px] font-mono font-semibold leading-none bg-clip-text"
                style={{
                  backgroundImage: ACCENT,
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                }}
              >
                {s.n}
              </span>
              <span className="mt-4 block text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {s.title}
              </span>
              <span className="mt-2 block text-[12px] leading-[1.65]" style={{ color: 'var(--text-muted)' }}>
                {s.desc}
              </span>
            </div>
          ))}
        </div>

        {/* 三维度 —— surface-inset 一行，强调标签 + 分隔 */}
        <div data-tour-id="emergence-dimensions" className="surface-inset mt-4 flex flex-wrap items-center gap-x-7 gap-y-2 rounded-2xl px-6 py-4 text-[12px]">
          {DIMENSIONS.map((d, i) => (
            <span key={d.label} className="inline-flex items-center gap-2.5">
              {i > 0 && <span style={{ color: 'var(--text-muted)', opacity: 0.4 }}>→</span>}
              <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{d.label}</span>
              <span style={{ color: 'var(--text-muted)' }}>{d.desc}</span>
            </span>
          ))}
        </div>

        <p
          className="mt-10 text-[11px] leading-[1.7]"
          style={{ color: 'var(--text-muted)', opacity: 0.6 }}
        >
          画布手势：两指拖动平移 · 双指捏合或 ⌘/Ctrl+滚轮缩放 · Space+拖动临时平移。
          随时可通过顶栏「关于涌现」按钮再次查看本页。
        </p>
      </div>
    </div>
  );
}

/** 静态生长线稿：种子（底部发光圆）→ 平滑贝塞尔分叉 → 末端节点点。无动效，矢量清晰。 */
function GrowthVisual() {
  return (
    <svg width="340" height="380" viewBox="0 0 340 380" fill="none">
      <defs>
        <linearGradient id="emg-stroke" x1="170" y1="360" x2="170" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="48%" stopColor="#c084fc" />
          <stop offset="100%" stopColor="#fbbf24" />
        </linearGradient>
        <radialGradient id="emg-seed" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(192,132,252,0.9)" />
          <stop offset="100%" stopColor="rgba(192,132,252,0)" />
        </radialGradient>
      </defs>

      {/* 主干 + 分叉（一→二→四） */}
      <g stroke="url(#emg-stroke)" strokeWidth="1.5" strokeLinecap="round" opacity="0.85">
        <path d="M170 358 C 170 300, 170 280, 170 250" />
        <path d="M170 250 C 170 215, 110 210, 96 175" />
        <path d="M170 250 C 170 215, 230 210, 244 175" />
        <path d="M96 175 C 86 150, 64 140, 56 110" />
        <path d="M96 175 C 106 150, 128 142, 134 112" />
        <path d="M244 175 C 234 150, 212 142, 206 112" />
        <path d="M244 175 C 254 150, 276 140, 284 110" />
      </g>

      {/* 末端节点点 */}
      <g fill="url(#emg-stroke)">
        {[
          [56, 104], [134, 106], [206, 106], [284, 104],
        ].map(([cx, cy]) => (
          <g key={`${cx}-${cy}`}>
            <circle cx={cx} cy={cy} r="14" fill="rgba(255,255,255,0.04)" stroke="url(#emg-stroke)" strokeWidth="1" />
            <circle cx={cx} cy={cy} r="3.5" />
          </g>
        ))}
        {/* 中间节点 */}
        <circle cx="96" cy="175" r="3" />
        <circle cx="244" cy="175" r="3" />
        <circle cx="170" cy="250" r="3.5" />
      </g>

      {/* 种子（底部发光核） */}
      <circle cx="170" cy="358" r="34" fill="url(#emg-seed)" />
      <circle cx="170" cy="358" r="7" fill="#c084fc" />
      <circle cx="170" cy="358" r="13" fill="none" stroke="rgba(192,132,252,0.35)" strokeWidth="1" strokeDasharray="2 3" />
    </svg>
  );
}
