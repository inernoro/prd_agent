import {
  Palette,
  PenTool,
  Bug,
  Video,
  FileBarChart,
  Swords,
  Workflow,
  Zap,
  ClipboardCheck,
  AudioLines,
  Code2,
  Languages,
  FileSearch,
  BarChart3,
  ArrowUpRight,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Reveal } from '../components/Reveal';
import { SectionHeader } from '../components/SectionHeader';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * AgentGrid — 幕 6 · 15 个 Agent 总览
 *
 * Visual meta（icon / accent / route / kind）硬编码在本文件，
 * 因为这些跨语言共享；只有 name / description 走 i18n 字典。
 */

interface AgentVisual {
  Icon: LucideIcon;
  accent: string;
  route?: string;
  kind: 'custom' | 'dialog';
}

// 注：PRD 解读智能体 Web 端已下线，落地页不再展示该卡片
const VISUAL_META: Record<string, AgentVisual> = {
  visual: { Icon: Palette, accent: '#a855f7', route: '/visual-agent', kind: 'custom' },
  literary: { Icon: PenTool, accent: '#fb923c', route: '/literary-agent', kind: 'custom' },
  video: { Icon: Video, accent: '#f43f5e', route: '/video-agent', kind: 'custom' },
  defect: { Icon: Bug, accent: '#10b981', route: '/defect-agent', kind: 'custom' },
  report: { Icon: FileBarChart, accent: '#06b6d4', route: '/report-agent', kind: 'custom' },
  arena: { Icon: Swords, accent: '#eab308', route: '/arena', kind: 'custom' },
  workflow: { Icon: Workflow, accent: '#22c55e', route: '/workflow-agent', kind: 'custom' },
  shortcuts: { Icon: Zap, accent: '#f59e0b', route: '/shortcuts-agent', kind: 'custom' },
  review: { Icon: ClipboardCheck, accent: '#ec4899', route: '/review-agent', kind: 'custom' },
  transcript: { Icon: AudioLines, accent: '#8b5cf6', route: '/transcript-agent', kind: 'custom' },
  'code-review': { Icon: Code2, accent: '#64748b', kind: 'dialog' },
  translator: { Icon: Languages, accent: '#0ea5e9', kind: 'dialog' },
  summarizer: { Icon: FileSearch, accent: '#14b8a6', kind: 'dialog' },
  'data-analyst': { Icon: BarChart3, accent: '#d946ef', kind: 'dialog' },
};

export function AgentGrid() {
  const { t } = useLanguage();

  return (
    <section
      className="relative py-28 md:py-36 px-6"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      {/* Section header */}
      <div className="max-w-6xl mx-auto mb-20 md:mb-24">
        <SectionHeader
          Icon={Users}
          eyebrow={t.agents.eyebrow}
          accent="#22d3ee"
          title={splitLine(t.agents.title)}
          subtitle={t.agents.subtitle}
        />
      </div>

      {/* Grid */}
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {t.agents.items.map((agent, i) => {
            const visual = VISUAL_META[agent.id];
            if (!visual) return null;
            return (
              <Reveal key={agent.id} delay={(i % 4) * 60} offset={20}>
                <AgentCard
                  name={agent.name}
                  description={agent.description}
                  visual={visual}
                  dedicatedLabel={t.agents.dedicated}
                  assistantLabel={t.agents.assistant}
                />
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function splitLine(text: string) {
  const parts = text.split('\n');
  if (parts.length === 1) return text;
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && <br className="sm:hidden" />}
          {i < parts.length - 1 && <span className="hidden sm:inline">{' '}</span>}
        </span>
      ))}
    </>
  );
}

function AgentCard({
  name,
  description,
  visual,
  dedicatedLabel,
  assistantLabel,
}: {
  name: string;
  description: string;
  visual: AgentVisual;
  dedicatedLabel: string;
  assistantLabel: string;
}) {
  const { Icon, accent, route, kind } = visual;
  const isCustom = kind === 'custom';

  return (
    <a
      href={route ?? '#'}
      className="group relative block p-5 rounded-2xl transition-all duration-300"
      style={{
        background:
          'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)',
        border: '1px solid rgba(255,255,255,0.08)',
        ['--accent' as string]: accent,
      } as React.CSSProperties}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = `${accent}66`;
        e.currentTarget.style.boxShadow = `0 20px 40px -15px ${accent}40, inset 0 0 0 1px ${accent}22`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      {/* Header: icon + LV badge + arrow */}
      <div className="flex items-start justify-between mb-4">
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-300"
          style={{
            background: `linear-gradient(135deg, ${accent}22 0%, ${accent}08 100%)`,
            border: `1px solid ${accent}33`,
            boxShadow: `0 0 24px -6px ${accent}55`,
          }}
        >
          <Icon className="w-[18px] h-[18px]" style={{ color: accent }} />
        </div>
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] px-1.5 py-0.5 rounded"
            style={{
              background: `${accent}15`,
              border: `1px solid ${accent}33`,
              color: accent,
              fontFamily: 'var(--font-terminal)',
              letterSpacing: '0.08em',
              textShadow: `0 0 6px ${accent}99`,
            }}
          >
            LV.{isCustom ? '99' : '42'}
          </span>
          <ArrowUpRight
            className="w-4 h-4 text-white/30 group-hover:text-white/70 transition-all duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
          />
        </div>
      </div>

      {/* Name */}
      <div
        className="text-[15px] font-medium text-white mb-1.5"
        style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em' }}
      >
        {name}
      </div>

      {/* Description */}
      <div
        className="text-[12px] text-white/52 leading-[1.65]"
        style={{ fontFamily: 'var(--font-body)' }}
      >
        {description}
      </div>

      {/* Kind badge */}
      <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between">
        <span
          className="text-[9.5px] uppercase"
          style={{
            color: isCustom ? accent : 'rgba(255, 255, 255, 0.35)',
            fontFamily: 'var(--font-display)',
            letterSpacing: '0.18em',
          }}
        >
          {isCustom ? dedicatedLabel : assistantLabel}
        </span>
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{
            background: accent,
            opacity: 0.8,
            boxShadow: `0 0 6px ${accent}`,
          }}
        />
      </div>
    </a>
  );
}
