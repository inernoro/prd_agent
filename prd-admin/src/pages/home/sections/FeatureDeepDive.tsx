import { cn } from '@/lib/cn';
import { ArrowRight, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { Reveal } from '../components/Reveal';
import { SectionHeader } from '../components/SectionHeader';
import { useLanguage } from '../contexts/LanguageContext';
import type { FeatureItem } from '../i18n/landing';

/**
 * FeatureDeepDive — 六大 Agent 深度展示
 *
 * 徐徐前进的"段落感"实现：
 *   1. 每个 feature 块之间 space-y-44 md:space-y-56（比之前再拉大 25%）
 *   2. 每个 block 内部分 7 级 stagger reveal：
 *        chapter 标号 (0ms) → eyebrow (120ms) → title (240ms) →
 *        description (360ms) → bullets (480ms) → learn-more (600ms) →
 *        mockup (180ms, 从对侧 translate-x)
 *      这样用户看到的是"小小的 chapter 编号先出 → 然后 eyebrow → 然后大标题
 *      → 文字 → 列表 → 按钮"的渐次拼凑过程，而不是一次性全显示
 *   3. chapter 编号 "01 / 06"（VT323 mono）作为每段的开篇符号
 */

// 六段 mockup 从原来的函数名映射（内部几何 mockup 不走 i18n，因为是"示意图"）
const MOCKUPS = {
  visual: { accent: '#a855f7' },
  literary: { accent: '#fb923c' },
  prd: { accent: '#3b82f6' },
  video: { accent: '#f43f5e' },
  defect: { accent: '#10b981' },
  report: { accent: '#06b6d4' },
} as const;

export function FeatureDeepDive() {
  const { t } = useLanguage();

  return (
    <section
      className="relative py-28 md:py-36"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      {/* Section header —— 上下留白翻倍 */}
      <div className="max-w-6xl mx-auto px-6 pt-10 mb-36 md:mb-48">
        <SectionHeader
          Icon={Sparkles}
          eyebrow={t.features.eyebrow}
          accent="#a855f7"
          title={splitLine(t.features.title)}
          subtitle={t.features.subtitle}
        />
      </div>

      {/* 六段左右交替，块间距拉大 */}
      <div className="space-y-44 md:space-y-56">
        {t.features.items.map((feature, i) => (
          <FeatureBlock
            key={feature.id}
            feature={feature}
            reverse={i % 2 === 1}
            chapterIndex={i + 1}
            chapterTotal={t.features.items.length}
            chapterLabel={t.features.chapterLabel}
            learnMoreLabel={t.features.learnMore}
          />
        ))}
      </div>
    </section>
  );
}

function splitLine(text: string): ReactNode {
  const parts = text.split('\n');
  if (parts.length === 1) return text;
  return parts.map((p, i) => (
    <span key={i}>
      {p}
      {i < parts.length - 1 && <br />}
    </span>
  ));
}

// ── Feature block（内部 stagger reveal） ────────────────────────────────

function FeatureBlock({
  feature,
  reverse,
  chapterIndex,
  chapterTotal,
  chapterLabel,
  learnMoreLabel,
}: {
  feature: FeatureItem;
  reverse: boolean;
  chapterIndex: number;
  chapterTotal: number;
  chapterLabel: string;
  learnMoreLabel: string;
}) {
  const { id, eyebrow, title, description, bullets } = feature;
  const accent = MOCKUPS[id as keyof typeof MOCKUPS]?.accent ?? '#a855f7';

  return (
    <div className="max-w-6xl mx-auto px-6">
      <div
        className={cn(
          'grid md:grid-cols-2 gap-12 md:gap-20 items-center',
          reverse && 'md:[&>*:first-child]:order-2',
        )}
      >
        {/* Copy side —— 7 级分步 reveal */}
        <div>
          {/* Chapter marker —— 每段最先出现，提示"新的一段开始了" */}
          <Reveal offset={18}>
            <div
              className="flex items-center gap-3 mb-6"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              <span
                className="text-[11px] uppercase"
                style={{
                  color: `${accent}cc`,
                  letterSpacing: '0.22em',
                  textShadow: `0 0 8px ${accent}77`,
                }}
              >
                {chapterLabel}
              </span>
              <span
                className="text-[11px]"
                style={{
                  color: `${accent}cc`,
                  letterSpacing: '0.12em',
                }}
              >
                {String(chapterIndex).padStart(2, '0')} / {String(chapterTotal).padStart(2, '0')}
              </span>
              <span
                className="flex-1 h-px"
                style={{
                  background: `linear-gradient(90deg, ${accent}66 0%, transparent 100%)`,
                }}
              />
            </div>
          </Reveal>

          {/* Eyebrow */}
          <Reveal delay={120} offset={14}>
            <div
              className="inline-flex items-center gap-2 mb-6"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
              />
              <span
                className="text-[12px] uppercase"
                style={{
                  color: accent,
                  letterSpacing: '0.18em',
                  textShadow: `0 0 10px ${accent}88`,
                }}
              >
                {eyebrow}
              </span>
            </div>
          </Reveal>

          {/* Title */}
          <Reveal delay={240} offset={24}>
            <h3
              className="text-white font-medium mb-7"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(1.75rem, 3.6vw, 3.25rem)',
                lineHeight: 1.08,
                letterSpacing: '-0.025em',
                textShadow: `0 0 32px ${accent}26`,
              }}
            >
              {title}
            </h3>
          </Reveal>

          {/* Description */}
          <Reveal delay={360} offset={18}>
            <p className="text-white/62 text-[15px] leading-[1.75] mb-8 max-w-lg">
              {description}
            </p>
          </Reveal>

          {/* Bullets —— 每条再 stagger 60ms */}
          <ul className="space-y-3 mb-9">
            {bullets.map((b, bi) => (
              <Reveal key={bi} delay={480 + bi * 60} offset={14}>
                <li className="flex items-start gap-3 text-[14px] text-white/78">
                  <span
                    className="mt-[9px] w-1 h-1 rounded-full shrink-0"
                    style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
                  />
                  <span>{b}</span>
                </li>
              </Reveal>
            ))}
          </ul>

          {/* Learn more */}
          <Reveal delay={480 + bullets.length * 60 + 60} offset={12}>
            <a
              href={`/${id}-agent`}
              className="inline-flex items-center gap-2 text-[13px] font-medium text-white/85 hover:text-white transition-colors group"
              style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.01em' }}
            >
              {learnMoreLabel}
              <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
            </a>
          </Reveal>
        </div>

        {/* Mockup side —— 从对侧 translate 出来 */}
        <Reveal delay={180} offset={32}>
          <div className="relative">{renderMockup(id)}</div>
        </Reveal>
      </div>
    </div>
  );
}

// ── Mockups（六个抽象几何示意，不走 i18n） ────────────────────────────────

function renderMockup(id: string): ReactNode {
  switch (id) {
    case 'visual':
      return <VisualMockup />;
    case 'literary':
      return <LiteraryMockup />;
    case 'prd':
      return <PrdMockup />;
    case 'video':
      return <VideoMockup />;
    case 'defect':
      return <DefectMockup />;
    case 'report':
      return <ReportMockup />;
    default:
      return <VisualMockup />;
  }
}

function MockupFrame({
  children,
  accent,
}: {
  children: ReactNode;
  accent: string;
}) {
  return (
    <div
      className="relative rounded-2xl overflow-hidden border border-white/10 bg-[#0A0D14] p-5 md:p-6"
      style={{
        boxShadow: `0 40px 100px -30px ${accent}55, 0 20px 60px -20px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.06)`,
      }}
    >
      <div
        className="absolute top-0 left-0 right-0 h-px"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${accent}aa 50%, transparent 100%)`,
        }}
      />
      {children}
    </div>
  );
}

function VisualMockup() {
  const accent = '#a855f7';
  const grads = [
    'radial-gradient(circle at 30% 70%, #00d4ff 0%, transparent 50%), linear-gradient(135deg, #0a0a1e 0%, #2a0a3e 100%)',
    'radial-gradient(circle at 70% 30%, #f43f5e 0%, transparent 50%), linear-gradient(135deg, #1a0515 0%, #0a1a25 100%)',
    'radial-gradient(circle at 50% 50%, #a855f7 0%, transparent 50%), linear-gradient(135deg, #050a15 0%, #200a30 100%)',
    'radial-gradient(circle at 40% 60%, #06b6d4 0%, transparent 50%), linear-gradient(135deg, #0a0515 0%, #0a1a30 100%)',
  ];
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          visual-agent · 4 张候选
        </div>
        <div className="flex gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-white/25" />
          <span className="w-1.5 h-1.5 rounded-full bg-white/25" />
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: accent }} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {grads.map((g, i) => (
          <div
            key={i}
            className="relative aspect-[4/3] rounded-lg overflow-hidden border border-white/[0.06]"
            style={{ background: g }}
          >
            <div
              className="absolute inset-x-0 bottom-0 h-1/2"
              style={{ background: 'linear-gradient(180deg, transparent, rgba(0,0,0,0.5))' }}
            />
            {i < 2 && (
              <div className="absolute top-1.5 right-1.5 w-3 h-3 rounded-full bg-emerald-400/90 flex items-center justify-center">
                <svg className="w-1.5 h-1.5 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2 text-[10px] text-white/45">
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: accent, animation: 'mockup-pulse 1.5s ease-in-out infinite' }}
        />
        <span>生成中 · 2 / 4 已完成</span>
      </div>
      <style>{`
        @keyframes mockup-pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
      `}</style>
    </MockupFrame>
  );
}

function LiteraryMockup() {
  const accent = '#fb923c';
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          literary-agent · 润色中
        </div>
        <div className="text-[10px] text-white/35">段 3 / 7</div>
      </div>
      <div className="space-y-2">
        <TextLine width="100%" />
        <TextLine width="92%" />
        <TextLine width="78%" strike />
        <TextLine width="88%" highlight={accent} />
        <TextLine width="100%" />
        <TextLine width="96%" highlight={accent} />
        <TextLine width="54%" cursor accent={accent} />
      </div>
      <div className="mt-5 pt-4 border-t border-white/5 flex items-center justify-between text-[10px] text-white/45">
        <div className="flex items-center gap-3">
          <span>+ 12 字</span>
          <span style={{ color: accent }}>删除 3 字</span>
        </div>
        <span>差异视图</span>
      </div>
    </MockupFrame>
  );
}

function TextLine({
  width,
  strike,
  highlight,
  cursor,
  accent,
}: {
  width: string;
  strike?: boolean;
  highlight?: string;
  cursor?: boolean;
  accent?: string;
}) {
  return (
    <div className="relative h-2.5 flex items-center">
      <div
        className="h-[3px] rounded-sm"
        style={{
          width,
          background: strike
            ? 'rgba(255, 255, 255, 0.15)'
            : highlight
              ? `linear-gradient(90deg, rgba(255,255,255,0.5), ${highlight}66)`
              : 'rgba(255, 255, 255, 0.3)',
          textDecoration: strike ? 'line-through' : undefined,
        }}
      />
      {strike && (
        <div
          className="absolute left-0 top-1/2 h-px"
          style={{ width, background: 'rgba(251, 146, 60, 0.5)' }}
        />
      )}
      {cursor && (
        <span
          className="ml-0.5 w-0.5 h-3 rounded-sm"
          style={{
            background: accent ?? '#fff',
            animation: 'mockup-blink 1s steps(1) infinite',
          }}
        />
      )}
      <style>{`
        @keyframes mockup-blink { 50% { opacity: 0; } }
      `}</style>
    </div>
  );
}

function PrdMockup() {
  const accent = '#3b82f6';
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          prd-agent · v3.0 需求分析
        </div>
        <div
          className="px-2 py-0.5 rounded text-[9px] uppercase"
          style={{ background: `${accent}22`, color: accent, letterSpacing: '0.1em' }}
        >
          3 gaps
        </div>
      </div>
      <div className="space-y-3">
        <PrdSection title="§ 用户故事" complete />
        <PrdSection title="§ 核心流程" gap accent={accent} note="缺少异常分支" />
        <PrdSection title="§ 数据模型" complete />
        <PrdSection title="§ 权限矩阵" gap accent={accent} note="未定义角色边界" />
        <PrdSection title="§ 测试用例" gap accent={accent} note="缺少失败场景" />
      </div>
    </MockupFrame>
  );
}

function PrdSection({
  title,
  complete,
  gap,
  accent,
  note,
}: {
  title: string;
  complete?: boolean;
  gap?: boolean;
  accent?: string;
  note?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div
        className="mt-[7px] w-1.5 h-1.5 rounded-full shrink-0"
        style={{
          background: complete ? 'rgba(16, 185, 129, 0.8)' : accent,
          boxShadow: gap && accent ? `0 0 8px ${accent}` : undefined,
        }}
      />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-white/80" style={{ fontFamily: 'var(--font-body)' }}>
          {title}
        </div>
        {note && (
          <div className="text-[10px] mt-0.5" style={{ color: accent }}>
            ⚠ {note}
          </div>
        )}
      </div>
    </div>
  );
}

function VideoMockup() {
  const accent = '#f43f5e';
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          video-agent · 6 分镜
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-white/45">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: accent, animation: 'mockup-pulse 1.2s ease-in-out infinite' }}
          />
          <span>渲染中 · 72%</span>
        </div>
      </div>
      <div className="grid grid-cols-6 gap-1.5 mb-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="aspect-[16/9] rounded-sm relative overflow-hidden"
            style={{
              background: `linear-gradient(${135 + i * 20}deg, rgba(244, 63, 94, ${0.15 + i * 0.05}), rgba(124, 58, 237, ${0.1 + i * 0.05}))`,
              border: i === 3 ? `1px solid ${accent}` : '1px solid rgba(255,255,255,0.06)',
            }}
          >
            {i === 3 && (
              <div className="absolute inset-0 flex items-center justify-center">
                <svg className="w-2 h-2 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="relative h-1 bg-white/10 rounded-full overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: '72%', background: `linear-gradient(90deg, ${accent}, #f43f5e)` }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white"
          style={{ left: '72%', transform: 'translate(-50%, -50%)', boxShadow: `0 0 10px ${accent}` }}
        />
      </div>
      <div className="mt-2 flex justify-between text-[9px] text-white/40 font-mono">
        <span>00:00</span>
        <span>01:36</span>
        <span>02:45</span>
      </div>
    </MockupFrame>
  );
}

function DefectMockup() {
  const accent = '#10b981';
  const defects = [
    { sev: 'P0', title: '对话消息在刷新后丢失', color: '#ef4444' },
    { sev: 'P1', title: '图像生成超时未释放', color: '#f97316' },
    { sev: 'P2', title: '深色模式下描边消失', color: '#eab308' },
  ];
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          defect-agent · 3 个待处理
        </div>
        <div
          className="px-2 py-0.5 rounded text-[9px] uppercase"
          style={{ background: `${accent}22`, color: accent, letterSpacing: '0.1em' }}
        >
          AI triaged
        </div>
      </div>
      <div className="space-y-2.5">
        {defects.map((d, i) => (
          <div
            key={i}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/5"
          >
            <div
              className="px-2 py-0.5 rounded text-[9px] font-semibold shrink-0"
              style={{ background: `${d.color}22`, color: d.color, fontFamily: 'var(--font-display)' }}
            >
              {d.sev}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-white/85 truncate">{d.title}</div>
            </div>
            <div className="shrink-0 text-[10px] text-white/35">已分派</div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between text-[10px] text-white/45">
        <div>本周新增 · 27</div>
        <div>已修复 · 19</div>
        <div style={{ color: accent }}>修复率 · 70%</div>
      </div>
    </MockupFrame>
  );
}

function ReportMockup() {
  const accent = '#06b6d4';
  const bars = [
    { label: '周一', plan: 100, actual: 95 },
    { label: '周二', plan: 80, actual: 88 },
    { label: '周三', plan: 90, actual: 72 },
    { label: '周四', plan: 85, actual: 90 },
    { label: '周五', plan: 70, actual: 65 },
  ];
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          report-agent · W15
        </div>
        <div className="flex items-center gap-3 text-[9px] text-white/40">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-white/25" />
            <span>计划</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm" style={{ background: accent }} />
            <span>实际</span>
          </div>
        </div>
      </div>
      <div className="flex items-end gap-3 h-32 mb-2">
        {bars.map((b, i) => (
          <div key={i} className="flex-1 flex items-end gap-1">
            <div
              className="flex-1 rounded-t"
              style={{ height: `${b.plan}%`, background: 'rgba(255,255,255,0.1)' }}
            />
            <div
              className="flex-1 rounded-t"
              style={{
                height: `${b.actual}%`,
                background: `linear-gradient(180deg, ${accent}, ${accent}80)`,
                boxShadow: `0 0 8px ${accent}66`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-white/40">
        {bars.map((b, i) => (
          <span key={i}>{b.label}</span>
        ))}
      </div>
    </MockupFrame>
  );
}
