import { useMemo } from 'react';
import {
  CalendarCheck,
  ClipboardList,
  FileText,
  Settings,
  Sparkles,
  Users,
} from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
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

const MODULE_LABELS: Record<UsageGuideModule, string> = {
  report: '周报',
  team: '团队',
  settings: '设置',
};

/**
 * 「使用指引」弹窗（标准居中弹窗版本）
 *
 * 改造说明：原实现是定位在侧栏右侧的半浮层（没有遮罩、top=58 显得不伦不类），
 * 用户反馈「太丑、不伦不类」。现改用全局 Dialog 组件：
 *   - 深色蒙版（rgba(0,0,0,0.72)）
 *   - createPortal 到 body（Radix Dialog 内置）
 *   - ESC / 点击蒙版关闭（Radix Dialog 内置）
 *   - 居中，宽度 max 720px
 *   - 三张操作卡片仍然保留，点击后切换到对应 Tab 并关闭弹窗
 */
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

  const flowText = useMemo(() => {
    if (moduleKey === 'report') {
      return role === 'manager'
        ? '推荐流程：团队配置 → 成员填写周报 → 团队查看与跟进'
        : '推荐流程：日常记录 → 写周报 → 提交 → 根据反馈修订';
    }
    if (moduleKey === 'team') {
      return role === 'manager'
        ? '推荐流程：选择周次 → 查看提交状态 → AI 汇总 → 团队跟进'
        : '推荐流程：查看团队状态 → 响应反馈 → 回周报修订';
    }
    return role === 'manager'
      ? '推荐流程：团队管理 → 模板管理 → 数据源与 Prompt 配置'
      : '推荐流程：个人数据源配置 → Prompt 调整 → 开始写周报';
  }, [moduleKey, role]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title={`使用指引 · ${MODULE_LABELS[moduleKey]}`}
      description="选择你的角色，查看推荐操作与流程。这是辅助引导层，不影响正式功能页面。"
      maxWidth={720}
      content={
        <div className="flex flex-col gap-4">
          <SegmentedTabs
            items={[
              { key: 'manager', label: '团队管理员' },
              { key: 'member', label: '团队成员' },
            ]}
            value={role}
            onChange={onRoleChange}
            ariaLabel="使用指引角色切换"
          />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.key}
                  className="rounded-xl p-3 border flex flex-col"
                  style={{ background: 'rgba(255, 255, 255, 0.03)', borderColor: 'var(--border-primary)' }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Icon size={14} style={{ color: 'var(--text-secondary)' }} />
                    <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      {item.title}
                    </div>
                  </div>
                  <div className="text-[12px] mb-3 flex-1" style={{ color: 'var(--text-muted)' }}>
                    {item.desc}
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="whitespace-nowrap self-start"
                    onClick={() => {
                      item.action();
                      onClose();
                    }}
                  >
                    {item.actionLabel}
                  </Button>
                </div>
              );
            })}
          </div>

          <div
            className="text-[12px] rounded-lg px-3 py-2"
            style={{ background: 'rgba(255, 255, 255, 0.03)', color: 'var(--text-secondary)' }}
          >
            {flowText}
          </div>
        </div>
      }
    />
  );
}
