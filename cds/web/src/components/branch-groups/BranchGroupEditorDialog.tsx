/*
 * 编辑 / 新建分组（2026-09-29 自定义分组）。
 *
 * 用户改规则时要当场看到后果：「现在命中哪些分支」随输入实时刷新，规则命中但被上方
 * 分组先认领走的单独列出并说清原因（分组按顺序认领），手动钉入的列在最后、可一键取消。
 * 命中预览走 lib/branchGroups 的 previewGroupHits——与页面分区同一个判定源。
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, GitBranch, Pin, Plus, Tag, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  BRANCH_GROUP_COLORS,
  BRANCH_GROUP_COLOR_LABELS,
  BRANCH_GROUP_RULE_KINDS,
  BRANCH_GROUP_RULE_LABELS,
  previewGroupHits,
  type BranchGroup,
  type BranchGroupRuleKind,
  type GroupableBranch,
} from '@/lib/branchGroups';
import { BRANCH_GROUP_SWATCH_CLASS } from './BranchGroupHeader';

const PREVIEW_LIMIT = 6;

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
}

/** 修改人：服务端优先记登录名；拿不到名字时只说「某位成员」，不拿泛称冒充名字。 */
function actorText(actor: string | null): string {
  if (!actor) return '';
  if (actor === 'user') return '某位成员';
  if (actor === 'ai') return '某个 AI Agent';
  if (actor.startsWith('ai:')) return `AI（${actor.slice(3)}）`;
  if (actor.startsWith('system:')) return '系统';
  return actor;
}

export function BranchGroupEditorDialog({
  open,
  initial,
  isNew,
  groups,
  branches,
  tags,
  updatedAt,
  updatedBy,
  saving,
  error,
  onSave,
  onDelete,
  onClose,
}: {
  open: boolean;
  initial: BranchGroup | null;
  isNew: boolean;
  groups: BranchGroup[];
  branches: GroupableBranch[];
  tags: string[];
  updatedAt: string | null;
  updatedBy: string | null;
  saving: boolean;
  error: string;
  onSave: (group: BranchGroup) => void;
  onDelete: (groupId: string) => void;
  onClose: () => void;
}): JSX.Element | null {
  const [draft, setDraft] = useState<BranchGroup | null>(initial);
  useEffect(() => {
    if (open) setDraft(initial);
  }, [open, initial]);

  const preview = useMemo(
    () => (draft ? previewGroupHits(groups, draft, branches) : { hits: [], pinned: [], taken: [] }),
    [draft, groups, branches],
  );
  const nameById = useMemo(() => new Map(branches.map((branch) => [branch.id, branch.branch])), [branches]);
  // 被别组认领走的，按认领它的分组分行：用户要知道「归了谁」才知道该挪哪边的顺序或钉入。
  const takenByGroup = useMemo(() => {
    const map = new Map<string, { groupName: string; names: string[] }>();
    for (const item of preview.taken) {
      const entry = map.get(item.groupId) || { groupName: item.groupName, names: [] };
      entry.names.push(item.branch.branch);
      map.set(item.groupId, entry);
    }
    return [...map.values()];
  }, [preview.taken]);
  const draftIndex = draft ? groups.findIndex((group) => group.id === draft.id) : -1;

  if (!draft) return null;
  const update = (patch: Partial<BranchGroup>) => setDraft((current) => (current ? { ...current, ...patch } : current));
  const setRule = (index: number, patch: Partial<{ kind: BranchGroupRuleKind; value: string }>) =>
    update({ rules: draft.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)) });
  const canSave = draft.name.trim().length > 0 && !saving;
  const who = actorText(updatedBy);
  const when = formatWhen(updatedAt);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden" aria-describedby="branch-group-editor-desc">
        <DialogHeader>
          <DialogTitle>{isNew ? '新建分组' : '编辑分组'}</DialogTitle>
          <DialogDescription id="branch-group-editor-desc">
            {!isNew && who && when ? `${who} 于 ${when} 修改。` : ''}分组对本项目所有成员和 Agent 生效。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-1">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="text-xs font-semibold text-muted-foreground">名称</span>
              <input
                className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                value={draft.name}
                maxLength={40}
                placeholder="例如：Claude 在做"
                onChange={(event) => update({ name: event.target.value })}
              />
            </label>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-muted-foreground">颜色</span>
              <div className="flex h-9 items-center gap-1.5" role="radiogroup" aria-label="分组颜色">
                {BRANCH_GROUP_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    role="radio"
                    aria-checked={draft.color === color}
                    aria-label={BRANCH_GROUP_COLOR_LABELS[color]}
                    title={BRANCH_GROUP_COLOR_LABELS[color]}
                    className={`h-6 w-6 rounded-md ${BRANCH_GROUP_SWATCH_CLASS[color]} ${draft.color === color ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : 'opacity-80 hover:opacity-100'}`}
                    onClick={() => update({ color })}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-muted-foreground">归组规则 · 满足任意一条就归入</span>
            {draft.rules.length === 0 ? (
              <div className="rounded-md border border-dashed border-[hsl(var(--hairline-strong))] px-3 py-2 text-xs text-muted-foreground">
                还没有规则：这个组只收拖进来的分支。加一条规则，新推上来的分支就会自动归进来。
              </div>
            ) : null}
            {draft.rules.map((rule, index) => (
              <div key={index} className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)_2.25rem] items-center gap-2">
                <label className="relative">
                  <span className="sr-only">规则类型</span>
                  <select
                    className="h-9 w-full appearance-none rounded-md border border-input bg-background pl-8 pr-8 text-sm outline-none focus:ring-2 focus:ring-ring"
                    value={rule.kind}
                    onChange={(event) => setRule(index, { kind: event.target.value as BranchGroupRuleKind })}
                  >
                    {BRANCH_GROUP_RULE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>{BRANCH_GROUP_RULE_LABELS[kind]}</option>
                    ))}
                  </select>
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden>
                    {rule.kind === 'tag' ? <Tag className="h-3.5 w-3.5" /> : <GitBranch className="h-3.5 w-3.5" />}
                  </span>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                </label>
                <label>
                  <span className="sr-only">规则值</span>
                  <input
                    className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
                    value={rule.value}
                    maxLength={100}
                    list={rule.kind === 'tag' ? 'branch-group-tag-options' : undefined}
                    placeholder={rule.kind === 'tag' ? '标签名' : rule.kind === 'prefix' ? '例如 claude/' : '分支名片段'}
                    onChange={(event) => setRule(index, { value: event.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-[hsl(var(--surface-sunken))] hover:text-foreground"
                  aria-label="删除这条规则"
                  onClick={() => update({ rules: draft.rules.filter((_, i) => i !== index) })}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
            <div className="text-xs text-muted-foreground" data-branch-group-rule-kinds>
              可选：{BRANCH_GROUP_RULE_KINDS.map((kind) => BRANCH_GROUP_RULE_LABELS[kind]).join(' / ')}
            </div>
            <datalist id="branch-group-tag-options">
              {tags.map((tag) => <option key={tag} value={tag} />)}
            </datalist>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => update({ rules: [...draft.rules, { kind: 'prefix', value: '' }] })}
            >
              <Plus />
              添加规则
            </Button>
          </div>

          <div className="flex flex-col gap-2.5 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/50 p-3.5" data-branch-group-preview>
            <div className="text-sm">
              <span className="font-bold">现在命中 {preview.hits.length} 个分支</span>
              <span className="text-muted-foreground">，改规则时实时刷新</span>
            </div>
            {preview.hits.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {preview.hits.slice(0, PREVIEW_LIMIT).map((branch) => (
                  <span key={branch.id} className="inline-flex h-6 max-w-full items-center truncate rounded-[0.3125rem] bg-[hsl(var(--hairline))] px-2 font-mono text-xs">
                    {branch.branch}
                  </span>
                ))}
                {preview.hits.length > PREVIEW_LIMIT ? (
                  <span className="inline-flex h-6 items-center px-1 text-xs text-muted-foreground">+ 另外 {preview.hits.length - PREVIEW_LIMIT} 个</span>
                ) : null}
              </div>
            ) : null}
            {takenByGroup.length > 0 ? (
              <div className="flex flex-col gap-1.5" data-branch-group-taken>
                <span className="text-xs text-warn">
                  另有 {preview.taken.length} 个规则命中、但已归了别的分组（钉入优先，其次靠上的分组先认领）：
                </span>
                {takenByGroup.map((entry) => (
                  <div key={entry.groupName} className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-warn">归了「{entry.groupName}」：</span>
                    {entry.names.slice(0, PREVIEW_LIMIT).map((name) => (
                      <span key={name} className="inline-flex h-6 max-w-full items-center truncate rounded-[0.3125rem] bg-[hsl(var(--hairline))] px-2 font-mono text-xs line-through opacity-60">
                        {name}
                      </span>
                    ))}
                    {entry.names.length > PREVIEW_LIMIT ? (
                      <span className="text-xs text-muted-foreground">+ 另外 {entry.names.length - PREVIEW_LIMIT} 个</span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            {draft.pinnedBranchIds.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">手动钉入 {draft.pinnedBranchIds.length} 个：</span>
                {draft.pinnedBranchIds.map((branchId) => (
                  <span key={branchId} className="inline-flex h-6 items-center gap-1 rounded-[0.3125rem] bg-[hsl(var(--hairline))] pl-1.5 pr-0.5 font-mono text-xs">
                    <Pin className="h-3 w-3 text-primary" aria-hidden />
                    <span className="max-w-[16rem] truncate">{nameById.get(branchId) || `${branchId}（分支已不在）`}</span>
                    <button
                      type="button"
                      className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                      aria-label={`取消钉入 ${nameById.get(branchId) || branchId}`}
                      onClick={() => update({ pinnedBranchIds: draft.pinnedBranchIds.filter((id) => id !== branchId) })}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex flex-col gap-1 text-xs leading-5 text-muted-foreground" data-branch-group-claim-order>
            <span className="font-semibold text-foreground">一个分支只归一组，认领顺序：</span>
            <span><span className="mr-1.5 font-mono text-primary">1</span>手动钉入：拖进组，或在卡片「更多」里选「移到分组」</span>
            <span>
              <span className="mr-1.5 font-mono text-primary">2</span>
              规则：按分组在页面上的顺序，第一个命中的认领（拖组头左侧的把手调顺序）
              {draftIndex >= 0 ? `；这一组现在排第 ${draftIndex + 1} 个` : '；新分组排在最后'}
            </span>
            <span><span className="mr-1.5 font-mono text-primary">3</span>都没命中：落进「未归组」</span>
            <span>钉入后卡片名字旁出现图钉；拖回「未归组」即取消钉入</span>
          </div>
          {error ? <div className="text-sm text-destructive" role="alert">{error}</div> : null}
        </div>

        <DialogFooter className="flex-row flex-wrap items-center gap-2 sm:justify-between">
          {!isNew ? (
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => onDelete(draft.id)}>
                删除分组
              </Button>
              <span className="text-xs text-muted-foreground">删除只解散分组，不动任何分支</span>
            </div>
          ) : <span />}
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>取消</Button>
            <Button type="button" size="sm" disabled={!canSave} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
