/*
 * 分组的组头（2026-09-29 自定义分组）。
 *
 * 一行讲清四件事：这是哪组（色块 + 名字 + 数量）、组里现在怎样（与页头同一套统计口径的
 * 一句话）、按什么归进来的（规则片）、以及可以怎么动它（把手拖动调顺序、收起、编辑）。
 * 收起时这一行照样显示汇总——组里有出错或排队的分支不会因为收起就被藏起来。
 */
import type { DragEvent, ReactNode } from 'react';
import { ChevronDown, ChevronRight, GitBranch, GripVertical, Pencil, Pin, Tag } from 'lucide-react';

import type { BranchGroup, BranchGroupColor, BranchGroupRule } from '@/lib/branchGroups';

/** 五个色块走主题 token（index.css 的 --group-*），类名写全，Tailwind 才扫得到。 */
export const BRANCH_GROUP_SWATCH_CLASS: Record<BranchGroupColor | 'none', string> = {
  orange: 'bg-[hsl(var(--group-orange))]',
  blue: 'bg-[hsl(var(--group-blue))]',
  green: 'bg-[hsl(var(--group-green))]',
  purple: 'bg-[hsl(var(--group-purple))]',
  gray: 'bg-[hsl(var(--group-gray))]',
  none: 'bg-[hsl(var(--hairline-strong))]',
};

export interface BranchGroupSummaryPart {
  text: string;
  tone: 'warn' | 'info' | 'plain';
}

export function BranchGroupSummary({ parts, empty }: { parts: BranchGroupSummaryPart[]; empty: string }): JSX.Element {
  if (parts.length === 0) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <span>
      {parts.map((part, index) => (
        <span key={part.text}>
          {index > 0 ? '，' : ''}
          <span
            className={
              part.tone === 'warn'
                ? 'font-semibold text-destructive'
                : part.tone === 'info'
                  ? 'text-info'
                  : 'text-muted-foreground'
            }
          >
            {part.text}
          </span>
        </span>
      ))}
    </span>
  );
}

/** 组头规则片的文案：一条规则一句人话。 */
export function describeBranchGroupRule(rule: BranchGroupRule): string {
  switch (rule.kind) {
    case 'prefix':
      return `以 ${rule.value} 开头`;
    case 'contains':
      return `包含 ${rule.value}`;
    case 'equals':
      return `名称是 ${rule.value}`;
    case 'tag':
      return `带标签 #${rule.value.replace(/^#/, '')}`;
    default:
      return rule.value;
  }
}

function ruleChipText(group: BranchGroup): Array<{ key: string; icon: ReactNode; text: string }> {
  return group.rules.map((rule, index) => ({
    key: `${rule.kind}-${index}`,
    icon: rule.kind === 'tag' ? <Tag className="h-3 w-3" aria-hidden /> : <GitBranch className="h-3 w-3" aria-hidden />,
    text: describeBranchGroupRule(rule),
  }));
}

export function BranchGroupHeader({
  group,
  count,
  parts,
  collapsed,
  onToggle,
  onEdit,
  onGripDragStart,
  onGripDragEnd,
  dropHint,
}: {
  /** null = 「未归组」这一栏。 */
  group: BranchGroup | null;
  count: number;
  parts: BranchGroupSummaryPart[];
  collapsed: boolean;
  onToggle: () => void;
  onEdit?: () => void;
  onGripDragStart?: (event: DragEvent<HTMLSpanElement>) => void;
  onGripDragEnd?: () => void;
  /** 拖动卡片悬停在本组上时的提示；没有拖动时为空。 */
  dropHint?: string;
}): JSX.Element {
  const name = group ? group.name : '未归组';
  const pinnedCount = group ? group.pinnedBranchIds.length : 0;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-h-10 min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-branch-group-header={group ? group.id : '__ungrouped__'}>
        {group ? (
          <span
            draggable
            onDragStart={onGripDragStart}
            onDragEnd={onGripDragEnd}
            className="inline-flex h-7 w-5 shrink-0 cursor-grab items-center justify-center text-muted-foreground/70 hover:text-foreground active:cursor-grabbing"
            title="拖动调整分组顺序（靠上的分组优先认领规则命中的分支）"
            aria-hidden
          >
            <GripVertical className="h-4 w-4" />
          </span>
        ) : (
          // 未归组固定在最后，不参与排序：把手淡显占位，保持各组头对齐。
          <span className="inline-flex h-7 w-5 shrink-0 items-center justify-center text-muted-foreground/30" title="「未归组」固定在最后" aria-hidden>
            <GripVertical className="h-4 w-4" />
          </span>
        )}
        <button
          type="button"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] text-muted-foreground transition-colors hover:border-[hsl(var(--hairline-strong))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          aria-label={`${collapsed ? '展开' : '收起'}${name}`}
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        <span className={`h-2.5 w-2.5 shrink-0 rounded-[0.1875rem] ${BRANCH_GROUP_SWATCH_CLASS[group ? group.color : 'none']}`} aria-hidden />
        <span className="shrink-0 text-base font-semibold text-foreground">{name}</span>
        <span className="shrink-0 font-mono text-sm text-muted-foreground">{count}</span>
        {group ? null : (
          <span className="min-w-0 text-sm text-muted-foreground">没被任何分组规则命中，也没有手动钉入</span>
        )}
        <span className="min-w-0 text-sm">
          {group || parts.length > 0 ? (
            <BranchGroupSummary parts={parts} empty="这一组现在没有分支" />
          ) : null}
        </span>
        {group
          ? ruleChipText(group).map((chip) => (
            <span
              key={chip.key}
              className="hidden h-[1.375rem] shrink-0 items-center gap-1 rounded-[0.3125rem] border border-dashed border-[hsl(var(--hairline-strong))] px-2 text-[0.6875rem] text-muted-foreground md:inline-flex"
            >
              {chip.icon}
              {chip.text}
            </span>
          ))
          : null}
        <span className="h-px min-w-6 flex-1 bg-[hsl(var(--hairline))]" aria-hidden />
        {pinnedCount > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground" title="拖进来或用卡片菜单「移到分组」放进来的分支，优先于规则">
            <Pin className="h-3.5 w-3.5 text-primary" aria-hidden />
            {pinnedCount} 个手动钉入
          </span>
        ) : null}
        {group && onEdit ? (
          <button
            type="button"
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-[hsl(var(--surface-sunken))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            aria-label={`编辑分组${name}`}
            onClick={onEdit}
          >
            <Pencil className="h-3.5 w-3.5" />
            编辑
          </button>
        ) : null}
      </div>
      {dropHint ? (
        <div className="pl-8 text-[0.8125rem] font-semibold text-primary" data-branch-group-drop-hint>
          {dropHint}
        </div>
      ) : null}
    </div>
  );
}
