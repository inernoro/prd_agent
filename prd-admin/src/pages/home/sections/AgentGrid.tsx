import {
  FileText,
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

/**
 * AgentGrid — 幕 6 · 15 个 Agent 总览（真实数据源）
 *
 * 数据和品牌调性：
 * - 15 条数据对应 toolboxStore.BUILTIN_TOOLS（单一真理）
 * - 每个 Agent 有自己的 accent color，hover 时描边 + 光晕变成该色
 * - 不使用浮动卡 / 不使用克莱风 / 不使用渐变背景 —— 纯深色玻璃板
 *
 * 替代掉原来那个又土又空的 LibrarySection（"殿堂将迎第一卷藏书"那种）
 */

interface Agent {
  id: string;
  name: string;
  description: string;
  Icon: LucideIcon;
  accent: string;
  route?: string;
  kind: 'custom' | 'dialog';
}

// 保持和 toolboxStore.BUILTIN_TOOLS 一致的顺序与 ID
const AGENTS: Agent[] = [
  { id: 'visual', name: '视觉设计师', description: '文生图 · 图生图 · 多图组合 · 局部重绘', Icon: Palette, accent: '#a855f7', route: '/visual-agent', kind: 'custom' },
  { id: 'literary', name: '文学创作者', description: '命题写作 · 段落润色 · 自动配图', Icon: PenTool, accent: '#fb923c', route: '/literary-agent', kind: 'custom' },
  { id: 'prd', name: 'PRD 分析师', description: '需求缺口识别 · 对话答疑 · AI 预审', Icon: FileText, accent: '#3b82f6', route: '/prd-agent', kind: 'custom' },
  { id: 'video', name: '视频创作者', description: '文章 → 分镜 → 预览 → 时间线', Icon: Video, accent: '#f43f5e', route: '/video-agent', kind: 'custom' },
  { id: 'defect', name: '缺陷管理员', description: '信息提取 · 严重度分类 · 修复闭环', Icon: Bug, accent: '#10b981', route: '/defect-agent', kind: 'custom' },
  { id: 'report', name: '周报管理员', description: 'Git 合成 · 计划对比 · 团队汇总', Icon: FileBarChart, accent: '#06b6d4', route: '/report-agent', kind: 'custom' },
  { id: 'arena', name: 'AI 竞技场', description: '多模型盲测 PK · 揭晓真实身份', Icon: Swords, accent: '#eab308', route: '/arena', kind: 'custom' },
  { id: 'workflow', name: '工作流引擎', description: '可视化编排 · 多步骤串联', Icon: Workflow, accent: '#22c55e', route: '/workflow-agent', kind: 'custom' },
  { id: 'shortcuts', name: '快捷指令', description: '一键执行 · 自定义 · 可分享', Icon: Zap, accent: '#f59e0b', route: '/shortcuts-agent', kind: 'custom' },
  { id: 'review', name: '产品评审员', description: '方案多维度打分 · 问题清单', Icon: ClipboardCheck, accent: '#ec4899', route: '/review-agent', kind: 'custom' },
  { id: 'transcript', name: '转录工作台', description: '多模型 ASR · 时间戳编辑 · 转文案', Icon: AudioLines, accent: '#8b5cf6', route: '/transcript-agent', kind: 'custom' },
  { id: 'code-review', name: '代码审查员', description: '代码质量审查 · Bug · 性能', Icon: Code2, accent: '#64748b', kind: 'dialog' },
  { id: 'translator', name: '多语言翻译', description: '专业级翻译 · 中英日韩', Icon: Languages, accent: '#0ea5e9', kind: 'dialog' },
  { id: 'summarizer', name: '内容摘要师', description: '长文本要点提取 · 关键数据', Icon: FileSearch, accent: '#14b8a6', kind: 'dialog' },
  { id: 'data-analyst', name: '数据分析师', description: '趋势分析 · 图表建议 · 洞察', Icon: BarChart3, accent: '#d946ef', kind: 'dialog' },
];

export function AgentGrid() {
  return (
    <section
      className="relative py-28 md:py-36 px-6"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      {/* Section header */}
      <div className="max-w-6xl mx-auto mb-20 md:mb-24">
        <SectionHeader
          Icon={Users}
          eyebrow="The Roster"
          accent="#22d3ee"
          title={
            <>
              十五位 Agent，
              <br className="sm:hidden" />
              随时可以派工
            </>
          }
          subtitle="11 位深度定制 + 4 位通用对话助手。每一位都能独立上岗，也能被别的 Agent 调用。"
        />
      </div>

      {/* Grid —— 整体 Reveal，卡片内部再分 stagger */}
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {AGENTS.map((agent, i) => (
            <Reveal key={agent.id} delay={(i % 4) * 60} offset={20}>
              <AgentCard agent={agent} />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function AgentCard({ agent }: { agent: Agent }) {
  const { Icon, name, description, accent, route, kind } = agent;
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
      {/* Header: icon + LVL badge + arrow */}
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
              fontFamily: 'var(--font-mono)',
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
        className="text-[12px] text-white/50 leading-relaxed"
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
          {isCustom ? 'Dedicated' : 'Assistant'}
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
