import { FolderGit2, LayoutGrid, List, Plus, Search } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import type { ProjectSummary } from '@/pages/ProjectListPage';

export type ProjectStatusFilter = 'all' | 'running' | 'paused' | 'ready';
export type ProjectEnvironmentStatus = 'loading' | 'ready' | 'error' | 'unavailable';
export interface ProjectInventorySelection {
  query: string;
  status: ProjectStatusFilter;
  environment: string;
  sort: 'default' | 'recent' | 'name';
  view: 'grid' | 'list';
}
export interface ProjectEnvironmentTarget {
  projectId: string;
  environment?: string;
  isEnabled?: boolean;
}
export const INITIAL_PROJECT_SELECTION: ProjectInventorySelection = {
  query: '', status: 'all', environment: 'all', sort: 'default', view: 'grid',
};

export function projectInventoryStatus(project: ProjectSummary): Exclude<ProjectStatusFilter, 'all'> | 'preparing' | 'error' {
  if (project.paused) return 'paused';
  if (project.cloneStatus === 'error') return 'error';
  if (project.cloneStatus === 'pending' || project.cloneStatus === 'cloning') return 'preparing';
  return (project.runningServiceCount || 0) + (project.runningInfraServiceCount || 0) > 0 ? 'running' : 'ready';
}

export function projectEnvironmentNames(projectId: string, targets: readonly ProjectEnvironmentTarget[]): string[] {
  return [...new Set(targets.filter(target => target.projectId === projectId && target.isEnabled !== false && target.environment)
    .map(target => target.environment!))];
}

export function selectInventoryProjects(
  projects: readonly ProjectSummary[],
  selection: ProjectInventorySelection,
  targets: readonly ProjectEnvironmentTarget[],
  serviceLabels: ReadonlyMap<string, readonly string[]>,
  pinnedProjectIds: readonly string[] = [],
): ProjectSummary[] {
  const query = selection.query.trim().toLocaleLowerCase();
  const selected = projects.filter(project => {
    if (selection.status !== 'all' && projectInventoryStatus(project) !== selection.status) return false;
    const environments = projectEnvironmentNames(project.id, targets);
    if (selection.environment === 'unconfigured' ? environments.length > 0
      : selection.environment !== 'all' && !environments.includes(selection.environment)) return false;
    if (!query) return true;
    return [project.aliasName, project.name, project.slug, project.description, project.githubRepoFullName,
      project.gitRepoUrl, ...(serviceLabels.get(project.id) || []),
      ...(project.appServices || []).flatMap(service => [service.id, service.name, service.dockerImage]),
      ...(project.infraServices || []).flatMap(service => [service.id, service.name, service.dockerImage]),
    ].some(value => value?.toLocaleLowerCase().includes(query));
  });
  if (selection.sort === 'name') selected.sort((a, b) =>
    (a.aliasName || a.name || a.slug || a.id).localeCompare(b.aliasName || b.name || b.slug || b.id, 'zh-CN'));
  if (selection.sort === 'recent') selected.sort((a, b) => (b.lastDeployedAt || '').localeCompare(a.lastDeployedAt || ''));
  if (pinnedProjectIds.length) {
    const pinned = new Set(pinnedProjectIds);
    selected.sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
  }
  return selected;
}

/** Loading and ready states share the same typography, spacing and responsive rows. */
export function ProjectInventoryLayout({ count, actions, filters, tools }: {
  count: ReactNode;
  actions: ReactNode;
  filters: ReactNode;
  tools: ReactNode;
}): JSX.Element {
  return <>
    <header className="cds-project-inventory-heading">
      <div>
        <div className="cds-project-inventory-title"><h1>项目</h1><span>{count}</span></div>
        <p>管理项目、分支环境与部署。</p>
      </div>
      {actions ? <div className="cds-project-inventory-actions">{actions}</div> : null}
    </header>
    <div className="cds-project-inventory-toolbar">
      <div className="cds-project-status-filters" role="group" aria-label="项目状态筛选">{filters}</div>
      <div className="cds-project-inventory-tools">{tools}</div>
    </div>
  </>;
}

interface ProjectInventoryHeaderProps {
  projects: readonly ProjectSummary[];
  selection: ProjectInventorySelection;
  onChange: (selection: ProjectInventorySelection) => void;
  targets: readonly ProjectEnvironmentTarget[];
  environmentStatus: ProjectEnvironmentStatus;
  canManageProjects: boolean;
  importOpen: boolean;
  onImport: () => void;
  onCreate: () => void;
}

export function ProjectInventoryHeader({ projects, selection, onChange, targets, environmentStatus,
  canManageProjects, importOpen, onImport, onCreate }: ProjectInventoryHeaderProps): JSX.Element {
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey ||
        (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);
  const filters: Array<{ value: ProjectStatusFilter; label: string }> = [
    { value: 'all', label: '全部项目' }, { value: 'running', label: '运行中' },
    { value: 'paused', label: '已暂停' }, { value: 'ready', label: '已就绪' },
  ];
  const visibleIds = new Set(projects.map(project => project.id));
  const environments = [...new Set(targets.filter(target => visibleIds.has(target.projectId) && target.isEnabled !== false && target.environment)
    .map(target => target.environment!))].sort();
  return (
    <ProjectInventoryLayout count={projects.length}
      actions={canManageProjects ? <>
        <Button variant="outline" size="sm" onClick={onImport} aria-expanded={importOpen} aria-controls="project-repository-import"><FolderGit2 />导入仓库</Button>
        <Button size="sm" onClick={onCreate}><Plus />新建项目</Button>
      </> : null}
      filters={filters.map(filter => <button key={filter.value} type="button" aria-pressed={selection.status === filter.value}
        onClick={() => onChange({ ...selection, status: filter.value })}>
        {filter.label}<span>{filter.value === 'all' ? projects.length : projects.filter(project => projectInventoryStatus(project) === filter.value).length}</span>
      </button>)}
      tools={<>
        <label className="cds-project-inventory-search"><Search aria-hidden /><input ref={searchRef} type="search" aria-label="搜索项目或服务"
          placeholder="搜索项目、服务…" value={selection.query} onChange={event => onChange({ ...selection, query: event.target.value })} /><kbd aria-hidden>/</kbd></label>
        <select aria-label="环境筛选" value={selection.environment} disabled={environmentStatus !== 'ready'}
          title="按项目已配置的发布目标环境筛选" onChange={event => onChange({ ...selection, environment: event.target.value })}>
          <option value="all">{environmentStatus === 'loading' ? '读取环境中…' : environmentStatus === 'error' ? '环境读取失败，请刷新' : environmentStatus === 'unavailable' ? '环境筛选不可用' : '全部环境'}</option>
          {environments.map(environment => <option key={environment} value={environment}>{environment}</option>)}
          <option value="unconfigured">未配置发布环境</option>
        </select>
        <select aria-label="项目排序" value={selection.sort} onChange={event => onChange({ ...selection, sort: event.target.value as ProjectInventorySelection['sort'] })}>
          <option value="default">默认排序</option><option value="recent">最近更新</option><option value="name">项目名称</option>
        </select>
        <div className="cds-project-view-switch" role="group" aria-label="项目视图">
          <button type="button" aria-label="卡片视图" title="卡片视图" aria-pressed={selection.view === 'grid'} onClick={() => onChange({ ...selection, view: 'grid' })}><LayoutGrid /></button>
          <button type="button" aria-label="列表视图" title="列表视图" aria-pressed={selection.view === 'list'} onClick={() => onChange({ ...selection, view: 'list' })}><List /></button>
        </div>
      </>}
    />
  );
}
