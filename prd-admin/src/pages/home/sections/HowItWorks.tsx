import { MessageSquare, Cpu, Waves } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * HowItWorks — 幕 5 · 三步流程
 *
 * 三张横排卡片，每张一个数字 + icon + 标题 + 描述 + 底部示意。
 * 连接线用 CSS 渐变横条暗示 "step → step" 的流程感。
 */

interface Step {
  n: string;
  Icon: LucideIcon;
  title: string;
  description: string;
  demo: string;
  accent: string;
}

const STEPS: Step[] = [
  {
    n: '01',
    Icon: MessageSquare,
    title: '提出需求',
    description:
      '用自然语言描述你想做的事 —— 不用选模型，不用挑 Agent，直接说。',
    demo: '帮我生成一张"未来科技城市"的海报',
    accent: '#6ee4ff',
  },
  {
    n: '02',
    Icon: Cpu,
    title: 'Agent 自动选型',
    description:
      'MAP 会根据意图路由到最合适的 Agent + 模型组合，必要时多个 Agent 协作。',
    demo: '→ 视觉设计师 · GPT-image-1 · 16:9',
    accent: '#a78bfa',
  },
  {
    n: '03',
    Icon: Waves,
    title: '流式输出',
    description:
      '实时看到思考过程、中间产物、进度，随时可以打断、分支、继续。',
    demo: '生成中 · 2 / 4 已完成 · 预计 12s',
    accent: '#f472b6',
  },
];

export function HowItWorks() {
  return (
    <section
      className="relative py-28 md:py-36 px-6"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="max-w-6xl mx-auto mb-16 md:mb-20 text-center">
        <div
          className="inline-flex items-center gap-2 mb-5 px-3 py-1 rounded border border-pink-400/25"
          style={{ fontFamily: 'var(--font-mono)', background: 'rgba(244, 114, 182, 0.05)' }}
        >
          <span
            className="text-[12px] uppercase"
            style={{
              color: '#f472b6',
              letterSpacing: '0.18em',
              textShadow: '0 0 10px rgba(244, 114, 182, 0.55)',
            }}
          >
            » How It Works
          </span>
        </div>
        <h2
          className="text-white font-medium"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(2rem, 5vw, 3.75rem)',
            lineHeight: 1.05,
            letterSpacing: '-0.03em',
            textShadow: '0 0 28px rgba(244, 114, 182, 0.22)',
          }}
        >
          三步，从想法到产物
        </h2>
      </div>

      {/* 三步卡片 */}
      <div className="max-w-6xl mx-auto">
        <div className="grid md:grid-cols-3 gap-4 md:gap-6 relative">
          {/* 步骤之间的连接线（仅桌面） */}
          <div
            className="hidden md:block absolute top-[90px] left-[16%] right-[16%] h-px pointer-events-none"
            style={{
              background:
                'linear-gradient(90deg, transparent 0%, rgba(167, 139, 250, 0.4) 20%, rgba(167, 139, 250, 0.4) 50%, rgba(244, 114, 182, 0.4) 80%, transparent 100%)',
            }}
          />

          {STEPS.map((step, i) => (
            <StepCard key={step.n} step={step} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}

function StepCard({ step, index: _index }: { step: Step; index: number }) {
  const { n, Icon, title, description, demo, accent } = step;
  return (
    <div
      className="relative p-6 rounded-2xl bg-white/[0.02] border border-white/8 backdrop-blur-sm"
      style={{ borderColor: 'rgba(255, 255, 255, 0.08)' }}
    >
      {/* 顶部 icon badge */}
      <div className="relative z-10 mb-6 flex items-center gap-4">
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center relative"
          style={{
            background: `linear-gradient(135deg, ${accent}22 0%, ${accent}08 100%)`,
            border: `1px solid ${accent}44`,
            boxShadow: `0 0 32px -8px ${accent}`,
          }}
        >
          <Icon className="w-5 h-5" style={{ color: accent }} />
        </div>
        <div
          className="text-[44px] font-light leading-none"
          style={{
            fontFamily: 'var(--font-display)',
            color: `${accent}40`,
            letterSpacing: '-0.04em',
          }}
        >
          {n}
        </div>
      </div>

      {/* Title */}
      <h3
        className="text-[22px] text-white font-medium mb-3"
        style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
      >
        {title}
      </h3>

      {/* Description */}
      <p className="text-[13px] text-white/55 leading-relaxed mb-6">
        {description}
      </p>

      {/* Demo hint (looks like a terminal/prompt line) */}
      <div
        className="px-3.5 py-2.5 rounded-lg bg-black/30 border border-white/[0.06] font-mono text-[11px] text-white/65"
        style={{ letterSpacing: '0.01em' }}
      >
        <span className="select-none" style={{ color: accent }}>
          ›{' '}
        </span>
        {demo}
      </div>
    </div>
  );
}
