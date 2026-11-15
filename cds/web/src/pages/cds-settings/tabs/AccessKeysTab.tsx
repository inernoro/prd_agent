import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Copy, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';

import { useSettingsSessionOwner, useSettingsSessionState } from '../useSettingsSessionState';
import { ConsoleAuthContext } from '@/lib/consoleAuthContext';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';
import { apiRequest, ApiError } from '@/lib/api';
import { AgentKeyScopePanel, type AgentKeyScope } from '@/components/AgentKeyScopePanel';

interface AgentKeySummary {
  id: string; label: string; scope: string; access?: AgentKeyScope;
  createdAt: string; createdBy?: string; lastUsedAt?: string; revokedAt?: string;
}
interface FreshKey { keyId: string; plaintext: string; preview: string; access?: AgentKeyScope; label: string; scope: object | null; expired?: boolean }
type KeysState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; scope: object | null; keys: AgentKeySummary[]; readError: string };
const defaultScope = (): AgentKeyScope => ({ canCreateProjects: true, projects: [] });
const actionClass = 'min-h-[3.25rem] text-base lg:min-h-0 lg:text-xs';
function scopeDescription(access?: AgentKeyScope): string {
  if (!access || typeof access.canCreateProjects !== 'boolean' || !(access.projects === 'all' || Array.isArray(access.projects))) return '权限范围未确认，请重新读取；勿按前缀判断权限';
  const projects = access.projects === 'all' ? '全部项目读写、配置与部署' : access.projects.length ? `指定项目：${access.projects.join('、')}` : '不授予已有项目访问';
  return `${access.canCreateProjects ? '可创建项目' : '不可创建项目'} · ${projects}`;
}
const knownRejection = (err: unknown) => err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408;

export function AccessKeysTab({ onToast }: { onToast: (message: string) => void }): JSX.Element {
  const { status: scope } = useContext(ConsoleAuthContext);
  const sessionOwner = useSettingsSessionOwner();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const currentScope = useRef(scope); currentScope.current = scope;
  const generation = useRef(0), receipt = useRef<HTMLTextAreaElement>(null);
  const [state, setState] = useSettingsSessionState<KeysState>('keys:read-state', { status: 'loading' });
  const [query, setQuery] = useState('');
  const [keyFilter, setKeyFilter] = useState<'active' | 'revoked' | 'all'>('active');
  const [signOpen, setSignOpen] = useSettingsSessionState<boolean>('keys:sign-open', false), [signing, setSigning] = useSettingsSessionState<boolean>('keys:signing', false, Boolean);
  const [signLabel, setSignLabel] = useSettingsSessionState<string>('keys:sign-label', ''), [signScope, setSignScope] = useSettingsSessionState<AgentKeyScope>('keys:sign-scope', defaultScope());
  const [signError, setSignError] = useSettingsSessionState<string>('keys:sign-error', '', undefined, { keepSession: true }), [signUnknown, setSignUnknown] = useSettingsSessionState<boolean>('keys:sign-unknown', false, Boolean);
  const [unknownRead, setUnknownRead] = useSettingsSessionState<boolean>('keys:unknown-read', false);
  const [unknownAttempt, setUnknownAttempt] = useSettingsSessionState<{ label: string; access: AgentKeyScope; startedAt: string } | null>('keys:unknown-attempt', null, undefined, { keepSession: true });
  const [freshKey, setFreshKey] = useSettingsSessionState<FreshKey | null>('keys:fresh', null, Boolean, { expireTo: value => value ? { ...value, plaintext: '', expired: true } : null }), [copyHint, setCopyHint] = useState('');
  const [revoking, setRevoking] = useSettingsSessionState<string>('keys:revoking', '', Boolean), [revokeUnknown, setRevokeUnknown] = useSettingsSessionState<string[]>('keys:revoke-unknown', [], value => value.length > 0), [revokeError, setRevokeError] = useSettingsSessionState<string>('keys:revoke-error', '', undefined, { keepSession: true });
  const revokeUnknownRef = useRef(revokeUnknown); revokeUnknownRef.current = revokeUnknown;
  const visibleFresh = freshKey?.scope === sessionOwner ? freshKey : null;
  const ready = state.status === 'ok' && state.scope === scope ? state : null;

  const loadKeys = useCallback(async (preserve = false) => {
    const run = ++generation.current;
    if (!preserve) setState({ status: 'loading' });
    try {
      const data = await apiRequest<{ keys: AgentKeySummary[] }>('/api/global-agent-keys');
      if (run !== generation.current || currentScope.current !== scope) return;
      if (!Array.isArray(data.keys)) throw new Error('未读取到 Key 列表');
      setState({ status: 'ok', scope, keys: data.keys, readError: '' });
      const unresolved = revokeUnknownRef.current.filter(id => !data.keys.some(key => key.id === id && Boolean(key.revokedAt)));
      if (revokeUnknownRef.current.length > 0 && unresolved.length === 0) setRevokeError('');
      setRevokeUnknown(unresolved);
      setUnknownRead(true);
    } catch (err) {
      if (run !== generation.current || currentScope.current !== scope) return;
      const message = err instanceof Error ? err.message : String(err);
      setState(current => preserve && current.status === 'ok' && current.scope === scope ? { ...current, readError: message } : { status: 'error', message });
    }
  }, [scope]);
  useEffect(() => {
    setUnknownRead(false); setQuery(''); setKeyFilter('active');
    void loadKeys(true); return () => { generation.current++; };
  }, [loadKeys]);
  useEffect(() => { if (visibleFresh) { receipt.current?.scrollIntoView({ block: 'nearest' }); receipt.current?.focus({ preventScroll: true }); } }, [visibleFresh]);
  useEffect(() => {
    if (!visibleFresh && !signing && !signUnknown && revokeUnknown.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [visibleFresh, signing, signUnknown, revokeUnknown]);

  useEffect(() => { if (visibleFresh && alive.current) void loadKeys(true); }, [visibleFresh?.keyId, loadKeys]);

  const emptyScope = !signScope.canCreateProjects && signScope.projects !== 'all' && signScope.projects.length === 0;
  async function signKey(): Promise<void> {
    if (signing || visibleFresh || signUnknown || !ready || ready.readError || emptyScope) return;
    const requestScope = scope, label = signLabel.trim(), access = { ...signScope, projects: signScope.projects === 'all' ? 'all' as const : [...signScope.projects] };
    const startedAt = new Date().toISOString();
    generation.current++; setSigning(true); setSignError('');
    try {
      const res = await apiRequest<{ keyId: string; plaintext: string; preview: string; access?: AgentKeyScope }>('/api/global-agent-keys', { method: 'POST', body: { label: label || undefined, access } });
      if (!res.keyId || !res.plaintext || !res.preview) throw new Error('签发响应不完整，无法确认明文');
      setFreshKey({ ...res, label: label || res.keyId, scope: sessionOwner }); setSignOpen(false);
      if (currentScope.current === requestScope) setCopyHint('');
      setSignLabel(''); setSignScope(defaultScope());
      if (!alive.current || currentScope.current !== requestScope) return;
      onToast(`已签发 ${label || res.keyId}，请保存本次明文`);
    } catch (err) {
      const unknown = !knownRejection(err); setSignUnknown(unknown); setUnknownRead(false);
      if (unknown) setUnknownAttempt({ label: label || '未填写标签', access, startedAt });
      setSignError(`${unknown ? '签发结果未确认，可能已生成 Key。请先重新读取列表核对标签、编号和时间，勿重复签发；丢失的明文无法读回，确认无用后可吊销再签发' : '签发被拒绝，输入已保留'}：${err instanceof Error ? err.message : String(err)}`);
    } finally { setSigning(false); }
  }
  async function revokeKey(key: AgentKeySummary): Promise<void> {
    if (revoking || signing || revokeUnknown.includes(key.id)) return;
    const requestScope = scope; generation.current++; setRevoking(key.id); setRevokeError('');
    try {
      await apiRequest(`/api/global-agent-keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' });
      if (alive.current && currentScope.current === requestScope) generation.current++;
      setState(current => current.status === 'ok' && current.scope === requestScope ? { ...current, keys: current.keys.map(item => item.id === key.id ? { ...item, revokedAt: new Date().toISOString() } : item) } : current);
      if (!alive.current || currentScope.current !== requestScope) return;
      onToast(`已吊销 ${key.label || key.id}`); void loadKeys(true);
    } catch (err) {
      const unknown = !knownRejection(err); if (unknown) setRevokeUnknown(current => [...current, key.id]);
      setRevokeError(`${key.label || key.id}：${unknown ? '吊销结果未确认，请重新读取核对，不要根据旧状态判断仍有效' : '吊销被拒绝'}。${err instanceof Error ? err.message : String(err)}`);
    } finally { setRevoking(''); }
  }
  async function copyFresh(): Promise<void> {
    if (!visibleFresh) return;
    const plaintext = visibleFresh.plaintext, requestScope = scope;
    try { await navigator.clipboard.writeText(plaintext); if (currentScope.current === requestScope) setCopyHint('已复制，请存入安全位置'); }
    catch { if (currentScope.current === requestScope) { setCopyHint('复制失败，请在完整明文框内全选复制'); receipt.current?.focus(); receipt.current?.select(); } }
  }
  const needle = query.trim().toLocaleLowerCase();
  const keys = ready ? ready.keys.filter(key => (keyFilter === 'all' || (keyFilter === 'active' ? !key.revokedAt : Boolean(key.revokedAt))) && (!needle || [key.id, key.label, key.createdBy, scopeDescription(key.access)].some(value => value?.toLocaleLowerCase().includes(needle)))) : [];
  return <div className="space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-base font-semibold"><KeyRound />AI Access Key</h2><p className="mt-1 max-w-3xl text-sm text-muted-foreground">供 cdscli / curl 自动化使用。权限由每个 Key 的授权范围决定，可并存轮换；本页不修改环境中的 bootstrap Key。</p></div><Button type="button" disabled={signing || Boolean(visibleFresh) || signUnknown} onClick={() => setSignOpen(value => !value)}><Plus />{signOpen ? '收起签发' : '签发新 Key'}</Button></div>
    <p className="text-sm text-warn">Key 是访问凭据，不应进入截图、公开内容或 Git。新签发的明文只显示一次，离开前请安全保存。</p>
    {visibleFresh ? <section className="space-y-3 rounded-md border border-warn/60 bg-warn-soft p-4" aria-label="本次签发结果"><h3 className="font-semibold">已签发 {visibleFresh.label} · 请保存明文</h3><p className="break-all text-sm text-muted-foreground">编号 {visibleFresh.keyId} · {scopeDescription(visibleFresh.access)}</p>{visibleFresh.expired ? <p role="alert" className="text-sm text-warn">明文临时保留已到期，无法恢复。请核对上方编号；未安全保存的 Key 应先吊销，再明确签发替代凭据。</p> : <textarea ref={receipt} aria-label="完整 Key 明文" readOnly value={visibleFresh.plaintext} rows={3} className="w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-sm" onFocus={event => event.currentTarget.select()} />}<div className="flex flex-wrap items-center gap-3"><Button type="button" className={actionClass} variant="outline" disabled={visibleFresh.expired} onClick={() => void copyFresh()}><Copy />复制完整明文</Button><Button type="button" className={actionClass} variant="ghost" onClick={() => { setFreshKey(null); setCopyHint(''); }}>{visibleFresh.expired ? '我已核对并处理，关闭结果' : '我已安全保存，关闭明文'}</Button></div>{copyHint ? <p role="status" className="text-sm">{copyHint}</p> : null}<p className="text-sm text-muted-foreground">{visibleFresh.expired ? '请先确认已安全保存，或吊销未领取的凭据，再关闭本次结果；不会自动重复签发。' : '明文不能再次读取。完成保存后才可继续签发。切换标签仅在本次登录会话内最多临时保留 30 分钟；刷新或关闭页面后无法恢复明文。'}</p></section> : null}
    {signError ? <p role="alert" className="text-sm text-destructive">{signError}</p> : null}
    {unknownAttempt ? <p className="break-words text-sm text-muted-foreground">未确认请求快照：{unknownAttempt.label} · {formatDate(unknownAttempt.startedAt)} · {scopeDescription(unknownAttempt.access)}。原请求结果仍未确认，读取列表不能证明它未执行。</p> : null}
    {signUnknown && unknownRead && !ready?.readError ? <div className="space-y-2"><p className="text-sm text-muted-foreground">列表读取成功也不能证明上一请求没有执行。请核对新增 Key 的编号、标签、签发时间；不需要或无法使用的 Key 应先吊销。</p><Button type="button" variant="outline" disabled={signing} onClick={() => { setSignUnknown(false); setSignOpen(true); setSignError('上一请求的签发结果仍未确认。你已选择在人工核对后准备新的签发；本页不会自动重复上一请求。'); }}>我已核对并处理，重新准备签发</Button></div> : null}
    {signOpen ? <section className="space-y-3 rounded-md border border-[hsl(var(--hairline))] p-4" aria-label="签发新 Key"><h3 className="font-semibold">签发范围</h3><label className="grid gap-2 text-sm">标签<input className="min-h-[3.25rem] w-full rounded-md border border-input bg-background px-3" placeholder="例如生产部署机器人" value={signLabel} onChange={event => setSignLabel(event.target.value)} maxLength={100} disabled={signing || signUnknown || Boolean(visibleFresh)} /></label><AgentKeyScopePanel value={signScope} onChange={setSignScope} disabled={signing || signUnknown || Boolean(visibleFresh)} /><p className="break-words text-sm text-muted-foreground">将授予：{scopeDescription(signScope)}</p>{signScope.projects === 'all' ? <p role="alert" className="text-sm text-destructive">此 Key 可读写、配置并部署全部项目。仅授予可信自动化，泄露会影响全部项目。</p> : null}<Button type="button" onClick={() => void signKey()} disabled={signing || signUnknown || Boolean(visibleFresh) || emptyScope || !ready || Boolean(ready.readError)}>{signing ? <Loader2 className="animate-spin" /> : <Plus />}{signing ? '正在签发' : '按所选范围签发'}</Button></section> : null}
    <section aria-label="已签发 Key" className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">已签发 Key{ready ? `（${ready.keys.filter(key => !key.revokedAt).length} 个未吊销、${ready.keys.filter(key => key.revokedAt).length} 个已吊销）` : ''}</h3><Button type="button" variant="outline" size="sm" className={actionClass} disabled={signing || Boolean(revoking)} onClick={() => void loadKeys(true)}><RefreshCw />重新读取列表</Button></div>
      {ready && ready.keys.length > 0 ? <div className="flex flex-wrap gap-3"><label className="min-w-0 flex-1"><span className="sr-only">搜索 Key</span><input aria-label="搜索 Key" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标签、Key 编号、项目编号或签发者" className="min-h-[3.25rem] w-full rounded-md border border-input bg-background px-3 text-sm" /></label><label className="flex items-center gap-2 text-sm">状态<select aria-label="Key 状态" value={keyFilter} onChange={event => setKeyFilter(event.target.value as 'active' | 'revoked' | 'all')} className="min-h-[3.25rem] rounded-md border border-input bg-background px-3"><option value="active">未吊销</option><option value="revoked">已吊销</option><option value="all">全部</option></select></label></div> : null}
      {state.status === 'loading' || state.status === 'ok' && !ready ? <LoadingBlock label="读取 Key 列表" /> : null}{state.status === 'error' ? <ErrorBlock message={state.message} /> : null}{ready?.readError ? <p role="alert" className="text-sm text-destructive">读取失败：{ready.readError}。以下为上次读取，不代表当前有效状态。</p> : null}{revokeError ? <p role="alert" className="text-sm text-destructive">{revokeError}</p> : null}
      {ready && keys.length === 0 ? <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">{ready.keys.length ? '没有匹配的 Key，请调整搜索或状态。' : '尚无 Key。需要自动化访问时，点击「签发新 Key」选择范围。'}</p> : null}
      {keys.map(key => <article data-agent-key-id={key.id} key={key.id} className="space-y-2 border-b border-[hsl(var(--hairline))] py-3"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="break-all font-medium">{key.label || key.id}</span><span className={`text-sm ${revokeUnknown.includes(key.id) ? 'text-warn' : 'text-muted-foreground'}`}>{revokeUnknown.includes(key.id) ? '吊销结果未确认' : key.revokedAt ? '已吊销' : ready?.readError ? '上次读取：未吊销' : '未吊销'}</span></div><p className="mt-1 break-all text-sm text-muted-foreground">编号 {key.id}</p></div>{!key.revokedAt ? <ConfirmAction scopeKey={key.id} title={`吊销 ${key.label || key.id}？`} description={`编号 ${key.id}。吊销后，使用此 Key 的自动化将无法继续认证。轮换时请先配置替代 Key。`} confirmLabel="确认吊销" onConfirm={() => revokeKey(key)} disabled={Boolean(revoking) || signing || revokeUnknown.includes(key.id) || Boolean(ready?.readError)} trigger={<Button type="button" className={actionClass} variant="outline" size="sm"><Trash2 />{revoking === key.id ? '正在吊销' : '吊销'}</Button>} /> : null}</div><p className="break-words text-sm">{scopeDescription(key.access)}</p>{key.access?.projects === 'all' && !key.revokedAt ? <p className="text-sm text-warn">全部项目授权，请仅交给可信自动化使用。</p> : null}<p className="break-words text-sm text-muted-foreground">签发 {formatDate(key.createdAt)}{key.createdBy ? ` · 签发者 ${key.createdBy}` : ''}{key.lastUsedAt ? ` · 最近使用 ${formatDate(key.lastUsedAt)}` : ''}{key.revokedAt ? ` · 吊销 ${formatDate(key.revokedAt)}` : ''}</p></article>)}
    </section>
  </div>;
}
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
