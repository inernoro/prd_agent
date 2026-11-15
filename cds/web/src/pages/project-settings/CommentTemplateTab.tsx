import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Eye, Loader2, Save } from 'lucide-react';
import { ConsoleAuthContext } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { useProjectSettingsRefresh, useSettingsReadRequest } from '@/components/project/ProjectSettingsRefresh';
import { apiRequest, ApiError } from '@/lib/api';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';

type Draft = { mode: 'default' | 'custom'; body: string };
type Template = { body: string; defaultBody: string; isDefault: boolean; updatedAt: string | null; variables: Array<{ key: string; label: string; example: string }> };
type Ready = { status: 'ok'; draft: Draft; saved: Draft; template: Template; preview?: { source: string; rendered: string }; previewError?: string; saveError?: string; saveUnconfirmed?: boolean; readError?: string; restoredDraft?: boolean };
// 以服务端认证状态对象作为会话身份；换身份不复用，旧会话可被回收。
// 草稿不进入 local/sessionStorage，最多保留 20 个项目、30 分钟。
const draftSessions = new WeakMap<object, Map<string, { state: Ready; expiresAt: number }>>();
function draftsFor(identity: object | null) {
  if (!identity) return undefined;
  let drafts = draftSessions.get(identity);
  if (!drafts) { drafts = new Map(); draftSessions.set(identity, drafts); }
  return drafts;
}
const same = (a: Draft, b: Draft) => a.mode === b.mode && (a.mode === 'default' || a.body === b.body);
const message = (err: unknown) => err instanceof ApiError || err instanceof Error ? err.message : String(err);
const sourceOf = (state: Ready) => state.draft.mode === 'default' ? state.template.defaultBody : state.draft.body;

export function CommentTemplateTab({ projectId, onToast }: { projectId: string; onToast: (message: string) => void }): JSX.Element {
  const auth = useContext(ConsoleAuthContext);
  const identity = auth.status?.user || (auth.status?.enabled === false ? auth.status : null);
  const projectDrafts = draftsFor(identity);
  const stateIdentity = useRef(identity);
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | Ready>({ status: 'loading' });
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const alive = useRef(true);
  const currentProject = useRef({ id: projectId, identity, generation: 0 });
  if (currentProject.current.id !== projectId || currentProject.current.identity !== identity) currentProject.current = { id: projectId, identity, generation: currentProject.current.generation + 1 };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const beginRead = useSettingsReadRequest();
  const load = useCallback(async (preserve = false) => {
    const signal = beginRead();
    const cachedEntry = projectDrafts?.get(projectId);
    const cached = cachedEntry && cachedEntry.expiresAt > Date.now() ? cachedEntry.state : undefined;
    if (!preserve) { setState(cached ? { ...cached, restoredDraft: true } : { status: 'loading' }); setSaving(false); setPreviewing(false); }
    try {
      const template = await apiRequest<Template>(`/api/comment-template?projectId=${encodeURIComponent(projectId)}`, { signal });
      if (signal.aborted) return;
      stateIdentity.current = identity;
      const saved: Draft = { mode: template.isDefault ? 'default' : 'custom', body: template.body || template.defaultBody || '' };
      setState(current => current.status === 'ok' && preserve ? { ...current, template, saved, saveError: undefined, saveUnconfirmed: false, readError: undefined, draft: same(current.draft, current.saved) ? saved : current.draft } : { status: 'ok', template, saved, draft: cached ? cached.draft : saved, preview: cached?.preview, restoredDraft: Boolean(cached) });
    } catch (err) {
      if (signal.aborted) return;
      setState(current => current.status === 'ok' ? { ...current, readError: message(err) } : { status: 'error', message: message(err) });
      if (preserve) throw err;
    }
  }, [projectId, beginRead, identity, projectDrafts]);
  useEffect(() => { void load(); }, [load]);
  useProjectSettingsRefresh(() => load(true));

  useEffect(() => {
    if (state.status !== 'ok' || stateIdentity.current !== identity) return;
    const dirty = !same(state.draft, state.saved);
    if (dirty || state.saveUnconfirmed) {
      projectDrafts?.set(projectId, { state, expiresAt: Date.now() + 30 * 60_000 });
      if (projectDrafts && projectDrafts.size > 20) projectDrafts.delete(projectDrafts.keys().next().value!);
    } else projectDrafts?.delete(projectId);
    const warnOnReload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    if (dirty || state.saveUnconfirmed) window.addEventListener('beforeunload', warnOnReload);
    return () => window.removeEventListener('beforeunload', warnOnReload);
  }, [state, projectId, identity, projectDrafts]);

  function updateDraft(change: Partial<Draft>): void {
    setState(current => current.status === 'ok' ? { ...current, draft: { ...current.draft, ...change }, saveError: current.saveUnconfirmed ? current.saveError : undefined } : current);
  }
  async function save(): Promise<void> {
    if (state.status !== 'ok' || saving) return;
    const submitted = { ...state.draft };
    const requestGeneration = currentProject.current.generation;
    setSaving(true);
    try {
      const result = await apiRequest<{ body: string; updatedAt: string }>(`/api/projects/${encodeURIComponent(projectId)}/comment-template`, { method: 'PUT', body: { body: submitted.mode === 'default' ? '' : submitted.body } });
      if (!alive.current || currentProject.current.generation !== requestGeneration) return;
      beginRead.cancel();
      setState(current => {
        if (current.status !== 'ok') return current;
        const saved: Draft = { mode: result.body ? 'custom' : 'default', body: result.body || current.template.defaultBody };
        return { ...current, saved, draft: same(current.draft, submitted) ? { ...saved, body: saved.mode === 'default' ? current.draft.body : saved.body } : current.draft, template: { ...current.template, updatedAt: result.updatedAt }, saveError: undefined };
      });
      onToast('当前项目的评论模板设置已保存');
    } catch (err) {
      if (!alive.current || currentProject.current.generation !== requestGeneration) return;
      setState(current => current.status === 'ok' ? { ...current, saveError: message(err), saveUnconfirmed: !(err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408) } : current);
    } finally { if (alive.current && currentProject.current.generation === requestGeneration) setSaving(false); }
  }
  async function preview(): Promise<void> {
    if (state.status !== 'ok') return;
    const source = sourceOf(state);
    const requestGeneration = currentProject.current.generation;
    setPreviewing(true);
    try {
      const result = await apiRequest<{ rendered: string }>('/api/comment-template/preview', { method: 'POST', body: { body: source } });
      if (!alive.current || currentProject.current.generation !== requestGeneration) return;
      setState(current => current.status === 'ok' ? { ...current, preview: { source, rendered: result.rendered || '(空)' }, previewError: undefined } : current);
    } catch (err) {
      if (!alive.current || currentProject.current.generation !== requestGeneration) return;
      setState(current => current.status === 'ok' ? { ...current, previewError: message(err) } : current);
    } finally { if (alive.current && currentProject.current.generation === requestGeneration) setPreviewing(false); }
  }
  function insertVariable(key: string): void {
    if (state.status !== 'ok' || state.draft.mode !== 'custom') return;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? state.draft.body.length;
    const end = textarea?.selectionEnd ?? start;
    const token = `{{${key}}}`;
    updateDraft({ body: state.draft.body.slice(0, start) + token + state.draft.body.slice(end) });
    requestAnimationFrame(() => { textarea?.focus(); textarea?.setSelectionRange(start + token.length, start + token.length); });
  }
  if (state.status === 'loading') return <LoadingBlock label="加载评论模板" />;
  if (state.status === 'error') return <div className="space-y-3"><ErrorBlock message={state.message} /><Button onClick={() => void load()}>重试</Button></div>;
  const dirty = !same(state.draft, state.saved);
  const stalePreview = Boolean(state.preview && state.preview.source !== sourceOf(state));
  return <section className="space-y-4" aria-labelledby="comment-template-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 id="comment-template-title" className="text-base font-semibold">PR 评论模板</h3><p className="mt-1 text-sm text-muted-foreground">保存仅修改当前项目；之后打开或重新打开 PR 时使用。示例预览不会发送 GitHub 评论。</p></div>
      <div className="flex flex-wrap items-center gap-3"><p role="status" className="text-sm text-muted-foreground">{dirty ? state.restoredDraft ? '已恢复未保存草稿' : '有未保存修改' : '与已保存设置一致'}{state.template.updatedAt ? ` · 最近保存 ${new Date(state.template.updatedAt).toLocaleString()}` : ''}</p><Button onClick={() => void save()} disabled={saving || state.saveUnconfirmed || !dirty || (state.draft.mode === 'custom' && !state.draft.body.trim())}>{saving ? <Loader2 className="animate-spin" /> : <Save />}保存模板</Button></div>
    </div>
    {state.readError ? <p role="alert" className="text-sm text-destructive">读取失败：{state.readError}。当前草稿已保留。<Button variant="outline" size="sm" onClick={() => void load(true).catch(() => undefined)}>重试读取</Button></p> : null}
    {state.saveError ? <div role="alert" className="text-sm text-destructive">{state.saveUnconfirmed ? '保存结果未确认' : '保存被拒绝'}：{state.saveError}。草稿已保留。{state.saveUnconfirmed ? <Button variant="outline" size="sm" onClick={() => void load(true).catch(() => onToast('读取失败，请稍后核对保存结果。'))}>重新读取并核对</Button> : '请修正后重试。'}</div> : null}
    <div className="grid min-w-0 gap-4 xl:grid-cols-2">
      <div className="block min-w-0 space-y-2"><fieldset className="flex flex-wrap gap-x-6 gap-y-2"><legend className="sr-only">模板模式（保存后生效）</legend>
      {(['default', 'custom'] as const).map(mode => <label key={mode} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm"><input type="radio" name="comment-template-mode" checked={state.draft.mode === mode} onChange={() => updateDraft({ mode })} className="h-4 w-4 accent-primary" />{mode === 'default' ? '使用默认模板' : '自定义模板'}</label>)}
    </fieldset><textarea ref={textareaRef} aria-label="模板正文" className="min-h-80 w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={sourceOf(state)} readOnly={state.draft.mode === 'default'} onChange={event => updateDraft({ body: event.target.value })} spellCheck={false} /></div>
      <section className="min-w-0 space-y-2" aria-labelledby="comment-preview-title"><div className="flex min-h-5 flex-wrap items-center justify-between gap-2"><h4 id="comment-preview-title" className="text-sm font-medium">示例预览</h4><Button variant="outline" size="sm" onClick={() => void preview()} disabled={previewing}>{previewing ? <Loader2 className="animate-spin" /> : <Eye />}{state.preview ? '更新预览' : '生成预览'}</Button></div>
        {stalePreview ? <p role="status" className="text-sm text-warn">草稿已变化，下方仍是上次预览。</p> : null}
        {state.previewError ? <p role="alert" className="text-sm text-destructive">预览失败：{state.previewError}。草稿已保留。</p> : null}
        <div className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 font-mono text-sm leading-6">{state.preview?.rendered || '生成预览，检查示例 PR 和分支数据渲染后的正文。'}</div>
      </section>
    </div>
    <details className="border-t border-border pt-3"><summary className="cursor-pointer text-sm font-medium">插入模板变量</summary><p className="my-2 text-sm text-muted-foreground">自定义模式下点击变量插入光标处；未知变量会原样保留。</p><div className="grid gap-2 md:grid-cols-2">{state.template.variables.map(variable => <button key={variable.key} type="button" disabled={state.draft.mode !== 'custom'} onClick={() => insertVariable(variable.key)} className="min-w-0 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><code>{`{{${variable.key}}}`}</code><span className="ml-2 text-muted-foreground">{variable.label}</span><span className="mt-1 block break-all text-xs text-muted-foreground">{variable.example}</span></button>)}</div></details>
  </section>;
}
