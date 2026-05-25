import { useEffect, useState } from 'react';
import { Link2, FileBarChart, Building2, Sparkles, Bell, ChevronRight, LogIn } from 'lucide-react';
import { toast } from '@/lib/toast';
import { GlassCard } from '@/components/design/GlassCard';
import { useAuthStore } from '@/stores/authStore';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { ReportTeamRole } from '@/services/contracts/reportAgent';
import type { DefaultTabKey } from '@/services/contracts/reportAgent';
import { getMyDefaultTab, updateMyDefaultTab } from '@/services';
import { PersonalSourcesPanel } from './PersonalSourcesPanel';
import { AiPromptSettingsPanel } from './AiPromptSettingsPanel';
import { TeamAiPromptSettingsPanel } from './TeamAiPromptSettingsPanel';
import { TemplateManager } from './TemplateManager';
import { TeamManager } from './TeamManager';
import { WebhookSettingsPanel } from './WebhookSettingsPanel';

type SettingsSection = 'overview' | 'my-sources' | 'ai-prompt' | 'team-ai-prompt' | 'templates' | 'teams' | 'webhooks' | 'default-tab';

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
    key: 'default-tab',
    label: '自定义登录页面',
    desc: '设置每次进入周报 Agent 时默认打开的页面',
    icon: LogIn,
    color: 'rgba(20, 184, 166, 0.85)',
    isPersonal: true,
  },
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
        {activeSection === 'default-tab' && <DefaultTabSettingPanel />}
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

// ── 自定义登录页面 ──

interface DefaultTabOption {
  key: DefaultTabKey;
  label: string;
  desc: string;
}

const DEFAULT_TAB_OPTIONS: DefaultTabOption[] = [
  { key: 'team', label: '团队', desc: '默认进入团队面板（推荐：有团队成员关系时）' },
  { key: 'dailyLog', label: '日常记录', desc: '每天先来打点，再写周报' },
  { key: 'report', label: '周报', desc: '直接查看 / 创建周报' },
  { key: 'settings', label: '设置', desc: '直接进入设置（不常用）' },
];

function DefaultTabSettingPanel() {
  // 未设置偏好时显示为「团队」(规则 #2 默认值)
  const [current, setCurrent] = useState<DefaultTabKey>('team');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await getMyDefaultTab();
      if (res.success && res.data) {
        setCurrent((res.data.tab as DefaultTabKey | null) ?? 'team');
      }
      setLoaded(true);
    })();
  }, []);

  const handleSelect = async (next: DefaultTabKey) => {
    if (saving || next === current) return;
    const prev = current;
    setCurrent(next);
    setSaving(true);
    const res = await updateMyDefaultTab({ tab: next });
    setSaving(false);
    if (res.success) {
      toast.success('已保存默认登录页面');
    } else {
      setCurrent(prev);
      toast.error(res.error?.message || '保存失败');
    }
  };

  return (
    <GlassCard variant="subtle" className="p-5 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <LogIn size={16} style={{ color: 'rgba(20, 184, 166, 0.9)' }} />
        <span className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          自定义登录页面
        </span>
      </div>
      <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
        每次进入周报 Agent 时默认打开的页面。默认为「团队」。
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
        {DEFAULT_TAB_OPTIONS.map((opt) => {
          const isActive = current === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              className="text-left px-3 py-2.5 rounded-lg transition-all duration-150 disabled:opacity-60"
              style={{
                background: isActive ? 'rgba(20, 184, 166, 0.10)' : 'var(--bg-tertiary)',
                border: `1px solid ${isActive ? 'rgba(20, 184, 166, 0.45)' : 'var(--border-primary)'}`,
                cursor: saving ? 'progress' : 'pointer',
              }}
              onClick={() => void handleSelect(opt.key)}
              disabled={!loaded || saving}
            >
              <div className="flex items-center gap-2">
                <span
                  className="w-3.5 h-3.5 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{
                    background: isActive ? 'rgba(20, 184, 166, 0.95)' : 'transparent',
                    border: `1px solid ${isActive ? 'rgba(20, 184, 166, 0.95)' : 'rgba(148, 163, 184, 0.45)'}`,
                  }}
                >
                  {isActive && <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'white' }} />}
                </span>
                <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  {opt.label}
                </span>
              </div>
              <div className="text-[11px] mt-1 ml-5" style={{ color: 'var(--text-muted)' }}>
                {opt.desc}
              </div>
            </button>
          );
        })}
      </div>
    </GlassCard>
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
