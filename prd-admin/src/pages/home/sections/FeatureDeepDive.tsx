import { ArrowRight, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { Reveal } from '../components/Reveal';
import { SectionHeader } from '../components/SectionHeader';
import { useLanguage } from '../contexts/LanguageContext';
import { useInView } from '../hooks/useInView';
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

// 六段 mockup accent 配色
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
      {/* Section header */}
      <div className="max-w-[1200px] mx-auto px-6 pt-6 mb-28 md:mb-36">
        <SectionHeader
          Icon={Sparkles}
          eyebrow={t.features.eyebrow}
          accent="#cbd5e1"
          title={splitLine(t.features.title)}
          subtitle={t.features.subtitle}
        />
      </div>

      {/* 六段 · 一屏一个 · 间距收紧到"舒服" */}
      <div className="space-y-32 md:space-y-40">
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

// ── Feature block（Linear 图 2 风格：上两列 title+desc，下几乎全宽 mockup）─

function FeatureBlock({
  feature,
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
  const accent = MOCKUPS[id as keyof typeof MOCKUPS]?.accent ?? '#cbd5e1';

  return (
    <div className="w-full max-w-[1200px] mx-auto px-6 md:px-8">
      {/* ── Top row: eyebrow + title 左 · description + bullets + cta 右 ── */}
      <div className="grid md:grid-cols-[1.15fr_1fr] gap-10 md:gap-16 mb-12 md:mb-16">
        {/* LEFT · eyebrow + 大标题 */}
        <div>
          <Reveal offset={14}>
            <div
              className="flex items-center gap-3 mb-5"
              style={{ fontFamily: 'var(--font-terminal)' }}
            >
              <span
                className="text-[11px] uppercase text-white/35"
                style={{ letterSpacing: '0.22em' }}
              >
                {chapterLabel}
              </span>
              <span
                className="text-[11px] text-white/35"
                style={{ letterSpacing: '0.12em' }}
              >
                {String(chapterIndex).padStart(2, '0')} / {String(chapterTotal).padStart(2, '0')}
              </span>
              <span className="inline-flex items-center gap-2">
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
              </span>
            </div>
          </Reveal>

          <Reveal delay={120} offset={22}>
            <h3
              className="text-white font-medium"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(1.875rem, 3.6vw, 3.25rem)',
                lineHeight: 1.04,
                letterSpacing: '-0.03em',
                textShadow: `0 0 32px ${accent}1a`,
              }}
            >
              {title}
            </h3>
          </Reveal>
        </div>

        {/* RIGHT · 描述 + bullets + CTA */}
        <div className="md:pt-5">
          <Reveal delay={240} offset={16}>
            <p className="text-white/62 text-[14.5px] leading-[1.75] mb-6 max-w-lg">
              {description}
            </p>
          </Reveal>

          <ul className="space-y-2.5 mb-7">
            {bullets.map((b, bi) => (
              <Reveal key={bi} delay={360 + bi * 70} offset={12}>
                <li className="flex items-start gap-3 text-[13.5px] text-white/78">
                  <span
                    className="mt-[9px] w-1 h-1 rounded-full shrink-0"
                    style={{ background: accent, boxShadow: `0 0 8px ${accent}` }}
                  />
                  <span>{b}</span>
                </li>
              </Reveal>
            ))}
          </ul>

          <Reveal delay={360 + bullets.length * 70 + 60} offset={10}>
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
      </div>

      {/* ── Bottom row: mockup · 简洁 card frame，无 grid 背景无 margin labels ── */}
      <Reveal delay={180} offset={36}>
        <div
          className="relative rounded-2xl overflow-hidden"
          style={{
            background: 'rgba(10, 14, 22, 0.55)',
            border: '1px solid rgba(255, 255, 255, 0.07)',
            boxShadow: `0 40px 100px -30px ${accent}22, 0 0 0 1px rgba(255, 255, 255, 0.02) inset`,
          }}
        >
          <div
            className="absolute top-0 left-0 right-0 h-px pointer-events-none"
            style={{
              background: `linear-gradient(90deg, transparent 0%, ${accent}88 50%, transparent 100%)`,
            }}
          />
          <div className="relative px-6 md:px-10 py-10 md:py-12">
            <div className="mx-auto max-w-[900px]">{renderMockup(id)}</div>
          </div>
        </div>
      </Reveal>
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
  const { t } = useLanguage();
  // 独立的 useInView，让内部 4 格走自己的 stagger 时序，叠加在外层 Reveal 之上
  const [gridRef, inView] = useInView<HTMLDivElement>();
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
          {t.mockups.visual.header}
        </div>
        <div className="flex gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-white/25" />
          <span className="w-1.5 h-1.5 rounded-full bg-white/25" />
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: accent }} />
        </div>
      </div>
      <div ref={gridRef} className="grid grid-cols-2 gap-2">
        {grads.map((g, i) => {
          const isDone = i < 2;
          const isGenerating = i >= 2;
          const stagger = i * 120;
          return (
            <div
              key={i}
              className="relative aspect-[4/3] rounded-lg overflow-hidden border border-white/[0.06]"
              style={{
                background: g,
                opacity: inView ? 1 : 0,
                transform: inView
                  ? 'scale(1) translateY(0)'
                  : 'scale(0.94) translateY(14px)',
                transition: `opacity 520ms cubic-bezier(0.2, 0.9, 0.2, 1) ${stagger}ms, transform 640ms cubic-bezier(0.2, 0.9, 0.2, 1) ${stagger}ms`,
                willChange: 'opacity, transform',
              }}
            >
              {/* 底部压暗 */}
              <div
                className="absolute inset-x-0 bottom-0 h-1/2 pointer-events-none"
                style={{ background: 'linear-gradient(180deg, transparent, rgba(0,0,0,0.5))' }}
              />

              {/* 生成中两格：shimmer 横扫（延迟在自身入场结束后开始） */}
              {isGenerating && (
                <div
                  className="absolute inset-0 pointer-events-none overflow-hidden"
                >
                  <div
                    className="absolute inset-y-0 w-1/2"
                    style={{
                      background:
                        'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.09) 50%, transparent 100%)',
                      animation: inView
                        ? `visual-mock-shimmer 2.4s ease-in-out ${stagger + 620}ms infinite`
                        : 'none',
                      willChange: 'transform',
                    }}
                  />
                </div>
              )}

              {/* 已完成两格：绿色对勾延迟 pop-in（弹性 overshoot） */}
              {isDone && (
                <div
                  className="absolute top-1.5 right-1.5 w-3 h-3 rounded-full bg-emerald-400/90 flex items-center justify-center"
                  style={{
                    opacity: inView ? 1 : 0,
                    transform: inView ? 'scale(1)' : 'scale(0)',
                    transition: `opacity 220ms ease-out ${stagger + 400}ms, transform 380ms cubic-bezier(0.34, 1.56, 0.64, 1) ${stagger + 400}ms`,
                    willChange: 'opacity, transform',
                  }}
                >
                  <svg className="w-1.5 h-1.5 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={4}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex items-center gap-2 text-[10px] text-white/45">
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: accent, animation: 'mockup-pulse 1.5s ease-in-out infinite' }}
        />
        <span>{t.mockups.visual.status}</span>
      </div>
      <style>{`
        @keyframes mockup-pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
        @keyframes visual-mock-shimmer {
          0%   { transform: translateX(-120%); }
          55%  { transform: translateX(260%); }
          100% { transform: translateX(260%); }
        }
        @media (prefers-reduced-motion: reduce) {
          [style*="visual-mock-shimmer"] { animation: none !important; }
        }
      `}</style>
    </MockupFrame>
  );
}

function LiteraryMockup() {
  const accent = '#fb923c';
  const { t } = useLanguage();
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          {t.mockups.literary.header}
        </div>
        <div className="text-[10px] text-white/35">{t.mockups.literary.progress}</div>
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
          <span>{t.mockups.literary.added}</span>
          <span style={{ color: accent }}>{t.mockups.literary.deleted}</span>
        </div>
        <span>{t.mockups.literary.diffView}</span>
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
  const { t } = useLanguage();
  const sections = t.mockups.prd.sections;
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          {t.mockups.prd.header}
        </div>
        <div
          className="px-2 py-0.5 rounded text-[9px] uppercase"
          style={{ background: `${accent}22`, color: accent, letterSpacing: '0.1em' }}
        >
          3 gaps
        </div>
      </div>
      <div className="space-y-3">
        <PrdSection title={sections[0].title} complete />
        <PrdSection title={sections[1].title} gap accent={accent} note={sections[1].note} />
        <PrdSection title={sections[2].title} complete />
        <PrdSection title={sections[3].title} gap accent={accent} note={sections[3].note} />
        <PrdSection title={sections[4].title} gap accent={accent} note={sections[4].note} />
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
  const { t } = useLanguage();
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          {t.mockups.video.header}
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-white/45">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: accent, animation: 'mockup-pulse 1.2s ease-in-out infinite' }}
          />
          <span>{t.mockups.video.status}</span>
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
  const { t } = useLanguage();
  const colors = ['#ef4444', '#f97316', '#eab308'];
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          {t.mockups.defect.header}
        </div>
        <div
          className="px-2 py-0.5 rounded text-[9px] uppercase"
          style={{ background: `${accent}22`, color: accent, letterSpacing: '0.1em' }}
        >
          AI triaged
        </div>
      </div>
      <div className="space-y-2.5">
        {t.mockups.defect.items.map((d, i) => (
          <div
            key={i}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/5"
          >
            <div
              className="px-2 py-0.5 rounded text-[9px] font-semibold shrink-0"
              style={{ background: `${colors[i]}22`, color: colors[i], fontFamily: 'var(--font-display)' }}
            >
              {d.sev}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] text-white/85 truncate">{d.title}</div>
            </div>
            <div className="shrink-0 text-[10px] text-white/35">{t.mockups.defect.assigned}</div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between text-[10px] text-white/45">
        <div>{t.mockups.defect.newThisWeek}</div>
        <div>{t.mockups.defect.fixed}</div>
        <div style={{ color: accent }}>{t.mockups.defect.fixRate}</div>
      </div>
    </MockupFrame>
  );
}

function ReportMockup() {
  const accent = '#06b6d4';
  const { t } = useLanguage();
  const barValues = [
    { plan: 100, actual: 95 },
    { plan: 80, actual: 88 },
    { plan: 90, actual: 72 },
    { plan: 85, actual: 90 },
    { plan: 70, actual: 65 },
  ];
  return (
    <MockupFrame accent={accent}>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[11px] text-white/60" style={{ fontFamily: 'var(--font-display)' }}>
          {t.mockups.report.header}
        </div>
        <div className="flex items-center gap-3 text-[9px] text-white/40">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm bg-white/25" />
            <span>{t.mockups.report.plan}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm" style={{ background: accent }} />
            <span>{t.mockups.report.actual}</span>
          </div>
        </div>
      </div>
      <div className="flex items-end gap-3 h-32 mb-2">
        {barValues.map((b, i) => (
          <div key={i} className="flex-1 flex items-end gap-1 h-full">
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
        {t.mockups.report.days.map((day, i) => (
          <span key={i}>{day}</span>
        ))}
      </div>
    </MockupFrame>
  );
}
