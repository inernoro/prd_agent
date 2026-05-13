import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, ErrorBlock, LoadingBlock, Section } from '@/pages/cds-settings/components';
import type { GitHubAppWhitelistResponse, GithubOwnerSuggestion } from '@/pages/cds-settings/types';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: GitHubAppWhitelistResponse };

function apiMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}

function normalizeOwner(owner: string): string {
  return owner.trim().replace(/^@/, '').toLowerCase();
}

function formatRelativeTime(iso?: string): string {
  if (!iso) return '暂无命中';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso.slice(0, 10);
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s 前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m 前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h 前`;
  return `${Math.floor(ms / 86_400_000)}d 前`;
}

export function GitHubAppWhitelistTab({ onToast }: { onToast: (message: string) => void }): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [owners, setOwners] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' });
    try {
      const data = await apiRequest<GitHubAppWhitelistResponse>('/api/cds-system/github/app-whitelist');
      setOwners(data.allowedOwners || []);
      setState({ status: 'ok', data });
    } catch (err) {
      setState({ status: 'error', message: apiMessage(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const allowedSet = useMemo(() => new Set(owners.map(normalizeOwner)), [owners]);
  const suggestions = state.status === 'ok' ? state.data.ownerSuggestions || [] : [];
  const pendingSuggestions = suggestions.filter((item) => !allowedSet.has(normalizeOwner(item.owner)));

  const addOwner = (owner: string): void => {
    const normalized = normalizeOwner(owner);
    if (!normalized || allowedSet.has(normalized)) return;
    if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(normalized)) {
      onToast('GitHub 组织名格式不正确');
      return;
    }
    setOwners((cur) => [...cur, normalized].sort((a, b) => a.localeCompare(b)));
    setDraft('');
  };

  const removeOwner = (owner: string): void => {
    const normalized = normalizeOwner(owner);
    setOwners((cur) => cur.filter((item) => normalizeOwner(item) !== normalized));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const data = await apiRequest<GitHubAppWhitelistResponse>('/api/cds-system/github/app-whitelist', {
        method: 'PUT',
        body: { allowedOwners: owners },
      });
      setOwners(data.allowedOwners || []);
      setState((cur) => cur.status === 'ok' ? { status: 'ok', data: { ...cur.data, ...data } } : cur);
      onToast(data.message || 'GitHub App 白名单已更新');
      void load();
    } catch (err) {
      onToast(`保存失败：${apiMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      <Section
        title="GitHub App 白名单"
        description="填写白名单后,只有列表中的 GitHub owner 或组织可以触发 CDS webhook dispatch。未命中的真实 GitHub webhook 会保留日志,但不会创建分支、部署、停容器或执行评论命令。"
      >
        {state.status === 'loading' || state.status === 'idle' ? (
          <LoadingBlock />
        ) : state.status === 'error' ? (
          <ErrorBlock message={state.message} />
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 rounded-md border border-border bg-muted/20 p-4 md:grid-cols-3">
              <StatusTile label="当前状态" value={owners.length > 0 ? '已启用' : '兼容放行'} />
              <StatusTile label="允许组织" value={owners.length} />
              <StatusTile label="日志候选" value={pendingSuggestions.length} />
            </div>

            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-800 dark:text-amber-200">
              白名单为空时不启用 owner 门禁,现有项目和 prd_agent 自身 webhook 会继续放行。需要限制公开 GitHub App 安装时,先从下方日志候选加入你的组织再保存。
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">允许的 GitHub owner / 组织</div>
              <div className="flex min-h-12 flex-wrap items-center gap-2 rounded-md border border-border bg-[hsl(var(--surface-sunken))] p-2">
                {owners.length === 0 ? (
                  <span className="px-2 text-sm text-muted-foreground">尚未允许任何组织</span>
                ) : owners.map((owner) => (
                  <span key={owner} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-sm">
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                    <span className="font-mono">{owner}</span>
                    <button
                      type="button"
                      aria-label={`移除 ${owner}`}
                      onClick={() => removeOwner(owner)}
                      className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </span>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addOwner(draft);
                  }
                }}
                placeholder="例如 my-org"
                className="min-h-11 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <Button type="button" variant="outline" onClick={() => addOwner(draft)}>
                <Plus />
                加入
              </Button>
              <Button type="button" onClick={() => void save()} disabled={saving}>
                {saving ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                保存白名单
              </Button>
              <Button type="button" variant="ghost" onClick={() => void load()}>
                <RefreshCw />
                刷新日志候选
              </Button>
            </div>
          </div>
        )}
      </Section>

      <Section
        title="从日志加入"
        description="这里汇总近期 GitHub webhook 命中的 owner。被拦截次数越多越靠前,可以直接加入白名单。"
      >
        {state.status !== 'ok' ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            白名单加载后会显示日志候选。
          </div>
        ) : suggestions.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            暂无 webhook owner 记录。GitHub App 收到投递后会出现在这里。
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">owner</th>
                  <th className="px-3 py-2 text-left font-medium">命中</th>
                  <th className="px-3 py-2 text-left font-medium">拦截</th>
                  <th className="px-3 py-2 text-left font-medium">来源</th>
                  <th className="px-3 py-2 text-left font-medium">最近</th>
                  <th className="px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {suggestions.map((item) => (
                  <OwnerSuggestionRow
                    key={item.owner}
                    item={item}
                    allowed={allowedSet.has(normalizeOwner(item.owner))}
                    onAdd={() => addOwner(item.owner)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function StatusTile({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function OwnerSuggestionRow({
  item,
  allowed,
  onAdd,
}: {
  item: GithubOwnerSuggestion;
  allowed: boolean;
  onAdd: () => void;
}): JSX.Element {
  return (
    <tr>
      <td className="px-3 py-2 font-mono">{item.owner}</td>
      <td className="px-3 py-2 tabular-nums">{item.count}</td>
      <td className="px-3 py-2 tabular-nums">
        <span className={item.blockedCount > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}>
          {item.blockedCount}
        </span>
      </td>
      <td className="px-3 py-2">
        {item.linked ? <CodePill>已绑定项目</CodePill> : <span className="text-muted-foreground">Webhook 日志</span>}
      </td>
      <td className="px-3 py-2 text-muted-foreground">{formatRelativeTime(item.lastSeenAt)}</td>
      <td className="px-3 py-2 text-right">
        <Button type="button" size="sm" variant={allowed ? 'outline' : 'default'} disabled={allowed} onClick={onAdd}>
          {allowed ? '已允许' : '加入白名单'}
        </Button>
      </td>
    </tr>
  );
}
