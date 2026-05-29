import type {
  PmProjectType,
  PmProjectLifecycle,
  PmTaskStatus,
  PmTaskPriority,
  PmOperationSubType,
  PmStakeholderRole,
  PmEvaluationGrade,
} from '@/services/contracts/pmAgent';

// ── 项目类型注册表（S / I / O）──
export const PROJECT_TYPE_REGISTRY: Record<PmProjectType, { label: string; short: string; color: string; desc: string }> = {
  strategic: { label: '战略级项目', short: 'S', color: '#EF4444', desc: '依据年度经营计划的重点项目，全流程监控、月度复盘、季度评审' },
  innovation: { label: '创新级项目', short: 'I', color: '#A855F7', desc: '基于"成就客户"的创新探索，一米宽十米深，主要做 POC' },
  operation: { label: '运营级项目', short: 'O', color: '#3B82F6', desc: '部门日常运营衍生的攻坚型项目' },
};

export const OPERATION_SUBTYPE_REGISTRY: Record<PmOperationSubType, { label: string }> = {
  routine: { label: '常规运营项目' },
  rectification: { label: '定向整改项目' },
  supervision: { label: '专项督办项目' },
};

// ── 生命周期注册表 ──
export const LIFECYCLE_REGISTRY: Record<PmProjectLifecycle, { label: string; color: string }> = {
  registered: { label: '已立项', color: '#6366F1' },
  running: { label: '进行中', color: '#3B82F6' },
  closing: { label: '结案中', color: '#F59E0B' },
  evaluated: { label: '已评价', color: '#10B981' },
  archived: { label: '已归档', color: '#6B7280' },
};

// ── 任务状态注册表（看板列顺序）──
export const TASK_STATUS_REGISTRY: Record<PmTaskStatus, { label: string; color: string }> = {
  backlog: { label: '待规划', color: '#6B7280' },
  todo: { label: '待办', color: '#3B82F6' },
  in_progress: { label: '进行中', color: '#F59E0B' },
  done: { label: '已完成', color: '#10B981' },
  cancelled: { label: '已取消', color: '#9CA3AF' },
};

/** 看板列顺序 */
export const BOARD_COLUMNS: PmTaskStatus[] = ['backlog', 'todo', 'in_progress', 'done'];

// ── 干系人角色注册表（决定打分权重）──
export const STAKEHOLDER_ROLE_REGISTRY: Record<PmStakeholderRole, { label: string; weightLabel: string; color: string }> = {
  beneficiary: { label: '客户 / 业务方', weightLabel: '50%', color: '#EF4444' },
  management: { label: '管理层', weightLabel: '20%', color: '#A855F7' },
  team: { label: '项目团队', weightLabel: '20%', color: '#3B82F6' },
  other: { label: '其他干系人', weightLabel: '10%', color: '#6B7280' },
};

// ── 权力利益矩阵四象限策略 ──
// key: `${power}-${interest}`（high/low）
export const POWER_INTEREST_MATRIX: Record<string, { label: string; strategy: string; color: string }> = {
  'high-high': { label: '重点管理', strategy: '客户/管理层/核心业务方：定期沟通，确保需求被满足', color: '#EF4444' },
  'low-high': { label: '让其参与', strategy: '项目成员/一线用户：听取意见，给予参与感', color: '#3B82F6' },
  'high-low': { label: '随时告知', strategy: '监管机构/高层：知会项目情况，避免出问题', color: '#F59E0B' },
  'low-low': { label: '持续监控', strategy: '普通公众/非直接相关方：保持监控即可', color: '#6B7280' },
};

// ── NPSS 等级注册表 ──
export const GRADE_REGISTRY: Record<PmEvaluationGrade, { label: string; color: string; desc: string }> = {
  success: { label: '成功项目', color: '#10B981', desc: '价值远大于投入，干系人非常满意（9-10 分）' },
  mediocre: { label: '平庸项目', color: '#F59E0B', desc: '有一定价值但有不足，不算完全成功（7-8 分）' },
  fail: { label: '失败项目', color: '#EF4444', desc: '价值小于投入，干系人觉得白做了（0-6 分）' },
};

/** NPSS 全球平均基线（PMI 调研） */
export const NPSS_GLOBAL_BASELINE = 36;

// ── 优先级注册表 ──
export const PRIORITY_REGISTRY: Record<PmTaskPriority, { label: string; color: string; weight: number }> = {
  urgent: { label: '紧急', color: '#EF4444', weight: 4 },
  high: { label: '高', color: '#F59E0B', weight: 3 },
  medium: { label: '中', color: '#3B82F6', weight: 2 },
  low: { label: '低', color: '#6B7280', weight: 1 },
  none: { label: '无', color: '#9CA3AF', weight: 0 },
};
