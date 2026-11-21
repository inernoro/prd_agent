import { useEffect, useState } from 'react';
import { apiRequest, ApiError } from '@/lib/api';
import type { DebtStatus, PlanningCommand, PlanningEventKind, PlanningSource } from '../../../../src/shared/engineering-planning';

type WithoutRequest<C> = C extends PlanningCommand ? Omit<C, 'requestId'> : never;
export type PlanningInput = WithoutRequest<PlanningCommand>;
export type PlanningProject = { id: string; name: string; aliasName?: string; mirror?: unknown };
export type PlanningView = 'plan' | 'timeline' | 'debts' | 'map' | 'evolution';

export const views: readonly PlanningView[] = ['plan', 'timeline', 'debts', 'map', 'evolution'];
export const viewLabels: Record<PlanningView, string> = {
  plan: '推进', timeline: '时间线', debts: '清单', map: '图谱', evolution: '演进',
};
export const debtLabels: Record<DebtStatus, string> = {
  open: '待处理', deferred: '已暂缓', in_progress: '处理中', repaid: '已偿还', dropped: '已失效',
};
export const decisionLabels = { proposed: '提议中', accepted: '已采纳', superseded: '已取代', deprecated: '已废弃' };
export const kindLabels = { decision: '决策', debt: '债务', plan: '计划', proposal: '提案' };
export const stepLabels = { todo: '待处理', doing: '进行中', done: '已完成', cancelled: '已取消' };
export const stepKindLabels = { task: '任务', decision: '落地决策', debt: '偿还债务', review: '复核决策', design: '定稿并通过做法验收' };
export const priorityLabels = { high: '高', mid: '中', low: '低' };
export const sourceLabels: Record<PlanningSource['type'], string> = {
  manual: '手动记录', review: '代码审查', test: '测试验收', incident: '故障复盘', code: '代码', adr: '决策文档', import: '历史台账',
};
export const events: Record<PlanningEventKind, string> = {
  created: '登记', imported: '导入', updated: '补充记录', deferred: '暂缓', started: '开始处理', progress: '记录进展',
  repaid: '偿还', reopened: '重开', dropped: '失效', extinct: '随功能消失', merged: '接纳合并', merged_into: '并入其他债务',
  verified: '认证债务', anchor_bound: '绑定功能', anchor_kept: '保留债务', extinct_pending: '疑似随功能消失', not_duplicate: '确认不同问题',
  dup_flagged: '巡检发现疑似重复', planned: '排入计划',
  hit: '又踩到一次', branch_moved: '改挂决策', proposed: '提出', accepted: '确认', rejected: '驳回',
  amended: '补充说明', reviewed: '复核', superseded: '取代', deprecated: '废弃', step_added: '添加步骤', step_changed: '更新步骤',
};
export const shortId = (id: string) => id.split('-').slice(0, 2).join('-');
export const closedDebt = (status: DebtStatus) => status === 'repaid' || status === 'dropped';
export const planningPath = (id: string) => `/api/projects/${encodeURIComponent(id)}/planning`;
export const dateLabel = (at: string) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(at));

export function planningError(error: unknown) {
  if (error instanceof ApiError && error.status === 409) return error.message || '记录已经变化，请刷新后重试';
  return error instanceof ApiError ? error.message : '暂时无法连接工程规划，请检查连接后重试';
}

type Read<T> = { key: string; data?: T; error?: string };
export function usePlanningRead<T>(path: string | null, reload: number): Omit<Read<T>, 'key'> & { loading: boolean } {
  const [state, setState] = useState<Read<T>>({ key: '' });
  const key = `${path ?? ''}\n${reload}`;
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    void apiRequest<T>(path, { signal: controller.signal, headers: { 'X-CDS-Poll': 'true' } })
      .then(data => { if (!controller.signal.aborted) setState({ key, data }); })
      .catch(error => { if (!controller.signal.aborted) setState({ key, error: planningError(error) }); });
    return () => controller.abort();
  }, [path, key]);
  if (path === null) return { loading: false };
  if (state.key === key) return { data: state.data, error: state.error, loading: false };
  return { data: state.key.startsWith(`${path}\n`) ? state.data : undefined, loading: true };
}
