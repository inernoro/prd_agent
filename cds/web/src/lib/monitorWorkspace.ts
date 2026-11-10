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
  /** A real observer/subject location; absence is explicitly unlabelled. */
  region: string;
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
      region: target.alarmIdentity?.subject.location?.trim() || target.alarmIdentity?.observer.location?.trim() || '未标注区域',
    };
    category.services.push(service);
    category.counts[state]++;
    result.services.push(service);
    result.counts[state]++;
  }
  return result;
}

/** Initial truncation prioritizes attention; subsequent polling preserves existing slots. */
export function visibleWorkspaceServices(services: readonly WorkspaceService[], capacity: number, pinnedIds?: readonly string[]): WorkspaceService[] {
  const limit = Math.max(0, Math.floor(capacity));
  const byId = new Map(services.map(service => [service.id, service]));
  const pinned = pinnedIds?.flatMap(id => byId.has(id) ? [byId.get(id)!] : []).slice(0, limit) ?? [];
  const selected = new Set(pinned.map(service => service.id));
  const remaining = services.filter(service => !selected.has(service.id));
  const rank = { bad: 0, warn: 1, none: 2, ok: 2 };
  const candidates = [...remaining].sort((a, b) => rank[a.state] - rank[b.state]);
  const chosen = new Set(candidates.slice(0, limit - pinned.length).map(service => service.id));
  const additions = remaining.filter(service => chosen.has(service.id));
  return pinnedIds ? [...pinned, ...additions] : services.filter(service => chosen.has(service.id));
}

export interface WorkspaceHealthCell {
  region: string;
  state: WorkspaceState | 'empty';
  counts: Record<WorkspaceState, number>;
  total: number;
  title: string;
  serviceId?: string;
}
export function workspaceHealthCell(category: WorkspaceCategory, region: string): WorkspaceHealthCell {
  const entries = category.services.filter(service => service.region === region), summary = counts();
  entries.forEach(service => summary[service.state]++);
  const state = !entries.length ? 'empty' : summary.bad ? 'bad' : summary.warn ? 'warn' : summary.none ? 'none' : 'ok';
  const parts = ([['ok', '正常'], ['bad', '异常'], ['warn', '待确认'], ['none', '无观测']] as const).filter(([key]) => summary[key]).map(([key, name]) => `${summary[key]} ${name}`);
  const attention = entries.find(service => service.state === 'bad') ?? entries.find(service => service.state === 'warn');
  return { region, state, counts: summary, total: entries.length, title: `${category.name} · ${region}：${entries.length ? `${entries.length} 项，${parts.join('，')}` : '未配置此区域'}`, serviceId: attention?.id };
}
