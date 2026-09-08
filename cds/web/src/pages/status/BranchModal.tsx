/*
 * 全部分支模态窗：点主列表里某个项目的分支汇总行弹出。
 *
 * 存活的排前面（运行中 → 未实测 → 已降温），每条分支列各服务的状态点、24h 迷你条、
 * 可用率、响应、当前状态与「打开分支」。点一行 = 选中该分支的代表目标看详情。
 * 主列表只汇总，明细全在这里；分支再多也不会把主站挤出第一屏。
 */
import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  filterBranches,
  formatLatency,
  formatPercent,
  type BranchFilter,
  type BranchTone,
  type BranchView,
  type ProjectBranchGroup,
} from '@/lib/monitorCenter';
import { AvailabilityBar, SegmentedControl } from './primitives';

type BranchSort = 'alive' | 'availability' | 'name';

const TONE_DOT: Record<BranchTone, string> = {
  ok: 'bg-ok',
  bad: 'bg-destructive',
  warn: 'bg-warn',
  muted: 'bg-[hsl(var(--hairline-strong))]',
};

// 桌面是一行八列的表格；手机（< md）退化为堆叠卡片：名字行 → 服务点 → 迷你条 + 数字 + 状态。
const GRID = 'md:grid md:grid-cols-[24px_minmax(0,1.6fr)_minmax(0,1.4fr)_200px_80px_70px_150px_90px] md:items-center md:gap-3';

function ServiceDots({ branch }: { branch: BranchView }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-1">
      {branch.services.map((s) => (
        <span key={s.profileId} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" title={`${s.profileId}：${s.target.probeDescription}`}>
          <span className={cn('inline-block h-2 w-2 rounded-full', TONE_DOT[s.tone])} />
          {s.profileId}
        </span>
      ))}
      {branch.userView ? (
        <span
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
          title={branch.userView.unreachable ? '探测器够不着预览域名，用户视角暂不可用' : `用户视角：经预览域名 ${branch.userView.url}`}
        >
          <span className={cn('inline-block h-2 w-2 rounded-full', branch.userView.status === 'up' ? 'bg-ok' : branch.userView.status === 'down' ? 'bg-destructive' : 'bg-[hsl(var(--hairline-strong))]')} />
          用户视角
        </span>
      ) : null}
    </div>
  );
}

function BranchRow({ branch, onSelect }: { branch: BranchView; onSelect: (branch: BranchView) => void }): JSX.Element {
  const alive = branch.bucket !== 'idle';
  return (
    <div
      role="row"
      className={cn(
        GRID,
        'flex flex-col gap-1.5 border-t border-[hsl(var(--hairline))] px-3.5 py-2.5 text-[13px]',
        alive ? 'bg-[hsl(var(--surface-raised))]' : 'bg-[hsl(var(--surface-sunken))]/35',
      )}
    >
      <span className="relative hidden h-2.5 w-2.5 md:inline-flex" aria-hidden="true">
        {branch.tone === 'bad' ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-60" /> : null}
        <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', TONE_DOT[branch.tone])} />
      </span>
      <button type="button" onClick={() => onSelect(branch)} className="flex min-w-0 items-start gap-2 text-left md:block">
        <span className={cn('mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full md:hidden', TONE_DOT[branch.tone])} aria-hidden="true" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className={cn('max-w-full truncate font-mono', alive ? 'font-medium text-foreground' : 'text-muted-foreground')}>{branch.branchName}</span>
          {branch.note ? <span className="max-w-full truncate text-[11px] text-muted-foreground" title={branch.note}>{branch.note}</span> : null}
        </span>
      </button>
      <ServiceDots branch={branch} />
      <div className="flex items-center gap-3 md:contents">
        <div className="min-w-0 flex-1 md:flex-none">
          <AvailabilityBar buckets={branch.primary.buckets} segments={40} compact label={`${branch.branchName} 最近 24 小时可用率分布`} />
        </div>
        <span className={cn('shrink-0 font-mono tabular-nums', branch.tone === 'bad' ? 'text-destructive' : alive ? 'text-foreground' : 'text-muted-foreground')}>
          {alive ? formatPercent(branch.availability24h) : '—'}
        </span>
        <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{alive ? formatLatency(branch.avgLatencyMs24h) : '—'}</span>
      </div>
      <div className="flex items-center justify-between gap-3 md:contents">
        <span className={cn('text-xs', branch.tone === 'bad' ? 'text-destructive' : 'text-muted-foreground')}>{branch.statusText}</span>
        <Link to={`/branch-panel/${encodeURIComponent(branch.branchId)}`} className="shrink-0 text-xs font-medium text-primary hover:underline">打开分支</Link>
      </div>
    </div>
  );
}

function SectionBar({ label, count, hint }: { label: string; count: number; hint: string }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2 bg-[hsl(var(--surface-sunken))] px-3.5 pb-1.5 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {label}
      <span className="font-mono">{count}</span>
      <span className="font-normal normal-case tracking-normal">{hint}</span>
    </div>
  );
}

export function BranchModal({ group, open, onOpenChange, onSelectBranch }: {
  group: ProjectBranchGroup | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectBranch: (branch: BranchView) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<BranchFilter>('all');
  const [sort, setSort] = useState<BranchSort>('alive');
  // 每次打开都从「全部 · 按存活」开始：上一次留下的筛选会让人以为分支少了。
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setFilter('all');
    setSort('alive');
  }, [open, group?.projectId]);

  const shown = useMemo(() => {
    if (!group) return [];
    const list = filterBranches(group.branches, filter, query);
    if (sort === 'availability') return [...list].sort((a, b) => (a.availability24h ?? 2) - (b.availability24h ?? 2));
    if (sort === 'name') return [...list].sort((a, b) => a.branchName.localeCompare(b.branchName));
    return list;
  }, [group, filter, query, sort]);

  const sections = useMemo(() => ([
    { key: 'running', label: '运行中', hint: '存活的分支排前面 · 进程视角与用户视角都探', rows: shown.filter((b) => b.bucket === 'running') },
    { key: 'unmeasured', label: '未实测', hint: '在跑但没有可探的 HTTP 端口，只按容器状态判定', rows: shown.filter((b) => b.bucket === 'unmeasured') },
    { key: 'idle', label: '已降温 / 未运行', hint: '不探测、不计故障；唤醒后自动恢复探测', rows: shown.filter((b) => b.bucket === 'idle') },
  ].filter((s) => s.rows.length > 0)), [shown]);

  if (!group) return <></>;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent frame className="max-w-[1200px]" style={{ height: '82vh' }}>
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[hsl(var(--hairline))] py-3.5 pl-4 pr-14 md:pl-[18px]">
          <div className="flex min-w-0 flex-col gap-0.5">
            <DialogTitle className="text-lg font-semibold">
              {group.projectName} · 全部分支 <span className="font-mono text-sm font-normal text-muted-foreground">{group.total}</span>
            </DialogTitle>
            <DialogDescription className="text-xs">
              每条分支的每个服务都在探；主列表只汇总，这里看明细。运行中 {group.running} · 已降温 {group.idle} · 故障 {group.bad}
              {group.unmeasured > 0 ? ` · 未实测 ${group.unmeasured}` : ''}
            </DialogDescription>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="relative block w-full sm:w-60">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜分支名或服务"
                aria-label="搜索分支"
                className="h-8 w-full rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] pl-8 pr-2 text-[13px] outline-none placeholder:text-muted-foreground/70 focus:border-primary/60"
              />
            </label>
            <SegmentedControl<BranchFilter>
              value={filter}
              options={[
                { value: 'all', label: '全部', count: group.total },
                { value: 'running', label: '运行中', count: group.running },
                { value: 'bad', label: '故障', count: group.bad },
                { value: 'idle', label: '已降温', count: group.idle },
              ]}
              onChange={setFilter}
              ariaLabel="筛选分支"
            />
            <SegmentedControl<BranchSort>
              value={sort}
              options={[{ value: 'alive', label: '按存活' }, { value: 'availability', label: '按可用率' }, { value: 'name', label: '按名称' }]}
              onChange={setSort}
              ariaLabel="排序"
            />
          </div>
        </header>
        <div className={cn(GRID, 'hidden shrink-0 px-3.5 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground')} role="row">
          <span />
          <span>分支</span>
          <span>服务（进程视角）</span>
          <span>近 24h</span>
          <span>可用率</span>
          <span>响应</span>
          <span>状态</span>
          <span />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" style={{ overscrollBehavior: 'contain' }} role="table" aria-label="全部分支">
          {sections.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">没有匹配的分支。</div>
          ) : sections.map((s) => (
            <section key={s.key}>
              <SectionBar label={s.label} count={s.rows.length} hint={s.hint} />
              {s.rows.map((b) => <BranchRow key={b.branchId} branch={b} onSelect={(branch) => { onSelectBranch(branch); onOpenChange(false); }} />)}
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
