import { useMemo } from 'react';
import {
  TreePine, Sparkle, Star, Zap, ArrowRight, MousePointerClick,
  Wand2, Hand, Keyboard, Leaf,
} from 'lucide-react';
import { Button } from '@/components/design/Button';

interface Props {
  onStart: () => void;
  onCreateFirst: () => void;
  hasTrees: boolean;
}

const DIMENSIONS = [
  {
    dim: 1, key: '系统内',
    label: '一维·系统内',
    sub: '基于已有能力做减法',
    tint: 'rgba(96,165,250,1)',
    tintSoft: 'rgba(59,130,246,0.1)',
    border: 'rgba(59,130,246,0.22)',
    samples: ['上传模式识别', '成本优化推荐', 'Token 用量预测'],
    icon: Zap,
  },
  {
    dim: 2, key: '跨系统', featured: true,
    label: '二维·跨系统',
    sub: 'AB 组合自然产生 C',
    tint: 'rgba(192,132,252,1)',
    tintSoft: 'rgba(147,51,234,0.1)',
    border: 'rgba(147,51,234,0.3)',
    samples: ['跨平台价格差异提醒', '企业合规性匹配', '多平台 API 统一管理'],
    icon: Sparkle,
  },
  {
    dim: 3, key: '幻想',
    label: '三维·幻想',
    sub: '放宽约束，标注假设',
    tint: 'rgba(250,204,21,1)',
    tintSoft: 'rgba(234,179,8,0.1)',
    border: 'rgba(234,179,8,0.22)',
    samples: ['AI 主动为你谈判', '模型能力盲盒订阅', '预测 3 年后的 API 形态'],
    icon: Star,
  },
];

const FLOW_STEPS = [
  { icon: TreePine, title: '种下种子', desc: '上传文档 / 粘贴想法 / 选已有文档', accent: 'rgba(96,165,250,1)' },
  { icon: MousePointerClick, title: '探索生长', desc: '点节点「探索」，AI 基于锚点派生子功能', accent: 'rgba(192,132,252,1)' },
  { icon: Sparkle, title: '涌现组合', desc: '节点 ≥ 3 后触发涌现，AI 交叉发现新可能', accent: 'rgba(250,204,21,1)' },
];

const GESTURES = [
  { icon: Hand, text: '两指拖动 = 平移画布' },
  { icon: Hand, text: '双指捏合 = 缩放' },
  { icon: Keyboard, text: '⌘/Ctrl + 滚轮 = 缩放' },
  { icon: Keyboard, text: 'Space + 拖动 = 临时平移' },
];

/**
 * 中央种子视觉 — 三层旋转光轨 + 浮动粒子 + 核心发光种子。
 * 承接 EmergenceTreeCard 的视觉语言但更大气、更有"未知即将涌现"的张力。
 */
function SeedHeroVisual() {
  // 三条轨道上的粒子：(轨道半径, 角度, 颜色)
  const ringParticles = useMemo(() => {
    const cfg = [
      { r: 60, n: 3, color: 'rgba(96,165,250,0.95)' },    // 一维·蓝
      { r: 92, n: 5, color: 'rgba(192,132,252,0.95)' },   // 二维·紫
      { r: 124, n: 7, color: 'rgba(250,204,21,0.95)' },   // 三维·黄
    ];
    return cfg.map((c, ringIdx) => ({
      ...c,
      ringIdx,
      particles: Array.from({ length: c.n }, (_, i) => ({
        angle: (i / c.n) * Math.PI * 2,
        delay: (i / c.n) * 0.5,
      })),
    }));
  }, []);

  return (
    <div
      className="relative"
      style={{ width: 300, height: 300 }}
      aria-hidden="true"
    >
      {/* 外层柔光 */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background:
            'radial-gradient(closest-side, rgba(147,51,234,0.25) 0%, rgba(147,51,234,0.08) 40%, transparent 70%)',
          filter: 'blur(24px)',
        }}
      />

      {/* 三条轨道 + 粒子 */}
      <svg
        viewBox="-150 -150 300 300"
        className="absolute inset-0"
        style={{ overflow: 'visible' }}
      >
        {ringParticles.map((ring) => {
          const cls = ring.ringIdx % 2 === 0 ? 'emergence-orbit-cw' : 'emergence-orbit-ccw';
          return (
            <g key={ring.ringIdx} className={cls}>
              {/* 轨道虚圆 */}
              <circle
                cx={0} cy={0} r={ring.r}
                fill="none"
                stroke={ring.color.replace('0.95', '0.18')}
                strokeWidth={0.8}
                strokeDasharray="2 4"
              />
              {/* 粒子 */}
              {ring.particles.map((p, i) => (
                <g key={i} transform={`rotate(${(p.angle * 180) / Math.PI})`}>
                  <circle
                    cx={ring.r} cy={0}
                    r={3 + ring.ringIdx * 0.8}
                    fill={ring.color}
                    style={{
                      filter: `drop-shadow(0 0 ${6 + ring.ringIdx * 2}px ${ring.color})`,
                    }}
                  />
                  {/* 粒子拖尾小点 */}
                  <circle
                    cx={ring.r - 6} cy={0}
                    r={1.2}
                    fill={ring.color.replace('0.95', '0.5')}
                  />
                </g>
              ))}
            </g>
          );
        })}

        {/* 中心种子：发光圆盘 + 叶片 */}
        <g className="emergence-seed-breath">
          {/* 柔光核心 */}
          <circle cx={0} cy={0} r={22}
            fill="rgba(255,255,255,0.95)"
            style={{ filter: 'drop-shadow(0 0 20px rgba(192,132,252,0.8))' }}
          />
          <circle cx={0} cy={0} r={14}
            fill="rgba(234,179,8,0.4)"
          />
          {/* 十字光芒 */}
          {[0, 45, 90, 135].map(a => (
            <line
              key={a}
              x1={-30} y1={0} x2={30} y2={0}
              stroke="rgba(255,255,255,0.5)"
              strokeWidth={1}
              transform={`rotate(${a})`}
            />
          ))}
        </g>
      </svg>

      {/* 顶部小标签 */}
      <div
        className="absolute left-1/2 -translate-x-1/2"
        style={{ top: -12 }}
      >
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
          style={{
            background: 'rgba(192,132,252,0.15)',
            border: '1px solid rgba(192,132,252,0.3)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <Leaf size={10} style={{ color: 'rgba(192,132,252,1)' }} />
          <span className="text-[10px] font-medium tracking-wider" style={{ color: 'rgba(255,255,255,0.9)' }}>
            SEED
          </span>
        </div>
      </div>
    </div>
  );
}

export function EmergenceIntroPage({ onStart, onCreateFirst, hasTrees }: Props) {
  // 背景粒子
  const bgParticles = useMemo(() => {
    const rand = (seed: number) => {
      const x = Math.sin(seed * 9999) * 10000;
      return x - Math.floor(x);
    };
    return Array.from({ length: 28 }).map((_, i) => ({
      left: `${rand(i * 3.1) * 100}%`,
      top: `${rand(i * 7.7) * 100}%`,
      size: 3 + rand(i * 2.3) * 6,
      delay: rand(i * 5.1) * 4,
      duration: 4 + rand(i * 11.3) * 5,
      tint: i % 3 === 0
        ? 'rgba(96,165,250,0.7)'
        : i % 3 === 1
          ? 'rgba(192,132,252,0.7)'
          : 'rgba(250,204,21,0.8)',
    }));
  }, []);

  return (
    <div className="relative h-full min-h-0 overflow-y-auto overflow-x-hidden">
      {/* ── 背景：渐变网格 + 浮动粒子 + 柔光晕 ── */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* 渐变底 */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse at 50% 0%, rgba(147,51,234,0.18) 0%, transparent 50%),' +
              'radial-gradient(ellipse at 20% 80%, rgba(59,130,246,0.12) 0%, transparent 50%),' +
              'radial-gradient(ellipse at 80% 70%, rgba(234,179,8,0.1) 0%, transparent 50%)',
          }}
        />
        {/* 浮动粒子 */}
        {bgParticles.map((n, i) => (
          <div
            key={i}
            className="absolute rounded-full emergence-particle-float"
            style={{
              left: n.left,
              top: n.top,
              width: n.size,
              height: n.size,
              background: n.tint,
              opacity: 0.55,
              filter: `blur(0.5px) drop-shadow(0 0 6px ${n.tint})`,
              animationDelay: `${n.delay}s`,
              animationDuration: `${n.duration}s`,
            }}
          />
        ))}
      </div>

      <div className="relative z-10 mx-auto flex max-w-[1080px] flex-col px-6 py-8">
        {/* ── Hero：中央种子视觉 + 标题 + CTA ── */}
        <section className="flex flex-col items-center pt-4 pb-8">
          {/* 顶部胶囊标签 */}
          <div
            className="mb-6 flex items-center gap-2 rounded-full px-3 py-1.5"
            style={{
              background: 'rgba(192,132,252,0.08)',
              border: '1px solid rgba(192,132,252,0.2)',
              backdropFilter: 'blur(10px)',
            }}
          >
            <Sparkle size={11} style={{ color: 'rgba(192,132,252,1)' }} />
            <span className="text-[11px] font-medium" style={{ color: 'rgba(255,255,255,0.8)' }}>
              AI 涌现探索器 · 反向自洽 · 有根之木
            </span>
          </div>

          {/* 中央种子视觉 */}
          <SeedHeroVisual />

          {/* 主标题 */}
          <h1
            className="mt-6 text-center font-semibold tracking-tight"
            style={{
              fontSize: 'clamp(28px, 4vw, 44px)',
              lineHeight: 1.1,
              color: 'var(--text-primary)',
            }}
          >
            从一颗
            <span
              className="mx-2 inline-block bg-clip-text"
              style={{
                backgroundImage:
                  'linear-gradient(120deg, rgba(96,165,250,1), rgba(192,132,252,1) 50%, rgba(250,204,21,1))',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}
            >
              种子
            </span>
            ，长出整棵可能性之树
          </h1>
          <p
            className="mt-4 max-w-[640px] text-center leading-relaxed"
            style={{ color: 'var(--text-muted)', fontSize: 14 }}
          >
            上传一段文档作为锚点，AI 沿着
            <span style={{ color: 'rgba(96,165,250,1)' }}> 系统内 </span>→
            <span style={{ color: 'rgba(192,132,252,1)' }}> 跨系统 </span>→
            <span style={{ color: 'rgba(250,204,21,1)' }}> 幻想未来 </span>
            三个维度持续生长，帮你把「模糊方向」变成「具体的功能列表」。
          </p>

          {/* CTA */}
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <Button variant="primary" size="md" onClick={onCreateFirst}>
              <TreePine size={14} /> 种下第一颗种子
            </Button>
            {hasTrees && (
              <Button variant="secondary" size="md" onClick={onStart}>
                查看我的涌现树 <ArrowRight size={14} />
              </Button>
            )}
          </div>
        </section>

        {/* ── Bento Grid：三个维度(中间放大) ── */}
        <section className="mt-4">
          <div className="mb-4 flex items-center gap-2">
            <Zap size={12} style={{ color: 'rgba(192,132,252,0.9)' }} />
            <span className="text-[11px] font-mono tracking-wider uppercase" style={{ color: 'var(--text-muted)' }}>
              THREE DIMENSIONS · 由近及远
            </span>
          </div>
          <div
            className="grid gap-3"
            style={{
              gridTemplateColumns: '1fr 1.4fr 1fr',
            }}
          >
            {DIMENSIONS.map((d) => {
              const Ic = d.icon;
              const featured = !!d.featured;
              return (
                <div
                  key={d.dim}
                  className="relative rounded-[18px] p-5 overflow-hidden transition-colors duration-200"
                  style={{
                    background: featured
                      ? `linear-gradient(180deg, ${d.tintSoft} 0%, rgba(255,255,255,0.03) 100%)`
                      : 'linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 100%)',
                    border: `1px solid ${d.border}`,
                    backdropFilter: 'blur(20px) saturate(160%)',
                    minHeight: featured ? 210 : 190,
                    boxShadow: featured
                      ? `0 20px 40px -20px ${d.tint.replace('1)', '0.3)')}, inset 0 1px 1px rgba(255,255,255,0.06)`
                      : 'inset 0 1px 1px rgba(255,255,255,0.05)',
                  }}
                >
                  {/* 右上角装饰：小型轨道 SVG */}
                  <svg
                    className="absolute -top-4 -right-4"
                    width="90" height="90"
                    viewBox="-50 -50 100 100"
                    style={{ opacity: featured ? 0.7 : 0.4 }}
                    aria-hidden="true"
                  >
                    <g className="emergence-orbit-cw">
                      <circle cx={0} cy={0} r={36} fill="none"
                        stroke={d.tint.replace('1)', '0.2)')} strokeWidth={0.8}
                        strokeDasharray="1 3" />
                      <circle cx={36} cy={0} r={2.5} fill={d.tint}
                        style={{ filter: `drop-shadow(0 0 4px ${d.tint})` }} />
                    </g>
                  </svg>

                  {/* 图标 + 维度徽章 */}
                  <div className="flex items-center gap-2 mb-3">
                    <div
                      className="w-9 h-9 rounded-[10px] flex items-center justify-center flex-shrink-0"
                      style={{
                        background: d.tintSoft,
                        border: `1px solid ${d.border}`,
                      }}
                    >
                      <Ic size={15} style={{ color: d.tint }} />
                    </div>
                    <div
                      className="text-[9.5px] font-mono tracking-wider uppercase px-1.5 py-0.5 rounded"
                      style={{
                        background: d.tintSoft,
                        color: d.tint,
                        border: `1px solid ${d.border}`,
                      }}
                    >
                      DIM {d.dim}
                    </div>
                  </div>

                  {/* 标题 */}
                  <div
                    className="mb-1 font-semibold"
                    style={{
                      fontSize: featured ? 17 : 15,
                      color: 'var(--text-primary)',
                    }}
                  >
                    {d.label}
                  </div>
                  <div className="mb-3 text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                    {d.sub}
                  </div>

                  {/* 样例列表 */}
                  <ul className="space-y-1.5 relative z-10">
                    {d.samples.map((s, i) => (
                      <li
                        key={s}
                        className="flex items-start gap-1.5 text-[11.5px] leading-[1.5]"
                        style={{ color: 'rgba(255,255,255,0.82)' }}
                      >
                        <span
                          className="inline-block mt-1 flex-shrink-0 rounded-full"
                          style={{
                            width: 4,
                            height: 4,
                            background: d.tint,
                            boxShadow: `0 0 4px ${d.tint}`,
                            opacity: 1 - i * 0.15,
                          }}
                        />
                        <span>{s}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── 三步流程时间线 ── */}
        <section className="mt-8">
          <div className="mb-4 flex items-center gap-2">
            <Wand2 size={12} style={{ color: 'rgba(96,165,250,0.9)' }} />
            <span className="text-[11px] font-mono tracking-wider uppercase" style={{ color: 'var(--text-muted)' }}>
              HOW IT WORKS · 三步完成一次涌现
            </span>
          </div>
          <div
            className="relative rounded-[18px] p-5"
            style={{
              background: 'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.015) 100%)',
              border: '1px solid rgba(255,255,255,0.06)',
              backdropFilter: 'blur(20px)',
            }}
          >
            <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
              {FLOW_STEPS.map((step, i) => {
                const Ic = step.icon;
                return (
                  <div key={step.title} className="relative">
                    {/* 连接线(除最后一个外) */}
                    {i < FLOW_STEPS.length - 1 && (
                      <div
                        className="absolute hidden md:block"
                        style={{
                          top: 20,
                          right: -12,
                          width: 24,
                          height: 2,
                          background: `linear-gradient(90deg, ${step.accent.replace('1)', '0.45)')} 0%, ${FLOW_STEPS[i + 1].accent.replace('1)', '0.45)')} 100%)`,
                          borderRadius: 2,
                        }}
                      />
                    )}
                    {/* 编号徽章 + 图标 */}
                    <div className="flex items-center gap-2 mb-2">
                      <div
                        className="w-10 h-10 rounded-[12px] flex items-center justify-center flex-shrink-0 relative"
                        style={{
                          background: step.accent.replace('1)', '0.1)'),
                          border: `1px solid ${step.accent.replace('1)', '0.3)')}`,
                          boxShadow: `0 0 20px -4px ${step.accent.replace('1)', '0.3)')}`,
                        }}
                      >
                        <Ic size={16} style={{ color: step.accent }} />
                        {/* 编号角标 */}
                        <div
                          className="absolute -top-1.5 -left-1.5 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-semibold"
                          style={{
                            background: step.accent,
                            color: '#0a0a0a',
                          }}
                        >
                          {i + 1}
                        </div>
                      </div>
                    </div>
                    <div className="font-semibold text-[13px] mb-1" style={{ color: 'var(--text-primary)' }}>
                      {step.title}
                    </div>
                    <div className="text-[11.5px] leading-[1.55]" style={{ color: 'var(--text-muted)' }}>
                      {step.desc}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* ── 手势提示(紧凑一行) ── */}
        <section className="mt-6">
          <div
            className="rounded-[14px] px-4 py-3 flex items-center gap-4 flex-wrap"
            style={{
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.05)',
            }}
          >
            <div className="flex items-center gap-1.5 text-[10px] font-mono tracking-wider uppercase flex-shrink-0"
              style={{ color: 'var(--text-muted)' }}>
              <Star size={11} style={{ color: 'rgba(234,179,8,0.85)' }} />
              GESTURES
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              {GESTURES.map((g, i) => {
                const Ic = g.icon;
                return (
                  <div key={i} className="flex items-center gap-1.5 text-[11px]"
                    style={{ color: 'rgba(255,255,255,0.7)' }}>
                    <Ic size={11} style={{ color: 'var(--text-muted)' }} />
                    {g.text}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* 底部小字 */}
        <p
          className="mt-6 mb-2 text-center text-[10.5px]"
          style={{ color: 'var(--text-muted)', opacity: 0.7 }}
        >
          随时可通过顶栏「关于涌现」按钮再次查看本介绍
        </p>
      </div>
    </div>
  );
}
