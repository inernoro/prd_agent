import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { AnchoredPopover, type PopoverAnchor } from '@/components/ui/anchored-popover';
import { Loader2, Plus, RefreshCw, Star } from 'lucide-react';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import type { RemoteBranch } from '@/lib/remoteBranches';
import { statusRailClass } from '@/lib/statusStyle';

export interface TrackedBranchOption { id: string; branch: string; status?: string; commitSha?: string; tags?: string[]; isFavorite?: boolean }

export function BranchSearchDropdown<T extends TrackedBranchOption>({
  query,
  anchorRef,
  onDismiss,
  id,
  tracked,
  remote,
  remoteLoading,
  trackedByName,
  actions,
  configSourceBranchId,
  onChangeConfigSource,
  onPickTracked,
  onPickRemote,
  onForceFetchRemote,
  describeTracked = () => '已登记',
  trackedStatusClass = branch => statusRailClass(branch.status || 'idle'),
  trackedBusy = () => false,
  emptyHint = '没有匹配的分支。',
  remoteError,
}: {
  query: string;
  anchorRef?: RefObject<HTMLElement | null>;
  onDismiss?: () => void;
  id?: string;
  tracked: T[];
  remote: RemoteBranch[];
  remoteLoading: boolean;
  trackedByName: Map<string, T>;
  actions: Record<string, { status?: string } | undefined>;
  configSourceBranchId?: string | null;
  onChangeConfigSource?: (branchId: string | null) => void;
  onPickTracked: (branch: T) => void;
  onPickRemote: (remote: RemoteBranch) => void;
  onForceFetchRemote: () => void;
  describeTracked?: (branch: T) => ReactNode;
  trackedStatusClass?: (branch: T) => string;
  trackedBusy?: (branch: T) => boolean;
  emptyHint?: string;
  remoteError?: string;
}): JSX.Element {
  const fallbackRef = useRef<HTMLSpanElement>(null);
  const fallbackAnchor = useMemo<PopoverAnchor>(() => ({ get current() { return fallbackRef.current?.parentElement ?? null; } }), []);
  const effectiveAnchor = anchorRef ?? fallbackAnchor;
  useEffect(() => {
    const input = effectiveAnchor.current instanceof HTMLElement ? effectiveAnchor.current.querySelector('input') : null;
    const key = (event: KeyboardEvent): void => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const panel = document.getElementById(id || '');
      const choices = panel?.querySelectorAll<HTMLButtonElement>('[data-branch-choice]:not(:disabled)');
      if (!choices?.length) return;
      event.preventDefault(); event.stopPropagation();
      (event.key === 'ArrowDown' ? choices[0] : choices[choices.length - 1]).focus();
    };
    input?.addEventListener('keydown', key);
    return () => input?.removeEventListener('keydown', key);
  }, [effectiveAnchor, id]);
  const trimmed = query.trim().toLowerCase();
  const matches = (text: string) => !trimmed || text.toLowerCase().includes(trimmed);
  // 波3 补 UI:新建分支的「配置来源」——按分支名排序,供用户从本项目已有分支
  // 快照拷贝分支级配置。跨项目派生后端已拒绝,这里天然只列本项目分支。
  const sourceCandidates = [...tracked].sort((a, b) => a.branch.localeCompare(b.branch));

  const visibleTracked = tracked
    .filter((branch) => matches(branch.branch) || matches(branch.commitSha || '') || (branch.tags || []).some(matches));
  const visibleRemote = remote.filter((row) => !trackedByName.get(row.name) && matches(row.name));

  const empty = visibleTracked.length === 0 && visibleRemote.length === 0;

  return (<><span ref={fallbackRef} aria-hidden />
    <AnchoredPopover open anchorRef={effectiveAnchor} onDismiss={onDismiss} width="anchor" minWidthRem={20} maxHeightRem={30} tabIntoPanel={false}
      id={id}
      className="cds-overlay-anim z-[300] rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] shadow-2xl"
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !(event.target as HTMLElement).hasAttribute('data-branch-choice')) return;
        const choices = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-branch-choice]:not(:disabled)')];
        const index = choices.indexOf(event.target as HTMLButtonElement);
        event.preventDefault(); event.stopPropagation();
        choices[event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]?.focus();
      }}
      role="dialog"
      aria-label="分支建议"
    >
      {/* 波3 补 UI:配置来源分支选择器。常驻于建议列表之上,仅在新建分支时生效
          (选中已跟踪分支只是聚焦卡片,不创建,忽略此项)。默认「项目模板」= 不派生。 */}
      {onChangeConfigSource && sourceCandidates.length > 0 ? (
        <div className="flex items-center gap-2 border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/40 px-4 py-2">
          <label htmlFor="cds-config-source" className="shrink-0 text-[0.6875rem] font-medium text-muted-foreground">
            配置来源
          </label>
          <select
            id="cds-config-source"
            value={configSourceBranchId ?? ''}
            onChange={(event) => onChangeConfigSource(event.target.value || null)}
            className="min-w-0 flex-1 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-2 py-1 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--ring))]"
            title="默认使用项目模板。派生会复制环境与额外服务，但保留项目极速默认；源码模式例外需创建后手动设置。额外服务仍可能使分支显示部分极速。"
          >
            <option value="">项目模板(默认,不派生)</option>
            {sourceCandidates.map((branch) => (
              <option key={branch.id} value={branch.id}>
                派生自 {branch.branch}（保留项目极速默认）
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {remoteError ? <p role="alert" className="px-4 py-2 text-xs text-destructive">{remoteError}</p> : null}
      <div className="py-1">
        {empty ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            {emptyHint}
          </div>
        ) : null}

        {visibleTracked.length > 0 ? (
          <>
            <div className="px-4 pt-2 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
              已跟踪 · {visibleTracked.length}
            </div>
            {visibleTracked.map((branch) => {
              const action = actions[branch.id];
              const busy = action?.status === 'running' || trackedBusy(branch);
              return (
                <button
                  key={branch.id}
                  data-branch-choice=""
                  type="button"
                  onClick={() => onPickTracked(branch)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[hsl(var(--surface-sunken))]"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${trackedStatusClass(branch)}`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{branch.branch}</span>
                    <span className="block truncate text-[0.6875rem] text-muted-foreground">
                      {describeTracked(branch)}
                    </span>
                  </span>
                  {busy ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
                  {branch.isFavorite ? <Star className="h-3 w-3 shrink-0 fill-current text-warn" /> : null}
                </button>
              );
            })}
          </>
        ) : null}

        {remoteLoading && visibleRemote.length === 0 ? <ContentLoading label="读取远程分支" variant="rows" /> : null}

        {/* Bug A:取消自动 force-fetch 兜底后,空 remote 时给个手动触发入口。
            5 分钟内点了 force-fetch 后端会真跑 git fetch(可能 30s)。
            Bugbot fix(2026-05-04):去掉 `tracked.length === 0` 限制 — 之前
            有任何本地分支 hint 就消失,用户无法发现新远程分支。footer 里的
            「刷新远程」永久按钮兜底 hint 可见性,这里只在空 remote 时给醒目提示。 */}
        {!remoteLoading && visibleRemote.length === 0 ? (
          <div className="flex items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] px-4 py-2.5 text-[0.6875rem] text-muted-foreground">
            <span>{remote.length ? '没有匹配的远程分支。' : '远程分支缓存为空。'}</span>
            <button
              type="button"
              onClick={onForceFetchRemote}
              className="rounded px-2 py-1 text-[0.6875rem] font-medium text-foreground hover:bg-[hsl(var(--surface-sunken))]"
            >
              <RefreshCw className="mr-1 inline h-3 w-3" />
              拉取远程(可能 ~10s)
            </button>
          </div>
        ) : null}

        {visibleRemote.length > 0 ? (
          <>
            <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
              <span>远程 · {visibleRemote.length}</span>
              {remoteLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            </div>
            {visibleRemote.map((remoteBranch) => {
              const action = actions[remoteBranch.name];
              return (
                <button
                  key={remoteBranch.name}
                  data-branch-choice=""
                  type="button"
                  onClick={() => onPickRemote(remoteBranch)}
                  disabled={!!action}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[hsl(var(--surface-sunken))] disabled:opacity-60"
                >
                  <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{remoteBranch.name}</span>
                      {remoteBranch.isDefault ? (
                        <span className="shrink-0 rounded border border-info/35 bg-info-soft px-1.5 py-0.5 text-[0.625rem] text-info">
                          默认分支
                        </span>
                      ) : null}
                    </span>
                    <span className="block truncate text-[0.6875rem] text-muted-foreground">
                      {remoteBranch.subject || remoteBranch.author || '部署并预览'}
                    </span>
                  </span>
                  {action ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" /> : null}
                </button>
              );
            })}
          </>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/50 px-4 py-2 text-[0.6875rem] text-muted-foreground">
        <span>选择分支 · Esc 关闭</span>
        <div className="flex items-center gap-2">
          <span>{visibleTracked.length + visibleRemote.length} 项</span>
          {/* Bugbot fix(2026-05-04):永久暴露"刷新远程"入口,
              不再依赖空状态 hint。即使 tracked/remote 都有,缓存可能仍 stale。 */}
          <button
            type="button"
            onClick={onForceFetchRemote}
            disabled={remoteLoading}
            title="重新拉取 origin 远程分支(可能 ~10s)"
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem] hover:bg-[hsl(var(--surface-raised))] disabled:opacity-50"
          >
            {remoteLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            刷新远程
          </button>
        </div>
      </div>
    </AnchoredPopover></>
  );
}
