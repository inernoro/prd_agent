/**
 * IdentityTab —— 权限总览：按**主体**聚合，不按钥匙平铺。
 *
 * 这一页要解掉一个具体的两难：吊销记录留着，列表用久了糊成一片；删掉，又分不出
 * 「从没签发」和「被吊销」。第三条路是把**看板和判据分开**——
 *
 *   - 看板（这一页）只回答「现在有谁能进来」：主列表列主体（十几个），
 *     每个主体下面的凭证历史默认折叠，超过保留期的直接不展示（归档，不是删除）。
 *   - 「这把到底怎么了」交给凭据自检端点，由持有者自己去查，不用来问管理员。
 *
 * 另外把此前看不见的两样东西端出来：**签发留痕**（这张用户级凭证签出过几张下游）
 * 与**级联撤销**（撤源头一次撤干净）。用户级凭证只授权不操作，所以滥用一定表现为
 * 「签出一堆项目级凭证」—— 看不见签发次数，留痕就等于没留。
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, KeyRound, Loader2, Plus, RefreshCw, ShieldOff, UserCog } from 'lucide-react';

import { useSettingsSessionOwner, useSettingsSessionState } from '../useSettingsSessionState';
import { ConsoleAuthContext } from '@/lib/consoleAuthContext';
import { useSettingsReadRequest } from '@/components/project/ProjectSettingsRefresh';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';
import { apiRequest, ApiError } from '@/lib/api';

interface CredentialView {
  id: string;
  kind: 'user' | 'project';
  label?: string;
  projectId?: string;
  projectName?: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  status: 'active' | 'expired' | 'revoked' | 'principal-disabled' | 'grant-revoked';
  issuedCount?: number;
  lastIssuedAt?: string;
}

interface GrantView {
  id: string;
  projectId: string;
  projectName?: string;
  origin: 'created' | 'approved';
  grantedAt: string;
}

interface PrincipalRow {
  principal: {
    id: string;
    name: string;
    kind: 'human' | 'machine' | 'agent';
    status: 'active' | 'disabled';
    createdAt: string;
    createdBy?: string;
    lastSeenAt?: string;
  };
  activeCredentials: CredentialView[];
  retiredCredentials: CredentialView[];
  grants: GrantView[];
}

interface OverviewResponse {
  rows: PrincipalRow[];
  unclaimed: CredentialView[];
  archivedCount: number;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: OverviewResponse };

interface Props {
  onToast: (message: string) => void;
}

const KIND_LABEL: Record<PrincipalRow['principal']['kind'], string> = {
  human: '人',
  machine: '机器',
  agent: '智能体',
};

function formatDate(value?: string): string {
  if (!value) return '—';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString('zh-CN', { hour12: false });
}

/** 到期还剩多久 —— 用户级 90 天、项目级 30 天都是「用一次自动续」，所以这里是活的。 */
function remaining(expiresAt?: string): string {
  if (!expiresAt) return '永不过期';
  const ms = Date.parse(expiresAt) - Date.now();
  if (Number.isNaN(ms)) return expiresAt;
  if (ms <= 0) return '已过期';
  const days = Math.floor(ms / 86_400_000);
  return days >= 1 ? `还剩 ${days} 天` : '不足 1 天';
}

/**
 * 这条退役凭证为什么不能用。
 *
 * 服务端把「主体被停用」「授权被撤」与「到期」分成了三种状态，界面若把非
 * `revoked` 的一律当成到期，管理员看到的就是「过期于 —」（这两种情况根本没有
 * 到期时间）—— 明明是他自己刚点的停用，界面却说不出原因。
 */
function retiredReason(cred: CredentialView): string {
  switch (cred.status) {
    case 'revoked':
      return `吊销于 ${formatDate(cred.revokedAt)}`;
    case 'principal-disabled':
      return '主体已停用，名下凭证一律不可用';
    case 'grant-revoked':
      return '该项目的授权已被撤销';
    default:
      return `过期于 ${formatDate(cred.expiresAt)}`;
  }
}

export function IdentityTab({ onToast }: Props): JSX.Element {
  const [state, setState] = useSettingsSessionState<LoadState>('identity:read-state', { status: 'idle' });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useSettingsSessionState<boolean>('identity:creating', false, Boolean);
  const [newName, setNewName] = useSettingsSessionState<string>('identity:new-name', '');
  const [issued, setIssued] = useSettingsSessionState<{ plaintext: string; reach: string; principal: PrincipalRow['principal']; credential: { id: string }; owner: object | null; expired?: boolean } | null>('identity:issued', null, Boolean, { expireTo: value => value ? { ...value, plaintext: '', expired: true } : null });
  const [createOpen, setCreateOpen] = useSettingsSessionState<boolean>('identity:create-open', false);
  const [query, setQuery] = useState('');
  const [readError, setReadError] = useState('');
  const [issueError, setIssueError] = useSettingsSessionState<string>('identity:issue-error', '', undefined, { keepSession: true });
  const [issueUnknown, setIssueUnknown] = useSettingsSessionState<boolean>('identity:issue-unknown', false, Boolean);
  const [busyAction, setBusyAction] = useSettingsSessionState<string>('identity:busy-action', '', Boolean);
  const [uncertainKey, setUncertainKey] = useSettingsSessionState<string>('identity:uncertain-key', '', Boolean);
  const [pendingMutation, setPendingMutation] = useSettingsSessionState<{ kind: 'principal' | 'credential'; id: string; status?: 'active' | 'disabled' } | null>('identity:pending-mutation', null, undefined, { keepSession: true });
  const uncertainMutation = useRef(pendingMutation); uncertainMutation.current = pendingMutation;
  const [issueRead, setIssueRead] = useState(false);
  const [unknownIssue, setUnknownIssue] = useSettingsSessionState<{ principal: string; requestedAt: string } | null>('identity:unknown-issue', null, undefined, { keepSession: true });
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const sessionOwner = useSettingsSessionOwner();
  const receiptRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { status: authScope } = useContext(ConsoleAuthContext);
  const currentScope = useRef(authScope); currentScope.current = authScope;
  const beginRead = useSettingsReadRequest();

  const load = useCallback(async (preserve = false) => {
    const signal = beginRead();
    if (!preserve) setState({ status: 'loading' });
    try {
      const res = await apiRequest<OverviewResponse>('/api/identity/overview', { signal });
      if (signal.aborted) return;
      setState({ status: 'ok', data: res }); setReadError(''); setIssueRead(true);
      const pending = uncertainMutation.current;
      if (pending && (pending.kind === 'principal' ? res.rows.some(row => row.principal.id === pending.id && row.principal.status === pending.status) : res.rows.some(row => [...row.activeCredentials, ...row.retiredCredentials].some(credential => credential.id === pending.id && credential.status === 'revoked')))) { setPendingMutation(null); setUncertainKey(''); }
    } catch (err) {
      if (signal.aborted) return;
      const message = err instanceof ApiError ? err.message : String(err);
      setReadError(message); setState(current => preserve && current.status === 'ok' ? current : { status: 'error', message });
    }
  }, [beginRead, setState, setPendingMutation, setUncertainKey]);
  useEffect(() => { setIssueRead(false); void load(true); }, [load, authScope]);
  useEffect(() => {
    if (issued && issued.owner === sessionOwner && state.status === 'ok') { receiptRef.current?.scrollIntoView({ block: 'nearest' }); receiptRef.current?.focus({ preventScroll: true }); }
  }, [issued, state.status, sessionOwner]);
  useEffect(() => { if (issued?.owner === sessionOwner) void load(true); }, [issued?.credential.id, sessionOwner, load]);
  useEffect(() => { if (createOpen && !issued) inputRef.current?.focus(); }, [createOpen, issued]);

  useEffect(() => {
    if (!issued && !creating && !issueUnknown && !uncertainKey) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [issued, creating, issueUnknown, uncertainKey]);

  /**
   * 签一张用户级凭证。
   *
   * 传 principalId = 给**已有主体**补一张（换了机器、凭证丢了、到期了）——
   * 这条路径是整套自愈的入口：新建主体名下没有任何项目授权，补签成新主体
   * 等于把「批一次就够」作废，人得重新批一遍。
   * 不传 = 新建一个主体。
   */
  const issue = useCallback(async (principalId?: string) => {
    if (creating || issueUnknown || issued || busyAction || uncertainKey) return;
    const requestScope = authScope;
    const name = newName.trim();
    if (!principalId && !name) { onToast('先给这台机器 / 这个智能体起个名字'); return; }
    setCreating(true); setIssueError(''); setIssueRead(false);
    const requestedAt = new Date().toISOString();
    try {
      const res = await apiRequest<{ plaintext: string; reach: string; principal: PrincipalRow['principal']; credential: { id: string } }>('/api/identity/user-credentials', {
        method: 'POST',
        body: principalId ? { principalId } : { name },
      });
      if (!res.plaintext || !res.principal?.id || !res.credential?.id) throw new Error('签发响应不完整，无法确认明文与对象');
      if (alive.current && currentScope.current === requestScope) beginRead.cancel();
      setIssued({ ...res, owner: sessionOwner }); setCreateOpen(true);
      if (!principalId) setNewName('');

    } catch (err) {
      const unknown = !(err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408);
      setIssueUnknown(unknown);
      if (unknown) setUnknownIssue({ principal: principalId || name, requestedAt });
      setIssueError(unknown ? '签发结果未确认，请重新读取列表核对，勿重复签发；未收到的明文不能从列表恢复，可核对后吊销未领取凭证。' : err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [newName, load, creating, issueUnknown, authScope, beginRead, busyAction, uncertainKey, issued]);

  const revokeCredential = useCallback(async (id: string) => {
    if (creating || busyAction || uncertainKey) return;
    const requestScope = authScope; setBusyAction(id);
    try {
      const res = await apiRequest<{ cascadedCount: number }>(`/api/identity/user-credentials/${id}/revoke`, { method: 'POST', body: {} });
      if (currentScope.current !== requestScope) return;
      onToast(res.cascadedCount > 0 ? `已撤销，并同时撤销 ${res.cascadedCount} 张下游凭证` : '凭证已撤销');
      await load(true);
    } catch (err) {
      const unknown = !(err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408);
      if (unknown) { setPendingMutation({ kind: 'credential', id }); setUncertainKey(id); }
      if (alive.current && currentScope.current === requestScope) onToast(unknown ? '凭证撤销结果未确认，请重新读取核对，勿重复提交。' : err instanceof Error ? err.message : String(err));
    } finally { setBusyAction(''); }
  }, [authScope, creating, busyAction, uncertainKey, onToast, load]);

  const setPrincipalStatus = useCallback(async (id: string, status: 'active' | 'disabled') => {
    if (creating || busyAction || uncertainKey) return;
    const requestScope = authScope; setBusyAction(id);
    try {
      await apiRequest(`/api/identity/principals/${id}/status`, { method: 'POST', body: { status } });
      if (currentScope.current !== requestScope) return;
      onToast(status === 'disabled' ? '主体已停用，名下凭证立即不可用' : '主体已恢复');
      await load(true);
    } catch (err) {
      const unknown = !(err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408);
      if (unknown) { setPendingMutation({ kind: 'principal', id, status }); setUncertainKey(id); }
      if (alive.current && currentScope.current === requestScope) onToast(unknown ? '主体状态变更结果未确认，请重新读取核对，勿重复提交。' : err instanceof Error ? err.message : String(err));
    } finally { setBusyAction(''); }
  }, [authScope, creating, busyAction, uncertainKey, onToast, load]);

  if (state.status === 'loading' || state.status === 'idle') return <LoadingBlock label="加载权限总览" />;
  if (state.status === 'error') return <div className="space-y-3"><ErrorBlock message={state.message} /><Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" onClick={() => void load()}>重试读取</Button></div>;

  const { rows, unclaimed, archivedCount } = state.data;
  const visibleIssued = issued?.owner === sessionOwner ? issued : null;
  const needle = query.trim().toLocaleLowerCase();
  const visibleRows = rows.filter(row => !needle || [row.principal.id, row.principal.name, row.principal.createdBy, ...row.activeCredentials.map(credential => credential.id), ...row.grants.map(grant => grant.projectName || grant.projectId)].some(value => value?.toLocaleLowerCase().includes(needle)));

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">权限总览</h3>
          <p className="max-w-[80ch] text-xs leading-6 text-muted-foreground">
            按人员、机器或智能体查看主体及其凭证与项目授权。用户级凭证可创建、列出项目，并为已授权项目签发项目级凭证；不能直接执行部署运维。撤销用户级凭证会<strong>级联撤销它签发的下游凭证</strong>。
          </p>
        </div>
        <div className="flex flex-wrap gap-2"><Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" size="sm" onClick={() => setCreateOpen(value => !value)} disabled={creating || Boolean(issued) || Boolean(busyAction) || Boolean(uncertainKey)}><Plus />登记新主体</Button><Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" size="sm" variant="outline" disabled={creating} onClick={() => void load(true)}><RefreshCw />重新读取</Button></div>
      </header>

      {rows.length > 5 || query ? <label className="block sm:max-w-md"><span className="sr-only">搜索主体</span><input aria-label="搜索主体" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索名称、主体编号或项目" /></label> : null}
      {busyAction ? <p role="status" className="text-sm text-muted-foreground">正在处理权限变更，请稍候。</p> : null}
      {uncertainKey ? <p role="alert" className="text-sm text-warn">对象 {uncertainKey} 的变更结果未确认。当前显示上次读取结果，请重新读取核对后继续。</p> : null}
      {readError ? <p role="alert" className="text-sm text-destructive">读取失败：{readError}。当前显示上次结果。</p> : null}
      {issueError ? <p role="alert" className="text-sm text-destructive">{issueError}</p> : null}
      {unknownIssue ? <p className="break-words text-sm text-muted-foreground">未确认签发请求：主体 {unknownIssue.principal} · {formatDate(unknownIssue.requestedAt)}。列表读取不能证明该请求未执行，一次性明文不能从列表找回。</p> : null}
      {issueUnknown && issueRead && !readError ? <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" variant="outline" disabled={creating} onClick={() => { setIssueUnknown(false); setIssueError('原签发结果仍未确认。你已选择在人工核对并处理未领取凭证后准备新的签发；不会自动重复原请求。'); }}>已核对并处理，准备新的签发</Button> : null}
      {createOpen || visibleIssued ? <section ref={receiptRef} tabIndex={-1} aria-label="凭证签发结果与操作" className="rounded-md border border-border p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {!visibleIssued ? <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[13.75rem] flex-1 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">给这台机器 / 这个智能体起个名字</span>
            <input
              className="h-9 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary"
              ref={inputRef}
              disabled={creating || issueUnknown || Boolean(busyAction) || Boolean(uncertainKey)}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="例如：我的笔记本 / CI 构建机 / 缺陷修复智能体"
            />
          </label>
          <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" size="sm" onClick={() => void issue()} disabled={creating || issueUnknown || Boolean(busyAction) || Boolean(uncertainKey)}>
            {creating ? <Loader2 className="animate-spin" /> : <Plus />} 签发用户级凭证
          </Button>
        </div> : null}
        {visibleIssued ? (
          <div className="mt-3 rounded-md border border-[hsl(var(--warn))]/40 bg-[hsl(var(--warn-soft))] p-3">
            <h4 className="mb-2 break-words text-sm font-semibold">已为 {visibleIssued.principal.name} 签发凭证</h4><p className="mb-2 break-all text-xs">主体编号：{visibleIssued.principal.id} · 凭证编号：{visibleIssued.credential.id}</p><div className="mb-2 text-sm font-semibold text-[hsl(var(--warn))]">{visibleIssued.expired ? '本次明文临时保留已到期，请先核对凭证。' : '请立即安全保存明文；切换标签最多临时保留 30 分钟，刷新或关闭页面无法恢复。'}</div>
            <div className="flex flex-wrap items-center gap-2">
              {visibleIssued.expired ? <p role="alert" className="text-sm text-warn">明文临时保留已到期，无法恢复。请按上方主体与凭证编号核对；未领取的凭证应先撤销，再准备新的签发。</p> : <textarea readOnly aria-label="一次性凭证明文" value={visibleIssued.plaintext} rows={2} onFocus={event => event.currentTarget.select()} className="min-w-0 flex-1 resize-y rounded border border-input bg-background p-2 font-mono text-sm" spellCheck={false} />}
              <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs"
                type="button"
                size="sm"
                variant="outline"
                disabled={visibleIssued.expired}
                onClick={() => {
                  void (async () => { try { await navigator.clipboard.writeText(visibleIssued.plaintext); onToast('已复制'); } catch { onToast('复制失败，请手动选择明文并保存。'); } })();
                }}
              >
                <Copy /> 复制
              </Button>
              <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" size="sm" variant="ghost" onClick={() => { setIssued(null); setCreateOpen(false); }}>{visibleIssued.expired ? '我已核对并处理' : '我已存好'}</Button>
            </div>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">{visibleIssued.reach}</p>
            {/*
              光说「复制、存好」不够：whoami 与自愈只读用户目录下那个文件，
              存进密码管理器或随手贴进别处，自愈会报「本机没有用户级凭证」——
              这一屏只出现一次，所以要在这里就把落地方式说清（Codex P2）。
            */}
            <div className="mt-3 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--muted))]/40 p-3">
              <p className="mb-1 text-xs font-semibold">{visibleIssued.expired ? '若已安全保存明文，可按此方式配置到机器；未领取的凭据应先撤销' : '在那台机器上执行一次，凭证才真正落地'}</p>
              {/*
                必须带上主机：新机器 / 新 clone 上没有仓库里那份凭据文件，
                CDS_HOST 也往往没设，命令会在收凭证之前就先失败 —— 而这一屏
                只出现一次，给一条跑不通的命令等于没给。主机就是当前这个页面
                的域名，直接从地址栏取，不写死。
              */}
              <pre className="overflow-x-auto rounded bg-[hsl(var(--background))] px-2 py-1.5 font-mono text-[0.6875rem] leading-5">
                {`cdscli identity save --host ${typeof window === 'undefined' ? '<CDS 主机>' : window.location.host}`}
              </pre>
              <p className="mt-1 text-xs leading-6 text-muted-foreground">
                回车后粘贴上面这串（不回显），会写进用户目录并设为仅本人可读。
                它跟着人走、不跟着仓库走，所以挪目录、重新 clone 都不会丢。
                <span className="font-medium">不要把明文写进命令行参数</span> —— 那样它会留在 shell 历史里。
              </p>
            </div>
          </div>
        ) : null}
      </section> : null}

      {rows.length === 0 ? (
        <section className="cds-surface-raised cds-hairline rounded-md border border-dashed border-[hsl(var(--hairline))] px-4 py-8 text-center text-sm text-muted-foreground">
          还没有任何主体。签发第一张用户级凭证后，这里会按主体列出谁能进来。
        </section>
      ) : null}

      {rows.length > 0 && visibleRows.length === 0 ? <p className="py-4 text-sm text-muted-foreground">没有匹配的主体，请调整搜索条件。</p> : null}
      {visibleRows.map((row) => {
        const open = expanded[row.principal.id] === true;
        const disabled = row.principal.status !== 'active';
        return (
          <section
            key={row.principal.id}
            data-principal-id={row.principal.id}
            className="cds-surface-raised cds-hairline rounded-md border border-[hsl(var(--hairline))]"
          >
            <header className="flex flex-wrap items-center gap-3 border-b border-[hsl(var(--hairline))] px-4 py-3">
              <UserCog className="h-4 w-4 text-muted-foreground" />
              <div className="min-w-0"><h4 className="break-words text-sm font-semibold">{row.principal.name}</h4><p className="mt-1 break-all text-xs text-muted-foreground">主体编号：<code>{row.principal.id}</code></p><p className="mt-1 break-words text-xs text-muted-foreground">创建于 {formatDate(row.principal.createdAt)} · 来源 {row.principal.createdBy || '未记录'}</p></div>
              <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground">
                {KIND_LABEL[row.principal.kind]}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-[0.625rem] ${uncertainKey === row.principal.id ? 'bg-warn-soft text-warn' : disabled ? 'bg-bad-soft text-bad' : 'bg-ok-soft text-ok'}`}
              >
                {uncertainKey === row.principal.id ? '状态未确认' : disabled ? '已停用' : '已启用'}
              </span>
              <span className="text-xs text-muted-foreground">
                有效凭证 {row.activeCredentials.length} · 项目授权 {row.grants.length}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">最近活动 {formatDate(row.principal.lastSeenAt)}</span>
              <ConfirmAction scopeKey={row.principal.id} title={`为 ${row.principal.name} 补签凭证？`} description={`主体编号：${row.principal.id}。请按编号核对对象，不按重名猜测。已有项目授权保持不变；确认后本页上方展示一次性明文，请立即复制保存。`} confirmLabel="确认补签" disabled={creating || disabled || issueUnknown || Boolean(issued) || Boolean(busyAction) || Boolean(uncertainKey)} onConfirm={() => issue(row.principal.id)} trigger={<Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs"
                type="button"
                size="sm"
                variant="ghost"
                disabled={creating || disabled}
                aria-label={`为 ${row.principal.id} 补签凭证`}
                title={disabled ? '主体已停用，先恢复再补签' : '为这个主体再签一张用户级凭证（换机器 / 凭证丢了 / 到期）'}
              >
                <KeyRound /> 补签凭证
              </Button>} />
              <ConfirmAction
                disabled={creating || Boolean(busyAction) || Boolean(uncertainKey)}
                scopeKey={row.principal.id}
                title={`${disabled ? '恢复' : '停用'}主体：${row.principal.name}`}
                description={`主体编号：${row.principal.id}。${disabled ? '恢复后名下未吊销、未过期的凭证重新可用。' : '停用后名下所有凭证立即不可用，主体、授权与审计记录保留。'}`}
                confirmLabel={disabled ? '恢复' : '停用'}
                onConfirm={() => void setPrincipalStatus(row.principal.id, disabled ? 'active' : 'disabled')}
                trigger={(
                  <Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" size="sm" variant="ghost">
                    <ShieldOff /> {disabled ? '恢复' : '停用'}
                  </Button>
                )}
              />
            </header>

            <div className="flex flex-col gap-2 px-4 py-3">
              {row.grants.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground">已记录项目授权：</span>
                  {row.grants.map((grant) => (
                    <span
                      key={grant.id}
                      className="rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-2 py-0.5"
                      title={grant.origin === 'created' ? '这个项目是它建的' : '经人在页面上批准过一次'}
                    >
                      {grant.projectName || grant.projectId}
                      <span className="ml-1 text-[0.625rem] text-muted-foreground">
                        {grant.origin === 'created' ? '创建' : '批准'}
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {disabled ? '主体已停用，名下凭证不可用于访问；授权记录保留。' : '暂无项目授权。'}
                </p>
              )}

              {row.activeCredentials.map((cred) => (
                <div
                  key={cred.id}
                  className="flex flex-wrap items-center gap-3 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs"
                >
                  {uncertainKey === cred.id ? <span className="text-warn">撤销结果未确认</span> : null}
                  <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-mono text-[0.6875rem]">{cred.id}</span>
                  <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 text-[0.625rem]">
                    {cred.kind === 'user' ? '用户级' : `项目级 · ${cred.projectName || cred.projectId}`}
                  </span>
                  {cred.label ? <span className="text-muted-foreground">{cred.label}</span> : null}
                  <span className="text-muted-foreground">签发于 {formatDate(cred.createdAt)}</span><span className="text-muted-foreground">{remaining(cred.expiresAt)}</span>
                  <span className="text-muted-foreground">最近使用 {formatDate(cred.lastUsedAt)}</span>
                  {cred.kind === 'user' ? (
                    <span
                      className="text-muted-foreground"
                      title="用户级凭证只授权不操作，所以滥用一定表现为「签出一堆项目级凭证」。看不见次数，留痕就等于没留。"
                    >
                      已签出 {cred.issuedCount || 0} 张下游
                    </span>
                  ) : null}
                  {cred.kind === 'user' ? (
                    <ConfirmAction
                      disabled={creating || Boolean(busyAction) || Boolean(uncertainKey)}
                      scopeKey={cred.id}
                      title={`撤销凭证：${cred.id}`}
                      description={`所属主体：${row.principal.name}（${row.principal.id}）。此用户级凭证及其签出的所有下游项目级凭证会立即失效，主体与授权记录保留。`}
                      confirmLabel="撤销并级联"
                      onConfirm={() => void revokeCredential(cred.id)}
                      trigger={<Button className="min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs" type="button" size="sm" variant="ghost">撤销</Button>}
                    />
                  ) : null}
                </div>
              ))}

              {row.retiredCredentials.length > 0 ? (
                <button
                  type="button"
                  className="flex min-h-[3.25rem] w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground lg:min-h-0 lg:text-xs"
                  onClick={() => setExpanded((prev) => ({ ...prev, [row.principal.id]: !open }))}
                >
                  {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  已吊销 / 已过期 {row.retiredCredentials.length} 张
                </button>
              ) : null}
              {open
                ? row.retiredCredentials.map((cred) => (
                    <div key={cred.id} className="flex flex-wrap items-center gap-3 px-3 py-1 text-xs text-muted-foreground">
                      <span className="font-mono text-[0.6875rem]">{cred.id}</span>
                      <span>{retiredReason(cred)}</span>
                    </div>
                  ))
                : null}
            </div>
          </section>
        );
      })}

      {unclaimed.length > 0 ? (
        <section className="cds-surface-raised cds-hairline rounded-md border border-[hsl(var(--warn))]/30 p-4">
          <h4 className="mb-1 text-xs font-semibold text-[hsl(var(--warn))]">未认领的存量凭证 {unclaimed.length} 张</h4>
          <p className="mb-2 text-xs leading-6 text-muted-foreground">
            这些是身份层之前签发的项目级凭证，还没有归属主体。它们照常可用，只是不享受
            「换机器自助补发」和「按主体聚合」。要让某台机器拿到这两样，让它用自己的用户级
            凭证跑一次自愈、拿一张有主的新凭证，再吊销这张旧的。也可在用户管理的“历史匿名凭据归属”核对确切账号后认领，保持原密钥和权限。存量凭证不会自己认领 ——
            光看它被使用，认不出背后是谁。
          </p>
          <div className="flex flex-wrap gap-2 text-xs">
            {unclaimed.slice(0, 30).map((cred) => (
              <span key={cred.id} className="rounded border border-[hsl(var(--hairline))] px-2 py-0.5 font-mono text-[0.6875rem]">
                {cred.projectName || cred.projectId} · {cred.id}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      <p className="text-xs text-muted-foreground">
        已归档 {archivedCount} 条超过 90 天的吊销记录：不再出现在这里，但仍留在状态里可供审计。
        凭证持有者可通过自检接口查看失效原因。
      </p>
    </div>
  );
}
