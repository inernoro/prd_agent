import { ChevronDown, ChevronRight, UserRound } from 'lucide-react';

import type { BranchSubmitter } from '@/lib/branchSubmitters';
import { BranchGroupSummary, type BranchGroupSummaryPart } from './BranchGroupHeader';

export function BranchSubmitterHeader({
  submitter, count, parts, collapsed, onToggle,
}: {
  submitter: BranchSubmitter;
  count: number;
  parts: BranchGroupSummaryPart[];
  collapsed: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <div className="flex min-h-10 min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        className="inline-flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left text-sm font-semibold text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        aria-label={`${collapsed ? '展开' : '收起'}提交者 ${submitter.name}`}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        {collapsed ? <ChevronRight className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />}
        <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{submitter.name}</span>
        <span className="shrink-0 text-xs font-normal text-muted-foreground">{count} 个分支</span>
      </button>
      <span className="text-xs"><BranchGroupSummary parts={parts} empty="暂无运行中的分支" /></span>
    </div>
  );
}
