/**
 * CDS 系统设置 · Agent Key（2026-11-25，Agent Key 管理一期）。
 *
 * 一页两件事：找到已有 Key 并管理它（列表是主体），签发一把新 Key（右上角唯一主按钮）。
 * 项目卡片的「Agent Key」也进到这里，只是带上 ?project= 筛选，签发时默认选中该项目。
 *
 * 列表来自 GET /api/global-agent-keys/catalog：签发来源与当前状态由服务端判定（与鉴权
 * 同一判据），这里不再自己用 revokedAt 推「有效」。「这把 Key 能做什么」统一由
 * describeAgentKey 生成，签发预览、回执、列表详情三处同源。
 *
 * 签发结果未知、明文只显示一次、吊销结果未知这三类保护沿用原实现：结果不明时不允许
 * 重复提交，必须先重新读取核对。
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bot, ChevronDown, CircleHelp, Copy, KeyRound, Loader2, Plus, RefreshCw, ShieldAlert, Terminal, Trash2, UserRound } from 'lucide-react';

import { useSettingsSessionOwner, useSettingsSessionState } from '../useSettingsSessionState';
import { ConsoleAuthContext } from '@/lib/consoleAuthContext';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';
import { apiRequest, ApiError } from '@/lib/api';
import {
  PERMISSION_OPTIONS,
  accessShort,
  agentKeyRowId,
  describeAgentKey,
  expiryChoiceToIso,
  formatKeyDateTime,
  isAgentKeyCatalogEntry,
  sourceLabel,
  sourceSentence,
  sourceSteps,
  statusText,
  type AgentKeyAccessView,
  type AgentKeyCatalogEntry,
  type AgentKeyDescription,
  type AgentKeyPermission,
  type DescribeInput,
  type ExpiryChoice,
} from '@/lib/agentKeyCatalog';

interface ProjectOption { id: string; name: string }
interface SignDraft {
  label: string;
  scope: 'project' | 'all' | 'create';
  projectId: string;
  alsoCreate: boolean;
  permission: AgentKeyPermission;
  expiry: ExpiryChoice;
  date: string;
}
interface FreshKey {
  keyId: string;
  plaintext: string;
  label: string;
  rowId: string;
  describe: DescribeInput;
  scope: object | null;
  expired?: boolean;
}
type KeysState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; scope: object | null; filter: string; keys: AgentKeyCatalogEntry[]; readError: string };
type SourceFilter = 'all' | 'user' | 'agent' | 'unknown';
type StatusFilter = 'all' | 'active' | 'inactive';

const defaultDraft = (projectId = ''): SignDraft => ({
  label: '', scope: 'project', projectId, alsoCreate: false, permission: 'full', expiry: 'never', date: '',
});
const actionClass = 'min-h-[3.25rem] text-base lg:min-h-0 lg:text-sm';
const knownRejection = (err: unknown) => err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408;
const DAY = 86_400_000;

/** 签发草稿 → 与列表同形的范围描述，喂给同一个说明函数。 */
function draftAccess(draft: SignDraft, projects: ProjectOption[]): AgentKeyAccessView {
  const picked = projects.find((p) => p.id === draft.projectId);
  const projectKey = draft.scope === 'project' && !draft.alsoCreate;
  return {
    scope: draft.scope,
    projects: draft.scope === 'project' && draft.projectId ? [{ id: draft.projectId, name: picked?.name || draft.projectId }] : [],
    canCreateProjects: draft.scope === 'create' || draft.alsoCreate,
    // 全局 Key 暂不能限制操作类别；只有单项目 Key 能选受限权限。
    permission: projectKey ? draft.permission : 'full',
  };
}

function draftExpiryIso(draft: SignDraft): string | undefined | null {
  return expiryChoiceToIso(draft.expiry, draft.date);
}

function draftBlocker(draft: SignDraft): string {
  if (draft.scope === 'project' && !draft.projectId) return '请在第 1 步选择一个项目';
  if (draft.expiry === 'date' && draftExpiryIso(draft) === null) return '请选择晚于今天的失效日期';
  return '';
}

export function AccessKeysTab({ onToast }: { onToast: (message: string) => void }): JSX.Element {
  const { status: scope } = useContext(ConsoleAuthContext);
  const sessionOwner = useSettingsSessionOwner();
  const location = useLocation();
  const navigate = useNavigate();
  const projectFilter = new URLSearchParams(location.search).get('project') || '';

  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const currentScope = useRef(scope); currentScope.current = scope;
  const generation = useRef(0);
  const receipt = useRef<HTMLTextAreaElement>(null);

  const [state, setState] = useSettingsSessionState<KeysState>('keys:catalog-state', { status: 'loading' });
  const [projects, setProjects] = useState<ProjectOption[] | null>(null);
  const [projectsError, setProjectsError] = useState('');
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [expanded, setExpanded] = useState<string>('');
  const [askOpen, setAskOpen] = useState(false);
  const [copyHint, setCopyHint] = useState('');

  const [signOpen, setSignOpen] = useSettingsSessionState<boolean>('keys:sign-open', false);
  const [signing, setSigning] = useSettingsSessionState<boolean>('keys:signing', false, Boolean);
  const [draft, setDraft] = useSettingsSessionState<SignDraft>('keys:sign-draft', defaultDraft());
  const [signError, setSignError] = useSettingsSessionState<string>('keys:sign-error', '', undefined, { keepSession: true });
  const [signUnknown, setSignUnknown] = useSettingsSessionState<boolean>('keys:sign-unknown', false, Boolean);
  const [listSnapshotAvailable, setListSnapshotAvailable] = useSettingsSessionState<boolean>('keys:unknown-read', false);
  const [unknownAttempt, setUnknownAttempt] = useSettingsSessionState<{ label: string; summary: string; startedAt: string } | null>('keys:unknown-attempt', null, undefined, { keepSession: true });
  const [freshKey, setFreshKey] = useSettingsSessionState<FreshKey | null>('keys:fresh', null, Boolean, { expireTo: (value) => (value ? { ...value, plaintext: '', expired: true } : null) });
  const [highlight, setHighlight] = useState('');
  const [revoking, setRevoking] = useSettingsSessionState<string>('keys:revoking', '', Boolean);
  const [revokeUnknown, setRevokeUnknown] = useSettingsSessionState<string[]>('keys:revoke-unknown', [], (value) => value.length > 0);
  const [revokeError, setRevokeError] = useSettingsSessionState<string>('keys:revoke-error', '', undefined, { keepSession: true });
  const revokeUnknownRef = useRef(revokeUnknown); revokeUnknownRef.current = revokeUnknown;

  const visibleFresh = freshKey?.scope === sessionOwner ? freshKey : null;
  const ready = state.status === 'ok' && state.scope === scope && state.filter === projectFilter ? state : null;

  const loadKeys = useCallback(async (preserve = false) => {
    const run = ++generation.current;
    if (!preserve) setState({ status: 'loading' });
    try {
      const suffix = projectFilter ? `?project=${encodeURIComponent(projectFilter)}` : '';
      const data = await apiRequest<{ keys: unknown[] }>(`/api/global-agent-keys/catalog${suffix}`);
      if (run !== generation.current || currentScope.current !== scope) return;
      if (!Array.isArray(data.keys) || !data.keys.every(isAgentKeyCatalogEntry)) throw new Error('Key 列表格式无法识别，请刷新页面后重试');
      const keys = data.keys as AgentKeyCatalogEntry[];
      setState({ status: 'ok', scope, filter: projectFilter, keys, readError: '' });
      const unresolved = revokeUnknownRef.current.filter((id) => !keys.some((key) => agentKeyRowId(key) === id && Boolean(key.revokedAt)));
      if (revokeUnknownRef.current.length > 0 && unresolved.length === 0) setRevokeError('');
      setRevokeUnknown(unresolved);
      setListSnapshotAvailable(true);
    } catch (err) {
      if (run !== generation.current || currentScope.current !== scope) return;
      const message = err instanceof Error ? err.message : String(err);
      setState((current) => (preserve && current.status === 'ok' && current.scope === scope && current.filter === projectFilter
        ? { ...current, readError: message }
        : { status: 'error', message }));
    }
  }, [scope, projectFilter]);

  useEffect(() => {
    setListSnapshotAvailable(false); setQuery(''); setSourceFilter('all'); setStatusFilter('all'); setExpanded('');
    void loadKeys(true);
    return () => { generation.current++; };
  }, [loadKeys]);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ projects?: Array<{ id: string; name?: string; aliasName?: string; slug?: string }> }>('/api/projects')
      .then((data) => {
        if (cancelled) return;
        setProjects((data.projects || []).map((p) => ({ id: p.id, name: p.aliasName || p.name || p.slug || p.id })));
      })
      .catch((err) => { if (!cancelled) setProjectsError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [scope]);

  useEffect(() => {
    if (visibleFresh) { receipt.current?.scrollIntoView({ block: 'nearest' }); receipt.current?.focus({ preventScroll: true }); }
  }, [visibleFresh]);
  useEffect(() => {
    if (!visibleFresh && !signing && !signUnknown && revokeUnknown.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [visibleFresh, signing, signUnknown, revokeUnknown]);
  useEffect(() => { if (visibleFresh && alive.current) void loadKeys(true); }, [visibleFresh?.keyId, loadKeys]);

  const projectName = (id: string) => projects?.find((p) => p.id === id)?.name || id;

  function openSign(): void {
    setSignError('');
    // 从项目卡进来时默认选中该项目；草稿里已有选择就尊重用户的选择。
    setDraft((current) => (current.projectId || !projectFilter ? current : { ...current, scope: 'project', projectId: projectFilter }));
    setSignOpen(true);
  }

  async function signKey(): Promise<void> {
    if (signing || visibleFresh || signUnknown || !ready || ready.readError || draftBlocker(draft)) return;
    const requestScope = scope;
    const label = draft.label.trim();
    const access = draftAccess(draft, projects || []);
    const expiresAt = draftExpiryIso(draft) || undefined;
    const describe: DescribeInput = { access, expiry: expiresAt ? 'fixed' : 'never', ...(expiresAt ? { expiresAt } : {}) };
    const projectKey = draft.scope === 'project' && !draft.alsoCreate;
    const startedAt = new Date().toISOString();
    generation.current++; setSigning(true); setSignError('');
    try {
      let keyId: string; let plaintext: string;
      if (projectKey) {
        const permission = draft.permission;
        const res = await apiRequest<{ keyId: string; plaintext: string }>(`/api/projects/${encodeURIComponent(draft.projectId)}/agent-keys`, {
          method: 'POST',
          body: {
            label: label || undefined,
            ...(permission === 'planning-read' || permission === 'planning-propose' ? { planningAccess: permission.slice('planning-'.length) } : {}),
            ...(permission.startsWith('design-') ? { designAccess: permission.slice('design-'.length) } : {}),
            ...(expiresAt ? { expiresAt } : {}),
          },
        });
        keyId = res.keyId; plaintext = res.plaintext;
      } else {
        const res = await apiRequest<{ keyId: string; plaintext: string }>('/api/global-agent-keys', {
          method: 'POST',
          body: {
            label: label || undefined,
            access: {
              canCreateProjects: access.canCreateProjects,
              projects: draft.scope === 'all' ? 'all' : draft.scope === 'project' ? [draft.projectId] : [],
            },
            ...(expiresAt ? { expiresAt } : {}),
          },
        });
        keyId = res.keyId; plaintext = res.plaintext;
      }
      if (!keyId || !plaintext) throw new Error('签发响应不完整，无法确认明文');
      const rowId = projectKey ? agentKeyRowId({ kind: 'project', projectId: draft.projectId, id: keyId }) : agentKeyRowId({ kind: 'global', id: keyId });
      setFreshKey({ keyId, plaintext, label: label || keyId, rowId, describe, scope: sessionOwner });
      setHighlight(rowId);
      setSignOpen(false);
      if (currentScope.current === requestScope) setCopyHint('');
      setDraft(defaultDraft());
      if (!alive.current || currentScope.current !== requestScope) return;
      onToast(`已签发 ${label || keyId}，请保存本次明文`);
    } catch (err) {
      const unknown = !knownRejection(err);
      setSignUnknown(unknown); setListSnapshotAvailable(false);
      if (unknown) setUnknownAttempt({ label: label || '未填写名称', summary: describeAgentKey(describe).scope, startedAt });
      setSignError(`${unknown ? '签发结果未确认，可能已生成 Key。请先重新读取列表核对名称、编号和时间，勿重复签发；丢失的明文无法读回，确认无用后可吊销再签发' : '签发被拒绝，输入已保留'}：${err instanceof Error ? err.message : String(err)}`);
    } finally { setSigning(false); }
  }

  async function revokeKey(key: AgentKeyCatalogEntry): Promise<void> {
    const rowId = agentKeyRowId(key);
    if (revoking || signing || revokeUnknown.includes(rowId)) return;
    const requestScope = scope;
    generation.current++; setRevoking(rowId); setRevokeError('');
    try {
      const url = key.kind === 'project'
        ? `/api/projects/${encodeURIComponent(key.projectId || '')}/agent-keys/${encodeURIComponent(key.id)}`
        : `/api/global-agent-keys/${encodeURIComponent(key.id)}`;
      await apiRequest(url, { method: 'DELETE' });
      if (alive.current && currentScope.current === requestScope) generation.current++;
      if (!alive.current || currentScope.current !== requestScope) return;
      onToast(`已吊销 ${key.label || key.id}`);
      void loadKeys(true);
    } catch (err) {
      const unknown = !knownRejection(err);
      if (unknown) setRevokeUnknown((current) => [...current, rowId]);
      setRevokeError(`${key.label || key.id}：${unknown ? '吊销结果未确认，请重新读取核对，不要根据旧状态判断仍有效' : '吊销被拒绝'}。${err instanceof Error ? err.message : String(err)}`);
    } finally { setRevoking(''); }
  }

  async function copyFresh(): Promise<void> {
    if (!visibleFresh) return;
    const plaintext = visibleFresh.plaintext, requestScope = scope;
    try { await navigator.clipboard.writeText(plaintext); if (currentScope.current === requestScope) setCopyHint('已复制，请存入安全位置'); }
    catch { if (currentScope.current === requestScope) { setCopyHint('复制失败，请在完整明文框内全选复制'); receipt.current?.focus(); receipt.current?.select(); } }
  }

  const clearProjectFilter = () => navigate({ pathname: location.pathname, search: '', hash: location.hash }, { replace: true });

  const canPrepareNewIssuance = signUnknown && listSnapshotAvailable && Boolean(ready && !ready.readError);
  const allKeys = ready?.keys || [];
  const sourceCounts = useMemo(() => {
    const counts = { all: allKeys.length, user: 0, agent: 0, unknown: 0 };
    for (const key of allKeys) counts[key.source.type]++;
    return counts;
  }, [allKeys]);
  const needle = query.trim().toLocaleLowerCase();
  const keys = allKeys.filter((key) => {
    if (sourceFilter !== 'all' && key.source.type !== sourceFilter) return false;
    if (statusFilter === 'active' && !key.status.usable) return false;
    if (statusFilter === 'inactive' && key.status.usable) return false;
    if (!needle) return true;
    return [key.id, key.label, key.createdBy, accessShort(key.access), sourceSentence(key.source)]
      .some((value) => value?.toLocaleLowerCase().includes(needle));
  });
  const groups = groupByRecency(keys);
  const filterName = projectFilter ? projectName(projectFilter) : '';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold"><KeyRound />{filterName ? `${filterName} 的 Agent Key` : 'Agent Key'}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">供 Agent 和 cdscli / curl 自动化访问 CDS。点开一行查看这把 Key 能做什么、从哪来；明文只在签发时显示一次。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" className={actionClass} aria-expanded={askOpen} onClick={() => setAskOpen((value) => !value)}><Terminal />让 Agent 自己申请</Button>
          <Button type="button" className={actionClass} disabled={signing || Boolean(visibleFresh) || signUnknown} onClick={openSign}><Plus />{signUnknown ? '签发待核对' : '签发新 Key'}</Button>
        </div>
      </div>

      {askOpen ? (
        <section aria-label="让 Agent 自己申请" className="space-y-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-4 text-sm">
          <p className="font-medium">更推荐：让 Agent 在仓库里发起申请</p>
          <pre className="whitespace-pre-wrap break-all rounded-md border border-[hsl(var(--hairline))] bg-background p-3 font-mono text-xs">{`cdscli connect --host ${window.location.origin} --project ${projectFilter || '<项目 ID>'} --agent "<Agent 名称>"`}</pre>
          <p className="text-muted-foreground">Agent 发起后，在 CDS 右下角批准一次即可。Key 由 CLI 直接保存到项目本地，不经过对话和剪贴板；列表里会标为 AI Agent 签发，并记下是谁批准的。</p>
        </section>
      ) : null}

      {projectFilter ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>只显示能访问 {filterName} 的 Key，包括全部项目授权的 Key。签发时默认选中这个项目。</span>
          <Button type="button" variant="outline" size="sm" className={actionClass} onClick={clearProjectFilter}>显示全部 Key</Button>
        </div>
      ) : null}

      {visibleFresh ? (
        <section className="space-y-3 rounded-md border border-warn/60 bg-warn-soft p-4" aria-label="本次签发结果">
          <h3 className="font-semibold">已签发 {visibleFresh.label} · 请保存明文</h3>
          <p className="break-all text-sm text-muted-foreground">编号 {visibleFresh.keyId}</p>
          {visibleFresh.expired
            ? <p role="alert" className="text-sm text-warn">明文临时保留已到期，无法恢复。请核对上方编号；未安全保存的 Key 应先吊销，再明确签发替代凭据。</p>
            : <textarea ref={receipt} aria-label="完整 Key 明文" readOnly value={visibleFresh.plaintext} rows={3} className="w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-sm" onFocus={(event) => event.currentTarget.select()} />}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" className={actionClass} variant="outline" disabled={visibleFresh.expired} onClick={() => void copyFresh()}><Copy />复制完整明文</Button>
            <Button type="button" className={actionClass} variant="ghost" onClick={() => { setFreshKey(null); setCopyHint(''); }}>{visibleFresh.expired ? '我已核对并处理，关闭结果' : '我已安全保存，关闭明文'}</Button>
          </div>
          {copyHint ? <p role="status" className="text-sm">{copyHint}</p> : null}
          <KeySummary description={describeAgentKey(visibleFresh.describe, projects?.length)} compact />
          <p className="text-sm text-muted-foreground">{visibleFresh.expired ? '请先确认已安全保存，或吊销未领取的凭据，再关闭本次结果；不会自动重复签发。' : '这段说明与签发前看到的一致。明文不能再次读取，保存后才可继续签发；切换页签最多临时保留 30 分钟，刷新或关闭页面后无法恢复。'}</p>
        </section>
      ) : null}

      {signError ? (
        <div className="space-y-2">
          <p role="alert" className={`text-sm ${signUnknown ? 'text-warn' : 'text-destructive'}`}>{signUnknown ? '签发结果未确认，可能已生成 Key。明文无法再次读取，请先核对原请求与现有记录，勿重复提交。' : signError}</p>
          {signUnknown ? <details><summary className="min-h-[3.25rem] cursor-pointer py-3 text-sm text-muted-foreground lg:min-h-0 lg:py-1">查看签发错误详情</summary><p className="break-words text-sm text-muted-foreground">{signError}</p></details> : null}
        </div>
      ) : null}
      {unknownAttempt && signUnknown ? <p className="break-words text-sm text-muted-foreground">未确认请求快照：{unknownAttempt.label} · {formatKeyDateTime(unknownAttempt.startedAt)} · {unknownAttempt.summary}。</p> : null}
      {canPrepareNewIssuance ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">请核对下方记录的编号、名称和签发时间；无法使用的 Key 应先吊销，处理后再准备新的签发。</p>
          <Button type="button" className={actionClass} variant="outline" disabled={signing} onClick={() => { setSignUnknown(false); setUnknownAttempt(null); setSignOpen(true); setSignError('原请求结果仍未确认。你已选择在人工核对后准备新的签发；本页不会自动重复上一请求。'); }}>我已核对并处理，重新准备签发</Button>
        </div>
      ) : null}

      <section aria-label="已签发 Key" className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="min-w-0 flex-1 basis-56">
            <span className="sr-only">搜索 Key</span>
            <input aria-label="搜索 Key" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、项目、签发人、Agent 或编号" className="min-h-[3.25rem] w-full rounded-md border border-input bg-background px-3 text-sm lg:min-h-10" />
          </label>
          <div role="group" aria-label="签发来源" className="flex max-w-full flex-wrap gap-1 rounded-md border border-input p-1">
            {([['all', '全部'], ['user', '用户签发'], ['agent', 'AI Agent'], ['unknown', '来源未记录']] as Array<[SourceFilter, string]>).map(([value, text]) => (
              <button key={value} type="button" aria-pressed={sourceFilter === value} onClick={() => setSourceFilter(value)}
                className={`min-h-[2.75rem] rounded px-3 text-sm lg:min-h-8 ${sourceFilter === value ? 'bg-primary-soft font-semibold text-primary' : 'text-muted-foreground hover:text-foreground'}`}>
                {text} {sourceCounts[value]}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm">状态
            <select aria-label="Key 状态" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} className="min-h-[3.25rem] rounded-md border border-input bg-background px-3 lg:min-h-10">
              <option value="all">全部</option>
              <option value="active">有效</option>
              <option value="inactive">已失效</option>
            </select>
          </label>
          <Button type="button" variant="outline" size="sm" className={actionClass} disabled={signing || Boolean(revoking)} onClick={() => void loadKeys(true)}><RefreshCw />重新读取列表</Button>
        </div>

        {state.status === 'loading' || (state.status === 'ok' && !ready) ? <LoadingBlock label="读取 Key 列表" /> : null}
        {state.status === 'error' ? <ErrorBlock message={state.message} /> : null}
        {ready?.readError ? <p role="alert" className="text-sm text-destructive">读取失败：{ready.readError}。以下为上次读取，不代表当前状态。</p> : null}
        {revokeError ? <p role="alert" className="text-sm text-destructive">{revokeError}</p> : null}
        {ready && keys.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
            {allKeys.length ? '没有符合条件的 Key，请调整搜索或筛选。' : projectFilter ? `还没有能访问 ${filterName} 的 Key。点击「签发新 Key」，或让 Agent 自己申请。` : '还没有 Key。需要自动化访问时，点击「签发新 Key」，或让 Agent 自己申请。'}
          </p>
        ) : null}

        {groups.map((group) => (
          <div key={group.title} className="space-y-1">
            <h3 className="flex items-center gap-2 pt-2 text-xs font-semibold tracking-wide text-muted-foreground after:h-px after:flex-1 after:bg-[hsl(var(--hairline))]">{group.title} · {group.items.length}</h3>
            {group.items.map((key) => {
              const rowId = agentKeyRowId(key);
              return (
                <KeyRow
                  key={rowId}
                  entry={key}
                  rowId={rowId}
                  open={expanded === rowId}
                  fresh={highlight === rowId}
                  totalProjects={projects?.length}
                  revokeUnknown={revokeUnknown.includes(rowId)}
                  revoking={revoking === rowId}
                  revokeDisabled={Boolean(revoking) || signing || revokeUnknown.includes(rowId) || Boolean(ready?.readError)}
                  staleRead={Boolean(ready?.readError)}
                  onToggle={() => setExpanded((current) => (current === rowId ? '' : rowId))}
                  onRevoke={() => revokeKey(key)}
                />
              );
            })}
          </div>
        ))}
      </section>

      <Dialog open={signOpen && !signUnknown && !visibleFresh} onOpenChange={(open) => { if (!signing) setSignOpen(open); }}>
        <DialogContent frame className="max-w-[62.5rem]" style={{ width: '62.5rem' }} aria-describedby="agent-key-sign-desc">
          <div className="shrink-0 border-b border-[hsl(var(--hairline))] px-5 py-4 pr-12">
            <DialogTitle className="text-base font-semibold">签发新 Key</DialogTitle>
            <DialogDescription id="agent-key-sign-desc" className="mt-1 text-sm text-muted-foreground">依次回答三个问题；「拿到这把 Key 的 Agent」一栏会随选择实时说明它能做什么、不能做什么。</DialogDescription>
          </div>
          <SignForm
            draft={draft}
            setDraft={setDraft}
            projects={projects}
            projectsError={projectsError}
            disabled={signing}
          />
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t border-[hsl(var(--hairline))] px-5 py-3">
            <p className="min-w-0 flex-1 basis-48 text-sm text-muted-foreground">{draftBlocker(draft) || signError || '确认说明无误后签发。明文只显示一次。'}</p>
            <Button type="button" variant="outline" className={actionClass} disabled={signing} onClick={() => setSignOpen(false)}>取消</Button>
            <Button type="button" className={actionClass} disabled={signing || Boolean(draftBlocker(draft)) || !ready || Boolean(ready.readError)} onClick={() => void signKey()}>
              {signing ? <Loader2 className="animate-spin" /> : <KeyRound />}{signing ? '正在签发' : '签发'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function groupByRecency(keys: AgentKeyCatalogEntry[]): Array<{ title: string; items: AgentKeyCatalogEntry[] }> {
  const now = Date.now();
  const today = new Date(now).toDateString();
  const buckets: Array<{ title: string; items: AgentKeyCatalogEntry[] }> = [
    { title: '今天', items: [] }, { title: '最近 7 天', items: [] }, { title: '更早', items: [] },
  ];
  for (const key of keys) {
    const at = Date.parse(key.createdAt);
    if (!Number.isNaN(at) && new Date(at).toDateString() === today) buckets[0].items.push(key);
    else if (!Number.isNaN(at) && now - at < 7 * DAY) buckets[1].items.push(key);
    else buckets[2].items.push(key);
  }
  return buckets.filter((bucket) => bucket.items.length > 0);
}

function relativeTime(value?: string): string {
  if (!value) return '';
  const at = Date.parse(value);
  if (Number.isNaN(at)) return value;
  const diff = Date.now() - at;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < DAY) return `${Math.round(diff / 3_600_000)} 小时前`;
  if (diff < 30 * DAY) return `${Math.round(diff / DAY)} 天前`;
  return formatKeyDateTime(at).slice(0, 10);
}

function SourceChip({ entry }: { entry: AgentKeyCatalogEntry }): JSX.Element {
  const { type } = entry.source;
  const Icon = type === 'user' ? UserRound : type === 'agent' ? Bot : CircleHelp;
  const tone = type === 'user'
    ? 'border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-foreground'
    : type === 'agent' ? 'bg-info-soft text-info' : 'border border-dashed border-[hsl(var(--hairline-strong))] text-muted-foreground';
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}><Icon className="h-3.5 w-3.5" />{sourceLabel(entry.source)}</span>;
}

function StatusPill({ entry }: { entry: AgentKeyCatalogEntry }): JSX.Element {
  const tone = entry.status.code === 'active' ? 'bg-ok-soft text-ok'
    : entry.status.code === 'expiring' ? 'bg-warn-soft text-warn'
      : 'border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground';
  return <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>{statusText(entry)}</span>;
}

function RiskBadge({ risk }: { risk: AgentKeyDescription['risk'] }): JSX.Element {
  const tone = risk.level === 'high' ? 'bg-bad-soft text-bad' : risk.level === 'mid' ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok';
  return <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold ${tone}`}><ShieldAlert className="h-3.5 w-3.5" />{risk.label} · {risk.reason}</span>;
}

function KeySummary({ description, compact }: { description: AgentKeyDescription; compact?: boolean }): JSX.Element {
  const block = 'space-y-1';
  const heading = 'text-xs font-semibold tracking-wide text-muted-foreground';
  return (
    <div className={compact ? 'grid gap-3 sm:grid-cols-2' : 'space-y-4'}>
      <div className={block}><h4 className={heading}>能访问</h4><p className="text-sm">{description.scope}</p></div>
      <div className={block}><h4 className={heading}>何时失效</h4><p className="text-sm">{description.expiry}</p></div>
      <div className={block}><h4 className={heading}>能做什么</h4><ul className="list-disc space-y-0.5 pl-5 text-sm marker:text-ok">{description.can.map((line) => <li key={line}>{line}</li>)}</ul></div>
      <div className={block}><h4 className={heading}>不能做什么</h4><ul className="list-disc space-y-0.5 pl-5 text-sm marker:text-bad">{description.cannot.map((line) => <li key={line}>{line}</li>)}</ul></div>
    </div>
  );
}

function KeyRow({ entry, rowId, open, fresh, totalProjects, revokeUnknown, revoking, revokeDisabled, staleRead, onToggle, onRevoke }: {
  entry: AgentKeyCatalogEntry; rowId: string; open: boolean; fresh: boolean; totalProjects?: number;
  revokeUnknown: boolean; revoking: boolean; revokeDisabled: boolean; staleRead: boolean;
  onToggle: () => void; onRevoke: () => Promise<void>;
}): JSX.Element {
  const described = describeAgentKey({ access: entry.access, expiry: entry.expiry, expiresAt: entry.expiresAt }, totalProjects);
  // 已失效的 Key 不再讲「还剩几天」，直接说它现在的状态，避免把吊销的 Key 读成还在倒计时。
  const description = entry.status.usable ? described : { ...described, expiry: `${statusText(entry)}，不能再用于认证` };
  const detailsId = `agent-key-details-${rowId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const expiryShort = entry.expiry === 'never' ? '永久' : entry.expiresAt ? `到 ${formatKeyDateTime(entry.expiresAt).slice(5, 10)}` : '';
  return (
    <article data-agent-key-id={entry.id} className={`rounded-md border-b border-[hsl(var(--hairline))] ${fresh ? 'bg-primary-soft' : ''}`}>
      <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={onToggle}
        className="grid min-h-[3.25rem] w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 rounded-md px-2 py-3 text-left hover:bg-[hsl(var(--surface-sunken))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className={`break-all font-medium ${entry.status.usable ? '' : 'text-muted-foreground'}`}>{entry.label || entry.id}</span>
            {fresh ? <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">刚签发</span> : null}
            {revokeUnknown ? <span className="text-sm text-warn">吊销结果未确认</span> : <StatusPill entry={entry} />}
            {staleRead ? <span className="text-xs text-muted-foreground">（上次读取）</span> : null}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <SourceChip entry={entry} />
            <span>{sourceSentence(entry.source)}</span>
            <span aria-hidden="true">·</span>
            <span className="break-words">{accessShort(entry.access)}</span>
          </span>
        </span>
        <span className="flex flex-col items-end gap-0.5 whitespace-nowrap text-xs text-muted-foreground">
          <span>签发 {relativeTime(entry.createdAt)}</span>
          <span className="flex items-center gap-1">{expiryShort}<ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} /></span>
        </span>
      </button>
      {open ? (
        <div id={detailsId} className="space-y-4 px-2 pb-4 pt-1">
          {entry.status.usable ? <RiskBadge risk={description.risk} /> : null}
          <KeySummary description={description} compact />
          <div className="space-y-1">
            <h4 className="text-xs font-semibold tracking-wide text-muted-foreground">签发来源</h4>
            <ol className="list-decimal space-y-0.5 pl-5 text-sm">{sourceSteps(entry.source).map((line) => <li key={line}>{line}</li>)}</ol>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">签发时间</dt><dd>{formatKeyDateTime(entry.createdAt)}</dd>
            <dt className="text-muted-foreground">最近使用</dt><dd>{entry.lastUsedAt ? `${relativeTime(entry.lastUsedAt)}（${formatKeyDateTime(entry.lastUsedAt)}）` : '从未使用'}</dd>
            {entry.revokedAt ? <><dt className="text-muted-foreground">吊销时间</dt><dd>{formatKeyDateTime(entry.revokedAt)}</dd></> : null}
            <dt className="text-muted-foreground">编号</dt><dd className="break-all font-mono text-xs">{entry.id}{entry.kind === 'global' ? '（全局 Key）' : '（项目 Key）'}</dd>
          </dl>
          {!entry.revokedAt ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--hairline))] pt-3">
              <p className="min-w-0 flex-1 basis-56 text-sm text-muted-foreground">
                吊销后立即失效，正在使用它的自动化会认证失败，记录会保留。{entry.lastUsedAt ? `最近一次使用在 ${relativeTime(entry.lastUsedAt)}。` : ''}
              </p>
              <ConfirmAction
                scopeKey={rowId}
                title={`吊销 ${entry.label || entry.id}？`}
                description={`编号 ${entry.id}。吊销后无法恢复；如果还有自动化在用它，请先配置替代 Key。`}
                confirmLabel="确认吊销"
                onConfirm={onRevoke}
                disabled={revokeDisabled}
                trigger={<Button type="button" className={actionClass} variant="outline" size="sm"><Trash2 />{revoking ? '正在吊销' : '吊销'}</Button>}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function SignForm({ draft, setDraft, projects, projectsError, disabled }: {
  draft: SignDraft;
  setDraft: (update: (current: SignDraft) => SignDraft) => void;
  projects: ProjectOption[] | null;
  projectsError: string;
  disabled: boolean;
}): JSX.Element {
  const [projectQuery, setProjectQuery] = useState('');
  const patch = (next: Partial<SignDraft>) => setDraft((current) => ({ ...current, ...next }));
  const projectKey = draft.scope === 'project' && !draft.alsoCreate;
  const description = describeAgentKey(
    { access: draftAccess(draft, projects || []), expiry: draftExpiryIso(draft) ? 'fixed' : 'never', expiresAt: draftExpiryIso(draft) || undefined },
    projects?.length,
  );
  const needle = projectQuery.trim().toLocaleLowerCase();
  const visibleProjects = (projects || []).filter((p) => !needle || p.name.toLocaleLowerCase().includes(needle) || p.id.toLocaleLowerCase().includes(needle));
  const scopeOptions: Array<{ value: SignDraft['scope']; title: string; detail: string }> = [
    { value: 'project', title: '指定项目', detail: '只能访问你选的项目' },
    { value: 'all', title: '全部项目', detail: '包括以后新建的项目' },
    { value: 'create', title: '仅创建新项目', detail: '不能访问现有项目' },
  ];
  const expiryOptions: Array<[ExpiryChoice, string]> = [['never', '永久（默认）'], ['1', '1 天'], ['7', '7 天'], ['30', '30 天'], ['90', '90 天'], ['date', '指定日期']];
  const stepTitle = 'flex flex-wrap items-baseline gap-x-2 text-sm';
  const choice = (selected: boolean, danger = false) => `rounded-md border p-3 text-left ${selected ? (danger ? 'border-bad bg-bad-soft' : 'border-primary bg-primary-soft') : 'border-input hover:border-foreground/40'} disabled:opacity-60`;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:overflow-hidden">
      <div className="space-y-6 px-5 py-4 lg:overflow-y-auto">
        <label className="grid gap-2 text-sm font-medium">名称（可选）
          <input className="min-h-[3.25rem] w-full rounded-md border border-input bg-background px-3 font-normal lg:min-h-10" placeholder="写明用途，例如 Claude Code 部署调试" value={draft.label} maxLength={100} disabled={disabled} onChange={(event) => patch({ label: event.target.value })} />
        </label>

        <fieldset className="space-y-3" disabled={disabled}>
          <legend className={stepTitle}><span className="font-mono text-xs text-primary">1/3</span><span className="font-semibold">能访问哪些项目</span></legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {scopeOptions.map((option) => (
              <button key={option.value} type="button" aria-pressed={draft.scope === option.value} className={choice(draft.scope === option.value, option.value === 'all')}
                onClick={() => patch({ scope: option.value, ...(option.value === 'create' ? { alsoCreate: false } : {}) })}>
                <span className="block text-sm font-semibold">{option.title}</span>
                <span className="block text-xs text-muted-foreground">{option.detail}</span>
              </button>
            ))}
          </div>
          {draft.scope === 'project' ? (
            <div className="space-y-2">
              {projects && projects.length > 6 ? (
                <input aria-label="搜索项目" value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder="搜索项目" className="min-h-[3.25rem] w-full rounded-md border border-input bg-background px-3 text-sm lg:min-h-9" />
              ) : null}
              {projects === null && !projectsError ? <p className="text-sm text-muted-foreground">正在读取项目列表…</p> : null}
              {projectsError ? <p role="alert" className="text-sm text-destructive">项目列表读取失败：{projectsError}</p> : null}
              {projects && projects.length === 0 ? <p className="text-sm text-muted-foreground">还没有项目。可以选“仅创建新项目”，让 Agent 先建第一个项目。</p> : null}
              <div role="radiogroup" aria-label="选择项目" className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">
                {visibleProjects.map((p) => (
                  <button key={p.id} type="button" role="radio" aria-checked={draft.projectId === p.id} onClick={() => patch({ projectId: p.id })}
                    className={`min-h-[2.75rem] rounded-full border px-3 text-sm lg:min-h-8 ${draft.projectId === p.id ? 'border-primary bg-primary-soft font-semibold text-primary' : 'border-input'}`}>
                    {p.name}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">一把 Key 暂时只能指定一个项目；需要多个项目时，可以分别签发，或选“全部项目”。</p>
            </div>
          ) : null}
          {draft.scope !== 'create' ? (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]" checked={draft.alsoCreate} onChange={(event) => patch({ alsoCreate: event.target.checked })} />
              <span>同时允许创建新项目</span>
            </label>
          ) : null}
        </fieldset>

        <fieldset className="space-y-3" disabled={disabled}>
          <legend className={stepTitle}><span className="font-mono text-xs text-primary">2/3</span><span className="font-semibold">能执行哪些操作</span></legend>
          {projectKey ? (
            <div role="radiogroup" aria-label="权限" className="grid gap-2">
              {PERMISSION_OPTIONS.map((option, index) => (
                <div key={option.value}>
                  {index === 1 ? <p className="pb-1 pt-2 text-xs font-semibold text-muted-foreground">只开放一个模块（由系统所有者签发）</p> : null}
                  <button type="button" role="radio" aria-checked={draft.permission === option.value} className={`w-full ${choice(draft.permission === option.value)}`} onClick={() => patch({ permission: option.value })}>
                    <span className="block text-sm font-semibold">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">{option.detail}</span>
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-3 text-sm text-muted-foreground">
              {draft.scope === 'create'
                ? '只能创建新项目。每建一个项目，Agent 会拿到该项目的完整读写 Key。'
                : '跨项目或可建项目的 Key 目前只能是完整读写；需要只开放工程规划或设计稿时，请选“指定项目”并取消“同时允许创建新项目”。'}
            </p>
          )}
        </fieldset>

        <fieldset className="space-y-3" disabled={disabled}>
          <legend className={stepTitle}><span className="font-mono text-xs text-primary">3/3</span><span className="font-semibold">何时失效</span><span className="text-xs text-muted-foreground">临时调试建议设置期限</span></legend>
          <div role="radiogroup" aria-label="有效期" className="flex flex-wrap gap-2">
            {expiryOptions.map(([value, text]) => (
              <button key={value} type="button" role="radio" aria-checked={draft.expiry === value} onClick={() => patch({ expiry: value })}
                className={`min-h-[2.75rem] rounded-full border px-3 text-sm lg:min-h-8 ${draft.expiry === value ? 'border-primary bg-primary-soft font-semibold text-primary' : 'border-input'}`}>
                {text}
              </button>
            ))}
          </div>
          {draft.expiry === 'date' ? (
            <input type="date" aria-label="失效日期" value={draft.date} onChange={(event) => patch({ date: event.target.value })} className="min-h-[3.25rem] rounded-md border border-input bg-background px-3 text-sm lg:min-h-10" />
          ) : null}
        </fieldset>
      </div>

      <aside aria-label="这把 Key 能做什么" aria-live="polite" className="space-y-4 border-t border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-5 py-4 lg:overflow-y-auto lg:border-l lg:border-t-0">
        <p className="text-sm font-semibold">拿到这把 Key 的 Agent</p>
        <RiskBadge risk={description.risk} />
        {draft.scope === 'all' ? <p className="text-sm text-warn">全部项目授权包括以后新建的项目。只有一两个项目需要访问时，选“指定项目”更安全。</p> : null}
        <KeySummary description={description} />
      </aside>
    </div>
  );
}
