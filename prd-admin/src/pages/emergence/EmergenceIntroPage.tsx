import { useMemo } from 'react';
import { TreePine, Sparkle, Star, Zap, ArrowRight, MousePointerClick } from 'lucide-react';
import { Button } from '@/components/design/Button';

interface Props {
  onStart: () => void;
  onCreateFirst: () => void;
  hasTrees: boolean;
}

const DIMENSION_SAMPLES = [
  {
    dim: 1,
    label: '一维 · 系统内',
    tint: 'rgba(59,130,246,0.8)',
    bg: 'rgba(59,130,246,0.08)',
    border: 'rgba(59,130,246,0.2)',
    samples: ['上传模式识别', '成本优化推荐', 'Token 用量预测'],
  },
  {
    dim: 2,
    label: '二维 · 跨系统',
    tint: 'rgba(147,51,234,0.8)',
    bg: 'rgba(147,51,234,0.08)',
    border: 'rgba(147,51,234,0.2)',
    samples: ['跨平台价格差异提醒', '企业合规性匹配', '多平台 API 统一管理'],
  },
  {
    dim: 3,
    label: '三维 · 幻想',
    tint: 'rgba(234,179,8,0.9)',
    bg: 'rgba(234,179,8,0.08)',
    border: 'rgba(234,179,8,0.2)',
    samples: ['AI 主动为你谈判', '模型能力盲盒订阅', '预测 3 年后的 API 形态'],
  },
];

const FLOW_STEPS = [
  {
    icon: TreePine,
    title: '种下种子',
    desc: '上传 PRD / 方案 / 竞品分析，或直接粘贴文字作为起点',
    accent: 'rgba(59,130,246,0.7)',
  },
  {
    icon: MousePointerClick,
    title: '探索生长',
    desc: '点击任意节点的「探索」按钮，AI 基于现实能力长出子功能',
    accent: 'rgba(147,51,234,0.7)',
  },
  {
    icon: Sparkle,
    title: '涌现组合',
    desc: '节点 ≥ 3 个后触发涌现，AI 交叉组合发现意想不到的新可能',
    accent: 'rgba(234,179,8,0.85)',
  },
];

export function EmergenceIntroPage({ onStart, onCreateFirst, hasTrees }: Props) {
  const bgNodes = useMemo(() => {
    const rand = (seed: number) => {
      const x = Math.sin(seed * 9999) * 10000;
      return x - Math.floor(x);
    };
    return Array.from({ length: 22 }).map((_, i) => ({
      left: `${rand(i * 3.1) * 100}%`,
      top: `${rand(i * 7.7) * 100}%`,
      size: 4 + rand(i * 2.3) * 7,
      delay: rand(i * 5.1) * 4,
      duration: 4 + rand(i * 11.3) * 4,
      tint: i % 3 === 0
        ? 'rgba(59,130,246,0.6)'
        : i % 3 === 1
          ? 'rgba(147,51,234,0.6)'
          : 'rgba(234,179,8,0.7)',
    }));
  }, []);

  return (
    <div className="relative h-full min-h-0 overflow-y-auto overflow-x-hidden">
      {/* 背景星点动画 */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {bgNodes.map((n, i) => (
          <div
            key={i}
            className="absolute rounded-full animate-pulse"
            style={{
              left: n.left,
              top: n.top,
              width: n.size,
              height: n.size,
              background: n.tint,
              opacity: 0.35,
              filter: 'blur(1px)',
              animationDelay: `${n.delay}s`,
              animationDuration: `${n.duration}s`,
            }}
          />
        ))}
        {/* 柔光晕 */}
        <div
          className="absolute left-1/2 top-[20%] -translate-x-1/2 w-[600px] h-[600px] rounded-full pointer-events-none"
          style={{
            background:
              'radial-gradient(closest-side, rgba(147,51,234,0.18), rgba(147,51,234,0.04) 60%, transparent)',
            filter: 'blur(40px)',
          }}
        />
      </div>

      <div className="relative z-10 mx-auto flex max-w-[960px] flex-col items-center px-6 py-10">
        {/* Hero */}
        <div
          className="mb-5 flex items-center gap-2 rounded-full px-3 py-1.5"
          style={{
            background: 'rgba(147,51,234,0.08)',
            border: '1px solid rgba(147,51,234,0.18)',
          }}
        >
          <Sparkle size={12} style={{ color: 'rgba(147,51,234,0.9)' }} />
          <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.7)' }}>
            AI 涌现探索器 · 陌生领域也能知道下一步做什么
          </span>
        </div>

        <h1
          className="text-center text-[34px] font-semibold leading-tight tracking-tight"
          style={{ color: 'var(--text-primary)' }}
        >
          从一颗
          <span
            className="mx-2 inline-block bg-clip-text"
            style={{
              backgroundImage:
                'linear-gradient(120deg, rgba(59,130,246,0.9), rgba(147,51,234,1) 50%, rgba(234,179,8,0.9))',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            种子
          </span>
          ，长出一整棵可能性之树
        </h1>
        <p
          className="mt-3 max-w-[620px] text-center text-[13px] leading-relaxed"
          style={{ color: 'var(--text-muted)' }}
        >
          上传一段文档作为锚点，AI 会沿着「系统内 → 跨系统 → 幻想未来」三个维度持续生长，
          并在多个节点之间交叉涌现，帮你把「模糊的方向」变成「具体的功能列表」。
        </p>

        {/* 三步流程卡片 */}
        <div className="mt-9 grid w-full grid-cols-1 gap-3 md:grid-cols-3">
          {FLOW_STEPS.map((step, i) => (
            <div
              key={step.title}
              className="relative flex flex-col rounded-[16px] p-4"
              style={{
                background:
                  'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
                border: '1px solid rgba(255,255,255,0.06)',
                backdropFilter: 'blur(20px) saturate(160%)',
              }}
            >
              <div
                className="mb-3 flex h-8 w-8 items-center justify-center rounded-[10px]"
                style={{
                  background: `${step.accent.replace('0.7)', '0.12)').replace('0.85)', '0.12)')}`,
                  border: `1px solid ${step.accent.replace('0.7)', '0.22)').replace('0.85)', '0.22)')}`,
                }}
              >
                <step.icon size={14} style={{ color: step.accent }} />
              </div>
              <div
                className="mb-1 text-[10px] font-mono tracking-wider"
                style={{ color: step.accent }}
              >
                STEP 0{i + 1}
              </div>
              <p
                className="mb-1 text-[14px] font-semibold"
                style={{ color: 'var(--text-primary)' }}
              >
                {step.title}
              </p>
              <p
                className="text-[11.5px] leading-[1.6]"
                style={{ color: 'var(--text-muted)' }}
              >
                {step.desc}
              </p>
            </div>
          ))}
        </div>

        {/* 三维度样例 */}
        <div className="mt-8 w-full">
          <div className="mb-3 flex items-center gap-2">
            <Zap size={12} style={{ color: 'var(--text-muted)' }} />
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              三个维度，由近及远
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {DIMENSION_SAMPLES.map((d) => (
              <div
                key={d.dim}
                className="rounded-[14px] p-3.5"
                style={{ background: d.bg, border: `1px solid ${d.border}` }}
              >
                <div className="mb-2 flex items-center gap-1.5">
                  <span style={{ color: d.tint }}>
                    {d.dim === 1 ? '●' : d.dim === 2 ? '◆' : '★'}
                  </span>
                  <span
                    className="text-[11px] font-semibold"
                    style={{ color: d.tint }}
                  >
                    {d.label}
                  </span>
                </div>
                <ul className="space-y-1">
                  {d.samples.map((s) => (
                    <li
                      key={s}
                      className="text-[11.5px] leading-[1.5]"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      · {s}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* 操作提示 */}
        <div
          className="mt-8 flex w-full items-center justify-between rounded-[12px] px-4 py-3"
          style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <Star size={12} style={{ color: 'rgba(234,179,8,0.85)' }} />
            <span>
              画布手势统一：两指拖动 = 平移，双指捏合或 ⌘/Ctrl + 滚轮 = 缩放
            </span>
          </div>
        </div>

        {/* 主 CTA */}
        <div className="mt-9 flex w-full flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <Button variant="primary" size="md" onClick={onCreateFirst}>
            <TreePine size={14} /> 种下第一颗种子
          </Button>
          {hasTrees && (
            <Button variant="secondary" size="md" onClick={onStart}>
              查看我的涌现树 <ArrowRight size={14} />
            </Button>
          )}
        </div>

        <p
          className="mt-5 text-[10.5px]"
          style={{ color: 'var(--text-muted)', opacity: 0.7 }}
        >
          点击开始后将进入我的涌现树列表，随时可通过顶栏「关于涌现」按钮再次查看本介绍
        </p>
      </div>
    </div>
  );
}
