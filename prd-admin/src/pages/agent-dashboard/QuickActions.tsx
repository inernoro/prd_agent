/**
 * 快捷操作组件
 *
 * 常用操作的快捷入口
 */

import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Store,
  ScrollText,
  Cpu,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { cn } from '@/lib/cn';

/** 图标映射 */
const ICON_MAP: Record<string, LucideIcon> = {
  Plus,
  Store,
  ScrollText,
  Cpu,
  Settings,
};

interface QuickAction {
  key: string;
  label: string;
  icon: string;
  route: string;
  description?: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    key: 'new-prd-session',
    label: '新建 PRD 会话',
    icon: 'Plus',
    route: '/prd-agent',
    description: '开始新的 PRD 分析对话',
  },
  {
    key: 'new-canvas',
    label: '新建画布',
    icon: 'Plus',
    route: '/visual-agent',
    description: '创建新的视觉创作画布',
  },
  {
    key: 'marketplace',
    label: '配置市场',
    icon: 'Store',
    route: '/literary-agent',
    description: '浏览社区配置',
  },
  {
    key: 'llm-logs',
    label: '调用日志',
    icon: 'ScrollText',
    route: '/logs',
    description: '查看 LLM 请求日志',
  },
  {
    key: 'model-manage',
    label: '模型管理',
    icon: 'Cpu',
    route: '/mds',
    description: '管理 LLM 模型配置',
  },
];

function QuickActionItem({ action }: { action: QuickAction }) {
  const navigate = useNavigate();
  const Icon = ICON_MAP[action.icon] || Plus;

  return (
    <button
      type="button"
      onClick={() => navigate(action.route)}
      className={cn(
        'flex items-center gap-3 w-full px-4 py-3 rounded-[14px]',
        'transition-all duration-200 ease-out',
        'hover:bg-white/5 active:bg-white/8',
        'outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-gold)]/50',
        'text-left'
      )}
    >
      <div
        className="w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0"
        style={{ background: 'rgba(255, 255, 255, 0.06)' }}
      >
        <Icon size={18} style={{ color: 'var(--text-secondary)' }} />
      </div>

      <div className="flex-1 min-w-0">
        <div
          className="text-[14px] font-medium"
          style={{ color: 'var(--text-primary)' }}
        >
          {action.label}
        </div>
        {action.description && (
          <div
            className="text-[12px] mt-0.5 truncate"
            style={{ color: 'var(--text-muted)' }}
          >
            {action.description}
          </div>
        )}
      </div>
    </button>
  );
}

export function QuickActions() {
  return (
    <GlassCard className="p-4">
      <div
        className="flex items-center gap-2 px-2 mb-3 text-[12px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text-muted)' }}
      >
        <span>⚡</span>
        <span>快捷操作</span>
      </div>

      <div className="space-y-1">
        {QUICK_ACTIONS.map((action) => (
          <QuickActionItem key={action.key} action={action} />
        ))}
      </div>
    </GlassCard>
  );
}

export default QuickActions;
