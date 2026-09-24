import type { UptimeTargetSummary } from './monitorCenter';
import { assessCell, assessFreshness } from './ownerBoard';

export type HomeState = 'down' | 'overdue' | 'unknown' | 'paused' | 'up';
export const HOME_STATES: Record<HomeState, string> = {
  down: '待处理', overdue: '检查逾期', unknown: '待确认', paused: '已暂停', up: '正常',
};
const ORDER: Record<HomeState, number> = { down: 0, overdue: 1, unknown: 2, paused: 3, up: 4 };

export function homeState(target: UptimeTargetSummary, now: number): HomeState {
  if (target.status === 'paused' || target.enabled === false || target.excluded) return 'paused';
  const freshness = assessFreshness(target, now);
  if (target.status !== 'down' && (target.lastSample?.noData || freshness === 'never')) return 'unknown';
  const state = assessCell(target, freshness);
  return state === 'stale' ? 'unknown' : state;
}

export function sortHomeTargets(targets: readonly UptimeTargetSummary[], now: number): UptimeTargetSummary[] {
  return [...targets].sort((a, b) => ORDER[homeState(a, now)] - ORDER[homeState(b, now)] || a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
}

export function businessProjects(targets: readonly UptimeTargetSummary[], now: number) {
  const groups = new Map<string, UptimeTargetSummary[]>();
  for (const target of targets.filter((t) => t.source === 'custom')) {
    const group = groups.get(target.projectId) ?? [];
    group.push(target);
    groups.set(target.projectId, group);
  }
  return [...groups].map(([id, entries]) => {
    const ordered = sortHomeTargets(entries, now);
    const counts = Object.fromEntries(Object.keys(HOME_STATES).map((state) => [state, entries.filter((t) => homeState(t, now) === state).length])) as Record<HomeState, number>;
    return { id, name: entries.find((t) => t.projectName)?.projectName || id || '未归属项目', targets: ordered, counts, state: homeState(ordered[0], now) };
  }).sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name, 'zh-CN'));
}

/** 说明绑定结构化指标 ID，不从名字或错误文本猜测指标含义。 */
export function explainTarget(target: UptimeTargetSummary): { meaning: string; impact: string; action: string } {
  switch (target.healthCheck?.componentId) {
    case 'webhook.dispatch-unresolved':
      return {
        meaning: '检查是否还有代码推送触发的部署任务未成功派发。每次检查可能读到同一批积压任务。',
        impact: '新代码可能尚未部署；仅凭这一项不能断言当前线上业务不可用。',
        action: '进入项目的部署记录，核对失败任务、目标分支和版本，处理阻塞后重新部署，再回到这里检查。',
      };
    case 'api.branches-p95-ms':
      return {
        meaning: '检查首屏接口的响应速度：P95 表示 95% 的请求在这个时间内完成。',
        impact: '超过阈值说明部分请求变慢；缺少样本或读数时无法判断速度。',
        action: '查看近期请求样本与服务日志，确认是否有慢请求；没有流量时等待新样本。',
      };
    default:
      return target.healthCheck ? {
        meaning: '检查业务上报的这一项指标是否满足设定条件。',
        impact: '异常表示这项检查未通过，业务影响需结合实际任务和服务记录确认。',
        action: '核对下方检查结果与相关业务记录，处理原因后点击「立即检查」复核。',
      } : {
        meaning: target.observeMode === 'passive' ? '根据真实业务调用的结果检查运行情况。没有调用时无法确认业务是否正常。' : '按设定间隔执行检查，确认目标是否满足监控条件。',
        impact: '结果反映本监控所覆盖的路径，不能代表未接入检查的业务。',
        action: '查看最近检查结果与故障记录，排查目标服务后点击「立即检查」复核。',
      };
  }
}

export type StatusHomeView = 'home' | 'catalog' | 'history' | 'owner' | 'all' | 'detail';
export function readStatusLocation(params: URLSearchParams): { view: StatusHomeView; targetId: string | null } {
  const targetId = params.get('target');
  if (targetId) return { view: 'detail', targetId };
  const view = params.get('view');
  return { view: view === 'catalog' || view === 'history' || view === 'owner' || view === 'all' ? view : 'home', targetId: null };
}
