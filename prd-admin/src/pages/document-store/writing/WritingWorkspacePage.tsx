import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, ChevronLeft, Check, ChevronRight, FileText, Moon, X, Play, BookOpen } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { writingContext, createWriting, getWriting, saveWriting, generateWriting, commandWriting } from '@/services/real/writing';
import type { WritingContext, WritingDocument, WritingState, WritingParagraph, WritingSource } from '@/services/contracts/writing';
import { PARAGRAPH_REGISTRY, WRITING_STAGE_REGISTRY, remainingQuestions, writingKnowledgeHref, writingSaveInput } from './writingView';
import { WritingReaderPage } from './WritingReaderPage';
import { WritingLearningEditor } from './WritingLearningEditor';
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
  const [pendingConfirm, setPendingConfirm] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stepOverride, setStepOverride] = useState<number>();
  const [search, setSearch] = useState('');
  const [sourceId, setSourceId] = useState<string>();
  const [sourceQuote, setSourceQuote] = useState('');
  const [questionId, setQuestionId] = useState<string>();
  const [answer, setAnswer] = useState('');
  const [openAnswer, setOpenAnswer] = useState(false);
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
    panelRef.current?.focus();
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
  const unseen = reviewable.filter(p => !p.confirmed).length;
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
    triggerRef.current = trigger; setQuestionId(id); setAnswer(q.answer); setOpenAnswer(q.status === 'open'); setSourceId(undefined);
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
    if (!unresolved && unseen) { primaryDisabled = true; reason = `还有 ${unseen} 段正文未过目`; }
  } else if (!state.sources.length && !state.manualInput.trim()) { primaryDisabled = true; reason = '关联资料或输入内容后生成，也可以用空白模版开始'; }
  return <div className="writing-author writing-root" data-writing-page="author">
    <header className="writing-mobile-header"><Link to={writingKnowledgeHref(storeId)} aria-label="返回知识库"><ChevronLeft size={20} /></Link><div><strong>{state.title ? template.type : '新建文档'}</strong><span>{busy ? '保存中…' : dirty ? '有未保存修改' : '已保存'}</span></div><WritingThemeButton /></header><div className="writing-mobile-step"><strong>第 {step + 1} / 4 步 · {STEPS[step]}</strong><div>{STEPS.map((label, i) => <button key={label} className={i <= step ? 'on' : ''} aria-label={label} disabled={i > serverStep && i !== 3} onClick={() => setStepOverride(i)} />)}</div></div><header className="writing-top">
      <div className="writing-breadcrumb"><Link to={writingKnowledgeHref(storeId)} aria-label="返回知识库"><BookOpen size={19} /></Link><Link to="/document-store">团队知识库</Link><span>/</span><Link to={writingKnowledgeHref(storeId)}>{context.store.name}</Link><span>/</span><span>{state.title || '新建文档'}</span></div>
      <ol className="stp" aria-label="进度">{STEPS.map((label, i) => <li className={step === i ? 'cur' : i < step ? 'done' : ''} key={label}>{i > 0 && <span className="sep" />}<button disabled={i > serverStep && i !== 3} onClick={() => setStepOverride(i)} aria-current={step === i ? 'step' : undefined}><span className="n">{i < step ? <Check size={10} /> : i + 1}</span>{label}</button></li>)}</ol>
      <div className="writing-actions"><span className="mono" role="status">{busy ? '保存中…' : dirty ? '有未保存修改' : state.updatedAt ? `已保存 ${new Date(state.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '尚未保存'}</span><button className="btn ghost" disabled={busy} onClick={() => void perform('exit')}>保存并退出</button><WritingThemeButton /><button className="btn pri" disabled={primaryDisabled} onClick={primary}>{busy && <MapSpinner size={13} />}{primaryLabel}</button></div>
    </header>
    {(error || notice || reason) && <div className={`writing-banner ${error ? 'danger' : ''}`} role={error ? 'alert' : 'status'}>{error || notice || reason}{error && <button className="btn ghost sm" onClick={() => { setError(''); void load(); }}>重新读取草稿</button>}</div>}
    <main className="writing-author-main">
      <fieldset className="writing-fieldset" disabled={busy}>
      {step === 0 && <div className="writing-choose">
        <section className="panel scroll writing-template-panel"><div className="writing-section-heading"><div><h2 className="serif">选择模版</h2><p className="hint">模版只决定默认小标题，生成后都能改。</p></div><span className="cap">1 / 2</span></div>
          <div className="writing-template-grid" role="radiogroup" aria-label="模版">{context.templates.map(t => <button className="tc" role="radio" aria-checked={state.templateId === t.id} key={t.id} disabled={locked} onClick={() => patch({ templateId: t.id })}><span className="writing-card-title">{t.type}</span><span className="hint cl2">{t.useWhen}</span></button>)}</div>
          <div className="writing-divided"><div className="cap">将生成的小标题 · {template.headings.length} 节</div><ol className="writing-headings">{template.headings.map((h, i) => <li key={h.title}><span className="mono">{String(i + 1).padStart(2, '0')}</span>{h.title}</li>)}</ol></div>
          <div className="writing-divided"><div className="cap">系统已知 · 不用再填</div><div className="writing-known">{[['作者', state.authorName], ['所属知识库', context.store.name], ['可见范围', context.store.isPublic ? '公开知识库' : '沿用知识库权限'], ['审核人', state.reviewerName], ['模版', `${template.type} v${template.version}`], ['关联项目', context.store.pmProjectId ? '项目知识库' : '未关联']].map(([label, value]) => <div key={label}><div className="hint">{label}</div><div>{value}</div></div>)}</div></div>
          <details className="writing-manual-input"><summary className="hint">手动输入与作者重点</summary><label className="writing-input-label">文档标题<input className="field" value={state.title} onChange={e => patch({ title: e.target.value })} placeholder="把最能区分这份文档的词放在前面" /></label>
          <label className="writing-input-label">手动输入<textarea className="field" value={state.manualInput} onChange={e => patch({ manualInput: e.target.value })} placeholder="粘贴松散信息、背景或你的想法，可与关联资料一起整理" rows={5} /></label>
          <label className="writing-input-label">必须传达的重点<textarea className="field" value={state.intentPoints.join('\n')} onChange={e => patch({ intentPoints: e.target.value.split('\n') })} placeholder="每行一个重点，保留适用条件和例外" rows={3} /></label></details>
        </section>
        <section className="panel writing-source-picker"><div className="writing-picker-header"><div className="writing-section-heading"><h2 className="serif">关联资料</h2><span className="cap">2 / 2</span></div><input className="field" placeholder="搜索团队知识库" aria-label="搜索资料" value={search} onChange={e => setSearch(e.target.value)} /></div><div className="cap writing-picker-count">来自当前知识库 · 已选 {state.sources.length} / {eligibleSources.length}</div>
          <div className="scroll writing-source-list">{eligibleSources.map((s, i) => { const on = state.sources.some(x => x.entryId === s.id); return <button className="pickrow" role="checkbox" aria-checked={on} disabled={locked} key={s.id} onClick={() => patch({ sources: on ? state.sources.filter(x => x.entryId !== s.id) : [...state.sources, { id: `S${state.sources.length + 1}`, entryId: s.id, title: s.title, content: '', hash: '', status: 'pending', updatedAt: s.updatedAt }] })}><span className={`ck ${on ? 'on' : ''}`}><Check size={10} /></span><span className="sid">S{i + 1}</span><span className="writing-source-title"><span className="cl1">{s.title}</span><span className="hint">{s.contentType || '文档'} · {new Date(s.updatedAt).toLocaleDateString('zh-CN')}</span></span></button>; })}{!eligibleSources.length && <div className="writing-empty"><FileText size={40} /><strong>{search ? '没有找到匹配资料' : '当前知识库里还没有资料'}</strong><p className="hint">可以手动输入信息，或直接用空白模版写。</p><button className="btn" onClick={() => void perform('blank')}>用空白模版开始</button></div>}</div>
          <div className="writing-picker-footer"><p className="hint">生成时只读取已选资料，不会修改原文或它们的权限。生成期间可以保存退出。</p><button className="btn ghost sm" onClick={() => void perform('blank')}>用空白模版开始</button></div>
        </section>
      </div>}
      {step === 1 && <div className="writing-generation-layout"><section className="panel writing-generation"><span className="cap">按模版完成文档</span><h1 className="serif">{state.stage === 'failed' ? '生成暂停' : '正在生成初稿'}</h1><p className="hint">已用 {elapsed} 秒 · 可保存退出，后台任务继续</p>{['读取资料', '提取要点', '按模版组织', '标注来源与缺口'].map((label, i) => { const progress = document?.run?.progress ?? 0; const done = progress >= [20, 50, 90, 100][i]; const active = !done && progress >= [0, 20, 50, 90][i]; return <div className="gs" key={label}><span className={`gi ${done ? 'done' : active ? 'act' : ''}`}>{done ? <Check size={12} /> : active ? <MapSpinner size={16} /> : i + 1}</span><div><strong>{label}</strong><p className="hint">{active ? document?.run?.phase ?? '等待后台处理' : done ? '已完成' : '等待'}</p></div></div>; })}{state.failure && <div className="note dg" role="alert">{state.failure}</div>}<div className="writing-actions"><button className="btn" onClick={() => void perform('exit')}>保存并退出</button>{state.stage === 'failed' && <><button className="btn pri" onClick={() => void perform('generate')}>重试</button><button className="btn" onClick={() => setStepOverride(0)}>调整关联资料</button></>}</div>{elapsed > 8 && state.stage === 'generating' && <div className="note am">仍在处理，可保存退出；已读取的资料会保留。</div>}</section><aside className="panel writing-generation-sources"><div className="writing-section-heading"><h3 className="h3">资料读取情况</h3><span className="mono">{state.sources.filter(s => s.status === 'read').length} / {state.sources.length} 份</span></div>{state.sources.map(s => <div className="srow" key={s.id}><span className="sid">{s.id}</span><span><span className="writing-block">{s.title}</span><span className="hint">{s.status === 'read' ? '已读取' : '等待或读取中'}</span></span>{s.status !== 'read' && state.stage === 'generating' && <button className="btn ghost sm" onClick={() => void perform('skip-source', { sourceId: s.id })}>跳过</button>}</div>)}<p className="hint">资料中没有或互相矛盾的地方会单独列出，由你确认。</p></aside></div>}
      {step === 2 && <>
        <div className="writing-three-columns">
          <aside className="panel scroll writing-sources-column"><div className="col-h"><h3 className="h3">资料 · {state.sources.length} 份</h3></div>{state.sources.map(s => <div key={s.id}><button className="src-h" onClick={() => { setSourceId(sourceId === s.id ? undefined : s.id); setQuestionId(undefined); }}><span className="sid">{s.id}</span><span><strong>{s.title}</strong><span className="hint writing-block">{s.status === 'read' ? '已读取' : '未读取'}</span></span><ChevronRight size={14} /></button>{sourceId === s.id && <div className="ex on"><p>{sourceQuote && s.content.includes(sourceQuote) ? <>{s.content.slice(0, s.content.indexOf(sourceQuote))}<mark>{sourceQuote}</mark>{s.content.slice(s.content.indexOf(sourceQuote) + sourceQuote.length)}</> : s.content || '尚未读取，生成后可以核对原文。'}</p><Link className="btn ghost sm" to={writingKnowledgeHref(storeId, s.entryId)} target="_blank">定位到原文 <ArrowUpRight size={12} /></Link>{!locked && <div className="writing-actions"><button className="btn sm" onClick={() => void perform('keep-source', { sourceId: s.id })}>复核，保留快照</button><button className="btn sm" onClick={() => void perform('update-source', { sourceId: s.id })}>更新并复核</button></div>}</div>}</div>)}</aside>
          <section className="panel scroll writing-document-column"><div className="writing-legend">{Object.entries(PARAGRAPH_REGISTRY).map(([key, item]) => <button className="lg" aria-pressed={!markFilter || markFilter === key} key={key} onClick={() => setMarkFilter(markFilter === key ? undefined : key)}><span className={`sw ${key}`} />{item.label}<b>{paragraphs.filter(p => p.status === key).length}</b></button>)}<span className="hint">点来源编号核对原文；直接修改正文后请重新确认。</span></div><div className="writing-document-content"><div className="writing-document-meta"><span className="tag t-l">{template.type}</span><span className="mono">{state.authorName} · {WRITING_STAGE_REGISTRY[state.stage]?.label}</span></div><input className="writing-title-input serif" aria-label="文档标题" disabled={locked} value={state.title} onChange={e => patch({ title: e.target.value })} placeholder="填写文档标题" />{state.sections.map((section, i) => <section className="writing-doc-section" key={section.id}><h2 className="serif"><span className="mono">{String(i + 1).padStart(2, '0')}</span>{section.title}</h2>{section.paragraphs.map(p => <div className={`pa ${p.status} ${markFilter && p.status !== markFilter ? 'dim' : ''}`} key={p.id}><div className={`pl ${p.status}`}>{PARAGRAPH_REGISTRY[p.status]?.label}{p.citations.map(c => <button className="sc" key={c} onClick={() => { setSourceId(c); setSourceQuote(p.quotes?.[c] ?? ''); setQuestionId(undefined); }}>{c}</button>)}{p.confirmed && <span>· 已确认</span>}</div><textarea className="writing-paragraph pt" ref={el => { if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }} aria-label={`${section.title}段落`} disabled={locked} value={p.text} onChange={e => patchParagraph(p.id, e.target.value)} rows={Math.max(2, Math.ceil(p.text.length / 30))} /></div>)}</section>)}<button className="btn" disabled={locked || busy} onClick={() => void perform('save')}>保存正文</button></div></section>
          <aside className="panel scroll writing-confirm-column" ref={panelRef} tabIndex={-1}>{question ? <><div className="col-h"><span className="h3">第 {state.questions.indexOf(question) + 1} / {state.questions.length} 项</span><button className="btn ghost sm" aria-label="关闭补充面板" onClick={() => { setQuestionId(undefined); triggerRef.current?.focus(); }}><X size={14} /></button></div><div className="writing-question-detail"><span className={`tag ${question.kind === 'conf' ? 't-d' : 't-c'}`}>{question.kind === 'conf' ? '资料冲突' : '资料缺失'}</span><h2 className="serif">{question.title}</h2><p className="hint">影响「{question.sectionTitle}」 · {question.why}</p>{question.citations.map(id => { const s = state.sources.find(s => s.id === id); return s ? <blockquote className="side" key={id}><span className="sid">{id}</span><span>{s.content}</span></blockquote> : null; })}{question.options.map(option => <button className="opt" role="radio" aria-checked={answer === option && !openAnswer} key={option} onClick={() => { setAnswer(option); setOpenAnswer(false); }}><span className="rd" /><span className="ol">{option}</span></button>)}<label className="writing-input-label">其他，自己写<textarea className="field" autoFocus value={answer} onChange={e => setAnswer(e.target.value)} rows={4} /></label><label className="writing-checkbox"><input type="checkbox" checked={openAnswer} onChange={e => setOpenAnswer(e.target.checked)} />暂不确定，写入开放问题</label><button className="btn pri" disabled={!answer.trim() || busy || locked} onClick={() => void perform('answer', { questionId: question.id, text: answer, open: openAnswer })}>确认，保存补充</button></div></> : <><div className="col-h"><h3 className="h3">需要你确认</h3><span className="tag t-c">{unresolved} 项</span></div><div className="writing-question-list">{state.questions.map(q => <div className={`qc ${q.status !== 'pending' ? 'done' : ''}`} key={q.id}><span className={`tag ${q.kind === 'conf' ? 't-d' : 't-c'}`}>{q.status === 'open' ? '已写入开放问题' : q.status === 'answered' ? '已确认' : q.kind === 'conf' ? '资料冲突' : '待确认'}</span><strong>{q.title}</strong><p className="hint">影响「{q.sectionTitle}」</p><button className="btn sm" disabled={locked} onClick={e => openQuestion(q.id, e.currentTarget)}>{q.status === 'pending' ? '处理' : '修改'}</button></div>)}{!state.questions.length && <p className="hint">没有待补充问题，请核对正文后审核。</p>}<div className="writing-divided"><div className="cap">作者补充 · 发布前过目</div>{auths.map(p => <p className="hint" key={p.id}>{p.text}</p>)}</div><div className="writing-divided"><div className="cap">系统已知 · 不再询问</div><div className="kv"><span>作者</span><span>{state.authorName}</span><span>知识库</span><span>{context.store.name}</span><span>可见</span><span>沿用知识库权限</span><span>审核人</span><span>{state.reviewerName}</span></div></div><button className="btn" onClick={() => setStepOverride(3)}>检查正文与发布预览</button></div></>}</aside>
        </div>
      </>}
      {step === 3 && <div className="writing-review-layout"><section className="panel scroll writing-review-panel"><h2 className="serif">发布前审核</h2><div className="writing-review-stats">{Object.entries(PARAGRAPH_REGISTRY).map(([status, item]) => <div className="lg" key={status}><span className={`sw ${status}`} /><span>{item.label}</span><strong>{paragraphs.filter(p => p.status === status).length}</strong></div>)}</div><h3 className="h3">正文 · 核对来源、数字与条件</h3>{reviewable.map(p => <label className="chk" key={p.id}><input type="checkbox" checked={pendingConfirm[p.id] ?? p.confirmed} disabled={locked || busy || dirty} onChange={e => { const confirmed = e.target.checked; setPendingConfirm({ [p.id]: confirmed }); void perform('confirm', { paragraphId: p.id, confirmed }).finally(() => setPendingConfirm({})); }} /><span>{p.text || '此段尚未填写'}</span></label>)}<div className="writing-divided"><label className="writing-input-label">摘要<textarea className="field" value={state.summary} disabled={locked} onChange={e => patch({ summary: e.target.value })} rows={3} /></label><label className="writing-input-label">首屏结论<textarea className="field" value={state.conclusions.join('\n')} disabled={locked} onChange={e => patch({ conclusions: e.target.value.split('\n') })} rows={4} placeholder="每行一条，保留条件与例外" /></label><label className="writing-input-label">适用范围<input className="field" value={state.scopeIn} disabled={locked} onChange={e => patch({ scopeIn: e.target.value })} /></label><label className="writing-input-label">不适用范围<input className="field" value={state.scopeOut} disabled={locked} onChange={e => patch({ scopeOut: e.target.value })} /></label></div><div className="writing-divided"><div className="kv"><span>可见范围</span><span>沿用「{context.store.name}」权限</span><span>审核人</span><span>{state.reviewerName} · 知识库维护者</span><span>发布版本</span><span>v{(state.published?.version ?? 0) + (state.stage === 'published' ? 0 : 1)}</span></div></div>{dirty && <button className="btn" onClick={() => void perform('save')}>保存修改后继续审核</button>}{state.stage === 'pending-review' && <button className="btn" disabled={busy} onClick={() => void perform('withdraw')}>撤回审核</button>}{state.stage === 'published' && <button className="btn" onClick={() => void perform('edit')}>编辑下一版</button>}<button className="btn ghost" onClick={() => setStepOverride(2)}><ArrowLeft size={13} />返回正文</button></section><section className="writing-preview"><div className="writing-section-heading"><span className="cap">读者首屏预览</span><span className="tag t-l">{state.stage === 'published' ? '已发布' : '待发布'}</span></div><div className="writing-preview-frame"><div className="pvf"><span className="cap">{state.authorName} · 审核人 {state.reviewerName}</span><h1>{state.title || '未命名文档'}</h1>{state.conclusions.length ? <ol>{state.conclusions.filter(Boolean).map((c, i) => <li key={i}>{c}</li>)}</ol> : <p className="hint">尚未填写首屏结论，请从正文核实后补充。</p>}<div className="scope"><div className="note ac"><div>适用<p>{state.scopeIn || '尚未说明'}</p></div></div><div className="note am"><div>不适用<p>{state.scopeOut || '尚未说明'}</p></div></div></div>{state.roles.map(role => <div className="act" key={role.label}><strong>{role.label}</strong><div>{role.action}{role.condition && <p className="cond">条件：{role.condition}</p>}</div></div>)}<p>{state.summary}</p></div></div><WritingLearningEditor state={state} disabled={locked} onChange={patch} /><section className="panel writing-media-settings"><h3 className="h3"><Play size={14} /> 教学素材</h3><p className="hint">关联本知识库中的真实视频；图文步骤随发布文档提供。</p><select className="field" value={state.videoEntryId ?? ''} disabled={locked} onChange={e => patch({ videoEntryId: e.target.value })}><option value="">暂不关联视频</option>{context.sources.filter(s => s.contentType.startsWith('video/')).map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select><Link className="btn ghost sm" to="/video-agent">打开视频创作</Link></section></section></div>}
      </fieldset>
    </main>
    {selectedSource && step !== 2 && <aside className="writing-bottom-sheet" role="dialog" aria-label="来源原文"><button className="btn" onClick={() => setSourceId(undefined)}>关闭</button><h2>{selectedSource.title}</h2><p>{selectedSource.content}</p></aside>}
  </div>;
}

export type { WritingParagraph, WritingSource };
