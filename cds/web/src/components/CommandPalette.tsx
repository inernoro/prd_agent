import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CornerDownLeft,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Loader2,
  Network,
  Search,
  Settings,
} from 'lucide-react';

import { apiRequest } from '@/lib/api';

/*
 * CommandPalette — global Cmd/Ctrl+K palette.
 *
 * Search across projects + tracked branches; pick a row to navigate. This is
 * the "convenience layer" Railway / Linear users expect: any resource is one
 * keystroke + a few characters away.
 *
 * Open: Cmd/Ctrl + K, or programmatic via the dispatch hook in AppShell.
 * Close: Esc, click backdrop, pick a result.
 *
 * Data sources:
 *   GET /api/projects         — list of projects
 *   GET /api/branches?project — branches per project (lazy-loaded after open)
 */

interface ProjectRow {
  id: string;
  name?: string;
  aliasName?: string;
  slug?: string;
  branchCount?: number;
}

interface BranchRow {
  id: string;
  projectId: string;
  branch: string;
  status?: string;
  isFavorite?: boolean;
}

interface PaletteData {
  projects: ProjectRow[];
  branches: BranchRow[];
}

interface ResultItem {
  key: string;
  type: 'project' | 'branch' | 'action';
  label: string;
  hint?: string;
  href?: string;
  icon: 'project' | 'branch' | 'settings' | 'topology';
}

function projectDisplay(project: ProjectRow): string {
  return project.aliasName || project.name || project.slug || project.id;
}

function projectsToRows(projects: ProjectRow[]): ResultItem[] {
  return projects.map((project) => ({
    key: `project:${project.id}`,
    type: 'project' as const,
    label: projectDisplay(project),
    hint: project.branchCount != null ? `${project.branchCount} 分支` : '项目',
    href: `/branches/${encodeURIComponent(project.id)}`,
    icon: 'project' as const,
  }));
}

function branchesToRows(branches: BranchRow[], projectsById: Map<string, ProjectRow>): ResultItem[] {
  return branches.map((branch) => {
    const project = projectsById.get(branch.projectId);
    const projectLabel = project ? projectDisplay(project) : branch.projectId;
    return {
      key: `branch:${branch.id}`,
      type: 'branch' as const,
      label: branch.branch,
      hint: `${projectLabel} · ${branch.status || ''}${branch.isFavorite ? ' · 收藏' : ''}`.trim(),
      href: `/branch-panel/${encodeURIComponent(branch.id)}?project=${encodeURIComponent(branch.projectId)}`,
      icon: 'branch' as const,
    };
  });
}

const STATIC_ACTIONS: ResultItem[] = [
  {
    key: 'action:project-list',
    type: 'action',
    label: '所有项目',
    hint: '回到项目控制台',
    href: '/project-list',
    icon: 'project',
  },
  {
    key: 'action:cds-settings',
    type: 'action',
    label: 'CDS 系统设置',
    hint: '存储 / 集群 / GitHub / 维护',
    href: '/cds-settings',
    icon: 'settings',
  },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [data, setData] = useState<PaletteData>({ projects: [], branches: [] });
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const projectRes = await apiRequest<{ projects: ProjectRow[] }>('/api/projects');
      const projects = projectRes.projects || [];
      const branchLists = await Promise.all(
        projects.map((project) =>
          apiRequest<{ branches: BranchRow[] }>(`/api/branches?project=${encodeURIComponent(project.id)}`).catch(
            () => ({ branches: [] as BranchRow[] }),
          ),
        ),
      );
      const branches = branchLists.flatMap((res, idx) =>
        (res.branches || []).map((branch) => ({ ...branch, projectId: projects[idx].id })),
      );
      setData({ projects, branches });
    } catch {
      // ignored — palette is best-effort
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIdx(0);
    void reload();
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open, reload]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  const projectsById = useMemo(() => new Map(data.projects.map((project) => [project.id, project])), [data.projects]);

  const results = useMemo<ResultItem[]>(() => {
    const trimmed = query.trim().toLowerCase();
    const projectRows = projectsToRows(data.projects);
    const branchRows = branchesToRows(data.branches, projectsById);

    if (!trimmed) {
      const favoriteBranches = data.branches.filter((branch) => branch.isFavorite);
      return [
        ...STATIC_ACTIONS,
        ...projectRows.slice(0, 6),
        ...branchesToRows(favoriteBranches.slice(0, 6), projectsById),
      ];
    }

    const score = (text: string) => {
      const idx = text.toLowerCase().indexOf(trimmed);
      if (idx < 0) return -1;
      return text.toLowerCase().startsWith(trimmed) ? 100 - idx : 50 - idx;
    };

    const merged = [...projectRows, ...branchRows, ...STATIC_ACTIONS];
    return merged
      .map((item) => ({
        item,
        rank: Math.max(score(item.label), item.hint ? score(item.hint) - 10 : -1),
      }))
      .filter((entry) => entry.rank >= 0)
      .sort((left, right) => right.rank - left.rank)
      .slice(0, 18)
      .map((entry) => entry.item);
  }, [data.projects, data.branches, projectsById, query]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(Math.max(0, results.length - 1));
  }, [results, activeIdx]);

  const navigate = useCallback(
    (item: ResultItem) => {
      if (!item.href) return;
      onClose();
      window.location.href = item.href;
    },
    [onClose],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIdx((current) => Math.min(results.length - 1, current + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIdx((current) => Math.max(0, current - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = results[activeIdx];
      if (item) navigate(item);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
    >
      <button
        type="button"
        className="cds-overlay-anim absolute inset-0 bg-black/45 backdrop-blur-sm"
        onClick={onClose}
        aria-label="关闭命令面板"
      />
      <div
        className="cds-surface-raised cds-hairline relative z-10 mx-4 w-full max-w-[560px] overflow-hidden shadow-2xl"
        style={{ animation: 'cds-overlay-fade-in 160ms ease-out' }}
      >
        <div className="flex items-center gap-3 border-b border-[hsl(var(--hairline))] px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索项目、分支或操作"
            className="h-12 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoComplete="off"
            spellCheck={false}
          />
          {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : null}
          <kbd className="hidden rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-flex">
            ESC
          </kbd>
        </div>
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {loading ? '加载中…' : '没有匹配项'}
            </div>
          ) : (
            results.map((item, idx) => (
              <button
                key={item.key}
                type="button"
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => navigate(item)}
                data-active={idx === activeIdx ? 'true' : 'false'}
                className="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[hsl(var(--surface-sunken))] data-[active=true]:bg-[hsl(var(--surface-sunken))]"
              >
                <PaletteIcon kind={item.icon} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{item.label}</span>
                  {item.hint ? <span className="block truncate text-[11px] text-muted-foreground">{item.hint}</span> : null}
                </span>
                {idx === activeIdx ? (
                  <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                )}
              </button>
            ))
          )}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/40 px-4 py-2 text-[11px] text-muted-foreground">
          <span>↑↓ 选择 · Enter 跳转 · Esc 关闭</span>
          <span>{results.length} 项</span>
        </div>
      </div>
    </div>
  );
}

function PaletteIcon({ kind }: { kind: ResultItem['icon'] }): JSX.Element {
  const className = 'h-4 w-4 shrink-0 text-muted-foreground group-data-[active=true]:text-foreground';
  if (kind === 'project') return <FolderGit2 className={className} />;
  if (kind === 'branch') return <GitBranch className={className} />;
  if (kind === 'topology') return <Network className={className} />;
  if (kind === 'settings') return <Settings className={className} />;
  return <ExternalLink className={className} />;
}
