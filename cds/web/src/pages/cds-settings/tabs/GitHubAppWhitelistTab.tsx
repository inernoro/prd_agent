import { useSettingsSessionOwner, useSettingsSessionState } from '../useSettingsSessionState';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Loader2, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';

import { useSettingsReadRequest } from '@/components/project/ProjectSettingsRefresh';
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
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const owner = useSettingsSessionOwner();
  const currentOwner = useRef(owner); currentOwner.current = owner;
  const [state, setState] = useSettingsSessionState<LoadState>('whitelist:state', { status: 'idle' });
  const [owners, setOwners] = useSettingsSessionState<string[]>('whitelist:owners', []);
  const [draft, setDraft] = useSettingsSessionState<string>('whitelist:draft', '');
  const [saving, setSaving] = useSettingsSessionState<boolean>('whitelist:saving', false, Boolean);
  const [readError, setReadError] = useSettingsSessionState<string>('whitelist:read-error', '');
  const [saveError, setSaveError] = useSettingsSessionState<string>('whitelist:saveError', '', undefined, { keepSession: true });
  const [needsRead, setNeedsRead] = useSettingsSessionState<boolean>('whitelist:needsRead', false, Boolean);
  const [pendingOwners, setPendingOwners] = useSettingsSessionState<string[] | null>('whitelist:pending', null, undefined, { keepSession: true });
  const unconfirmedOwners = useRef(pendingOwners); unconfirmedOwners.current = pendingOwners;
  const [savedOwnerList, setSavedOwnerList] = useSettingsSessionState<string[]>('whitelist:saved', []);
  const savedOwners = useRef(savedOwnerList); savedOwners.current = savedOwnerList;
  const beginRead = useSettingsReadRequest();
  const sameOwners = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

  const load = useCallback(async (preserve = false): Promise<void> => {
    const signal = beginRead();
    if (!preserve) setState({ status: 'loading' });
    try {
      const data = await apiRequest<GitHubAppWhitelistResponse>('/api/cds-system/github/app-whitelist', { signal });
      if (signal.aborted) return;
      if (!Array.isArray(data.allowedOwners) || data.allowedOwners.some(owner => typeof owner !== 'string')) throw new Error('服务未返回可核对的白名单，请重新读取确认。');
      const previous = savedOwners.current;
      const next = data.allowedOwners || [];
      savedOwners.current = next; setSavedOwnerList(next);
      setOwners(current => preserve && !sameOwners(current, previous) ? current : next);
      setState({ status: 'ok', data }); setReadError('');
      if (!unconfirmedOwners.current || sameOwners(next, unconfirmedOwners.current)) { unconfirmedOwners.current = null; setPendingOwners(null); setNeedsRead(false); setSaveError(''); }
    } catch (err) {
      if (signal.aborted) return;
      setReadError(apiMessage(err));
      setState(current => preserve && current.status === 'ok' ? current : { status: 'error', message: apiMessage(err) });
    }
  }, [beginRead, setState, setOwners, setPendingOwners, setSavedOwnerList, setNeedsRead, setSaveError]);

  useEffect(() => {
    void load(true);
  }, [load]);

  const allowedSet = useMemo(() => new Set(owners.map(normalizeOwner)), [owners]);
  const suggestions = state.status === 'ok' ? state.data.ownerSuggestions || [] : [];

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
    if (saving || needsRead) return;
    const pending = normalizeOwner(draft);
    if (pending && !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(pending)) { setSaveError('GitHub 组织名格式不正确'); return; }
    const submitted = pending ? [...new Set([...owners, pending])].sort() : [...owners];
    setSaving(true); setSaveError('');
    try {
      const data = await apiRequest<GitHubAppWhitelistResponse>('/api/cds-system/github/app-whitelist', { method: 'PUT', body: { allowedOwners: submitted } });
      beginRead.cancel();
      if (!Array.isArray(data.allowedOwners)) throw new Error('服务未返回保存后的名单，请重新读取核对。');
      const next = data.allowedOwners || [];
      savedOwners.current = next; setSavedOwnerList(next); setOwners(next); setDraft('');
      setState(current => current.status === 'ok' ? { status: 'ok', data: { ...current.data, ...data } } : current);
      if (alive.current && currentOwner.current === owner) onToast(data.message || 'GitHub App 白名单已保存并生效');
    } catch (err) {
      const unknown = !(err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408);
      setNeedsRead(unknown); unconfirmedOwners.current = unknown ? submitted : null; setPendingOwners(unconfirmedOwners.current);
      setSaveError(`${unknown ? '保存结果未确认，请先重新读取核对，勿重复提交' : '本次保存被拒绝'}：${apiMessage(err)}。当前草稿已保留。`);
    } finally { setSaving(false); }
  };
  useEffect(() => {
    if (!needsRead && !saving) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [needsRead, saving]);
  const dirty = !sameOwners(owners, savedOwners.current) || Boolean(draft.trim());
  const savedCount = state.status === 'ok' ? state.data.allowedOwners.length : 0;

  return (
    <div className="space-y-8">
      <Section
        title="GitHub App 白名单"
        description="填写白名单后,只有列表中的 GitHub owner 或组织可以触发 CDS webhook dispatch。未命中的真实 GitHub webhook 会保留日志,但不会创建分支、部署、停容器或执行评论命令。"
      >
        {state.status === 'loading' || state.status === 'idle' ? (
          <LoadingBlock />
        ) : state.status === 'error' ? (
          <div className="space-y-3"><ErrorBlock message={state.message} /><Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" onClick={() => void load()}>重试读取</Button></div>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm" role="status"><span>{needsRead || readError ? '上次读取门禁' : '已保存门禁'}：<strong>{savedCount > 0 ? '限制为名单内组织' : '兼容放行'}</strong></span><span className="text-muted-foreground">已保存 {savedCount} 个组织</span><span className="text-muted-foreground">{needsRead ? '保存结果未确认' : dirty ? '当前草稿未保存' : '与已保存名单一致'}</span></div>
            {readError ? <p role="alert" className="text-sm text-destructive">读取失败：{readError}。当前草稿和上次读取结果已保留。</p> : null}
            {needsRead && pendingOwners ? <p className="break-words text-sm text-muted-foreground">未确认的提交名单：{pendingOwners.length ? pendingOwners.join('、') : '空名单（兼容放行）'}。重新读取旧名单不能证明该请求未执行。</p> : null}
            {saveError ? <p role="alert" className="text-sm text-destructive">{saveError}</p> : null}

            {savedCount === 0 || owners.length === 0 ? <div className="rounded-md border border-warn/30 bg-warn-soft px-4 py-3 text-sm leading-6 text-warn ">
              白名单为空时不启用 owner 门禁,现有项目和 prd_agent 自身 webhook 会继续放行。需要限制公开 GitHub App 安装时,先从下方日志候选加入你的组织再保存。
            </div> : null}

            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">允许的 GitHub owner / 组织（待保存名单）</div>
              <div className="flex min-h-12 flex-wrap items-center gap-2 rounded-md border border-border bg-[hsl(var(--surface-sunken))] p-2">
                {owners.length === 0 ? (
                  <span className="px-2 text-sm text-muted-foreground">尚未允许任何组织</span>
                ) : owners.map((owner) => (
                  <span key={owner} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-sm">
                    <ShieldCheck className="h-4 w-4 text-ok" />
                    <span className="font-mono">{owner}</span>
                    <button
                      type="button"
                      disabled={saving}
                      aria-label={`移除 ${owner}`}
                      onClick={() => removeOwner(owner)}
                      className="inline-flex h-[3.25rem] w-[3.25rem] items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:h-7 lg:w-7"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </span>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                aria-label="添加 GitHub owner 或组织"
                disabled={saving}
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
              <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" variant="outline" disabled={saving} onClick={() => addOwner(draft)}>
                <Plus />
                加入
              </Button>
              <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" onClick={() => void save()} disabled={saving || needsRead || !dirty}>
                {saving ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                保存白名单
              </Button>
              <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" variant="ghost" disabled={saving} onClick={() => void load(true)}>
                <RefreshCw />
                重新读取名单与日志
              </Button>
            </div>
          </div>
        )}
      </Section>

      <Section
        title="从日志加入"
        description="近期 GitHub webhook 命中的组织。加入只修改上方草稿，点击保存白名单后才生效。"
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
          <><div className="hidden overflow-x-auto rounded-md border border-border lg:block">
            <table className="w-full min-w-[45rem] text-sm">
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
                    disabled={saving}
                    allowed={allowedSet.has(normalizeOwner(item.owner))}
                    onAdd={() => addOwner(item.owner)}
                  />
                ))}
              </tbody>
            </table>
          </div><div className="divide-y divide-border lg:hidden">{suggestions.map(item => { const allowed = allowedSet.has(normalizeOwner(item.owner)); return <article key={item.owner} className="space-y-2 py-3"><h3 className="break-all font-mono text-sm font-semibold">{item.owner}</h3><p className="text-sm text-muted-foreground">命中 {item.count} · 拦截 {item.blockedCount} · {item.linked ? '已绑定项目' : 'Webhook 日志'}</p><p className="text-sm text-muted-foreground">最近 {formatRelativeTime(item.lastSeenAt)}</p><Button className="min-h-[3.25rem] text-base" type="button" size="sm" variant={allowed ? 'outline' : 'default'} disabled={allowed || saving} onClick={() => addOwner(item.owner)}>{allowed ? '已在名单' : '加入待保存名单'}</Button></article>; })}</div></>
        )}
      </Section>
    </div>
  );
}

function OwnerSuggestionRow({
  item,
  allowed,
  disabled,
  onAdd,
}: {
  item: GithubOwnerSuggestion;
  allowed: boolean;
  disabled: boolean;
  onAdd: () => void;
}): JSX.Element {
  return (
    <tr>
      <td className="px-3 py-2 font-mono">{item.owner}</td>
      <td className="px-3 py-2 tabular-nums">{item.count}</td>
      <td className="px-3 py-2 tabular-nums">
        <span className={item.blockedCount > 0 ? 'text-warn' : 'text-muted-foreground'}>
          {item.blockedCount}
        </span>
      </td>
      <td className="px-3 py-2">
        {item.linked ? <CodePill>已绑定项目</CodePill> : <span className="text-muted-foreground">Webhook 日志</span>}
      </td>
      <td className="px-3 py-2 text-muted-foreground">{formatRelativeTime(item.lastSeenAt)}</td>
      <td className="px-3 py-2 text-right">
        <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" size="sm" variant={allowed ? 'outline' : 'default'} disabled={allowed || disabled} onClick={onAdd}>
          {allowed ? '已在名单' : '加入待保存名单'}
        </Button>
      </td>
    </tr>
  );
}
