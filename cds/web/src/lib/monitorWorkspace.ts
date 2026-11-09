import { formatLatency, formatRelative, proberLiveness, type UptimeSummary, type UptimeTargetSummary } from './monitorCenter';
import { explainTarget, homeState, type HomeState } from './statusHome';

export type WorkspaceState = 'ok' | 'bad' | 'warn' | 'none';
export interface WorkspaceService {
  id: string;
  name: string;
  categoryId: string;
  state: WorkspaceState;
  custom: boolean;
  fresh: boolean;
  target: UptimeTargetSummary;
  latency: string;
  rate: string;
  ago: string;
  reason: string;
}
export interface WorkspaceCategory {
  id: string;
  name: string;
  custom: boolean;
  services: WorkspaceService[];
  counts: Record<WorkspaceState, number>;
}
export interface WorkspaceModel {
  categories: WorkspaceCategory[];
  services: WorkspaceService[];
  counts: Record<WorkspaceState, number>;
}
const STATES: Record<HomeState, WorkspaceState> = { up: 'ok', down: 'bad', overdue: 'warn', unknown: 'none', paused: 'none' };
const counts = (): Record<WorkspaceState, number> => ({ ok: 0, bad: 0, warn: 0, none: 0 });

/** The minimap has its own bounded height; measured canvas pixels are only proportions. */
export function workspaceMinimapRows(template: string): string {
  const tracks = template.trim().split(/\s+/).filter(Boolean);
  const weights = tracks.map(track => Number.parseFloat(track)).filter(weight => Number.isFinite(weight) && weight > 0);
  const fallback = weights.length ? weights.reduce((sum, weight) => sum + weight, 0) / weights.length : 1;
  return tracks.map(track => {
    const weight = Number.parseFloat(track);
    return `${Number.isFinite(weight) && weight > 0 ? weight : fallback}fr`;
  }).join(' ');
}

/** Preserve API order and identity across polling: a status change never moves a tile. */
export function buildWorkspaceModel(targets: readonly UptimeTargetSummary[], now: number, summary?: UptimeSummary): WorkspaceModel {
  const result: WorkspaceModel = { categories: [], services: [], counts: counts() };
  const categories = new Map<string, WorkspaceCategory>();
  const stopped = summary && (!summary.enabled || proberLiveness(summary)?.stalled);
  for (const target of targets) {
    const categoryId = target.projectId || 'unassigned';
    let category = categories.get(categoryId);
    if (!category) {
      category = { id: categoryId, name: target.projectName || target.projectId || '我的服务', custom: true, services: [], counts: counts() };
      categories.set(categoryId, category);
      result.categories.push(category);
    } else if (target.projectName) category.name = target.projectName;
    const custom = target.source === 'custom' && target.addedBy?.origin !== 'discovered' && !target.id.startsWith('monitor@self-');
    if (!custom) category.custom = false;
    let state = STATES[homeState(target, now)];
    if (state === 'ok' && stopped) state = 'warn';
    const reason = state === 'bad' ? target.lastSample?.err || explainTarget(target).impact
      : state === 'warn' ? '检查未持续更新，当前状态待确认'
      : state === 'none' ? target.pausedReason || (target.lastSample?.noData ? '本轮没有可用观测数据' : target.lastSample ? '检查暂停或已排除' : '等待首次观测') : '最近检查通过';
    const service: WorkspaceService = {
      id: target.id, name: target.name, categoryId, state, custom,
      fresh: state === 'none' && !target.lastSample && target.status !== 'paused' && target.enabled !== false && !target.excluded,
      target,
      latency: formatLatency(target.lastSample && !target.lastSample.noData ? target.lastSample.ms : null),
      rate: target.availability24h === null ? '—' : `${(target.availability24h * 100).toFixed(2)}%`,
      ago: target.lastSample ? formatRelative(target.lastSample.t, now) : '尚无观测', reason,
    };
    category.services.push(service);
    category.counts[state]++;
    result.services.push(service);
    result.counts[state]++;
  }
  return result;
}
