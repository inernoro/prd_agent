/**
 * Agent Dashboard API 契约
 */

/** 单个 Agent 的统计摘要 */
export interface AgentSummary {
  /** Agent 标识 */
  appKey: string;
  /** 显示名称 */
  displayName: string;
  /** 统计数量（会话数/画布数/项目数/缺陷数） */
  count: number;
  /** 最近活动描述 */
  recentActivity?: string;
  /** 最近活动时间 */
  lastActivityAt?: string;
}

/** Dashboard 汇总响应 */
export interface AgentDashboardSummaryResponse {
  /** 各 Agent 统计 */
  agents: AgentSummary[];
  /** 总交互次数 */
  totalInteractions: number;
  /** 统计周期（天） */
  periodDays: number;
}

/** 快捷操作定义 */
export interface QuickAction {
  key: string;
  label: string;
  icon: string;
  route: string;
  description?: string;
}

/** 预定义的快捷操作 */
export const QUICK_ACTIONS: QuickAction[] = [
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
    description: '浏览和获取社区配置',
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
