import { useState } from 'react';
import { BookOpen, GraduationCap, FileText, Palette, PenTool, Bug, ChevronRight, ExternalLink } from 'lucide-react';

// ── Tutorial data ──

interface TutorialGuide {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  icon: typeof BookOpen;
  accentFrom: string;
  accentTo: string;
  steps: { title: string; desc: string }[];
  features: string[];
}

const tutorials: TutorialGuide[] = [
  {
    id: 'prd-agent',
    title: 'PRD Agent',
    subtitle: '智能需求文档解读',
    description: '上传 PRD 即可与 AI 对话，快速理解需求、发现遗漏、生成测试用例。',
    icon: FileText,
    accentFrom: '#3B82F6',
    accentTo: '#06B6D4',
    steps: [
      { title: '创建团队', desc: '邀请成员，建立协作空间' },
      { title: '上传文档', desc: '支持 PDF、Word、Markdown' },
      { title: '智能问答', desc: '基于文档内容精准回答' },
    ],
    features: ['智能问答', '缺失检测', '用例生成', '需求摘要'],
  },
  {
    id: 'visual-agent',
    title: '视觉创作 Agent',
    subtitle: '专业级 AI 图像生成',
    description: '文生图、图生图、局部重绘、风格融合，从文字到惊艳视觉触手可及。',
    icon: Palette,
    accentFrom: '#A855F7',
    accentTo: '#EC4899',
    steps: [
      { title: '进入工作区', desc: '创建或选择工作区' },
      { title: '描述画面', desc: '输入文字生成图片' },
      { title: '精细编辑', desc: '局部重绘或风格融合' },
    ],
    features: ['文生图', '图生图', '局部重绘', '风格融合'],
  },
  {
    id: 'literary-agent',
    title: '文学创作 Agent',
    subtitle: '智能配图与文学润色',
    description: '一键为文章生成契合的插画，支持 20+ 艺术风格，AI 辅助润色提升表达力。',
    icon: PenTool,
    accentFrom: '#F59E0B',
    accentTo: '#EF4444',
    steps: [
      { title: '导入文章', desc: '粘贴或输入文章内容' },
      { title: '选择风格', desc: '水彩、油画、素描等 20+' },
      { title: '批量生成', desc: '一键为全文生成配图' },
    ],
    features: ['智能配图', '风格迁移', '文学润色', '批量处理'],
  },
  {
    id: 'defect-agent',
    title: '缺陷管理 Agent',
    subtitle: 'AI 驱动的缺陷管理',
    description: '可视化缺陷看板、智能分析、自动分配、完整生命周期追踪。',
    icon: Bug,
    accentFrom: '#10B981',
    accentTo: '#84CC16',
    steps: [
      { title: '创建项目', desc: '建立缺陷管理空间' },
      { title: '提交缺陷', desc: 'AI 自动分类和评级' },
      { title: '跟踪处理', desc: '看板拖拽管理状态' },
    ],
    features: ['缺陷看板', '智能分析', 'AI 修复建议', '分享协作'],
  },
];

// ── Skill docs ──

interface SkillDoc {
  id: string;
  title: string;
  category: string;
  desc: string;
  accentColor: string;
}

const skillDocs: SkillDoc[] = [
  { id: 'run-worker', title: 'Run/Worker 异步架构', category: '架构', desc: '了解任务如何后台执行、断线续传的核心机制', accentColor: '#06B6D4' },
  { id: 'llm-gateway', title: 'LLM Gateway 统一调用', category: '核心', desc: '所有大模型调用的统一入口，三级调度策略', accentColor: '#6366F1' },
  { id: 'marketplace', title: '配置市场', category: '功能', desc: '浏览和分享提示词、参考图等配置模板', accentColor: '#EC4899' },
  { id: 'open-platform', title: '开放平台 API', category: 'API', desc: '标准 RESTful 接口，轻松接入 AI 能力', accentColor: '#8B5CF6' },
  { id: 'rbac', title: '权限与角色管理', category: '安全', desc: '精细化权限管控，60+ 权限项', accentColor: '#10B981' },
  { id: 'model-pool', title: '模型池策略引擎', category: '调度', desc: '6 种策略引擎，智能模型选择与负载均衡', accentColor: '#F59E0B' },
];

// ── Components ──

function TutorialCard({ guide }: { guide: TutorialGuide }) {
  const [hovered, setHovered] = useState(false);
  const Icon = guide.icon;

  return (
    <div
      className="relative rounded-2xl overflow-hidden transition-all duration-300"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'var(--bg-elevated)',
        border: `1px solid ${hovered ? `${guide.accentFrom}40` : 'var(--border-default)'}`,
        boxShadow: hovered ? `0 8px 32px ${guide.accentFrom}15` : 'none',
      }}
    >
      <div className="p-6">
        {/* Header */}
        <div className="flex items-start gap-4 mb-4">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: `linear-gradient(135deg, ${guide.accentFrom}, ${guide.accentTo})` }}
          >
            <Icon className="w-6 h-6 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{guide.title}</h3>
            <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>{guide.subtitle}</p>
          </div>
        </div>

        <p className="text-sm mb-5 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{guide.description}</p>

        {/* Steps */}
        <div className="space-y-3 mb-5">
          {guide.steps.map((step, i) => (
            <div key={i} className="flex items-center gap-3">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                style={{ background: `linear-gradient(135deg, ${guide.accentFrom}, ${guide.accentTo})` }}
              >
                {i + 1}
              </div>
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{step.title}</span>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{step.desc}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Feature tags */}
        <div className="flex flex-wrap gap-2">
          {guide.features.map((f) => (
            <span
              key={f}
              className="px-2.5 py-1 rounded-lg text-xs"
              style={{
                background: `${guide.accentFrom}12`,
                color: guide.accentFrom,
                border: `1px solid ${guide.accentFrom}20`,
              }}
            >
              {f}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function SkillDocRow({ doc }: { doc: SkillDoc }) {
  return (
    <div
      className="group flex items-center gap-4 px-4 py-3.5 rounded-xl transition-colors duration-200 cursor-default"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
      }}
    >
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: `${doc.accentColor}15` }}
      >
        <BookOpen className="w-4.5 h-4.5" style={{ color: doc.accentColor }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{doc.title}</span>
          <span
            className="px-2 py-0.5 rounded text-[11px] font-medium"
            style={{ background: `${doc.accentColor}15`, color: doc.accentColor }}
          >
            {doc.category}
          </span>
        </div>
        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{doc.desc}</p>
      </div>
      <ChevronRight className="w-4 h-4 flex-shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" style={{ color: 'var(--text-muted)' }} />
    </div>
  );
}

// ── Page ──

export default function TutorialsPage() {
  const [activeTab, setActiveTab] = useState<'guides' | 'docs'>('guides');

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--bg-base)' }}>
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Page header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg, #3B82F6, #6366F1)' }}
            >
              <GraduationCap className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>使用教程</h1>
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>从入门到进阶的操作指南</p>
            </div>
          </div>
        </div>

        {/* Tab switcher */}
        <div className="flex items-center gap-1 mb-6 p-1 rounded-xl w-fit" style={{ background: 'var(--bg-sunken, var(--bg-elevated))' }}>
          <button
            onClick={() => setActiveTab('guides')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200"
            style={{
              background: activeTab === 'guides' ? 'var(--bg-elevated)' : 'transparent',
              color: activeTab === 'guides' ? 'var(--text-primary)' : 'var(--text-muted)',
              boxShadow: activeTab === 'guides' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            <GraduationCap className="w-4 h-4" />
            上手教程
          </button>
          <button
            onClick={() => setActiveTab('docs')}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200"
            style={{
              background: activeTab === 'docs' ? 'var(--bg-elevated)' : 'transparent',
              color: activeTab === 'docs' ? 'var(--text-primary)' : 'var(--text-muted)',
              boxShadow: activeTab === 'docs' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
            }}
          >
            <BookOpen className="w-4 h-4" />
            技能文档
          </button>
        </div>

        {/* Guides tab */}
        {activeTab === 'guides' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {tutorials.map((guide) => (
              <TutorialCard key={guide.id} guide={guide} />
            ))}
          </div>
        )}

        {/* Docs tab */}
        {activeTab === 'docs' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {skillDocs.map((doc) => (
              <SkillDocRow key={doc.id} doc={doc} />
            ))}
          </div>
        )}

        {/* External link */}
        <div className="mt-8 text-center">
          <a
            href="/home#tutorials"
            className="inline-flex items-center gap-2 text-sm transition-colors duration-200"
            style={{ color: 'var(--text-muted)' }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
          >
            <ExternalLink className="w-4 h-4" />
            查看完整教程中心
          </a>
        </div>
      </div>
    </div>
  );
}
