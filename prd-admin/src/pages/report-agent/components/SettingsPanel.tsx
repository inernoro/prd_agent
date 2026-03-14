import { useState } from 'react';
import { Link2, FileBarChart, Building2, GitBranch, ChevronRight } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { PersonalSourcesPanel } from './PersonalSourcesPanel';
import { TemplateManager } from './TemplateManager';
import { TeamManager } from './TeamManager';
import { DataSourceManager } from './DataSourceManager';
import { HistoryTrendsPanel } from './HistoryTrendsPanel';

type SettingsSection = 'overview' | 'my-sources' | 'templates' | 'teams' | 'data-sources' | 'trends';

interface SectionDef {
  key: SettingsSection;
  label: string;
  desc: string;
  icon: React.ElementType;
  color: string;
  requirePerm?: string;
  isPersonal?: boolean;
}

const SECTIONS: SectionDef[] = [
  {
    key: 'my-sources',
    label: '我的数据源',
    desc: '绑定 GitHub / GitLab / 语雀，自动采集提交和文档',
    icon: Link2,
    color: 'rgba(59, 130, 246, 0.85)',
    isPersonal: true,
  },
  {
    key: 'trends',
    label: '数据统计',
    desc: '查看个人和团队的周报趋势',
    icon: GitBranch,
    color: 'rgba(20, 184, 166, 0.85)',
    isPersonal: true,
  },
  {
    key: 'templates',
    label: '模板管理',
    desc: '设置周报模板结构和填写指引',
    icon: FileBarChart,
    color: 'rgba(168, 85, 247, 0.85)',
    requirePerm: 'report-agent.template.manage',
  },
  {
    key: 'teams',
    label: '团队管理',
    desc: '管理团队成员、角色和身份映射',
    icon: Building2,
    color: 'rgba(249, 115, 22, 0.85)',
    requirePerm: 'report-agent.team.manage',
  },
  {
    key: 'data-sources',
    label: '团队数据源',
    desc: '配置团队级 Git 仓库、分支过滤和用户映射',
    icon: GitBranch,
    color: 'rgba(34, 197, 94, 0.85)',
    requirePerm: 'report-agent.datasource.manage',
  },
];

export function SettingsPanel() {
  const [activeSection, setActiveSection] = useState<SettingsSection>('overview');
  const permissions = useAuthStore((s) => s.permissions);
  const isSuper = permissions.includes('super');

  const visibleSections = SECTIONS.filter((s) => {
    if (s.isPersonal) return true;
    if (!s.requirePerm) return true;
    return isSuper || permissions.includes(s.requirePerm);
  });

  // Overview — section cards
  if (activeSection === 'overview') {
    return (
      <div className="flex flex-col gap-4">
        {/* Personal section */}
        <div className="px-1">
          <span className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>
            个人设置
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {visibleSections.filter((s) => s.isPersonal).map((section) => (
            <SettingSectionCard
              key={section.key}
              section={section}
              onClick={() => setActiveSection(section.key)}
            />
          ))}
        </div>

        {/* Admin sections */}
        {visibleSections.some((s) => !s.isPersonal) && (
          <>
            <div className="px-1 mt-2">
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>
                管理设置
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {visibleSections.filter((s) => !s.isPersonal).map((section) => (
                <SettingSectionCard
                  key={section.key}
                  section={section}
                  onClick={() => setActiveSection(section.key)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  // Sub-page with back navigation
  const currentSection = SECTIONS.find((s) => s.key === activeSection);

  return (
    <div className="flex flex-col gap-3 h-full">
      <button
        onClick={() => setActiveSection('overview')}
        className="flex items-center gap-2 px-1 text-[13px] font-medium cursor-pointer transition-colors hover:opacity-80"
        style={{ color: 'var(--text-secondary)' }}
      >
        <ChevronRight size={14} className="rotate-180" />
        返回设置
        {currentSection && (
          <span style={{ color: 'var(--text-muted)' }}>/ {currentSection.label}</span>
        )}
      </button>
      <div className="flex-1 min-h-0">
        {activeSection === 'my-sources' && <PersonalSourcesPanel />}
        {activeSection === 'templates' && <TemplateManager />}
        {activeSection === 'teams' && <TeamManager />}
        {activeSection === 'data-sources' && <DataSourceManager />}
        {activeSection === 'trends' && <HistoryTrendsPanel />}
      </div>
    </div>
  );
}

function SettingSectionCard({ section, onClick }: { section: SectionDef; onClick: () => void }) {
  const Icon = section.icon;
  return (
    <div
      onClick={onClick}
      className="group cursor-pointer rounded-xl p-4 transition-all duration-200 hover:translate-y-[-1px]"
      style={{
        background: 'var(--surface-glass)',
        backdropFilter: 'blur(12px)',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: `${section.color}15` }}
        >
          <Icon size={18} style={{ color: section.color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold mb-0.5" style={{ color: 'var(--text-primary)' }}>
            {section.label}
          </div>
          <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {section.desc}
          </div>
        </div>
        <ChevronRight size={14} style={{ color: 'var(--text-muted)', opacity: 0.4 }} className="mt-1 flex-shrink-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </div>
  );
}
