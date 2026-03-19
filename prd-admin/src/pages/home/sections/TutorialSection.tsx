import { useState } from 'react';
import { cn } from '@/lib/cn';
import { SectionHeader } from '@/components/design/SectionHeader';

// Tutorial data for all agents
const tutorials = [
  {
    id: 'prd-agent',
    title: 'PRD Agent',
    subtitle: '智能需求文档解读',
    description: '上传 PRD 即可与 AI 对话，快速理解需求、发现遗漏、生成测试用例。',
    gradient: 'from-blue-500 via-cyan-500 to-teal-500',
    glowColor: 'rgba(59, 130, 246, 0.3)',
    iconColor: 'text-blue-400',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/20',
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
    gradient: 'from-purple-500 via-pink-500 to-rose-500',
    glowColor: 'rgba(168, 85, 247, 0.3)',
    iconColor: 'text-purple-400',
    bgColor: 'bg-purple-500/10',
    borderColor: 'border-purple-500/20',
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
    gradient: 'from-amber-500 via-orange-500 to-red-500',
    glowColor: 'rgba(251, 146, 60, 0.3)',
    iconColor: 'text-amber-400',
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-amber-500/20',
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
    gradient: 'from-emerald-500 via-green-500 to-lime-500',
    glowColor: 'rgba(16, 185, 129, 0.3)',
    iconColor: 'text-emerald-400',
    bgColor: 'bg-emerald-500/10',
    borderColor: 'border-emerald-500/20',
    steps: [
      { title: '创建项目', desc: '建立缺陷管理空间' },
      { title: '提交缺陷', desc: 'AI 自动分类和评级' },
      { title: '跟踪处理', desc: '看板拖拽管理状态' },
    ],
    features: ['缺陷看板', '智能分析', 'AI 修复建议', '分享协作'],
  },
  {
    id: 'video-agent',
    title: '视频创作 Agent',
    subtitle: '文章一键转视频',
    description: '上传文章自动生成分镜脚本、场景图片和配音，合成可下载的完整视频。',
    gradient: 'from-rose-500 via-red-500 to-pink-500',
    glowColor: 'rgba(244, 63, 94, 0.3)',
    iconColor: 'text-rose-400',
    bgColor: 'bg-rose-500/10',
    borderColor: 'border-rose-500/20',
    steps: [
      { title: '上传文章', desc: '粘贴文章内容或 Markdown' },
      { title: '生成分镜', desc: 'AI 拆分场景并生成脚本' },
      { title: '合成视频', desc: '一键渲染并下载成品' },
    ],
    features: ['分镜生成', '场景编辑', '预览图片', '视频下载'],
  },
  {
    id: 'report-agent',
    title: '周报管理 Agent',
    subtitle: 'AI 辅助周报生成',
    description: '日志记录、数据源集成、AI 自动汇总，让周报从「苦差事」变成「一键完成」。',
    gradient: 'from-indigo-500 via-violet-500 to-purple-500',
    glowColor: 'rgba(99, 102, 241, 0.3)',
    iconColor: 'text-indigo-400',
    bgColor: 'bg-indigo-500/10',
    borderColor: 'border-indigo-500/20',
    steps: [
      { title: '创建团队', desc: '建立团队并邀请成员' },
      { title: '记录日志', desc: '每日记录工作内容' },
      { title: 'AI 生成', desc: '一键生成结构化周报' },
    ],
    features: ['日志记录', 'AI 生成', '团队汇总', '评论协作'],
  },
  {
    id: 'arena',
    title: 'AI 竞技场',
    subtitle: '多模型盲测对比',
    description: '将多个大语言模型匿名回答同一问题，消除品牌偏见，找到最适合的模型。',
    gradient: 'from-yellow-500 via-amber-500 to-orange-500',
    glowColor: 'rgba(245, 158, 11, 0.3)',
    iconColor: 'text-amber-400',
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-amber-500/20',
    steps: [
      { title: '创建竞技组', desc: '选择 2-4 个模型' },
      { title: '发起对战', desc: '输入问题同时提问' },
      { title: '评判揭晓', desc: '盲评后揭晓模型身份' },
    ],
    features: ['盲测对比', 'TTFT 指标', '思考过程', '对战历史'],
  },
  {
    id: 'workflow-agent',
    title: '工作流引擎',
    subtitle: '可视化流程编排',
    description: '拖拽胶囊节点编排 HTTP 请求、条件判断、数据转换等，实现自动化任务。',
    gradient: 'from-teal-500 via-cyan-500 to-sky-500',
    glowColor: 'rgba(20, 184, 166, 0.3)',
    iconColor: 'text-teal-400',
    bgColor: 'bg-teal-500/10',
    borderColor: 'border-teal-500/20',
    steps: [
      { title: '创建工作流', desc: '定义名称和描述' },
      { title: '编排节点', desc: '拖拽胶囊并连线' },
      { title: '测试运行', desc: '验证流程并启用' },
    ],
    features: ['画布编辑', '胶囊节点', '条件分支', '定时调度'],
  },
  {
    id: 'shortcuts-agent',
    title: '快捷指令',
    subtitle: 'iOS 一键调用 AI',
    description: '将平台 AI 能力接入 iOS 快捷指令，手机端一键触发对话、工作流等功能。',
    gradient: 'from-orange-500 via-yellow-500 to-amber-500',
    glowColor: 'rgba(249, 115, 22, 0.3)',
    iconColor: 'text-orange-400',
    bgColor: 'bg-orange-500/10',
    borderColor: 'border-orange-500/20',
    steps: [
      { title: '创建指令', desc: '选择绑定类型' },
      { title: '扫码安装', desc: 'iPhone 扫码添加' },
      { title: 'Siri 触发', desc: '语音一键调用' },
    ],
    features: ['收藏书签', '绑定工作流', '绑定智能体', 'QR 安装'],
  },
];

// Skill documents data
const skillDocs = [
  { id: 'run-worker', title: 'Run/Worker 异步架构', category: '架构', desc: '了解任务如何后台执行、断线续传的核心机制', color: 'text-cyan-400', bgColor: 'bg-cyan-500/10' },
  { id: 'llm-gateway', title: 'LLM Gateway 统一调用', category: '核心', desc: '所有大模型调用的统一入口，三级调度策略', color: 'text-indigo-400', bgColor: 'bg-indigo-500/10' },
  { id: 'marketplace', title: '配置市场', category: '功能', desc: '浏览和分享提示词、参考图等配置模板', color: 'text-pink-400', bgColor: 'bg-pink-500/10' },
  { id: 'open-platform', title: '开放平台 API', category: 'API', desc: '标准 RESTful 接口，轻松接入 AI 能力', color: 'text-violet-400', bgColor: 'bg-violet-500/10' },
  { id: 'rbac', title: '权限与角色管理', category: '安全', desc: '精细化权限管控，60+ 权限项', color: 'text-emerald-400', bgColor: 'bg-emerald-500/10' },
  { id: 'model-pool', title: '模型池策略引擎', category: '调度', desc: '6 种策略引擎，智能模型选择与负载均衡', color: 'text-amber-400', bgColor: 'bg-amber-500/10' },
];

type TabKey = 'tutorials' | 'docs';

// Step number badge
function StepBadge({ number, gradient }: { number: number; gradient: string }) {
  return (
    <div className={cn('w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white bg-gradient-to-br flex-shrink-0', gradient)}>
      {number}
    </div>
  );
}

// Tutorial card component
function TutorialCard({ tutorial, index }: { tutorial: typeof tutorials[0]; index: number }) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-2xl border border-white/[0.1] bg-white/[0.04] backdrop-blur-xl',
        'transition-all duration-500 hover:border-white/20',
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        boxShadow: isHovered ? `0 0 40px ${tutorial.glowColor}` : 'none',
        animationDelay: `${index * 100}ms`,
      }}
    >
      {/* Glow effect on hover */}
      <div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
        style={{
          background: `radial-gradient(circle at 50% 0%, ${tutorial.glowColor} 0%, transparent 70%)`,
        }}
      />

      <div className="relative z-10 p-6">
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className={cn('inline-flex items-center gap-2 px-3 py-1 mb-3 rounded-full border', tutorial.borderColor, tutorial.bgColor)}>
              <span className={cn('text-xs font-medium', tutorial.iconColor)}>{tutorial.subtitle}</span>
            </div>
            <h3 className="text-lg font-bold text-white">{tutorial.title}</h3>
          </div>
        </div>

        <p className="text-sm text-white/55 mb-5 leading-relaxed">{tutorial.description}</p>

        {/* Steps */}
        <div className="space-y-3 mb-5">
          {tutorial.steps.map((step, i) => (
            <div key={i} className="flex items-center gap-3">
              <StepBadge number={i + 1} gradient={tutorial.gradient} />
              <div>
                <span className="text-sm font-medium text-white/85">{step.title}</span>
                <span className="text-xs text-white/45 ml-2">{step.desc}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Feature tags */}
        <div className="flex flex-wrap gap-2">
          {tutorial.features.map((feature) => (
            <span
              key={feature}
              className="px-2.5 py-1 rounded-lg text-xs text-white/60 bg-white/[0.06] border border-white/[0.08]"
            >
              {feature}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// Skill doc card component
function SkillDocCard({ doc, index }: { doc: typeof skillDocs[0]; index: number }) {
  return (
    <div
      className="group flex items-start gap-4 p-4 rounded-xl border border-white/[0.08] bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/15 transition-all duration-300"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      {/* Icon */}
      <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0', doc.bgColor)}>
        <svg className={cn('w-5 h-5', doc.color)} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
        </svg>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <h4 className="text-sm font-medium text-white/85 group-hover:text-white transition-colors truncate">{doc.title}</h4>
          <span className={cn('px-2 py-0.5 rounded text-[10px] font-medium flex-shrink-0', doc.bgColor, doc.color)}>{doc.category}</span>
        </div>
        <p className="text-xs text-white/45 leading-relaxed">{doc.desc}</p>
      </div>

      {/* Arrow */}
      <svg className="w-4 h-4 text-white/20 group-hover:text-white/50 group-hover:translate-x-0.5 transition-all flex-shrink-0 mt-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
    </div>
  );
}

interface TutorialSectionProps {
  className?: string;
}

export function TutorialSection({ className }: TutorialSectionProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('tutorials');
  // Show first 4 by default, expandable
  const [showAll, setShowAll] = useState(false);
  const visibleTutorials = showAll ? tutorials : tutorials.slice(0, 4);

  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    {
      key: 'tutorials',
      label: '上手教程',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4.26 10.147a60.438 60.438 0 00-.491 6.347A48.62 48.62 0 0112 20.904a48.62 48.62 0 018.232-4.41 60.46 60.46 0 00-.491-6.347m-15.482 0a50.636 50.636 0 00-2.658-.813A59.906 59.906 0 0112 3.493a59.903 59.903 0 0110.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0112 13.489a50.702 50.702 0 017.74-3.342M6.75 15a.75.75 0 100-1.5.75.75 0 000 1.5zm0 0v-3.675A55.378 55.378 0 0112 8.443m-7.007 11.55A5.981 5.981 0 006.75 15.75v-1.5" />
        </svg>
      ),
    },
    {
      key: 'docs',
      label: '技能文档',
      icon: (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
        </svg>
      ),
    },
  ];

  return (
    <section className={cn('relative py-24 sm:py-32 overflow-hidden', className)}>
      {/* Background overlay */}
      <div className="absolute inset-0 bg-[#030306]/30" />

      {/* Subtle pattern */}
      <div
        className="absolute inset-0 opacity-[0.02]"
        style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, rgba(255,255,255,0.15) 1px, transparent 0)`,
          backgroundSize: '40px 40px',
        }}
      />

      {/* Content */}
      <div className="relative z-10 max-w-7xl mx-auto px-6">
        <SectionHeader
          badge="教程中心"
          badgeIcon={
            <svg className="w-4 h-4 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
            </svg>
          }
          title="从零开始，轻松上手"
          subtitle="跟随教程快速掌握每个 Agent 的核心功能，查阅技能文档深入了解平台能力"
        />

        {/* Tab switcher */}
        <div className="flex justify-center mb-12">
          <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-white/[0.06] border border-white/[0.1]">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  'flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all duration-300',
                  activeTab === tab.key
                    ? 'bg-white/[0.12] text-white border border-white/[0.15] shadow-lg'
                    : 'text-white/50 hover:text-white/70 hover:bg-white/[0.04]'
                )}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Tutorials tab content */}
        <div className={cn(activeTab === 'tutorials' ? 'block' : 'hidden')}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {visibleTutorials.map((tutorial, index) => (
              <TutorialCard key={tutorial.id} tutorial={tutorial} index={index} />
            ))}
          </div>

          {/* Show more / less */}
          {tutorials.length > 4 && (
            <div className="flex justify-center mt-8">
              <button
                onClick={() => setShowAll(!showAll)}
                className="flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-medium text-white/60 hover:text-white/80 bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.1] transition-all duration-300"
              >
                {showAll ? '收起' : `查看全部 ${tutorials.length} 个教程`}
                <svg
                  className={cn('w-4 h-4 transition-transform duration-300', showAll && 'rotate-180')}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* Skill docs tab content */}
        <div className={cn(activeTab === 'docs' ? 'block' : 'hidden')}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {skillDocs.map((doc, index) => (
              <SkillDocCard key={doc.id} doc={doc} index={index} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
