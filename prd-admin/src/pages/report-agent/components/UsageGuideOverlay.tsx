import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowRight,
  CalendarCheck,
  ClipboardList,
  FileText,
  Settings,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { SegmentedTabs } from '@/components/design/SegmentedTabs';

export type UsageGuideRole = 'manager' | 'member';
export type UsageGuideModule = 'report' | 'team' | 'settings';

interface UsageGuideOverlayProps {
  open: boolean;
  moduleKey: UsageGuideModule;
  role: UsageGuideRole;
  onRoleChange: (next: UsageGuideRole) => void;
  onClose: () => void;
  onSwitchTab: (tab: UsageGuideModule) => void;
  onOpenDailyLog: () => void;
  onCreateReport: () => void;
}

interface GuideActionItem {
  key: string;
  title: string;
  desc: string;
  actionLabel: string;
  icon: React.ElementType;
  action: () => void;
}

interface GuideFlowStep {
  key: string;
  label: string;
}

const MODULE_VISUALS: Record<UsageGuideModule, {
  accent: string;
  accentSoft: string;
  border: string;
}> = {
  report: {
    accent: 'rgba(129, 140, 248, 0.92)',
    accentSoft: 'rgba(129, 140, 248, 0.2)',
    border: 'rgba(129, 140, 248, 0.28)',
  },
  team: {
    accent: 'rgba(45, 212, 191, 0.92)',
    accentSoft: 'rgba(45, 212, 191, 0.18)',
    border: 'rgba(45, 212, 191, 0.24)',
  },
  settings: {
    accent: 'rgba(251, 191, 36, 0.92)',
    accentSoft: 'rgba(251, 191, 36, 0.18)',
    border: 'rgba(251, 191, 36, 0.24)',
  },
};

export function UsageGuideOverlay(props: UsageGuideOverlayProps) {
  const {
    open,
    moduleKey,
    role,
    onRoleChange,
    onClose,
    onSwitchTab,
    onOpenDailyLog,
    onCreateReport,
  } = props;
  const [leftOffset, setLeftOffset] = useState(16);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const updateLeftOffset = () => {
      const aside = document.querySelector('aside');
      if (!(aside instanceof HTMLElement)) {
        setLeftOffset(16);
        return;
      }
      const rect = aside.getBoundingClientRect();
      const isVisible = rect.width > 0 && rect.right > 0 && rect.left < window.innerWidth;
      setLeftOffset(isVisible ? Math.max(16, Math.round(rect.right + 12)) : 16);
    };
    updateLeftOffset();
    window.addEventListener('resize', updateLeftOffset);
    return () => {
      window.removeEventListener('resize', updateLeftOffset);
    };
  }, [open]);

  const items = useMemo<GuideActionItem[]>(() => {
    if (moduleKey === 'report') {
      if (role === 'manager') {
        return [
          {
            key: 'report-manager-team',
            title: '团队与成员管理',
            desc: '维护团队成员角色，明确协作边界。',
            actionLabel: '去设置',
            icon: Users,
            action: () => onSwitchTab('settings'),
          },
          {
            key: 'report-manager-template',
            title: '模板与数据源配置',
            desc: '统一周报结构与数据来源口径。',
            actionLabel: '去设置',
            icon: Settings,
            action: () => onSwitchTab('settings'),
          },
          {
            key: 'report-manager-follow',
            title: '团队周报跟进',
            desc: '查看提交状态并集中处理问题。',
            actionLabel: '去团队',
            icon: ClipboardList,
            action: () => onSwitchTab('team'),
          },
        ];
      }
      return [
        {
          key: 'report-member-dailylog',
          title: '日常记录',
          desc: '随手记录工作事项，沉淀周报素材。',
          actionLabel: '去日常记录',
          icon: CalendarCheck,
          action: onOpenDailyLog,
        },
        {
          key: 'report-member-write',
          title: '写周报',
          desc: '按模板快速生成并完善周报内容。',
          actionLabel: '去写周报',
          icon: FileText,
          action: onCreateReport,
        },
        {
          key: 'report-member-revise',
          title: '提交与修订',
          desc: '查看状态并根据反馈继续修订。',
          actionLabel: '查看周报',
          icon: Sparkles,
          action: () => onSwitchTab('report'),
        },
      ];
    }

    if (moduleKey === 'team') {
      if (role === 'manager') {
        return [
          {
            key: 'team-manager-overview',
            title: '团队周报概览',
            desc: '按周查看成员提交进度与状态。',
            actionLabel: '查看团队',
            icon: ClipboardList,
            action: () => onSwitchTab('team'),
          },
          {
            key: 'team-manager-summary',
            title: '团队 AI 汇总',
            desc: '快速生成团队周总结与风险提示。',
            actionLabel: '去团队',
            icon: Sparkles,
            action: () => onSwitchTab('team'),
          },
          {
            key: 'team-manager-member',
            title: '成员协作管理',
            desc: '针对成员状态进行跟进和协同。',
            actionLabel: '去团队',
            icon: Users,
            action: () => onSwitchTab('team'),
          },
        ];
      }
      return [
        {
          key: 'team-member-status',
          title: '查看团队要求',
          desc: '了解团队当前周次目标与状态。',
          actionLabel: '去团队',
          icon: Users,
          action: () => onSwitchTab('team'),
        },
        {
          key: 'team-member-fix',
          title: '处理反馈并修订',
          desc: '根据团队反馈回到周报继续完善。',
          actionLabel: '去周报',
          icon: FileText,
          action: () => onSwitchTab('report'),
        },
        {
          key: 'team-member-dailylog',
          title: '同步日常进展',
          desc: '补充日常记录，保证周报素材完整。',
          actionLabel: '去日常记录',
          icon: CalendarCheck,
          action: onOpenDailyLog,
        },
      ];
    }

    if (role === 'manager') {
      return [
        {
          key: 'settings-manager-team',
          title: '团队管理配置',
          desc: '管理团队成员、角色和组织关系。',
          actionLabel: '去设置',
          icon: Users,
          action: () => onSwitchTab('settings'),
        },
        {
          key: 'settings-manager-template',
          title: '模板管理配置',
          desc: '配置周报章节结构和填写规范。',
          actionLabel: '去设置',
          icon: FileText,
          action: () => onSwitchTab('settings'),
        },
        {
          key: 'settings-manager-source',
          title: '数据源与提示词',
          desc: '统一管理数据源与 AI Prompt。',
          actionLabel: '去设置',
          icon: Settings,
          action: () => onSwitchTab('settings'),
        },
      ];
    }

    return [
      {
        key: 'settings-member-source',
        title: '我的数据源',
        desc: '配置个人可用的数据来源与开关。',
        actionLabel: '去设置',
        icon: Settings,
        action: () => onSwitchTab('settings'),
      },
      {
        key: 'settings-member-prompt',
        title: '个人 Prompt',
        desc: '微调生成风格，提升周报质量。',
        actionLabel: '去设置',
        icon: Sparkles,
        action: () => onSwitchTab('settings'),
      },
      {
        key: 'settings-member-write',
        title: '配置后开始写周报',
        desc: '完成设置后快速进入周报编辑。',
        actionLabel: '去写周报',
        icon: FileText,
        action: onCreateReport,
      },
    ];
  }, [moduleKey, role, onCreateReport, onOpenDailyLog, onSwitchTab]);

  const flowSteps = useMemo<GuideFlowStep[]>(() => {
    if (moduleKey === 'report') {
      return role === 'manager'
        ? [
            { key: 'team-config', label: '团队配置' },
            { key: 'member-write', label: '成员填写周报' },
            { key: 'team-follow', label: '查看与跟进' },
          ]
        : [
            { key: 'daily-log', label: '日常记录' },
            { key: 'write-report', label: '写周报' },
            { key: 'revise-report', label: '根据反馈修订' },
          ];
    }
    if (moduleKey === 'team') {
      return role === 'manager'
        ? [
            { key: 'choose-week', label: '选择周次' },
            { key: 'check-status', label: '查看提交状态' },
            { key: 'team-summary', label: '汇总与跟进' },
          ]
        : [
            { key: 'team-status', label: '查看团队状态' },
            { key: 'respond-feedback', label: '响应反馈' },
            { key: 'revise-from-team', label: '回周报修订' },
          ];
    }
    return role === 'manager'
      ? [
          { key: 'team-manage', label: '团队管理' },
          { key: 'template-manage', label: '模板管理' },
          { key: 'data-source', label: '数据源与 Prompt 配置' },
        ]
      : [
          { key: 'personal-source', label: '个人数据源配置' },
          { key: 'prompt-tune', label: 'Prompt 调整' },
          { key: 'start-write', label: '开始写周报' },
        ];
  }, [moduleKey, role]);

  const visual = MODULE_VISUALS[moduleKey];

  if (!open || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div className="fixed right-0 bottom-0 z-[1200]" style={{ top: 58, left: leftOffset }}>
      <div
        className="absolute inset-0"
        aria-hidden="true"
        style={{
          background: `
            radial-gradient(circle at 50% 12%, ${visual.accentSoft} 0%, transparent 36%),
            linear-gradient(180deg, rgba(4, 7, 16, 0.76) 0%, rgba(7, 10, 18, 0.7) 28%, rgba(8, 11, 19, 0.82) 100%)
          `,
          backdropFilter: 'blur(10px) saturate(115%)',
          WebkitBackdropFilter: 'blur(10px) saturate(115%)',
        }}
        onClick={onClose}
      />
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          background: `
            radial-gradient(circle at 50% 18%, rgba(255, 255, 255, 0.06) 0%, transparent 24%),
            radial-gradient(circle at 50% 100%, rgba(0, 0, 0, 0.34) 0%, transparent 46%)
          `,
        }}
      />

      <div className="relative z-10 h-full overflow-y-auto px-4 py-6 md:px-6 md:py-8">
        <div className="mx-auto w-full max-w-[1100px]" onClick={(e) => e.stopPropagation()}>
          <GlassCard
            variant="subtle"
            glow
            overflow="hidden"
            className="border prd-dialog-content"
            style={{
              borderColor: visual.border,
              background: `
                radial-gradient(circle at 50% 0%, rgba(255, 255, 255, 0.08) 0%, transparent 34%),
                linear-gradient(180deg, rgba(22, 25, 39, 0.94) 0%, rgba(14, 17, 29, 0.94) 100%)
              `,
              boxShadow: `0 28px 80px rgba(0, 0, 0, 0.42), 0 0 0 1px ${visual.border} inset, 0 10px 40px ${visual.accentSoft}`,
            }}
          >
            <div
              className="pointer-events-none absolute inset-0"
              aria-hidden="true"
              style={{
                background: `
                  radial-gradient(circle at 18% 10%, ${visual.accentSoft} 0%, transparent 28%),
                  radial-gradient(circle at 85% 14%, rgba(255, 255, 255, 0.06) 0%, transparent 24%)
                `,
              }}
            />

            <div className="relative">
              <button
                type="button"
                aria-label="关闭使用指引"
                className="absolute top-4 right-4 z-10 w-10 h-10 rounded-2xl flex items-center justify-center transition-transform duration-200 hover:scale-[1.02]"
                style={{
                  color: 'var(--text-secondary)',
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                }}
                onClick={onClose}
              >
                <X size={16} />
              </button>

              <div className="px-5 pt-5 md:px-6 md:pt-6">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="inline-flex items-center gap-2 text-[11px] font-medium tracking-[0.08em]" style={{ color: 'var(--text-muted)' }}>
                      <Sparkles size={12} style={{ color: visual.accent }} />
                      角色视角
                    </div>
                    <div className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                      切换后会同步更新当前模块的推荐动作与路径。
                    </div>
                  </div>
                  <SegmentedTabs
                    items={[
                      { key: 'manager', label: '团队管理员' },
                      { key: 'member', label: '团队成员' },
                    ]}
                    value={role}
                    onChange={onRoleChange}
                    ariaLabel="使用指引角色切换"
                  />
                </div>
              </div>

              <div className="px-5 py-5 md:px-6">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {items.map((item, index) => {
                    const Icon = item.icon;
                    return (
                      <div
                        key={item.key}
                        className="group rounded-[20px] p-4 border transition-all duration-200"
                        style={{
                          background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.055) 0%, rgba(255, 255, 255, 0.025) 100%)',
                          borderColor: 'rgba(255, 255, 255, 0.1)',
                          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 24px rgba(0,0,0,0.12)',
                        }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div
                            className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0"
                            style={{
                              background: visual.accentSoft,
                              border: `1px solid ${visual.border}`,
                              boxShadow: `0 10px 24px ${visual.accentSoft}`,
                            }}
                          >
                            <Icon size={16} style={{ color: visual.accent }} />
                          </div>
                          <div
                            className="inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-medium shrink-0"
                            style={{
                              color: 'rgba(255,255,255,0.76)',
                              background: 'rgba(255,255,255,0.05)',
                              border: '1px solid rgba(255,255,255,0.08)',
                            }}
                          >
                            步骤 {index + 1}
                          </div>
                        </div>

                        <div className="mt-4 text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                          {item.title}
                        </div>
                        <div className="mt-2 min-h-[42px] text-[12px] leading-6" style={{ color: 'var(--text-muted)' }}>
                          {item.desc}
                        </div>

                        <div className="mt-5 flex items-center justify-between gap-3">
                          <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                            推荐优先处理
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            className="whitespace-nowrap"
                            onClick={() => {
                              item.action();
                              onClose();
                            }}
                          >
                            {item.actionLabel}
                            <ArrowRight size={13} />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div
                  className="mt-5 rounded-[20px] px-4 py-4 border"
                  style={{
                    background: 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.025) 100%)',
                    borderColor: 'rgba(255,255,255,0.08)',
                  }}
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <div className="text-[11px] font-medium tracking-[0.08em]" style={{ color: 'var(--text-muted)' }}>
                        推荐流程
                      </div>
                      <div className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                        先按下面路径理解模块，再进入正式功能操作。
                      </div>
                    </div>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      点击暗幕或按 Esc 可关闭
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2.5">
                    {flowSteps.map((step, index) => (
                      <div key={step.key} className="flex items-center gap-2.5">
                        <div
                          className="inline-flex items-center rounded-full px-3 py-1.5 text-[12px] font-medium"
                          style={{
                            color: 'var(--text-primary)',
                            background: index === 0 ? visual.accentSoft : 'rgba(255,255,255,0.05)',
                            border: `1px solid ${index === 0 ? visual.border : 'rgba(255,255,255,0.08)'}`,
                          }}
                        >
                          {step.label}
                        </div>
                        {index < flowSteps.length - 1 && (
                          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            →
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </GlassCard>
        </div>
      </div>
    </div>,
    document.body
  );
}
