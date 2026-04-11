import {
  Workflow,
  Play,
  Clock,
  FileText,
  Palette,
  PenTool,
  Send,
  ArrowRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Reveal } from '../components/Reveal';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * WorkflowCanvas — Linear 图 3/4 风格一屏幕布局
 *
 * 结构（完全对标 linear.app 的 "Move work forward / Understand progress at scale"）:
 *   · Top row  (35% of block): eyebrow + 大标题 (左) + description + chapter marker (右)
 *   · Bottom row (60% of block): 全宽 canvas mockup，内含 5 节点 workflow pipeline
 *
 * 目标：整个 section 在 1 个视口（~100vh）里讲完"工作流编排"一个概念，
 * 践行"一屏一个视觉语言"原则。
 */

const NODE_VISUALS: Array<{ Icon: LucideIcon; accent: string }> = [
  { Icon: Clock, accent: '#94a3b8' },      // 触发器
  { Icon: FileText, accent: '#3b82f6' },   // PRD
  { Icon: Palette, accent: '#a855f7' },    // 视觉
  { Icon: PenTool, accent: '#fb923c' },    // 文学
  { Icon: Send, accent: '#10b981' },       // 发布
];

export function WorkflowCanvas() {
  const { t } = useLanguage();

  return (
    <section
      className="relative py-24 md:py-32 px-6"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="max-w-[1200px] mx-auto">
        {/* ── Top row · eyebrow + 大标题 左｜描述 + chapter marker 右 ── */}
        <div className="grid md:grid-cols-[1.15fr_1fr] gap-10 md:gap-16 mb-12 md:mb-16">
          {/* LEFT */}
          <div>
            <Reveal offset={14}>
              <div
                className="inline-flex items-center gap-2 mb-5"
                style={{ fontFamily: 'var(--font-mono)' }}
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full"
                  style={{ background: '#10b981', boxShadow: '0 0 8px #10b981' }}
                />
                <span
                  className="text-[12px] uppercase"
                  style={{
                    color: '#10b981',
                    letterSpacing: '0.18em',
                    textShadow: '0 0 10px rgba(16, 185, 129, 0.55)',
                  }}
                >
                  {t.workflow.eyebrow}
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
                  textShadow: '0 0 32px rgba(16, 185, 129, 0.15)',
                  maxWidth: '14ch',
                }}
              >
                {t.workflow.title}
              </h3>
            </Reveal>
          </div>

          {/* RIGHT */}
          <div className="md:pt-5">
            <Reveal delay={240} offset={16}>
              <p className="text-white/62 text-[14.5px] leading-[1.75] mb-6 max-w-lg">
                {t.workflow.description}
              </p>
            </Reveal>

            <Reveal delay={360} offset={12}>
              <div
                className="text-[11px] text-white/35 mt-4"
                style={{
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.18em',
                }}
              >
                {t.workflow.chapterMarker}
              </div>
            </Reveal>
          </div>
        </div>

        {/* ── Bottom row · Workflow canvas mockup ── */}
        <Reveal delay={180} offset={36}>
          <WorkflowMockup />
        </Reveal>
      </div>
    </section>
  );
}

function WorkflowMockup() {
  const { t } = useLanguage();
  const accent = '#10b981';

  return (
    <div
      className="relative rounded-2xl overflow-hidden"
      style={{
        background: 'rgba(10, 14, 22, 0.65)',
        border: '1px solid rgba(255, 255, 255, 0.07)',
        boxShadow:
          '0 40px 100px -30px rgba(16, 185, 129, 0.22), 0 0 0 1px rgba(255, 255, 255, 0.02) inset',
      }}
    >
      {/* 顶边 accent scanline */}
      <div
        className="absolute top-0 left-0 right-0 h-px pointer-events-none"
        style={{
          background:
            'linear-gradient(90deg, transparent 0%, rgba(16, 185, 129, 0.8) 50%, transparent 100%)',
        }}
      />

      {/* header: filename + Run button */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
        <div
          className="flex items-center gap-2 text-[12px] text-white/70"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          <Workflow className="w-3.5 h-3.5 text-emerald-400" />
          <span>{t.workflow.canvasTitle}</span>
        </div>
        <button
          className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] text-emerald-300"
          style={{
            background: 'rgba(16, 185, 129, 0.12)',
            border: '1px solid rgba(16, 185, 129, 0.35)',
            fontFamily: 'var(--font-display)',
          }}
        >
          <Play className="w-3 h-3 fill-current" />
          {t.workflow.runLabel}
        </button>
      </div>

      {/* canvas body */}
      <div className="relative px-6 md:px-10 py-14 md:py-16 min-h-[340px]">
        {/* grid background (subtle) */}
        <div
          className="absolute inset-0 opacity-50 pointer-events-none"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)
            `,
            backgroundSize: '28px 28px',
            maskImage:
              'radial-gradient(ellipse 80% 70% at 50% 50%, black 0%, transparent 100%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 80% 70% at 50% 50%, black 0%, transparent 100%)',
          }}
        />

        {/* nodes chain */}
        <div className="relative z-10 flex items-center justify-between gap-2 md:gap-3">
          {t.workflow.nodes.map((node, i) => {
            const visual = NODE_VISUALS[i];
            const state: NodeState =
              i < 2 ? 'done' : i === 2 ? 'running' : 'pending';
            return (
              <div key={i} className="flex items-center gap-2 md:gap-3 flex-1 last:flex-none">
                <Node
                  title={node.title}
                  subtitle={node.subtitle}
                  Icon={visual.Icon}
                  accent={visual.accent}
                  state={state}
                />
                {i < t.workflow.nodes.length - 1 && (
                  <Edge
                    progress={i < 2 ? 100 : i === 2 ? 45 : 0}
                    accent={state === 'running' ? visual.accent : '#ffffff20'}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* status footer */}
        <div
          className="relative z-10 mt-10 flex flex-wrap items-center gap-x-6 gap-y-1 text-[10.5px] text-white/45"
          style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}
        >
          <span className="flex items-center gap-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: accent,
                boxShadow: `0 0 8px ${accent}`,
                animation: 'wf-pulse 1.5s ease-in-out infinite',
              }}
            />
            {t.workflow.status.running}
          </span>
          <span>{t.workflow.status.elapsed}</span>
          <span>{t.workflow.status.eta}</span>
          <span className="ml-auto text-white/25">{t.workflow.status.trace}</span>
        </div>

        <style>{`
          @keyframes wf-pulse { 0%,100% { opacity:1; } 50% { opacity:0.45; } }
          @keyframes wf-progress {
            0%, 100% { transform: translateX(-100%); }
            50% { transform: translateX(0%); }
          }
        `}</style>
      </div>
    </div>
  );
}

// ── 节点 ─────────────────────────────────────────────────

type NodeState = 'done' | 'running' | 'pending';

function Node({
  title,
  subtitle,
  Icon,
  accent,
  state,
}: {
  title: string;
  subtitle: string;
  Icon: LucideIcon;
  accent: string;
  state: NodeState;
}) {
  const isDone = state === 'done';
  const isRunning = state === 'running';
  const isPending = state === 'pending';

  return (
    <div
      className="relative flex flex-col items-center text-center shrink-0"
      style={{
        width: 'clamp(96px, 11vw, 128px)',
      }}
    >
      {/* icon box */}
      <div
        className="relative w-12 h-12 md:w-14 md:h-14 rounded-xl flex items-center justify-center"
        style={{
          background: isPending
            ? 'rgba(255, 255, 255, 0.02)'
            : `linear-gradient(135deg, ${accent}22 0%, ${accent}08 100%)`,
          border: `1px solid ${isPending ? 'rgba(255, 255, 255, 0.08)' : `${accent}44`}`,
          boxShadow: isRunning
            ? `0 0 24px -4px ${accent}, inset 0 0 20px ${accent}15`
            : isDone
              ? `0 0 12px -4px ${accent}66`
              : 'none',
        }}
      >
        <Icon
          className="w-4 h-4 md:w-5 md:h-5"
          style={{
            color: isPending ? 'rgba(255, 255, 255, 0.3)' : accent,
          }}
          strokeWidth={isPending ? 1.25 : 1.5}
        />

        {/* running pulse ring */}
        {isRunning && (
          <span
            className="absolute inset-0 rounded-xl pointer-events-none"
            style={{
              border: `1.5px solid ${accent}`,
              animation: 'wf-pulse 1.8s ease-in-out infinite',
            }}
          />
        )}

        {/* done check */}
        {isDone && (
          <div
            className="absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center"
            style={{
              background: '#10b981',
              boxShadow: '0 0 8px #10b981',
            }}
          >
            <svg
              className="w-2 h-2 text-black"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}
      </div>

      {/* title */}
      <div
        className="mt-3 text-[11.5px] md:text-[12px] font-medium"
        style={{
          color: isPending ? 'rgba(255, 255, 255, 0.4)' : 'rgba(255, 255, 255, 0.95)',
          fontFamily: 'var(--font-display)',
          letterSpacing: '-0.005em',
        }}
      >
        {title}
      </div>
      <div
        className="text-[9.5px] md:text-[10px] text-white/35 mt-0.5 truncate max-w-full"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {subtitle}
      </div>
    </div>
  );
}

// ── 连接线 ───────────────────────────────────────────────

function Edge({ progress, accent }: { progress: number; accent: string }) {
  return (
    <div className="relative flex-1 h-px" style={{ minWidth: '24px' }}>
      {/* base line */}
      <div
        className="absolute inset-0 rounded-full"
        style={{ background: 'rgba(255, 255, 255, 0.06)' }}
      />
      {/* progress fill */}
      <div
        className="absolute inset-y-0 left-0 rounded-full"
        style={{
          width: `${progress}%`,
          background: `linear-gradient(90deg, ${accent}88, ${accent})`,
          boxShadow: progress > 0 ? `0 0 8px ${accent}aa` : undefined,
          transition: 'width 0.6s ease',
        }}
      />
      {/* arrow tip */}
      {progress >= 100 && (
        <ArrowRight
          className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 w-3 h-3"
          style={{ color: accent }}
          strokeWidth={2.5}
        />
      )}
    </div>
  );
}
