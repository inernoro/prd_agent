import { WritingLogo } from './WritingLogo';
import { WritingThreads } from './WritingThreads';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowUpRight, ChevronLeft, Check, ChevronRight, FileText, Moon, X, MoreHorizontal } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { writingContext, createWriting, getWriting, saveWriting, generateWriting, commandWriting } from '@/services/real/writing';
import type { WritingContext, WritingDocument, WritingState, WritingParagraph, WritingSource } from '@/services/contracts/writing';
import { PARAGRAPH_REGISTRY, WRITING_STAGE_REGISTRY, remainingQuestions, writingSourceBlocks, writingCitationLocation, writingKnowledgeHref, writingSaveInput } from './writingView';
import { WritingReaderPage } from './WritingReaderPage';
import { WritingQuestionPanel } from './WritingQuestionPanel';
import { WritingReviewPage } from './WritingReviewPage';
import './writing.css';

const STEPS = ['选择模版与资料', '生成初稿', '补充确认', '审核发布'];

export default function WritingWorkspacePage() {
  const { storeId = '', entryId, view } = useParams();
  if (view === 'read' || view === 'learn') return <WritingReaderPage storeId={storeId} entryId={entryId ?? ''} tutorial={view === 'learn'} />;
  return <WritingAuthor storeId={storeId} entryId={entryId} />;
}

export function WritingThemeButton() {
  return <button className="btn ghost" aria-label="切换明暗主题" onClick={() => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
  }}><Moon size={14} /></button>;
}

function WritingAuthor({ storeId, entryId }: { storeId: string; entryId?: string }) {
  const navigate = useNavigate();
  const [context, setContext] = useState<WritingContext>();
  const [document, setDocument] = useState<WritingDocument>();
  const [draft, setDraft] = useState<WritingState>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [restored, setRestored] = useState(false);
  const [stepOverride, setStepOverride] = useState<number>();
  const [search, setSearch] = useState('');
  const [sourceId, setSourceId] = useState<string>();
  const [sourceQuote, setSourceQuote] = useState('');
  const [questionId, setQuestionId] = useState<string>();
  const [answer, setAnswer] = useState('');
  const [openAnswer, setOpenAnswer] = useState(false);
  const [sectionSettings, setSectionSettings] = useState<string>();
  const [markFilter, setMarkFilter] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const activeId = useRef(entryId);
  const panelRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const accept = useCallback((state: WritingState) => { setDraft(state); setDirty(false); }, []);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await writingContext(storeId);
      if (!res.success) throw new Error(res.error.message);
      setContext(res.data);
      if (entryId) {
        const found = await getWriting(entryId);
        if (!found.success) throw new Error(found.error.message);
        setDocument(found.data); accept(found.data.state); activeId.current = entryId;
        setRestored(found.data.state.stage === 'confirm' && found.data.state.questions.some(q => q.status !== 'pending'));
        try {
          const ui = JSON.parse(localStorage.getItem(`map-writing-ui:${res.data.actorId}:${entryId}`) ?? '{}');
          setQuestionId(ui.questionId); setAnswer(ui.answer ?? ''); setOpenAnswer(!!ui.openAnswer); setStepOverride(ui.step);
        } catch { /* 损坏的阅读游标不影响草稿 */ }
      } else {
        activeId.current = undefined;
        accept({ revision: 0, stage: 'select', templateId: res.data.templates.some(t => t.id === new URLSearchParams(window.location.search).get('template')) ? new URLSearchParams(window.location.search).get('template')! : 'prd', templateVersion: '1.0', title: '', summary: '', manualInput: '',
          authorId: res.data.actorId, authorName: res.data.actorName, reviewerId: res.data.reviewerId, reviewerName: res.data.reviewerName,
          scopeIn: '', scopeOut: '', conclusions: [], intentPoints: [], sources: [], sections: [], questions: [], roles: [], chapters: [], updatedAt: '' });
      }
    } catch (e) { setError(e instanceof Error ? e.message : '页面加载失败'); }
    finally { setLoading(false); }
  }, [storeId, entryId, accept]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!entryId || draft?.stage !== 'generating') return;
    let stopped = false;
    const poll = async () => {
      const res = await getWriting(entryId);
      if (stopped) return;
      if (res.success) { setDocument(res.data); accept(res.data.state); }
      else setError(res.error.message);
    };
    const id = window.setInterval(() => { void poll(); }, 1800);
    const timer = window.setInterval(() => setElapsed(v => v + 1), 1000);
    return () => { stopped = true; clearInterval(id); clearInterval(timer); };
  }, [entryId, draft?.stage, accept]);
  useEffect(() => {
    if (!questionId && !sourceId) return;
    if (questionId) panelRef.current?.focus({ preventScroll: true });
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setQuestionId(undefined); setSourceId(undefined); triggerRef.current?.focus(); } };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [questionId, sourceId]);
  useEffect(() => {
    if (loading || !context || !entryId) return;
    try { localStorage.setItem(`map-writing-ui:${context.actorId}:${entryId}`, JSON.stringify({ questionId, answer, openAnswer, step: stepOverride })); } catch { /* 草稿仍保存在服务器 */ }
  }, [loading, context, entryId, questionId, answer, openAnswer, stepOverride]);
  useEffect(() => {
    if (!dirty) return;
    const before = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before);
  }, [dirty]);

  if (loading) return <div className="writing-author writing-root"><MapSectionLoader text="正在读取知识库与写作草稿…" /></div>;
  if (!draft || !context) return <div className="writing-author writing-root"><div className="writing-error" role="alert">{error}<button className="btn" onClick={() => void load()}>重试</button><Link className="btn" to={writingKnowledgeHref(storeId)}>返回知识库</Link></div></div>;
  const state = draft;
  const template = context.templates.find(t => t.id === state.templateId)!;
  const serverStep = WRITING_STAGE_REGISTRY[state.stage]?.step ?? 0;
  const step = stepOverride ?? serverStep;
  const locked = busy || ['generating', 'pending-review', 'publishing', 'published'].includes(state.stage);
  const unresolved = remainingQuestions(state);
  const paragraphs = state.sections.flatMap(s => s.paragraphs);
  const auths = paragraphs.filter(p => p.status === 'auth');
  const reviewable = paragraphs.filter(p => p.status === 'auth' || p.status === 'src');
  const unseenParagraphs = reviewable.filter(p => !p.confirmed).length;
  const unseenDetails = state.sections.filter(s => (s.condition || s.detail?.rows.length) && !s.metadataConfirmed).length;
  const unseen = unseenParagraphs + unseenDetails;
  const question = state.questions.find(q => q.id === questionId);
  const selectedSource = state.sources.find(s => s.id === sourceId);
  const eligibleSources = context.sources.filter(s => s.id !== entryId && !s.contentType.startsWith('video/') && !s.contentType.startsWith('audio/') && s.title.toLowerCase().includes(search.toLowerCase()));
  const patch = (fields: Partial<WritingState>) => { setDraft(v => v ? { ...v, ...fields } : v); setDirty(true); };
  const patchParagraph = (id: string, text: string) => patch({ sections: state.sections.map(s => ({ ...s, paragraphs: s.paragraphs.map(p => p.id === id ? { ...p, text, status: 'auth', confirmed: false } : p) })) });

  async function saveForm() {
    let id = activeId.current;
    let revision = state.revision;
    if (!id) {
      const created = await createWriting(storeId, state.templateId);
      if (!created.success) throw new Error(created.error.message);
      id = created.data.entryId; revision = created.data.state.revision; activeId.current = id;
      setDraft(current => current ? { ...current, revision } : current);
    }
    if (['generating', 'pending-review', 'published', 'publishing'].includes(state.stage)) return { id, state };
    const saved = await saveWriting(id, { ...writingSaveInput(state), revision });
    if (!saved.success) throw new Error(saved.error.message);
    accept(saved.data.state);
    return { id, state: saved.data.state };
  }
  async function perform(action: string, values: Record<string, unknown> = {}) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await saveForm();
      let next = saved.state;
      if (action === 'generate') {
        const result = await generateWriting(saved.id, next.revision);
        if (!result.success) throw new Error(result.error.message);
        next = result.data.state; setElapsed(0); setStepOverride(undefined);
      } else if (action !== 'save' && action !== 'exit') {
        const result = await commandWriting(saved.id, next.revision, action, values);
        if (!result.success) throw new Error(result.error.message);
        next = result.data.state;
        if (action === 'answer') {
          const remaining = next.questions.find(q => q.status === 'pending');
          setQuestionId(remaining?.id); setAnswer(remaining?.answer ?? ''); setOpenAnswer(false);
          setNotice('回答已保存，正文与读者结论请重新核对。');
        }
        if (action === 'blank' || action === 'edit') setStepOverride(2);
        if (action === 'review' || action === 'approve') setStepOverride(3);
      }
      accept(next);
      if (action === 'exit') navigate(writingKnowledgeHref(storeId, saved.id));
      else if (!entryId) navigate(`/document-store/${storeId}/write/${saved.id}`, { replace: true });
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败，请重试'); }
    finally { setBusy(false); }
  }
  const openQuestion = (id: string, trigger: HTMLButtonElement) => {
    const q = state.questions.find(q => q.id === id)!;
    if (matchMedia('(min-width:761px)').matches) requestAnimationFrame(() => window.document.querySelector(`[data-paragraph-id="${CSS.escape(q.paragraphId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    triggerRef.current = trigger; setQuestionId(id); setAnswer(q.answer); setOpenAnswer(q.status === 'open');
    const evidence = q.evidence?.[0];
    setSourceId(evidence?.sourceId); setSourceQuote(evidence?.quote ?? '');
  };
  let primaryLabel = '生成初稿';
  let primaryDisabled = busy;
  let reason = '';
  let primary: () => void = () => void perform('generate');
  if (state.stage === 'generating') { primaryLabel = '生成中…'; primaryDisabled = true; reason = '生成期间可保存退出'; }
  else if (state.stage === 'failed') { primaryLabel = '重试'; }
  else if (state.stage === 'pending-review') {
    if (context.actorId === state.reviewerId) { primaryLabel = '审核通过并发布'; primary = () => void perform('approve'); }
    else { primaryLabel = `等待${state.reviewerName}审核`; primaryDisabled = true; reason = '审核期间可撤回'; }
  } else if (state.stage === 'published') { primaryLabel = '查看读者页'; primary = () => navigate(`/document-store/${storeId}/write/${entryId}/read`); }
  else if (serverStep >= 2) {
    primaryLabel = unresolved ? `处理待确认（${unresolved}）` : '提交审核';
    primary = () => unresolved ? setStepOverride(2) : void perform('review');
    if (!unresolved && unseen) { primaryDisabled = true; reason = unseenDetails ? `还有 ${unseenParagraphs} 段正文、${unseenDetails} 项小节条件与细节未过目` : `还有 ${unseenParagraphs} 段正文未过目`; }
  } else if (!state.sources.length && !state.manualInput.trim()) { primaryDisabled = true; reason = '关联资料或输入内容后生成，也可以用空白模版开始'; }
  return <div className="writing-author writing-root" data-writing-page="author"><WritingThreads />
    <header className="writing-mobile-header"><Link to={writingKnowledgeHref(storeId)} aria-label="返回知识库"><ChevronLeft size={20} /></Link><div><strong>{state.published ? '编辑文档' : '新建文档'}</strong><span>{busy ? '保存中…' : dirty ? '有未保存修改' : state.updatedAt ? `已保存 ${new Date(state.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '尚未保存'}</span></div><WritingThemeButton /></header><div className="writing-mobile-step"><strong>第 {step + 1} / 4 步 · {STEPS[step]}</strong><div>{STEPS.map((label, i) => <button key={label} className={i === step ? 'on' : i < step ? 'done' : ''} aria-label={label} disabled={i > serverStep && i !== 3} onClick={() => setStepOverride(i)} />)}</div></div><header className="writing-top">
      <div className="writing-breadcrumb"><Link to={writingKnowledgeHref(storeId)} aria-label="返回知识库"><WritingLogo /></Link><Link to="/document-store">团队知识库</Link><span>/</span><Link to={writingKnowledgeHref(storeId)}>{context.store.name}</Link><span>/</span><span>{state.published ? '编辑文档' : '新建文档'}</span></div>
      <ol className="stp" aria-label="进度">{STEPS.map((label, i) => <li className={step === i ? 'cur' : i < step ? 'done' : ''} key={label}>{i > 0 && <span className="sep" />}<button disabled={i > serverStep && i !== 3} onClick={() => setStepOverride(i)} aria-current={step === i ? 'step' : undefined}><span className="n">{i < step ? <Check size={10} /> : i + 1}</span>{label}</button></li>)}</ol>
      <div className="writing-actions"><span className="mono" role="status">{busy ? '保存中…' : dirty ? '有未保存修改' : state.updatedAt ? `已保存 ${new Date(state.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '尚未保存'}</span><button className="btn ghost" disabled={busy} onClick={() => void perform('exit')}>保存并退出</button><WritingThemeButton /><button className="btn pri" title={reason || undefined} disabled={primaryDisabled} onClick={primary}>{busy && <MapSpinner size={13} />}{primaryLabel}</button></div>
    </header>
    {(error || notice) && <div className={`writing-banner ${error ? 'danger' : ''}`} role={error ? 'alert' : 'status'}>{error || notice}{error && <button className="btn ghost sm" onClick={() => { setError(''); void load(); }}>重新读取草稿</button>}</div>}
    <main className="writing-author-main">{question && <button className="writing-author-scrim" aria-label="关闭补充面板并保留进度" onClick={() => setQuestionId(undefined)} />}
      <fieldset className="writing-fieldset" disabled={busy}>
      {step === 0 && <div className="writing-choose">
        <section className="panel scroll writing-template-panel"><div className="writing-template-choice"><div className="writing-section-heading"><div><h2 className="serif">选择模版</h2><p className="hint">{context.store.pmProjectId ? `根据关联项目${context.projectName ? `「${context.projectName}」` : ''}推荐了需求说明。` : ''}模版只决定默认小标题，生成后都能改。</p></div><span className="cap writing-desktop-only">1 / 2</span><span className="hint writing-mobile-only">{context.store.pmProjectId ? '按关联项目推荐' : '选择适合的模版'}</span></div>
          <div className="writing-template-grid" role="radiogroup" aria-label="模版">{context.templates.map(t => <button className="tc" role="radio" aria-checked={state.templateId === t.id} key={t.id} disabled={locked} onClick={() => patch({ templateId: t.id })}><span className="writing-card-title">{t.type}{context.store.pmProjectId && t.id === 'prd' && <span className="tag t-m">推荐</span>}</span><span className="hint cl2">{t.useWhen}</span></button>)}</div>
          <p className="hint writing-mobile-only writing-template-use">{template.useWhen}</p><div className="writing-divided writing-template-headings"><div className="cap">将生成的小标题 · {template.headings.length} 节</div><ol className="writing-headings">{template.headings.map((h, i) => <li key={h.title}><span className="mono"><span className="writing-desktop-only">{String(i + 1).padStart(2, '0')}</span><span className="writing-mobile-only">{i + 1}</span></span>{h.title}</li>)}</ol></div>
          </div><div className="writing-divided writing-known-block"><div className="writing-known-heading"><span className="cap">系统已知 · 不用再填</span><Link className="btn ghost sm" to={writingKnowledgeHref(storeId)}>在知识库中修改</Link></div><div className="writing-known">{[['作者', state.authorName], [context.teamNames?.length ? '所属团队' : '所属知识库', context.teamNames?.join('、') || context.store.name], ['关联项目', context.projectName || (context.store.pmProjectId ? '已关联项目' : '未关联')], ['可见范围', context.store.isPublic ? '公开知识库' : '沿用知识库权限'], ['审核人', `${state.reviewerName}（知识库维护者）`], ['模版', `${template.type} v${template.version}`]].map(([label, value]) => <div key={label}><div className="hint">{label}</div><div>{value}</div></div>)}</div></div>
          <details className="writing-manual-input"><summary className="hint">手动输入与作者重点</summary><label className="writing-input-label">文档标题<input className="field" value={state.title} onChange={e => patch({ title: e.target.value })} placeholder="把最能区分这份文档的词放在前面" /></label>
          <label className="writing-input-label">手动输入<textarea className="field" value={state.manualInput} onChange={e => patch({ manualInput: e.target.value })} placeholder="粘贴松散信息、背景或你的想法，可与关联资料一起整理" rows={5} /></label>
          <label className="writing-input-label">必须传达的重点<textarea className="field" value={state.intentPoints.join('\n')} onChange={e => patch({ intentPoints: e.target.value.split('\n') })} placeholder="每行一个重点，保留适用条件和例外" rows={3} /></label></details>
        </section>
        <section className="panel writing-source-picker"><div className="writing-picker-header"><div className="writing-section-heading"><h2 className="serif">关联资料</h2><span className="cap writing-desktop-only">2 / 2</span><span className="mono writing-mobile-only">已选 {state.sources.length} / {eligibleSources.length}</span></div><input className="field" placeholder="搜索团队知识库" aria-label="搜索资料" value={search} onChange={e => setSearch(e.target.value)} /></div><div className="cap writing-picker-count">来自当前知识库 · 已选 {state.sources.length} / {eligibleSources.length}</div>
          <div className="scroll writing-source-list">{eligibleSources.map((s, i) => { const on = state.sources.some(x => x.entryId === s.id); return <button className="pickrow" role="checkbox" aria-checked={on} disabled={locked} key={s.id} onClick={() => patch({ sources: on ? state.sources.filter(x => x.entryId !== s.id) : [...state.sources, { id: `S${state.sources.length + 1}`, entryId: s.id, title: s.title, content: '', hash: '', status: 'pending', updatedAt: s.updatedAt }] })}><span className={`ck ${on ? 'on' : ''}`}><Check size={10} /></span><span className="sid">S{i + 1}</span><span className="writing-source-title"><span className="cl1">{s.title}</span><span className="hint writing-desktop-only">{s.metadata?.writing_source_kind || (s.metadata?.writing_template || s.contentType.includes('markdown') ? '托管文档' : s.contentType.includes('pdf') ? 'PDF 文档' : s.contentType.includes('csv') ? '表格' : '文档')} · {s.authorName || s.metadata?.author_name || s.metadata?.author || (s.createdBy === context.actorId ? context.actorName : s.createdBy)} · {new Date(s.updatedAt).toLocaleDateString('sv-SE')}{s.metadata?.writing_source_size ? ` · ${s.metadata.writing_source_size}` : ''}</span><span className="hint writing-mobile-only">{s.metadata?.writing_source_kind || (s.contentType.includes('markdown') ? '托管文档' : s.contentType.includes('pdf') ? 'PDF 文档' : '文档')} · {new Date(s.updatedAt).toLocaleDateString('sv-SE')}</span></span></button>; })}{!eligibleSources.length && <div className="writing-empty"><FileText size={40} /><strong>{search ? '没有找到匹配资料' : '当前知识库里还没有资料'}</strong><p className="hint">可以手动输入信息，或直接用空白模版写。</p><button className="btn" onClick={() => void perform('blank')}>用空白模版开始</button></div>}</div>
          <div className="writing-picker-footer"><p className="hint">生成时只读取已选资料，不会修改原文或它们的权限。生成期间可以保存退出。</p><button className="btn ghost sm" onClick={() => void perform('blank')}>用空白模版开始</button></div>
        </section>
      </div>}
      {step === 1 && <div className="writing-generation-layout"><section className="panel writing-generation"><span className="cap">按模版完成文档</span><h1 className="serif">{state.stage === 'failed' ? '生成暂停' : '正在生成初稿'}</h1><p className="hint">已用 {elapsed} 秒 · 可保存退出，后台任务继续</p>{['读取资料', '提取要点', '按模版组织', '标注来源与缺口'].map((label, i) => { const phase = document?.run?.phase ?? ''; const phaseIndex = phase.includes('初稿已生成') ? 4 : phase.includes('标注来源') ? 3 : phase.includes('按模版组织') ? 2 : phase.includes('提取要点') ? 1 : 0; const done = i < phaseIndex; const active = i === phaseIndex; return <div className="gs" key={label}><span className={`gi ${done ? 'done' : active ? 'act' : ''}`}>{done ? <Check size={12} /> : active ? <MapSpinner size={16} /> : i + 1}</span><div><strong>{label}</strong><p className="hint">{active ? document?.run?.phase ?? '等待后台处理' : done ? '已完成' : '等待'}</p></div></div>; })}{state.failure && <div className="note dg" role="alert">{state.failure}</div>}<div className="writing-actions"><button className="btn" onClick={() => void perform('exit')}>保存并退出</button>{state.stage === 'failed' && <><button className="btn pri" onClick={() => void perform('generate')}>重试</button><button className="btn" onClick={() => setStepOverride(0)}>调整关联资料</button></>}</div>{elapsed > 8 && state.stage === 'generating' && <div className="note am">仍在处理，可保存退出；已读取的资料会保留。</div>}</section><aside className="panel writing-generation-sources"><div className="writing-section-heading"><h3 className="h3">资料读取情况</h3><span className="mono">{state.sources.filter(s => s.status === 'read').length} / {state.sources.length} 份</span></div>{state.sources.map(s => <div className="srow" key={s.id}><span className="sid">{s.id}</span><span><span className="writing-block">{s.title}</span><span className="hint">{s.status === 'read' ? '已读取' : s.status === 'skipped' ? '已跳过 · 原文保留' : '等待或读取中'}</span></span>{s.status !== 'read' && s.status !== 'skipped' && state.stage === 'generating' && <button className="btn ghost sm" onClick={() => void perform('skip-source', { sourceId: s.id })}>跳过</button>}</div>)}<p className="hint">资料中没有或互相矛盾的地方会单独列出，由你确认。</p></aside></div>}
      {step === 2 && <>
        <div className="writing-three-columns">
          <aside className="panel scroll writing-sources-column"><div className="col-h"><h3 className="h3">资料 · {state.sources.length} 份</h3></div>{state.sources.map(s => <div key={s.id}><button className="src-h" onClick={() => { setSourceId(sourceId === s.id ? undefined : s.id); }}><span className="sid">{s.id}</span><span><strong>{s.title}</strong><span className="hint writing-block">{context.sources.find(item => item.id === s.entryId)?.metadata?.writing_source_kind || '文档'} · {context.sources.find(item => item.id === s.entryId)?.authorName || context.sources.find(item => item.id === s.entryId)?.metadata?.author_name || ''} · {s.status === 'skipped' ? '已跳过 · 未参与本次生成' : s.status === 'pending' ? '尚未读取' : new Date(s.updatedAt).toLocaleDateString('sv-SE')}</span></span><ChevronRight size={14} className={sourceId === s.id ? 'writing-source-open' : ''} /></button>{sourceId === s.id && <div className="writing-source-excerpts">{s.status === 'skipped' ? <p className="hint">已跳过，未参与本次生成。原文仍保留，使用“更新并复核”可读取原文。</p> : s.status === 'pending' ? <p className="hint">尚未读取。使用“更新并复核”可读取原文，无需生成正文。</p> : <>{writingSourceBlocks(s).map(block => <div key={block.id}><div className="mono writing-excerpt-location">{block.location}</div><p className={`ex ${sourceQuote && block.text.includes(sourceQuote) ? 'on' : ''}`}>{block.text}</p></div>)}{!s.content && <p className="hint">来源快照暂无正文。</p>}</>}<Link className="btn ghost sm" to={writingKnowledgeHref(storeId, s.entryId)} target="_blank">定位到原文 <ArrowUpRight size={12} /></Link>{!locked && <div className="writing-actions"><button className="btn sm" onClick={() => void perform('keep-source', { sourceId: s.id })}>复核，保留快照</button><button className="btn sm" onClick={() => void perform('update-source', { sourceId: s.id })}>更新并复核</button></div>}</div>}</div>)}</aside>
          <section className="panel scroll writing-document-column">{restored && <div className="writing-restored-notice note ac" role="status"><span>已恢复到 {new Date(state.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 保存的进度：{state.questions.filter(q => q.status !== 'pending').length} 项已确认{question ? `，正在处理第 ${state.questions.indexOf(question) + 1} / ${state.questions.length} 项。` : '。'}</span><button className="btn sm" onClick={() => setRestored(false)}>知道了</button></div>}<div className="writing-legend">{Object.entries(PARAGRAPH_REGISTRY).map(([key, item]) => <button className="lg" aria-pressed={!markFilter || markFilter === key} key={key} onClick={() => setMarkFilter(markFilter === key ? undefined : key)}><span className={`sw ${key}`} />{item.label}<b>{paragraphs.filter(p => p.status === key).length}</b></button>)}<span className="hint">点来源编号核对原文；直接修改正文后请重新确认。</span></div><div className="writing-document-content"><div className="writing-document-meta"><span className="tag t-l">{template.type}</span><span className="mono">{state.authorName} · {WRITING_STAGE_REGISTRY[state.stage]?.label}</span></div><input className="writing-title-input serif" aria-label="文档标题" disabled={locked} value={state.title} onChange={e => patch({ title: e.target.value })} placeholder="填写文档标题" />{state.sections.map((section, i) => <section className="writing-doc-section" key={section.id}><h2 className="serif"><span className="mono">{String(i + 1).padStart(2, '0')}</span><input className="writing-heading-input" aria-label={`第${i + 1}节标题`} disabled={locked} value={section.title} onChange={e => patch({ sections: state.sections.map(s => s.id === section.id ? { ...s, title: e.target.value } : s) })} /><button className="btn ghost sm writing-remove-section" aria-label={`编辑${section.title}的条件与细节`} onClick={() => setSectionSettings(sectionSettings === section.id ? undefined : section.id)}><MoreHorizontal size={12} /></button><button className="btn ghost sm writing-remove-section" aria-label={`删除${section.title}小节`} disabled={locked} onClick={() => patch({ sections: state.sections.filter(s => s.id !== section.id), questions: state.questions.filter(q => !section.paragraphs.some(p => p.id === q.paragraphId)) })}><X size={12} /></button></h2>{sectionSettings === section.id && <div className="writing-section-settings"><label className="writing-input-label">小节适用条件<textarea className="field" value={section.condition ?? ''} disabled={locked} onChange={e => patch({ sections: state.sections.map(s => s.id === section.id ? { ...s, condition: e.target.value } : s) })} /></label><label className="writing-input-label">折叠细节标题<input className="field" value={section.detail?.label ?? ''} disabled={locked} onChange={e => patch({ sections: state.sections.map(s => s.id === section.id ? { ...s, detail: { label: e.target.value, rows: s.detail?.rows ?? [] } } : s) })} /></label>{section.detail?.rows.map((row, rowIndex) => <div className="writing-detail-edit-row" key={rowIndex}>{row.map((cell, cellIndex) => <input className="field" key={cellIndex} aria-label={`第${rowIndex + 1}行第${cellIndex + 1}列`} value={cell} disabled={locked} onChange={e => patch({ sections: state.sections.map(s => s.id === section.id ? { ...s, detail: { label: s.detail?.label ?? '', rows: s.detail!.rows.map((r, n) => n === rowIndex ? r.map((v, j) => j === cellIndex ? e.target.value : v) : r) } } : s) })} />)}<button className="btn ghost sm" disabled={locked} onClick={() => patch({ sections: state.sections.map(s => s.id === section.id ? { ...s, detail: { label: s.detail?.label ?? '', rows: s.detail!.rows.filter((_, n) => n !== rowIndex) } } : s) })}>移除</button></div>)}<button className="btn sm" disabled={locked} onClick={() => patch({ sections: state.sections.map(s => s.id === section.id ? { ...s, detail: { label: s.detail?.label || '展开细节', rows: [...(s.detail?.rows ?? []), ['', '', '']] } } : s) })}>添加细节行</button></div>}{section.paragraphs.map(p => <div className={`pa ${p.status} ${markFilter && p.status !== markFilter ? 'dim' : ''} ${question?.paragraphId === p.id ? 'focus' : ''}`} data-paragraph-id={p.id} key={p.id}><div className={`pl ${p.status}`}>{PARAGRAPH_REGISTRY[p.status]?.label}{p.citations.map(c => <button className="sc" key={c} onClick={() => { setSourceId(c); setSourceQuote(p.quotes?.[c] ?? ''); }}>{c}{writingCitationLocation(state.sources.find(s => s.id === c), p.quotes?.[c] ?? '') && ` · ${writingCitationLocation(state.sources.find(s => s.id === c), p.quotes?.[c] ?? '')}`}</button>)}{p.confirmed && <span>· 已确认</span>}</div>{p.status === 'ask' ? <div className="writing-ask-body"><p className="pt">{state.questions.find(q => q.paragraphId === p.id)?.title ?? p.text}</p><button className="btn sm" onClick={e => { const q = state.questions.find(q => q.paragraphId === p.id); if (q) openQuestion(q.id, e.currentTarget); }}>补充</button></div> : p.status === 'conf' ? <div className="writing-conflict-body">{(state.questions.find(q => q.paragraphId === p.id)?.evidence ?? p.citations.map(sourceId => ({ sourceId, quote: p.quotes?.[sourceId] ?? state.sources.find(s => s.id === sourceId)?.content.slice(0, 200) ?? '' }))).map((evidence, index) => <div className="side" key={index}><button className="sc" onClick={() => { setSourceId(evidence.sourceId); setSourceQuote(evidence.quote); }}>{evidence.sourceId}</button><span>{evidence.quote}</span></div>)}<button className="btn sm" onClick={e => { const q = state.questions.find(q => q.paragraphId === p.id); if (q) openQuestion(q.id, e.currentTarget); }}>选择采用哪一条</button></div> : <textarea className="writing-paragraph pt" ref={el => { if (el) { el.style.height = '0px'; el.style.height = el.scrollHeight + 'px'; } }} aria-label={`${section.title}段落`} disabled={locked} value={p.text} onChange={e => patchParagraph(p.id, e.target.value)} rows={1} />}</div>)}</section>)}<div className="writing-actions"><button className="btn ghost" disabled={locked || busy} onClick={() => patch({ sections: [...state.sections, { id: crypto.randomUUID(), title: '新小节', paragraphs: [{ id: crypto.randomUUID(), text: '', status: 'auth', citations: [], confirmed: false }] }] })}>添加小节</button><button className="btn" disabled={locked || busy} onClick={() => void perform('save')}>保存正文</button></div></div></section>
          <aside className="panel scroll writing-confirm-column" ref={panelRef} tabIndex={-1}>{question ? <WritingQuestionPanel key={question.id} question={question} questions={state.questions} sources={state.sources} paragraphs={paragraphs} answer={answer} openAnswer={openAnswer} busy={busy} locked={locked} onAnswer={setAnswer} onOpenAnswer={setOpenAnswer} onConfirm={() => void perform('answer', { questionId: question.id, text: answer, open: openAnswer })} onPrevious={() => { const previous = state.questions[state.questions.indexOf(question) - 1]; if (previous) { setQuestionId(previous.id); setAnswer(previous.answer); setOpenAnswer(previous.status === 'open'); } }} onClose={() => { setQuestionId(undefined); triggerRef.current?.focus(); }} onLocate={(id, quote) => { setSourceId(id); setSourceQuote(quote); }} /> : <><div className="col-h"><h3 className="h3">需要你确认</h3><span className="tag t-c">{unresolved} 项</span></div><div className="writing-question-list">{state.questions.map(q => <div className={`qc ${q.status !== 'pending' ? 'done' : ''}`} key={q.id}><span className={`tag ${q.kind === 'conf' ? 't-d' : 't-c'}`}>{q.status === 'open' ? '已写入开放问题' : q.status === 'answered' ? '已确认' : q.kind === 'conf' ? '资料冲突' : '待确认'}</span><strong>{q.title}</strong><p className="hint">影响「{q.sectionTitle}」</p><button className="btn sm" disabled={locked} onClick={e => openQuestion(q.id, e.currentTarget)}>{q.status === 'pending' ? '处理' : '修改'}</button></div>)}{!state.questions.length && <p className="hint">没有待补充问题，请核对正文后审核。</p>}<div className="writing-divided"><div className="cap">作者补充 · 发布前过目</div>{auths.map(p => <p className="hint" key={p.id}>{p.text}</p>)}</div><div className="writing-divided"><div className="cap">系统已知 · 不再询问</div><div className="kv"><span>作者</span><span>{state.authorName}</span><span>知识库</span><span>{context.store.name}</span><span>可见</span><span>沿用知识库权限</span><span>审核人</span><span>{state.reviewerName}</span></div></div><button className="btn" onClick={() => setStepOverride(3)}>检查正文与发布预览</button></div></>}</aside>
        </div>
      </>}
      {step === 3 && <WritingReviewPage state={state} context={context} template={template} locked={locked} busy={busy} dirty={dirty} onPatch={patch} onCommand={perform} onBack={() => setStepOverride(2)} />}
      </fieldset>
    </main>
    {selectedSource && step !== 2 && <aside className="writing-bottom-sheet" role="dialog" aria-label="来源原文"><button className="btn" onClick={() => setSourceId(undefined)}>关闭</button><h2>{selectedSource.title}</h2>{selectedSource.status === 'skipped' ? <p className="hint">已跳过，未参与本次生成。原文仍保留，返回“补充确认”后可用“更新并复核”读取。</p> : selectedSource.status === 'pending' ? <p className="hint">尚未读取。返回“补充确认”，使用“更新并复核”读取原文，无需生成正文。</p> : <p>{selectedSource.content || '来源快照暂无正文。'}</p>}</aside>}
  </div>;
}

export type { WritingParagraph, WritingSource };
