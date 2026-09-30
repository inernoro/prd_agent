/*
 * 第一次切到「按分组」时的建组建议（2026-09-29 自定义分组）。
 *
 * 不让用户对着空白从零配：CDS 按分支名前缀在本项目里数一遍，列出几类，勾上就建。
 * 只有一个分支的前缀默认不勾，免得一上来就一堆单卡小组。组名是猜的，可以当场改。
 */
import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react';
import { Plus, Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  BRANCH_GROUP_LIMITS,
  newBranchGroupId,
  suggestPrefixGroups,
  type BranchGroup,
  type GroupableBranch,
} from '@/lib/branchGroups';
import { BRANCH_GROUP_SWATCH_CLASS } from './BranchGroupHeader';

/** 勾选与组名草稿：由页面持有。建组是乐观更新，点「创建」时本组件会卸载；
 *  草稿放在这里的话，请求失败、面板重新出现时用户改过的内容就全丢了（Codex P2，PR #1647）。 */
export interface BranchGroupSuggestionDraft {
  checked: Record<string, boolean>;
  names: Record<string, string>;
}

export const EMPTY_SUGGESTION_DRAFT: BranchGroupSuggestionDraft = { checked: {}, names: {} };

export function BranchGroupSuggestions({
  branches,
  saving,
  error,
  draft,
  onDraftChange,
  onCreate,
  onBlank,
}: {
  branches: GroupableBranch[];
  saving: boolean;
  error: string;
  draft: BranchGroupSuggestionDraft;
  onDraftChange: Dispatch<SetStateAction<BranchGroupSuggestionDraft>>;
  onCreate: (groups: BranchGroup[]) => void;
  onBlank: () => void;
}): JSX.Element {
  const suggestions = useMemo(() => suggestPrefixGroups(branches), [branches]);
  const { checked, names } = draft;
  const setChecked = (update: (current: Record<string, boolean>) => Record<string, boolean>) =>
    onDraftChange((current) => ({ ...current, checked: update(current.checked) }));
  const setNames = (update: (current: Record<string, string>) => Record<string, string>) =>
    onDraftChange((current) => ({ ...current, names: update(current.names) }));
  useEffect(() => {
    // 分支列表每来一条事件都会重算建议；只给新冒出来的前缀填默认值，用户已经改过的勾选和组名原样保留（Codex P2，PR #1647）。
    // 默认勾选不超过分组上限：前缀多到超过上限时，只默认勾最多的那几类。
    setChecked((current) => Object.fromEntries(suggestions.map((item, index) => [
      item.prefix,
      item.prefix in current ? current[item.prefix] : item.defaultChecked && index < BRANCH_GROUP_LIMITS.groups,
    ])));
    setNames((current) => Object.fromEntries(suggestions.map((item) => [
      item.prefix,
      item.prefix in current ? current[item.prefix] : item.name,
    ])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestions]);
  const picked = suggestions.filter((item) => checked[item.prefix]);
  const overLimit = picked.length - BRANCH_GROUP_LIMITS.groups;

  const create = () => {
    onCreate(picked.map((item) => ({
      id: newBranchGroupId(),
      name: (names[item.prefix] || item.name).trim() || item.name,
      color: item.color,
      rules: [{ kind: 'prefix', value: item.prefix }],
      pinnedBranchIds: [],
    })));
  };

  return (
    <section
      className="flex w-full max-w-[40rem] flex-col gap-4 rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-6"
      aria-label="按分支前缀建组"
      data-branch-group-suggestions
    >
      <div>
        <h3 className="text-lg font-bold">还没有分组</h3>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {suggestions.length > 0
            ? 'CDS 按分支名前缀在本项目里找到了这几类，勾上就建。新分支推上来会自动进对应的组。'
            : '本项目的分支名都没有「前缀/」这种结构，找不到可以自动建组的规律。可以从空白新建，按标签或名字片段归组。'}
        </p>
      </div>
      {suggestions.length > 0 ? (
        <div className="flex flex-col gap-2">
          {suggestions.map((item) => (
            <div
              key={item.prefix}
              className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[hsl(var(--hairline))] px-3 py-1.5"
            >
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[hsl(var(--primary))]"
                  checked={Boolean(checked[item.prefix])}
                  onChange={(event) => setChecked((current) => ({ ...current, [item.prefix]: event.target.checked }))}
                />
                <span className={`h-2.5 w-2.5 rounded-[0.1875rem] ${BRANCH_GROUP_SWATCH_CLASS[item.color]}`} aria-hidden />
                <span className="font-mono text-sm font-semibold">{item.prefix}</span>
                <span className="text-sm text-muted-foreground">{item.count} 个分支</span>
              </label>
              <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                组名
                <input
                  className="h-8 w-36 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
                  value={names[item.prefix] ?? item.name}
                  maxLength={BRANCH_GROUP_LIMITS.nameLength}
                  aria-label={`${item.prefix} 的组名`}
                  onChange={(event) => setNames((current) => ({ ...current, [item.prefix]: event.target.value }))}
                />
              </label>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">只有 1 个分支的前缀默认不勾，免得一上来就一堆单卡小组。</p>
        </div>
      ) : null}
      {overLimit > 0 ? (
        <div className="text-sm text-destructive" data-branch-group-suggestion-limit>
          一个项目最多 {BRANCH_GROUP_LIMITS.groups} 个分组，已勾选 {picked.length} 个，请再取消 {overLimit} 个。
        </div>
      ) : null}
      {error ? <div className="text-sm text-destructive" role="alert">{error}</div> : null}
      <div className="flex flex-wrap items-center gap-2">
        {suggestions.length > 0 ? (
          <Button type="button" disabled={picked.length === 0 || overLimit > 0 || saving} onClick={create}>
            {saving ? '创建中…' : `创建 ${picked.length} 个分组`}
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={onBlank}>
          <Plus />
          从空白新建
        </Button>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Users className="h-3.5 w-3.5" aria-hidden />
        分组对本项目所有成员和 Agent 生效；收起、展开只记在你自己的浏览器里
      </div>
    </section>
  );
}
