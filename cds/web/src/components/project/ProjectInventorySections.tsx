import { ChevronDown } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import type { ProjectSummary } from '@/pages/ProjectListPage';

export function partitionInventoryProjects(projects: readonly ProjectSummary[]): {
  active: ProjectSummary[];
  paused: ProjectSummary[];
} {
  const active: ProjectSummary[] = [];
  const paused: ProjectSummary[] = [];
  for (const project of projects) (project.paused === true ? paused : active).push(project);
  return { active, paused };
}

/** Preserve filtering, pinning and sorting within each section; only paused projects move down. */
export function ProjectInventorySections({ projects, view, separatePaused, filterKey, renderProject }: {
  projects: readonly ProjectSummary[];
  view: 'grid' | 'list';
  separatePaused: boolean;
  filterKey: string;
  renderProject: (project: ProjectSummary) => ReactNode;
}): JSX.Element {
  const [collapsedKey, setCollapsedKey] = useState<string | null>(null);
  const pausedRegionId = useId();
  const { active, paused } = partitionInventoryProjects(projects);
  const gridClass = `cds-card-grid cds-project-inventory-grid ${view === 'list' ? 'cds-project-inventory--list' : ''}`;
  const grid = (items: readonly ProjectSummary[]): JSX.Element => <div className={gridClass}>{items.map(renderProject)}</div>;
  // A single status group stays directly visible, including the explicit paused filter and paused-only searches.
  if (!separatePaused || !active.length || !paused.length) return grid(projects);
  const collapsed = collapsedKey === filterKey;
  return <>
    {grid(active)}
    <section className="mt-8" aria-label="已暂停项目">
      <div className="flex min-w-0 items-center gap-3">
        <button type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-[hsl(var(--hairline-strong))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          aria-expanded={!collapsed} aria-controls={pausedRegionId}
          onClick={() => setCollapsedKey(collapsed ? null : filterKey)}>
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} aria-hidden />
          已暂停 · {paused.length}
        </button>
        <span className="h-px min-w-6 flex-1 bg-[hsl(var(--hairline))]" aria-hidden />
      </div>
      <div id={pausedRegionId}>{!collapsed ? <div className="mt-4">{grid(paused)}</div> : null}</div>
    </section>
  </>;
}
