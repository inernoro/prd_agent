import { useEffect, useState } from 'react';
import { Link2, FileBarChart, Building2, Sparkles, Bell, ChevronRight } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { useAuthStore } from '@/stores/authStore';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { ReportTeamRole } from '@/services/contracts/reportAgent';
import { PersonalSourcesPanel } from './PersonalSourcesPanel';
import { AiPromptSettingsPanel } from './AiPromptSettingsPanel';
import { TeamAiPromptSettingsPanel } from './TeamAiPromptSettingsPanel';
import { TemplateManager } from './TemplateManager';
import { TeamManager } from './TeamManager';
import { WebhookSettingsPanel } from './WebhookSettingsPanel';

type SettingsSection = 'overview' | 'my-sources' | 'ai-prompt' | 'team-ai-prompt' | 'templates' | 'teams' | 'webhooks';

interface SectionDef {
  key: SettingsSection;
  label: string;
  desc: string;
  icon: React.ElementType;
  color: string;
  requirePerm?: string;
  /** 自定义可见性函数，若存在则优先生效；返回 true 表示可见 */
  customGate?: (ctx: { isLeaderOrDeputyOfAny: boolean; permissions: string[]; isSuper: boolean }) => boolean;
  isPersonal?: boolean;
}

const SECTIONS: SectionDef[] = [
  {
    key: 'my-sources',
    label: '我的数据源',
    desc: '管理 AI 周报的数据源开关与个人扩展数据源',
    icon: Link2,
    color: 'rgba(59, 130, 246, 0.85)',
    isPersonal: true,
  },
  {
    key: 'ai-prompt',
    label: 'AI生成周报Prompt',
    desc: '配置 AI 生成周报时的系统默认与个人自定义 Prompt',
    icon: Sparkles,
    color: 'rgba(168, 85, 247, 0.85)',
    isPersonal: true,
  },
  {
    key: 'templates',
    label: '模板管理',
    desc: '设置周报模板结构与团队默认',
    icon: FileBarChart,
    color: 'rgba(168, 85, 247, 0.85)',
    // 入口收窄：只有任一团队的管理员/副管理员可见
    customGate: ({ isLeaderOrDeputyOfAny }) => isLeaderOrDeputyOfAny,
  },
  {
    key: 'team-ai-prompt',
    label: '团队周报AI分析Prompt',
    desc: '配置团队周报AI分析汇总使用的系统默认与团队自定义 Prompt',
    icon: Sparkles,
    color: 'rgba(14, 165, 233, 0.9)',
    requirePerm: 'report-agent.team.manage',
  },
  {
    key: 'webhooks',
    label: 'Webhook 通知',
    desc: '配置企微/钉钉/飞书群消息推送',
    icon: Bell,
    color: 'rgba(34, 197, 94, 0.85)',
    requirePerm: 'report-agent.team.manage',
  },
  {
    key: 'teams',
    label: '团队管理',
    desc: '管理团队成员、角色和身份映射',
    icon: Building2,
    color: 'rgba(249, 115, 22, 0.85)',
    requirePerm: 'report-agent.team.manage',
  },
];

export function SettingsPanel() {
  const [activeSection, setActiveSection] = useState<SettingsSection>('overview');
  const permissions = useAuthStore((s) => s.permissions);
  const isSuper = permissions.includes('super');
  const userId = useAuthStore((s) => s.user?.userId);
  const teams = useReportAgentStore((s) => s.teams);
  const loadTeams = useReportAgentStore((s) => s.loadTeams);

  useEffect(() => {
    if (teams.length === 0) void loadTeams();
  }, [teams.length, loadTeams]);

  const isLeaderOrDeputyOfAny = teams.some((t) => {
    const role = t.myRole ?? (t.leaderUserId === userId ? ReportTeamRole.Leader : undefined);
    return role === ReportTeamRole.Leader || role === ReportTeamRole.Deputy;
  });

  const gateCtx = { isLeaderOrDeputyOfAny, permissions, isSuper };

  const visibleSections = SECTIONS.filter((s) => {
    if (s.isPersonal) return true;
    if (s.customGate) return s.customGate(gateCtx);
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
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
        className="flex items-center gap-2 px-2 py-1 rounded hover-bg-soft text-[13px] font-medium cursor-pointer"
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
        {activeSection === 'ai-prompt' && <AiPromptSettingsPanel />}
        {activeSection === 'team-ai-prompt' && <TeamAiPromptSettingsPanel />}
        {activeSection === 'templates' && <TemplateManager />}
        {activeSection === 'webhooks' && <WebhookSettingsPanel />}
        {activeSection === 'teams' && <TeamManager />}
      </div>
    </div>
  );
}

function SettingSectionCard({ section, onClick }: { section: SectionDef; onClick: () => void }) {
  const Icon = section.icon;
  return (
    <GlassCard interactive padding="none" onClick={onClick} className="group cursor-pointer">
      <div className="flex items-start gap-3 p-4">
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
    </GlassCard>
  );
}
