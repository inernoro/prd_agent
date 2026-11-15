import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, Loader2, Save } from 'lucide-react';
import { countProtectedSettingsEntries, useSettingsSessionOwner, useSettingsSessionState } from '@/pages/cds-settings/useSettingsSessionState';
import { Button } from '@/components/ui/button';
import { useProjectSettingsRefresh, useSettingsReadRequest } from '@/components/project/ProjectSettingsRefresh';
import { apiRequest, ApiError } from '@/lib/api';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';

type Draft = { mode: 'default' | 'custom'; body: string };
type Template = { body: string; defaultBody: string; isDefault: boolean; updatedAt: string | null; variables: Array<{ key: string; label: string; example: string }> };
type Ready = { status: 'ok'; scopeIdentity: object | null; draft: Draft; saved: Draft; template: Template; preview?: { source: string; rendered: string }; previewError?: string; saveError?: string; saveUnconfirmed?: boolean; savePending?: boolean; saveAdjusted?: boolean; unconfirmedSubmitted?: Draft; readError?: string; restoredDraft?: boolean };
const MAX_TEMPLATE_LENGTH = 16 * 1024;
const same = (a: Draft, b: Draft) => a.mode === b.mode && (a.mode === 'default' || a.body === b.body);
const message = (err: unknown) => err instanceof ApiError || err instanceof Error ? err.message : String(err);
const sourceOf = (state: Ready) => state.draft.mode === 'default' ? state.template.defaultBody : state.draft.body;

export function CommentTemplateTab({ projectId, onToast }: { projectId: string; onToast: (message: string) => void }): JSX.Element {
  const identity = useSettingsSessionOwner();
  const [state, setState] = useSettingsSessionState<{ status: 'loading' } | { status: 'error'; message: string } | Ready>(`template:${projectId}`, { status: 'loading' }, value => value.status === 'ok' && Boolean(value.saveUnconfirmed || value.savePending));
  const saving = state.status === 'ok' && Boolean(state.savePending);
  const [capacityError, setCapacityError] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const alive = useRef(true);
  const currentProject = useRef({ id: projectId, identity, generation: 0 });
  if (currentProject.current.id !== projectId || currentProject.current.identity !== identity) currentProject.current = { id: projectId, identity, generation: currentProject.current.generation + 1 };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const beginRead = useSettingsReadRequest();
  const load = useCallback(async (preserve = false) => {
    const signal = beginRead();
    if (!preserve) { setCapacityError(''); setPreviewing(false); }
    try {
      const template = await apiRequest<Template>(`/api/comment-template?projectId=${encodeURIComponent(projectId)}`, { signal });
      if (signal.aborted) return;
      const saved: Draft = { mode: template.isDefault ? 'default' : 'custom', body: template.body || template.defaultBody || '' };
      setState(current => {
        const previous = current.status === 'ok' && current.scopeIdentity === identity ? current : undefined;
        const unconfirmed = Boolean(previous?.saveUnconfirmed && (!previous.unconfirmedSubmitted || !same(previous.unconfirmedSubmitted, saved)));
        const keepDraft = previous && (previous.savePending || previous.saveUnconfirmed || !same(previous.draft, previous.saved));
        const draft = keepDraft ? previous.draft : saved.mode === 'default' && previous ? { ...saved, body: previous.draft.body } : saved;
        return { ...previous, status: 'ok', scopeIdentity: identity, template, saved, draft, readError: undefined, saveError: unconfirmed ? previous?.saveError : undefined, saveUnconfirmed: unconfirmed, unconfirmedSubmitted: unconfirmed || previous?.savePending ? previous?.unconfirmedSubmitted : undefined, restoredDraft: preserve ? previous?.restoredDraft : Boolean(previous && (keepDraft || unconfirmed)) };
      });
    } catch (err) {
      if (signal.aborted) return;
      setState(current => current.status === 'ok' ? { ...current, readError: message(err) } : { status: 'error', message: message(err) });
      if (preserve) throw err;
    }
  }, [projectId, beginRead, identity, setState]);
  useEffect(() => { void load(); }, [load]);
  useProjectSettingsRefresh(() => load(true));

  useEffect(() => {
    if (state.status !== 'ok' || state.scopeIdentity !== identity) return;
    const dirty = !same(state.draft, state.saved);
    const warnOnReload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    if (dirty || state.saveUnconfirmed || state.savePending) window.addEventListener('beforeunload', warnOnReload);
    return () => window.removeEventListener('beforeunload', warnOnReload);
  }, [state, projectId, identity]);

  function updateDraft(change: Partial<Draft>): void {
    setState(current => current.status === 'ok' ? { ...current, draft: { ...current.draft, ...change }, saveError: current.saveUnconfirmed ? current.saveError : undefined } : current);
  }
  async function save(): Promise<void> {
    if (state.status !== 'ok' || saving || state.saveUnconfirmed || state.draft.mode === 'custom' && state.draft.body.length > MAX_TEMPLATE_LENGTH) return;
    if (countProtectedSettingsEntries(identity, 'template:') >= 20) { setCapacityError('当前会话有 20 个项目的保存尚待核对，请先回到相应项目读取核对后再提交新的保存。'); return; }
    setCapacityError('');
    const submitted = { ...state.draft };
    const requestGeneration = currentProject.current.generation;
    setState(current => current.status === 'ok' ? { ...current, savePending: true, unconfirmedSubmitted: submitted } : current);
    try {
      const result = await apiRequest<{ body: string; updatedAt: string }>(`/api/projects/${encodeURIComponent(projectId)}/comment-template`, { method: 'PUT', body: { body: submitted.mode === 'default' ? '' : submitted.body } });
      if (typeof result.body !== 'string' || typeof result.updatedAt !== 'string') throw new Error('服务未返回可核对的已保存正文');
      const adjusted = submitted.mode === 'custom' && result.body !== submitted.body || submitted.mode === 'default' && result.body !== '';
      if (alive.current && currentProject.current.generation === requestGeneration) beginRead.cancel();
      setState(current => {
        if (current.status !== 'ok' || current.scopeIdentity !== identity) return current;
        const saved: Draft = { mode: result.body ? 'custom' : 'default', body: result.body || current.template.defaultBody };
        return { ...current, saved, draft: !adjusted && same(current.draft, submitted) ? { ...saved, body: saved.mode === 'default' ? current.draft.body : saved.body } : current.draft, template: { ...current.template, updatedAt: result.updatedAt }, saveError: adjusted ? '完整草稿已保留，请核对服务中实际保存的正文后继续修改。' : undefined, saveAdjusted: adjusted, savePending: false, saveUnconfirmed: false, unconfirmedSubmitted: undefined };
      });
      if (alive.current && currentProject.current.generation === requestGeneration) onToast(adjusted ? '服务保存的正文与提交不同，完整草稿已保留，请核对。' : '当前项目的评论模板设置已保存');
    } catch (err) {
      setState(current => current.status === 'ok' && current.scopeIdentity === identity ? { ...current, savePending: false, saveAdjusted: false, unconfirmedSubmitted: submitted, saveError: message(err), saveUnconfirmed: !(err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408) } : current);
    }
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
  if (state.status === 'ok' && state.scopeIdentity !== identity) return <LoadingBlock label="读取当前会话的评论模板" />;
  if (state.status === 'loading') return <LoadingBlock label="加载评论模板" />;
  if (state.status === 'error') return <div className="space-y-3"><ErrorBlock message={state.message} /><Button onClick={() => void load()}>重试</Button></div>;
  const dirty = !same(state.draft, state.saved);
  const overLimit = state.draft.mode === 'custom' && state.draft.body.length > MAX_TEMPLATE_LENGTH;
  const stalePreview = Boolean(state.preview && state.preview.source !== sourceOf(state));
  return <section className="space-y-4" aria-labelledby="comment-template-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 id="comment-template-title" className="text-base font-semibold">PR 评论模板</h3><p className="mt-1 text-sm text-muted-foreground">保存仅修改当前项目；之后打开或重新打开 PR 时使用。示例预览不会发送 GitHub 评论。</p></div>
      <div className="flex flex-wrap items-center gap-3"><p role="status" className="text-sm text-muted-foreground">{state.saveUnconfirmed ? '草稿保存结果未确认' : dirty ? state.restoredDraft ? '已恢复未保存草稿' : '有未保存修改' : '与已保存设置一致'}{state.template.updatedAt ? ` · 最近保存 ${new Date(state.template.updatedAt).toLocaleString()}` : ''}</p><Button onClick={() => void save()} disabled={saving || state.saveUnconfirmed || overLimit || !dirty || (state.draft.mode === 'custom' && !state.draft.body.trim())}>{saving ? <Loader2 className="animate-spin" /> : <Save />}保存模板</Button></div>
    </div>
    {overLimit ? <p role="alert" className="text-sm text-destructive">正文长度 {state.draft.body.length}，超过上限 {MAX_TEMPLATE_LENGTH}；请缩短后保存，当前完整草稿未被裁切。</p> : null}
    {capacityError ? <p role="alert" className="text-sm text-warn">{capacityError}</p> : null}
    {state.readError ? <p role="alert" className="text-sm text-destructive">读取失败：{state.readError}。当前草稿已保留。<Button variant="outline" size="sm" onClick={() => void load(true).catch(() => undefined)}>重试读取</Button></p> : null}
    {state.saveError ? <div role="alert" className="text-sm text-destructive">{state.saveUnconfirmed ? '保存结果未确认' : state.saveAdjusted ? '服务保存了不同正文' : '保存被拒绝'}：{state.saveError}。草稿已保留。{state.saveUnconfirmed ? <Button variant="outline" size="sm" onClick={() => void load(true).catch(() => onToast('读取失败，请稍后核对保存结果。'))}>重新读取并核对</Button> : '请修正后重试。'}</div> : null}
    <div className="grid min-w-0 gap-4 xl:grid-cols-2">
      <div className="block min-w-0 space-y-2"><fieldset className="flex flex-wrap gap-x-6 gap-y-2"><legend className="sr-only">模板模式（保存后生效）</legend>
      {(['default', 'custom'] as const).map(mode => <label key={mode} className="flex min-h-10 cursor-pointer items-center gap-2 text-sm"><input type="radio" name="comment-template-mode" checked={state.draft.mode === mode} onChange={() => updateDraft({ mode })} className="h-4 w-4 accent-primary" />{mode === 'default' ? '使用默认模板' : '自定义模板'}</label>)}
    </fieldset>{state.draft.mode === 'custom' ? <p className="text-right text-xs text-muted-foreground">正文长度 {state.draft.body.length}/{MAX_TEMPLATE_LENGTH}</p> : null}<textarea ref={textareaRef} aria-label="模板正文" className="min-h-80 w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={sourceOf(state)} readOnly={state.draft.mode === 'default'} onChange={event => updateDraft({ body: event.target.value })} spellCheck={false} /></div>
      <section className="min-w-0 space-y-2" aria-labelledby="comment-preview-title"><div className="flex min-h-5 flex-wrap items-center justify-between gap-2"><h4 id="comment-preview-title" className="text-sm font-medium">示例预览</h4><Button variant="outline" size="sm" onClick={() => void preview()} disabled={previewing}>{previewing ? <Loader2 className="animate-spin" /> : <Eye />}{state.preview ? '更新预览' : '生成预览'}</Button></div>
        {stalePreview ? <p role="status" className="text-sm text-warn">草稿已变化，下方仍是上次预览。</p> : null}
        {state.previewError ? <p role="alert" className="text-sm text-destructive">预览失败：{state.previewError}。草稿已保留。</p> : null}
        <div className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 font-mono text-sm leading-6">{state.preview?.rendered || '生成预览，检查示例 PR 和分支数据渲染后的正文。'}</div>
      </section>
    </div>
    <details className="border-t border-border pt-3"><summary className="cursor-pointer text-sm font-medium">插入模板变量</summary><p className="my-2 text-sm text-muted-foreground">自定义模式下点击变量插入光标处；未知变量会原样保留。未保存草稿跨标签最多临时保留 30 分钟，未确认的保存需先读取核对。</p><div className="grid gap-2 md:grid-cols-2">{state.template.variables.map(variable => <button key={variable.key} type="button" disabled={state.draft.mode !== 'custom'} onClick={() => insertVariable(variable.key)} className="min-w-0 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><code>{`{{${variable.key}}}`}</code><span className="ml-2 text-muted-foreground">{variable.label}</span><span className="mt-1 block break-all text-xs text-muted-foreground">{variable.example}</span></button>)}</div></details>
  </section>;
}
