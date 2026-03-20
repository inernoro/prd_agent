import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen, GraduationCap, FileText, Palette, PenTool, Bug,
  ChevronRight, Video, FileBarChart, Swords, Workflow, Zap,
  Store, ArrowRight, Play,
  type LucideIcon,
} from 'lucide-react';

// ── Tutorial data ──

interface QuickAction {
  label: string;
  path: string;
  desc: string;
}

interface TutorialGuide {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  icon: LucideIcon;
  accentFrom: string;
  accentTo: string;
  steps: { title: string; desc: string }[];
  features: string[];
  /** Path to navigate for "try it" */
  tryPath: string;
  /** Quick actions - direct links to specific operations */
  quickActions?: QuickAction[];
}

const tutorials: TutorialGuide[] = [
  {
    id: 'prd-agent',
    title: 'PRD Agent',
    subtitle: '智能需求文档解读',
    description: '上传 PRD 文档与 AI 对话，在「PRD 对话」Tab 中精准问答，在「群组管理」Tab 中协作审阅。支持内容缺失检测、测试用例生成。',
    icon: FileText,
    accentFrom: '#3B82F6',
    accentTo: '#06B6D4',
    steps: [
      { title: '创建群组', desc: '群组管理 Tab → 创建按钮，邀请成员协作' },
      { title: '上传文档', desc: '上传 PDF/Word/Markdown，系统自动解析' },
      { title: '智能问答', desc: 'PRD 对话 Tab 中基于文档精准回答' },
    ],
    features: ['PRD 对话', '群组管理', '缺失检测', '用例生成'],
    tryPath: '/prd-agent',
    quickActions: [
      { label: '创建群组', path: '/prd-agent', desc: '新建协作群组并邀请成员' },
      { label: '上传 PRD', path: '/prd-agent', desc: '上传需求文档开始 AI 解读' },
    ],
  },
  {
    id: 'visual-agent',
    title: '视觉创作 Agent',
    subtitle: '专业级 AI 图像生成',
    description: '三栏式工作区：左侧工具面板、中间无限画布、右侧 AI 对话。支持文生图、图生图、局部重绘，尺寸标签如「1K·1:1」一目了然。',
    icon: Palette,
    accentFrom: '#A855F7',
    accentTo: '#EC4899',
    steps: [
      { title: '新建工作区', desc: '点击创建按钮，进入三栏式创作界面' },
      { title: '对话生图', desc: '在右侧聊天区描述画面，AI 实时生成' },
      { title: '画布编辑', desc: '拖拽到画布精细编辑，局部重绘或风格融合' },
    ],
    features: ['文生图', '图生图', '局部重绘', '参考图配置'],
    tryPath: '/visual-agent',
    quickActions: [
      { label: '新建工作区', path: '/visual-agent', desc: '创建画布开始创作' },
      { label: '浏览参考图', path: '/marketplace?type=refImage', desc: '从市场获取风格参考' },
    ],
  },
  {
    id: 'literary-agent',
    title: '文学创作 Agent',
    subtitle: '智能配图与文学润色',
    description: '点击「新建文章」创建作品，通过「选择文件」上传文本，AI 为每段自动生成「配图 N」卡片，支持「重新生成」「预览」「删除」操作。',
    icon: PenTool,
    accentFrom: '#F59E0B',
    accentTo: '#EF4444',
    steps: [
      { title: '新建文章', desc: '点击「新建文章」按钮或「新建文件夹」整理作品' },
      { title: '导入内容', desc: '点击「选择文件」上传，或直接粘贴文本' },
      { title: '生成配图', desc: 'AI 为每段生成「配图 N」卡片，支持 20+ 风格' },
    ],
    features: ['智能配图', '风格迁移', '批量生成', '提示词市场'],
    tryPath: '/literary-agent',
    quickActions: [
      { label: '新建作品', path: '/literary-agent', desc: '创建文章开始配图' },
      { label: '浏览提示词', path: '/marketplace?type=prompt', desc: '获取创作灵感模板' },
    ],
  },
  {
    id: 'defect-agent',
    title: '缺陷管理 Agent',
    subtitle: 'AI 驱动的缺陷管理',
    description: '「收到的」和「我提交的」双 Tab 管理缺陷，支持 4 种视图模式（列表/网格/看板/统计），顶部「提交缺陷」「项目管理」「我的模板」快捷入口。',
    icon: Bug,
    accentFrom: '#10B981',
    accentTo: '#84CC16',
    steps: [
      { title: '创建项目', desc: '点击「项目管理」建立缺陷管理空间' },
      { title: '提交缺陷', desc: '点击「提交缺陷」按钮，AI 自动分类评级' },
      { title: '跟踪处理', desc: '看板拖拽管理状态，点击「分享管理」协作' },
    ],
    features: ['四种视图', 'AI 分析', '修复建议', '外部分享'],
    tryPath: '/defect-agent',
    quickActions: [
      { label: '提交缺陷', path: '/defect-agent', desc: '快速提交一个 Bug 报告' },
      { label: '项目管理', path: '/defect-agent', desc: '管理缺陷项目和模板' },
    ],
  },
  {
    id: 'video-agent',
    title: '视频创作 Agent',
    subtitle: '文章一键转视频',
    description: '上传文章后点击「生成分镜标记」，AI 拆分为「镜头 N」场景卡片（8 种场景类型），三阶段进度条实时追踪，最终「导出视频」下载 MP4。',
    icon: Video,
    accentFrom: '#F43F5E',
    accentTo: '#FB7185',
    steps: [
      { title: '上传文章', desc: '粘贴文章内容，点击「生成分镜标记」' },
      { title: '编辑分镜', desc: '调整「镜头 N」卡片，选择 8 种场景类型' },
      { title: '导出视频', desc: '点击「导出视频」，支持 MP4/SRT/台词下载' },
    ],
    features: ['分镜标记', '8 种场景', '三阶段进度', '多格式下载'],
    tryPath: '/video-agent',
    quickActions: [
      { label: '创建视频', path: '/video-agent', desc: '上传文章开始制作视频' },
    ],
  },
  {
    id: 'report-agent',
    title: '周报管理 Agent',
    subtitle: 'AI 辅助周报生成',
    description: '三个 Tab：「周报」记录日志和生成报告、「团队」查看成员提交状态（有团队时显示）、「设置」配置 Git 数据源和模板。',
    icon: FileBarChart,
    accentFrom: '#6366F1',
    accentTo: '#818CF8',
    steps: [
      { title: '配置数据源', desc: '设置 Tab → 添加 Git 仓库，自动拉取 commit' },
      { title: '记录日志', desc: '周报 Tab → 每日记录，哪怕一句话也行' },
      { title: 'AI 生成', desc: '点击 AI 生成，输出本周完成/进行中/下周计划/风险' },
    ],
    features: ['日志记录', 'Git 集成', 'AI 汇总', '团队看板'],
    tryPath: '/report-agent',
    quickActions: [
      { label: '写周报', path: '/report-agent', desc: '创建本周的周报' },
      { label: '团队管理', path: '/report-agent', desc: '管理团队和数据源' },
    ],
  },
  {
    id: 'arena',
    title: 'AI 竞技场',
    subtitle: '多模型盲测对比',
    description: '添加 2-4 个模型到竞技组，匿名标记为「助手 A」「助手 B」「助手 C」，实时显示 TTFT 和思考过程，评判后点击「Reveal」揭晓真实身份。',
    icon: Swords,
    accentFrom: '#F59E0B',
    accentTo: '#FBBF24',
    steps: [
      { title: '创建竞技组', desc: '选择 2-4 个模型，身份随机打乱' },
      { title: '发起对战', desc: '输入问题，所有模型同时流式回答' },
      { title: '评判揭晓', desc: '盲评后点击「Reveal」揭晓模型身份' },
    ],
    features: ['盲测对比', 'TTFT 指标', '思考过程', '对战历史'],
    tryPath: '/arena',
    quickActions: [
      { label: '开始对战', path: '/arena', desc: '创建竞技组开始盲测' },
    ],
  },
  {
    id: 'workflow-agent',
    title: '工作流引擎',
    subtitle: '可视化流程编排',
    description: '画布编辑器中拖拽 5 种胶囊节点（HTTP 请求/延时/条件判断/格式转换/通知推送），执行日志按颜色区分状态，支持 Artifact 数据预览。',
    icon: Workflow,
    accentFrom: '#14B8A6',
    accentTo: '#5EEAD4',
    steps: [
      { title: '创建工作流', desc: '输入名称和描述，进入画布编辑器' },
      { title: '编排节点', desc: '拖拽 5 种胶囊节点并连线编排' },
      { title: '测试运行', desc: '点击运行，实时查看执行日志和 Artifact' },
    ],
    features: ['画布编辑', '5 种胶囊', '条件分支', 'Cron 调度'],
    tryPath: '/workflow-agent',
    quickActions: [
      { label: '创建工作流', path: '/workflow-agent', desc: '新建自动化流程' },
    ],
  },
  {
    id: 'shortcuts-agent',
    title: '快捷指令',
    subtitle: 'iOS 一键调用 AI',
    description: '三种绑定类型：「仅收藏」快捷书签、「工作流」绑定自动化、「智能体」绑定 AI 对话。创建后扫描二维码安装到 iPhone，支持 Siri 语音触发。',
    icon: Zap,
    accentFrom: '#F59E0B',
    accentTo: '#FCD34D',
    steps: [
      { title: '创建指令', desc: '选择绑定类型（收藏/工作流/智能体）' },
      { title: '扫码安装', desc: '系统生成二维码，iPhone 扫码添加' },
      { title: '多种触发', desc: '桌面图标、Siri 语音、App 内点击' },
    ],
    features: ['收藏书签', '绑定工作流', '绑定智能体', 'QR 安装'],
    tryPath: '/shortcuts-agent',
    quickActions: [
      { label: '创建快捷指令', path: '/shortcuts-agent', desc: '新建一个快捷指令' },
    ],
  },
];

// ── Quick entry data ──

interface QuickEntry {
  icon: LucideIcon;
  label: string;
  desc: string;
  path: string;
  accentColor: string;
}

const quickEntries: QuickEntry[] = [
  { icon: Store, label: '海鲜市场', desc: '浏览和 Fork 优质提示词、参考图配置', path: '/marketplace', accentColor: '#F59E0B' },
  { icon: Palette, label: '开始作图', desc: '进入视觉创作工作区，输入描述生成图片', path: '/visual-agent', accentColor: '#A855F7' },
  { icon: FileText, label: '上传 PRD', desc: '上传需求文档，AI 帮你解读和问答', path: '/prd-agent', accentColor: '#3B82F6' },
  { icon: Bug, label: '提交缺陷', desc: '快速提交 Bug，AI 自动分析和分类', path: '/defect-agent', accentColor: '#10B981' },
  { icon: Video, label: '制作视频', desc: '上传文章一键生成讲解视频', path: '/video-agent', accentColor: '#F43F5E' },
  { icon: Workflow, label: '编排工作流', desc: '拖拽式创建自动化流程', path: '/workflow-agent', accentColor: '#14B8A6' },
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

type TabKey = 'quick' | 'guides' | 'docs';

// ── Components ──

function QuickEntryCard({ entry, onClick }: { entry: QuickEntry; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-4 p-4 rounded-xl text-left transition-all duration-200"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = `${entry.accentColor}40`;
        e.currentTarget.style.boxShadow = `0 4px 16px ${entry.accentColor}12`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-default)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
        style={{ background: `${entry.accentColor}15` }}
      >
        <entry.icon className="w-5 h-5" style={{ color: entry.accentColor }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{entry.label}</div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{entry.desc}</div>
      </div>
      <ArrowRight
        className="w-4 h-4 flex-shrink-0 opacity-0 group-hover:opacity-60 group-hover:translate-x-0.5 transition-all"
        style={{ color: entry.accentColor }}
      />
    </button>
  );
}

function TutorialCard({ guide, onNavigate }: { guide: TutorialGuide; onNavigate: (path: string) => void }) {
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
        <div className="flex flex-wrap gap-2 mb-5">
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

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2 pt-4" style={{ borderTop: '1px solid var(--border-default)' }}>
          <button
            type="button"
            onClick={() => onNavigate(guide.tryPath)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium text-white transition-all duration-200 hover:opacity-90"
            style={{ background: `linear-gradient(135deg, ${guide.accentFrom}, ${guide.accentTo})` }}
          >
            <Play className="w-3.5 h-3.5" />
            立即体验
          </button>
          {guide.quickActions?.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => onNavigate(action.path)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium transition-all duration-200"
              title={action.desc}
              style={{
                background: `${guide.accentFrom}10`,
                color: guide.accentFrom,
                border: `1px solid ${guide.accentFrom}20`,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = `${guide.accentFrom}20`;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = `${guide.accentFrom}10`;
              }}
            >
              {action.label}
            </button>
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
        <BookOpen className="w-4 h-4" style={{ color: doc.accentColor }} />
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
  const [activeTab, setActiveTab] = useState<TabKey>('quick');
  const navigate = useNavigate();

  const tabs: { key: TabKey; label: string; icon: LucideIcon; count?: number }[] = [
    { key: 'quick', label: '快速操作', icon: Zap, count: quickEntries.length },
    { key: 'guides', label: '上手教程', icon: GraduationCap, count: tutorials.length },
    { key: 'docs', label: '技能文档', icon: BookOpen, count: skillDocs.length },
  ];

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
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>从入门到进阶的操作指南，点击即可直达功能</p>
            </div>
          </div>
        </div>

        {/* Tab switcher */}
        <div className="flex items-center gap-1 mb-6 p-1 rounded-xl w-fit" style={{ background: 'var(--bg-sunken, var(--bg-elevated))' }}>
          {tabs.map((tab) => {
            const TabIcon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200"
                style={{
                  background: activeTab === tab.key ? 'var(--bg-elevated)' : 'transparent',
                  color: activeTab === tab.key ? 'var(--text-primary)' : 'var(--text-muted)',
                  boxShadow: activeTab === tab.key ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                }}
              >
                <TabIcon className="w-4 h-4" />
                {tab.label}
                {tab.count != null && (
                  <span
                    className="ml-1 px-1.5 py-0.5 rounded text-[10px]"
                    style={{
                      background: activeTab === tab.key ? 'var(--bg-hover, rgba(0,0,0,0.06))' : 'transparent',
                      color: 'var(--text-muted)',
                    }}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Quick actions tab */}
        {activeTab === 'quick' && (
          <div>
            <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>
              不知道从哪里开始？点击下方卡片直接进入对应功能页面。
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {quickEntries.map((entry) => (
                <QuickEntryCard key={entry.label} entry={entry} onClick={() => navigate(entry.path)} />
              ))}
            </div>
          </div>
        )}

        {/* Guides tab */}
        {activeTab === 'guides' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {tutorials.map((guide) => (
              <TutorialCard key={guide.id} guide={guide} onNavigate={(path) => navigate(path)} />
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
      </div>
    </div>
  );
}
