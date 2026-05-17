import { TreePine, ArrowRight } from 'lucide-react';
import { Button } from '@/components/design/Button';

interface Props {
  onStart: () => void;
  onCreateFirst: () => void;
  hasTrees: boolean;
}

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
 * 涌现介绍页 —— claude-code 式克制排版：暖色、留白、近乎无装饰。
 * 单一焦点 hero + 极简三步序列，去掉旋转轨道 / 浮动粒子 / 玻璃 bento。
 */
export function EmergenceIntroPage({ onStart, onCreateFirst, hasTrees }: Props) {
  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex min-h-full max-w-[760px] flex-col justify-center px-6 py-16">
        {/* 眉标 */}
        <div
          className="mb-5 inline-flex items-center gap-2 self-start text-[11px] font-mono uppercase tracking-[0.18em]"
          style={{ color: 'var(--text-muted)' }}
        >
          <TreePine size={12} />
          AI 涌现探索器
        </div>

        {/* 主标题 */}
        <h1
          className="font-semibold tracking-tight"
          style={{
            fontSize: 'clamp(30px, 4.4vw, 46px)',
            lineHeight: 1.12,
            color: 'var(--text-primary)',
          }}
        >
          从一颗种子，<br />长出整棵可能性之树
        </h1>

        {/* 副文 */}
        <p
          className="mt-5 max-w-[560px] text-[14px] leading-[1.7]"
          style={{ color: 'var(--text-muted)' }}
        >
          上传一段文档作为锚点，AI 沿着「系统内 → 跨系统 → 幻想未来」三个维度持续生长，
          把模糊的方向变成一份具体的功能列表。
        </p>

        {/* CTA */}
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

        {/* 分隔 */}
        <div
          className="my-12 h-px w-full"
          style={{ background: 'rgba(255,255,255,0.07)' }}
        />

        {/* 三步序列 —— 纯排版，无卡片无图标堆叠 */}
        <div className="grid gap-x-8 gap-y-7 sm:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="flex flex-col">
              <span
                className="text-[12px] font-mono tracking-widest"
                style={{ color: 'var(--text-muted)', opacity: 0.6 }}
              >
                {s.n}
              </span>
              <span
                className="mt-2 text-[14px] font-semibold"
                style={{ color: 'var(--text-primary)' }}
              >
                {s.title}
              </span>
              <span
                className="mt-1.5 text-[12px] leading-[1.6]"
                style={{ color: 'var(--text-muted)' }}
              >
                {s.desc}
              </span>
            </div>
          ))}
        </div>

        {/* 三维度一行说明 */}
        <div
          className="mt-12 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px]"
          style={{ color: 'var(--text-muted)' }}
        >
          {DIMENSIONS.map((d, i) => (
            <span key={d.label} className="inline-flex items-center gap-2">
              {i > 0 && <span style={{ opacity: 0.35 }}>→</span>}
              <span style={{ color: 'var(--text-primary)' }}>{d.label}</span>
              <span style={{ opacity: 0.7 }}>{d.desc}</span>
            </span>
          ))}
        </div>

        {/* 手势 + 备注 */}
        <p
          className="mt-12 text-[11px] leading-[1.7]"
          style={{ color: 'var(--text-muted)', opacity: 0.65 }}
        >
          画布手势：两指拖动平移 · 双指捏合或 ⌘/Ctrl+滚轮缩放 · Space+拖动临时平移。
          随时可通过顶栏「关于涌现」按钮再次查看本页。
        </p>
      </div>
    </div>
  );
}
