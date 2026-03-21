import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  GraduationCap, FileText, Palette, PenTool, Bug,
  ChevronRight, Video, FileBarChart, Swords, Workflow, Zap,
  Store, ArrowRight,
  type LucideIcon,
} from 'lucide-react';

// ── Tutorial index data ──

interface TutorialEntry {
  id: string;
  title: string;
  subtitle: string;
  icon: LucideIcon;
  accentColor: string;
}

const tutorials: TutorialEntry[] = [
  { id: 'prd-agent', title: 'PRD Agent', subtitle: '智能需求文档解读', icon: FileText, accentColor: '#3B82F6' },
  { id: 'visual-agent', title: '视觉创作 Agent', subtitle: '专业级 AI 图像生成', icon: Palette, accentColor: '#A855F7' },
  { id: 'literary-agent', title: '文学创作 Agent', subtitle: '智能配图与文学润色', icon: PenTool, accentColor: '#F59E0B' },
  { id: 'defect-agent', title: '缺陷管理 Agent', subtitle: 'AI 驱动的缺陷管理', icon: Bug, accentColor: '#10B981' },
  { id: 'video-agent', title: '视频创作 Agent', subtitle: '文章一键转视频', icon: Video, accentColor: '#F43F5E' },
  { id: 'report-agent', title: '周报管理 Agent', subtitle: 'AI 辅助周报生成', icon: FileBarChart, accentColor: '#6366F1' },
  { id: 'arena', title: 'AI 竞技场', subtitle: '多模型盲测对比', icon: Swords, accentColor: '#F59E0B' },
  { id: 'workflow-agent', title: '工作流引擎', subtitle: '可视化流程编排', icon: Workflow, accentColor: '#14B8A6' },
  { id: 'shortcuts-agent', title: '快捷指令', subtitle: 'iOS 一键调用 AI', icon: Zap, accentColor: '#F59E0B' },
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

type TabKey = 'quick' | 'guides';

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

function TutorialRow({ tutorial, onClick }: { tutorial: TutorialEntry; onClick: () => void }) {
  const Icon = tutorial.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-4 px-5 py-4 rounded-xl text-left transition-all duration-200 w-full"
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-default)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = `${tutorial.accentColor}40`;
        e.currentTarget.style.boxShadow = `0 4px 16px ${tutorial.accentColor}12`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-default)';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
        style={{ background: `${tutorial.accentColor}15` }}
      >
        <Icon className="w-5 h-5" style={{ color: tutorial.accentColor }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{tutorial.title}</div>
        <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{tutorial.subtitle}</div>
      </div>
      <ChevronRight
        className="w-4 h-4 flex-shrink-0 opacity-40 group-hover:opacity-80 group-hover:translate-x-0.5 transition-all"
        style={{ color: 'var(--text-muted)' }}
      />
    </button>
  );
}

// ── Page ──

export default function TutorialsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('quick');
  const navigate = useNavigate();

  const tabs: { key: TabKey; label: string; icon: LucideIcon; count?: number }[] = [
    { key: 'quick', label: '快速操作', icon: Zap, count: quickEntries.length },
    { key: 'guides', label: '上手教程', icon: GraduationCap, count: tutorials.length },
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
          <div className="flex flex-col gap-3">
            {tutorials.map((tutorial) => (
              <TutorialRow
                key={tutorial.id}
                tutorial={tutorial}
                onClick={() => navigate(`/tutorials/${tutorial.id}`)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
