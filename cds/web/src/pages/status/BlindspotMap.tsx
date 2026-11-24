/*
 * 盲区地图 —— 全局视角那一屏。
 *
 * 它回答的是全局独有的那个问题：**哪些项目根本没人盯**。站在某一个项目里，
 * 你永远看不见另外九个项目的业务坏了也不会有任何东西变红。
 *
 * 唯一要守住的渲染判据：**没有业务监控的格子不许是绿的，也不许只是浅一点的绿。**
 * 它画成镂空的洞（虚线 + 斜纹），因为它不是「好着」，是「不知道」——把「没人盯」
 * 渲染成绿色，等于用一个假绿把最该管的项目藏起来。
 *
 * 判据在 lib/pulseWall.ts 的 buildBlindspotMap，这里只负责画与下钻。
 */
import { cn } from '@/lib/utils';
import type { BlindCell, BlindspotMap as BlindspotMapModel } from '@/lib/pulseWall';

const CELL: Record<BlindCell['kind'], string> = {
  watched: 'border-solid border-ok/40 bg-ok-soft',
  // 洞：虚线 + 斜纹，和任何一种「好」都长得不一样
  blind: 'border-dashed border-warn/55 bg-[repeating-linear-gradient(135deg,hsl(var(--warn)/0.12)_0_0.3125rem,transparent_0.3125rem_0.625rem)]',
  absent: 'border-solid border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]',
};

const CELL_INK: Record<BlindCell['kind'], string> = {
  watched: 'text-ok',
  blind: 'text-warn',
  absent: 'text-muted-foreground/60',
};

function cellText(cell: BlindCell): string {
  if (cell.kind === 'watched') return `${cell.businessCount} 条`;
  if (cell.kind === 'blind') return '没人盯';
  return '—';
}

function cellTitle(cell: BlindCell): string {
  if (cell.kind === 'watched') {
    return `${cell.label}：${cell.businessCount} 条业务监控${cell.worst && cell.worst !== 'up' ? '，其中有不正常的' : '，都通过判据'}`;
  }
  if (cell.kind === 'blind') {
    return `${cell.label}：${cell.infraCount} 项容器与端口在盯，但没有一条业务监控 —— 全绿只说明服务活着，不说明业务还能用`;
  }
  return `${cell.label}：这个项目在这个环境没有任何目标`;
}

export function BlindspotMap({
  map,
  onOpen,
}: {
  map: BlindspotMapModel;
  onOpen: (projectId: string) => void;
}): JSX.Element {
  const cols = `12rem repeat(${map.environments.length}, minmax(0, 1fr))`;
  return (
    <div className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-3">
      <div className="grid shrink-0 items-center gap-1.5" style={{ gridTemplateColumns: cols }}>
        <span className="font-mono text-[0.625rem] tracking-widest text-muted-foreground">项目</span>
        {map.environmentLabels.map((label) => (
          <span key={label} className="text-center font-mono text-[0.625rem] tracking-widest text-muted-foreground">{label}</span>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
        {map.rows.map((row) => (
          <div key={row.id} className="grid items-stretch gap-1.5" style={{ gridTemplateColumns: cols }}>
            <button
              type="button"
              onClick={() => onOpen(row.id)}
              className={cn(
                'flex min-w-0 items-center gap-1.5 rounded px-1 text-left text-xs transition-colors hover:text-foreground',
                row.watched ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              <span className="truncate">{row.name}</span>
              {row.trouble > 0 ? (
                <span className="ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-destructive px-1 font-mono text-[0.625rem] text-destructive-foreground">
                  {row.trouble}
                </span>
              ) : null}
            </button>
            {row.cells.map((cell) => (
              <button
                key={cell.environment}
                type="button"
                title={cellTitle(cell)}
                onClick={() => onOpen(row.id)}
                className={cn(
                  'flex h-8 items-center justify-center rounded-md border transition-colors hover:border-primary/50',
                  CELL[cell.kind],
                )}
              >
                <span className={cn('font-mono text-[0.6875rem]', CELL_INK[cell.kind])}>{cellText(cell)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-[hsl(var(--hairline))] pt-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-5 rounded-sm border border-solid border-ok/40 bg-ok-soft" />
          <span className="text-[0.6875rem] text-muted-foreground">有人盯</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={cn('h-3 w-5 rounded-sm border', CELL.blind)} />
          <span className="text-[0.6875rem] text-muted-foreground">没有业务监控 —— 画成洞，不画成绿</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-5 rounded-sm border border-solid border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]" />
          <span className="text-[0.6875rem] text-muted-foreground">这个项目没有这个环境</span>
        </span>
      </div>
    </div>
  );
}
