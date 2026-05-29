import type {
  PmProjectType,
  PmProjectLifecycle,
  PmTaskStatus,
  PmTaskPriority,
  PmOperationSubType,
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

// ── 优先级注册表 ──
export const PRIORITY_REGISTRY: Record<PmTaskPriority, { label: string; color: string; weight: number }> = {
  urgent: { label: '紧急', color: '#EF4444', weight: 4 },
  high: { label: '高', color: '#F59E0B', weight: 3 },
  medium: { label: '中', color: '#3B82F6', weight: 2 },
  low: { label: '低', color: '#6B7280', weight: 1 },
  none: { label: '无', color: '#9CA3AF', weight: 0 },
};
