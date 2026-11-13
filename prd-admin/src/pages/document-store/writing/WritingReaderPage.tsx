import { WritingLogo } from './WritingLogo';
import { WritingSectionConstraints } from './WritingSectionConstraints';
import { WritingMobileToc } from './WritingMobileToc';
import { WritingThreads } from './WritingThreads';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BookOpen, ChevronLeft, ChevronRight, ExternalLink, Check, Play, Pause, RotateCcw, RotateCw, ChevronDown, X } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { MarkdownViewer } from '@/components/file-preview/MarkdownViewer';
import { readWriting } from '@/services/real/writing';
import { getDocumentContent } from '@/services/real/documentStore';
import type { WritingReader, WritingSource } from '@/services/contracts/writing';
import { WritingThemeButton } from './WritingWorkspacePage';
import { roleReadingSections, writingKnowledgeHref, writingSourceHasSnapshot, writingSourceSnapshotDate } from './writingView';
import './writingTutorial.css';

export function WritingReaderPage({ storeId, entryId, tutorial }: { storeId: string; entryId: string; tutorial: boolean }) {
  const navigate = useNavigate();
  const [data, setData] = useState<WritingReader>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [bodyLoading, setBodyLoading] = useState(false);
  const [bodyFailure, setBodyFailure] = useState('');
  const [role, setRole] = useState('');
  const [current, setCurrent] = useState('top');
  const [visited, setVisited] = useState<string[]>([]);
  const [source, setSource] = useState<WritingSource>();
  const [sourceQuote, setSourceQuote] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [videoFailure, setVideoFailure] = useState('');
  const [mediaReady, setMediaReady] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [videoAttempt, setVideoAttempt] = useState(0);
  const [mobileVideo, setMobileVideo] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [preferDefaultVideo, setPreferDefaultVideo] = useState(false);
  const [caption, setCaption] = useState(true);
  const [subtitleTab, setSubtitleTab] = useState(false);
  const [followCaption, setFollowCaption] = useState(true);
  const [doneSteps, setDoneSteps] = useState<string[]>([]);
  const [chapterIndex, setChapterIndex] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const durationMedia = useRef<HTMLVideoElement>(null);
  const textArea = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const closeTrigger = useRef<HTMLButtonElement | null>(null);
  const readGeneration = useRef(0);
  const captionsRef = useRef<HTMLElement>(null);
  const stepsRef = useRef<HTMLElement>(null);
  const previousMedia = useRef<{ publication: string; id?: string }>({ publication: '' });
  const pendingPlayback = useRef<{ time: number; rate: number; playing: boolean; duration: number }>();
  const mediaGeneration = useRef(0);
  const decodedGeneration = useRef(-1);
  const publicationKey = data ? `${entryId}:v${data.publication.version}` : '';
  const defaultVideoId = data?.publication.videoEntryId;
  const selectedVideoId = mobileVideo && !preferDefaultVideo ? data?.publication.mobileVideoEntryId || defaultVideoId : defaultVideoId;
  const usingMobileVideo = !!selectedVideoId && selectedVideoId !== defaultVideoId;
  const loadBody = useCallback(async (id: string, version: number, generation: number) => {
    setBodyLoading(true); setBodyFailure('');
    const result = await readWriting(id, { version });
    if (generation !== readGeneration.current) return;
    setBodyLoading(false);
    if (result.success) {
      if (result.data.publication.version !== version || result.data.bodyPending) {
        setBodyFailure('正文版本与概要不一致，请重新加载文档');
      } else setData(result.data);
    } else if (['DISCONNECTED', 'NETWORK_ERROR', 'SERVER_ERROR', 'SERVER_UNAVAILABLE', 'INTERNAL_ERROR'].includes(result.error.code)) {
      setBodyFailure(result.error.message);
    } else {
      setData(undefined); setSource(undefined); setError(result.error.message);
    }
  }, []);
  const fetchData = useCallback(async () => {
    const generation = ++readGeneration.current;
    setLoading(true); setError(''); setData(undefined); setVideoUrl(''); setVideoFailure(''); setTime(0); setDuration(0); setPlaying(false); setStarted(false); setChapterIndex(0); setVisited([]); setSource(undefined);
    setBodyLoading(false); setBodyFailure('');
    const result = tutorial ? await readWriting(entryId) : await readWriting(entryId, { overview: true });
    if (generation !== readGeneration.current) return;
    if (result.success) { setData(result.data); setRole(result.data.publication.roles[0]?.label ?? ''); }
    else setError(result.error.message);
    setLoading(false);
    if (result.success && result.data.bodyPending) await loadBody(entryId, result.data.publication.version, generation);
  }, [entryId, tutorial, loadBody]);
  useEffect(() => { const generation = readGeneration; void fetchData(); return () => { generation.current++; }; }, [fetchData]);
  useEffect(() => { setTime(0); setStarted(false); setPlaying(false); setChapterIndex(0); setDuration(0); setSpeed(1); }, [tutorial]);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const changed = (event: MediaQueryListEvent) => setMobileVideo(event.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  useEffect(() => { setPreferDefaultVideo(false); }, [mobileVideo, entryId, data?.publication.version]);
  useEffect(() => {
    const previous = previousMedia.current;
    const media = video.current;
    const decoded = decodedGeneration.current === mediaGeneration.current && media && Number.isFinite(media.duration);
    mediaGeneration.current++;
    const switching = previous.publication === publicationKey && previous.id && selectedVideoId && previous.id !== selectedVideoId;
    pendingPlayback.current = switching
      ? decoded ? { time: media.currentTime, rate: media.playbackRate, playing: !media.paused, duration: media.duration } : pendingPlayback.current
      : undefined;
    previousMedia.current = { publication: publicationKey, id: selectedVideoId };
    setVideoUrl(''); setVideoFailure('');
    setMediaReady(false);
    setPlaying(false);
    if (!selectedVideoId) return;
    let disposed = false;
    void getDocumentContent(selectedVideoId).then(result => {
      if (disposed) return;
      if (result.success && result.data.fileUrl) setVideoUrl(result.data.fileUrl);
      else setVideoFailure(result.success ? '视频文件暂不可用' : result.error.message);
    });
    return () => { disposed = true; };
  }, [selectedVideoId, publicationKey, videoAttempt]);
  useEffect(() => {
    if (!source) return;
    dialog.current?.focus();
    dialog.current?.querySelector('mark')?.scrollIntoView({ block: 'center' });
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setSource(undefined); closeTrigger.current?.focus(); } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [source]);
  useEffect(() => {
    if (!data) return;
    const key = `map-learning:${entryId}:v${data.publication.version}`;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
      setDoneSteps(Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === 'string'))] : []);
    } catch { setDoneSteps([]); }
  }, [entryId, data]);
  useEffect(() => {
    if (!data || data.bodyPending || loading || tutorial) return;
    const media = window.matchMedia('(max-width: 760px)');
    let observer: IntersectionObserver;
    const install = () => {
      observer?.disconnect();
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) {
          const id = (entry.target as HTMLElement).dataset.section;
          if (id) { setCurrent(id); setVisited(v => v.includes(id) ? v : [...v, id]); }
        }
      }, { root: media.matches ? null : textArea.current, rootMargin: '-5% 0px -65% 0px', threshold: 0 });
      textArea.current?.querySelectorAll('[data-section]').forEach(el => observer.observe(el));
    };
    install(); media.addEventListener('change', install);
    return () => { observer.disconnect(); media.removeEventListener('change', install); };
  }, [data, loading, tutorial]);
  useEffect(() => {
    if (!subtitleTab || !followCaption || !data?.publication.chapters.length) return;
    const step = (data.publication.captions?.length ? data.publication.captions : data.publication.chapters.flatMap(c => c.steps)).filter(s => s.at <= time).at(-1);
    if (step) captionsRef.current?.querySelector(`[data-step-id="${CSS.escape(step.id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [time, subtitleTab, followCaption, data]);
  if (loading) return <div className="writing-reader writing-root"><MapSectionLoader text="正在读取已发布文档…" /></div>;
  if (!data) return <div className="writing-reader writing-root"><div className="writing-error" role="alert"><h1>文档暂不可读</h1><p>{error}</p><button className="btn" onClick={() => void fetchData()}>重试</button><Link className="btn" to={writingKnowledgeHref(storeId)}>返回知识库</Link></div></div>;
  const doc = data.publication;
  const bodyPending = !!data.bodyPending;
  const readingSections = roleReadingSections(doc.sections, doc.roles.find(r => r.label === role));
  const go = (id: string) => { if (bodyPending && id !== 'top') return; setCurrent(id); setVisited(v => v.includes(id) ? v : [...v, id]); textArea.current?.querySelector(`[data-section="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); };
  const openSource = (id: string, trigger: HTMLButtonElement, quote = '') => { setSourceQuote(quote); setSource(doc.sources.find(s => s.id === id)); closeTrigger.current = trigger; };
  const peers = data.entries; const index = peers.findIndex(e => e.id === entryId);
  const chapters = doc.chapters.length ? doc.chapters : doc.sections.map(s => ({ id: s.id, title: s.title, start: 0,
    steps: s.paragraphs.filter(p => !['ask', 'conf'].includes(p.status)).map(p => ({ id: p.id, text: p.text, condition: '', at: 0 })) }));
  const chapter = chapters[Math.min(chapterIndex, chapters.length - 1)];
  // Only derived chapters have an exact source section. Custom chapters have no section mapping.
  const chapterSection = !doc.chapters.length ? doc.sections.find(section => section.id === chapter?.id) : undefined;
  const currentStepIndex = doc.chapters.length && videoUrl && mediaReady && !videoFailure
    ? chapter?.steps.reduce((last, step, i) => time >= step.at ? i : last, 0) ?? 0 : -1;
  const mediaLoading = !!selectedVideoId && !videoUrl && !videoFailure;
  const allSteps = chapters.flatMap(c => c.steps);
  const allCaptions = doc.captions?.length ? doc.captions : allSteps;
  const hasTranscript = !!doc.captions?.length || !!selectedVideoId;
  const playMedia = (media: HTMLVideoElement) => {
    const generation = mediaGeneration.current;
    void media.play().catch(error => {
      if (generation !== mediaGeneration.current || media !== video.current || error?.name === 'AbortError') return;
      pendingPlayback.current = { time: media.currentTime, rate: media.playbackRate, playing: false, duration: media.duration };
      setVideoFailure('视频播放失败，可以重试或继续查看图文步骤');
    });
  };
  const togglePlay = () => { if (!video.current || !mediaReady) return; if (video.current.paused) playMedia(video.current); else video.current.pause(); };
  const seek = (value: number) => {
    if (!selectedVideoId || videoFailure || !Number.isFinite(value)) return;
    setStarted(true);
    if (!video.current || !mediaReady) {
      const resume = pendingPlayback.current;
      pendingPlayback.current = { time: Math.max(0, value), rate: resume?.rate ?? speed, playing: resume?.playing ?? false, duration: resume?.duration ?? 0 };
      setTime(Math.max(0, value)); return;
    }
    video.current.currentTime = Math.max(0, Math.min(value, duration || value));
  };
  const pickChapter = (i: number) => { setChapterIndex(i); if (doc.chapters.length) seek(chapters[i].start); };
  const toggleDone = (id: string) => {
    const next = doneSteps.includes(id) ? doneSteps.filter(x => x !== id) : [...doneSteps, id]; setDoneSteps(next);
    try { localStorage.setItem(`map-learning:${entryId}:v${doc.version}`, JSON.stringify(next)); } catch { /* 阅读仍可继续 */ }
  };
  const formatted = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
  return <div className={`${tutorial ? 'writing-tutorial' : 'writing-reader'} writing-root${tutorial && !selectedVideoId ? ' writing-graphic-tutorial' : ''}`} data-writing-page={tutorial ? 'tutorial' : 'reader'}><WritingThreads />
    <header className="writing-mobile-header"><Link to={writingKnowledgeHref(storeId)} aria-label="返回知识库"><ChevronLeft size={20} /></Link><div><strong>{tutorial ? '教学' : data.template?.type ?? '文档'}</strong><span>合集 · {data.store.name} · {index + 1} / {peers.length}</span></div><WritingThemeButton /></header><header className="writing-top writing-desktop-top"><div className="writing-breadcrumb"><Link to={writingKnowledgeHref(storeId)}><WritingLogo /></Link><Link to="/document-store">团队知识库</Link><span>/</span><Link to={writingKnowledgeHref(storeId)}>合集 · {data.store.name}</Link><span>/</span><span>{tutorial ? '教学' : doc.title}</span></div><div className="writing-actions">{tutorial ? <><Link className="btn ghost" to={writingKnowledgeHref(storeId, entryId)}>打开需求说明原文</Link><WritingThemeButton /></> : <><span className="mono">版本 v{doc.version}</span>{data.canEdit && <Link className="btn ghost" to={`/document-store/${storeId}/write/${entryId}`}>作者工作区</Link>}<WritingThemeButton /><button className="btn" onClick={() => navigate(writingKnowledgeHref(storeId, entryId))}>打开原文 <ExternalLink size={12} /></button></>}</div></header>
    {!tutorial && videoUrl && <video ref={durationMedia} key={videoUrl} hidden aria-hidden src={videoUrl} preload="metadata" onLoadedMetadata={e => { if (e.currentTarget !== durationMedia.current) return; const value = e.currentTarget.duration; setDuration(Number.isFinite(value) && value > 0 ? value : 0); }} onError={e => { if (e.currentTarget === durationMedia.current) setDuration(0); }} />}
    <div className="writing-mobile-tabs"><Link className={!tutorial ? 'on' : ''} to={`/document-store/${storeId}/write/${entryId}/read`}>阅读</Link><Link className={tutorial ? 'on' : ''} to={`/document-store/${storeId}/write/${entryId}/learn`}>教学{duration >= 60 ? ` · ${Math.floor(duration / 60)} 分钟` : ''}</Link></div>
    {data.affectedSources.length > 0 && <div className="writing-banner" role="status">引用资料有更新，待作者复核：{data.affectedSources.join('、')}。当前显示已发布的 v{doc.version}。</div>}
    {!tutorial ? <div className="writing-reader-layout">
      <aside className="writing-reader-toc scroll"><div className="cap">目录 · 已读 {visited.filter(id => id !== 'top').length} / {doc.sections.length} 节</div><nav className="toc" aria-label="文档目录"><button className={current === 'top' ? 'cur' : ''} onClick={() => go('top')}><span className="mono">00</span>结论与下一步<span className="dot" /></button>{doc.sections.map((s, i) => <button disabled={bodyPending} className={current === s.id ? 'cur' : ''} onClick={() => go(s.id)} key={s.id}><span className="mono">{String(i + 1).padStart(2, '0')}</span>{s.title}<span className={`dot ${visited.includes(s.id) ? 'v' : ''}`} /></button>)}</nav>{role && <div className="writing-divided"><div className="cap">按角色 · {role}</div>{readingSections.map((s, i) => <button className="btn ghost" disabled={bodyPending} key={s.id} onClick={() => go(s.id)}><span className="mono">{i + 1}</span>{s.title}</button>)}</div>}</aside>
      <main className="writing-reader-body scroll" ref={textArea} onScroll={() => {
        const parent = textArea.current; if (!parent) return;
        const hit = [...parent.querySelectorAll<HTMLElement>('[data-section]')].filter(el => el.getBoundingClientRect().top < parent.getBoundingClientRect().top + parent.clientHeight * .4).at(-1);
        const id = hit?.dataset.section; if (id && id !== current) { setCurrent(id); setVisited(v => v.includes(id) ? v : [...v, id]); }
      }}><article className="art"><div data-section="top"><div className="writing-reader-meta"><span className="tag t-l">{data.template?.type ?? '文档'}</span><span className="mono">v{doc.version} · {doc.authorName} · {doc.reviewerName} 审核 · {new Date(doc.publishedAt).toLocaleDateString('zh-CN')}</span></div><h1 className="writing-reader-title">{doc.title}</h1><div className="cap writing-mb">结论</div>{doc.conclusions.length ? <ol className="writing-conclusions">{doc.conclusions.filter(Boolean).map((c, i) => <li key={i}>{c}</li>)}</ol> : <p>{doc.summary || '正文开头：' + (doc.sections[0]?.paragraphs[0]?.text.slice(0, 60) ?? '')}</p>}<div className="writing-scope-grid"><div className="writing-scope-in"><span className="cap">适用</span><div>{doc.scopeIn || '原文未单独说明，请结合正文判断。'}</div></div><div className="writing-scope-out"><span className="cap">不适用</span><div>{doc.scopeOut || '原文未单独说明。'}</div></div></div>{doc.roles.length > 0 && <section className="writing-actions-panel"><div className="writing-role-heading"><strong>下一步</strong><div role="radiogroup" aria-label="我是"><span className="hint">我是 </span>{doc.roles.map(r => <button className="role" role="radio" aria-checked={r.label === role} onClick={() => setRole(r.label)} key={r.label}>{r.label}</button>)}</div></div>{[...doc.roles].sort((a, b) => Number(b.label === role) - Number(a.label === role)).map(r => <div className={`act ${r.label === role ? 'on' : ''}`} key={r.label}><button className="who" disabled={bodyPending} aria-label={`跳转到${doc.sections.find(s => s.id === r.sectionId)?.title ?? '对应章节'}，${r.label}`} onClick={() => go(r.sectionId)}>{r.label}</button><div className="what">{r.action}{r.condition && <div className="cond"><span className="tag t-c">条件</span>{r.condition}</div>}</div><button className="btn ghost sm" disabled={bodyPending} onClick={() => go(r.sectionId)}>{doc.sections.find(s => s.id === r.sectionId)?.title}<ChevronRight size={12} /></button></div>)}</section>}<div className="writing-reading-order"><span className="hint">{role}建议按这个顺序读</span>{readingSections.map((s, i) => <button className="ord" disabled={bodyPending} onClick={() => go(s.id)} key={s.id}><span className="n">{i + 1}</span>{s.title}</button>)}<Link className="btn ghost" to={`/document-store/${storeId}/write/${entryId}/learn`}>{duration >= 60 ? `或看 ${Math.floor(duration / 60)} 分钟教学` : '开始学习'}</Link></div></div>
        <WritingMobileToc sections={doc.sections} visited={visited} onGo={go} disabled={bodyPending} />
        {bodyPending ? <section className="sec writing-reader-body-state" aria-label="正文加载状态" role={bodyLoading ? 'status' : 'alert'} aria-live="polite" aria-busy={bodyLoading}>
          {bodyLoading ? <>
            <p className="hint">正在加载正文与来源复核。上方的结论、适用范围和下一步已可阅读。</p>
            <div className="writing-body-skeleton-desktop" aria-hidden>{[[40, 20], [100, 14], [100, 14], [82, 14], [36, 20], [100, 14], [90, 14]].map(([width, height], i) => <div className="sk" key={i} style={{ width: `${width}%`, height, ...(i === 4 ? { marginTop: 26 } : {}) }} />)}</div>
            <div className="writing-body-skeleton-mobile" aria-hidden>{[[45, 18], [100, 14], [100, 14], [70, 14]].map(([width, height], i) => <div className="sk" key={i} style={{ width: `${width}%`, height }} />)}</div>
          </> : <div className="callout"><span>正文暂未载入。{bodyFailure} 以上概要来自已发布的 v{doc.version}；来源更新状态尚未复核。<span className="writing-body-retry"><button className="btn sm" onClick={() => void loadBody(entryId, doc.version, readGeneration.current)}>重试正文</button><button className="btn sm ghost" onClick={() => void fetchData()}>重新加载文档</button></span></span></div>}
        </section> : <>
        {doc.sections.map((s, i) => <section className="sec" data-section={s.id} key={s.id}><h2><span className="mono">{String(i + 1).padStart(2, '0')}</span>{s.title}</h2>{s.paragraphs.map(p => <div key={p.id}><MarkdownViewer compact content={p.text} /></div>)}<WritingSectionConstraints section={s} /><div className="srcs">{[...new Set(s.paragraphs.flatMap(p => p.citations))].map(id => <button className="sc" key={id} onClick={e => openSource(id, e.currentTarget, s.paragraphs.find(p => p.quotes?.[id])?.quotes?.[id] ?? '')}>{id} · {doc.sources.find(source => source.id === id)?.title}</button>)}</div></section>)}
        </>}

        {doc.openQuestions.length > 0 && <section className="sec"><h2>待确认事项</h2>{doc.openQuestions.map(q => <p key={q.id}>{q.title}：{q.answer}</p>)}</section>}
      </article></main>
      <aside className="writing-reader-info scroll"><div><div className="cap writing-mb">这份文档</div><div className="kv"><span>版本</span><span>v{doc.version} · {new Date(doc.publishedAt).toLocaleDateString('zh-CN')} 发布</span><span>审核</span><span>{doc.reviewerName}</span><span>作者</span><span>{doc.authorName}</span><span>可见</span><span>沿用知识库权限</span></div></div><div><div className="cap">来源 · {doc.sources.length} 份</div>{doc.sources.map(s => <button className="srow" disabled={bodyPending} key={s.id} onClick={e => openSource(s.id, e.currentTarget)}><span className="sid">{s.id}</span><span><span className="cl1 writing-block">{s.title}</span><span className="hint">{bodyPending ? '来源快照尚未载入' : writingSourceHasSnapshot(s) ? `${writingSourceSnapshotDate(s) ?? '更新时间未记录'} · 发布时快照` : '该版本未保存原文快照'}</span></span></button>)}</div><div className="panel writing-learning-card"><div className="cap">教学</div><strong>{doc.title}</strong><p className="hint">章节、操作步骤与字幕，适合培训和第一次操作。</p><Link className="btn pri sm" to={`/document-store/${storeId}/write/${entryId}/learn`}>开始学习</Link></div><div><div className="cap">合集 · {data.store.name} · {index + 1} / {peers.length}</div>{index > 0 && <Link className="btn ghost writing-block" to={`/document-store/${storeId}/write/${peers[index - 1].id}/read`}>上一篇 · {peers[index - 1].title}</Link>}{index >= 0 && index < peers.length - 1 && <Link className="btn ghost writing-block" to={`/document-store/${storeId}/write/${peers[index + 1].id}/read`}>下一篇 · {peers[index + 1].title}</Link>}</div></aside>
    </div> : <div className="writing-tutorial-layout"><main className="scroll writing-tutorial-body"><div className="writing-tutorial-heading"><div><div className="cap">第 {chapterIndex + 1} / {chapters.length} 章{chapter && selectedVideoId && ` · ${formatted(chapter.start)}–${formatted(chapters[chapterIndex + 1]?.start ?? duration)}`}</div><h1 className="writing-tutorial-title">{chapter?.title ?? doc.title}</h1></div><span className="hint">{doc.title}{selectedVideoId && <> · 共 {duration ? `${Math.floor(duration / 60)} 分 ${Math.floor(duration % 60)} 秒` : '—'}</>}</span></div><div className="player" tabIndex={selectedVideoId ? 0 : -1} aria-label={selectedVideoId ? '教学视频' : '图文教学'} onKeyDown={e => { if ((e.target as HTMLElement).closest('input,textarea,select')) return; if ([' ', 'k', 'K'].includes(e.key)) { e.preventDefault(); togglePlay(); } if (e.key === 'ArrowLeft') { e.preventDefault(); seek(time - 5); } if (e.key === 'ArrowRight') { e.preventDefault(); seek(time + 5); } if (e.key.toLowerCase() === 'c') setCaption(v => !v); const n = Number(e.key); if (n > 0 && n <= chapters.length) pickChapter(n - 1); }}>
      {videoUrl && !videoFailure ? <video ref={video} src={videoUrl} preload="metadata" playsInline onPlay={() => { setPlaying(true); setStarted(true); }} onPause={() => setPlaying(false)} onError={e => { const media = e.currentTarget; if (decodedGeneration.current === mediaGeneration.current) pendingPlayback.current = { time: media.currentTime, rate: media.playbackRate, playing: false, duration: media.duration }; setMediaReady(false); setVideoFailure('视频加载失败，可以继续查看图文步骤'); }} onLoadedMetadata={e => {
        const media = e.currentTarget; if (media !== video.current) return;
        const resume = pendingPlayback.current;
        const lastChapterAt = doc.chapters.reduce((last, chapter) => chapter.steps.reduce((at, step) => Math.max(at, step.at), Math.max(last, chapter.start)), 0);
        const lastAt = allCaptions.reduce((last, caption) => Math.max(last, caption.at), lastChapterAt);
        if (!Number.isFinite(media.duration) || media.duration <= 0) { setVideoFailure('视频文件没有可用时长，可以重试或查看图文步骤'); return; }
        if (usingMobileVideo && resume && resume.duration > 0 && Number.isFinite(resume.duration) && Math.abs(media.duration - resume.duration) > .5) {
          setVideoFailure('手机视频与默认视频时长不一致，请改用默认视频或核对课程时间轴'); return;
        }
        if (lastAt > media.duration + .5) { setVideoFailure('教学素材时长不一致：无法覆盖已发布的章节、步骤与字幕'); return; }
        decodedGeneration.current = mediaGeneration.current; setMediaReady(true);
        setDuration(media.duration); media.playbackRate = resume?.rate ?? speed;
        if (resume) {
          media.currentTime = Math.max(0, Math.min(resume.time, media.duration)); setTime(media.currentTime); setSpeed(resume.rate);
          pendingPlayback.current = undefined;
          if (resume.playing) playMedia(media);
        }
      }} onTimeUpdate={e => { const at = e.currentTarget.currentTime; setTime(at); if (at > 0) setStarted(true); if (doc.chapters.length) { const i = chapters.reduce((last, c, i) => c.start <= at ? i : last, -1); if (i >= 0) setChapterIndex(i); } }} /> : <div className="ov"><BookOpen size={34} />{mediaLoading ? <MapSectionLoader text="正在加载教学视频…" /> : <><strong>{videoFailure || '图文教学 · 当前屏幕未关联视频'}</strong><p>图文步骤仍可查看，完成后勾选「我做完了」。</p>{videoFailure && <div className="writing-video-recovery"><button className="btn" onClick={() => { setTime(0); setChapterIndex(0); setStarted(false); setPlaying(false); setVideoAttempt(value => value + 1); }}>重试视频</button>{usingMobileVideo && defaultVideoId && <button className="btn" onClick={() => setPreferDefaultVideo(true)}>使用默认视频</button>}<button className="btn ghost" onClick={() => stepsRef.current?.scrollIntoView({ block: 'start' })}>继续查看图文步骤</button></div>}</>}</div>}
      {videoUrl && !mediaReady && !videoFailure && <div className="ov" role="status"><MapSectionLoader text="正在读取视频信息…" /></div>}{videoUrl && mediaReady && !started && !videoFailure && <button className="writing-play-overlay" onClick={togglePlay} aria-label="播放教学视频"><span className="writing-play-circle"><Play size={22} fill="currentColor" /></span><span>播放{duration ? ` · ${Math.floor(duration / 60)} 分 ${Math.floor(duration % 60)} 秒` : ''}，默认显示字幕</span></button>}{caption && started && videoUrl && mediaReady && !videoFailure && <div className="capbox">{allCaptions.filter(s => s.at <= time).at(-1)?.text}</div>}</div>
{selectedVideoId && <><div className="writing-player-controls">
  <button className="btn pri writing-control-play" disabled={!videoUrl || !mediaReady || !!videoFailure} aria-label={playing ? '暂停' : '播放'} onClick={togglePlay}>{playing ? <Pause size={14} /> : <Play size={14} fill="currentColor" />}</button>
  <button className="btn writing-control-back" disabled={!videoUrl || !mediaReady || !!videoFailure} aria-label="后退5秒" onClick={() => seek(time - 5)}><RotateCcw size={15} /></button>
  <button className="btn writing-control-forward" disabled={!videoUrl || !mediaReady || !!videoFailure} aria-label="前进5秒" onClick={() => seek(time + 5)}><RotateCw size={15} /></button>
  <span className="mono writing-player-time">{formatted(time)} / {duration ? formatted(duration) : '—'}</span>
  <div className="writing-player-progress">
    <input className="writing-accessible-seek" type="range" aria-label="播放进度" min="0" max={duration || 1} step=".1" value={time} disabled={!videoUrl || !mediaReady || !!videoFailure} onChange={e => seek(Number(e.target.value))} />
    <div className="tl writing-timeline" role="group" aria-label="按章节播放进度">{chapters.map((c, i) => { const end = chapters[i + 1]?.start ?? duration; const length = Math.max(0, end - c.start); const percent = length ? Math.max(0, Math.min(100, (time - c.start) / length * 100)) : 0; return <button key={c.id} disabled={!videoUrl || !mediaReady || !!videoFailure || !duration || c.start >= duration} aria-label={`跳到${c.title}`} title={c.title} style={{ flex: length || 1 }} onClick={() => seek(c.start)}><svg width="100%" height="8" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect className="fill" width={percent} height="8" /></svg></button>; })}</div>
  </div>
  <button className="btn sm writing-control-captions" aria-pressed={caption} onClick={() => setCaption(value => !value)}>字幕</button>
  <div className="seg writing-control-speed" role="group" aria-label="播放倍速">{[1, 1.25, 1.5].map(rate => <button key={rate} aria-pressed={speed === rate} disabled={!videoUrl || !mediaReady || !!videoFailure} onClick={() => { setSpeed(rate); if (video.current) video.current.playbackRate = rate; }}>{rate}×</button>)}</div>
</div>
<div className="mono writing-player-meta">{formatted(time)} / {duration ? formatted(duration) : '—'} · 键盘：空格 播放，← → 5 秒，C 字幕</div>
<div className="hint writing-keyboard-hint"><span>键盘（先聚焦视频）</span><span><kbd>空格</kbd> 播放 / 暂停</span><span><kbd>←</kbd> <kbd>→</kbd> 后退 / 前进 5 秒</span><span><kbd>C</kbd> 字幕</span><span><kbd>1</kbd>–<kbd>{chapters.length}</kbd> 跳到章节</span></div></>}
      <nav className="writing-mobile-chapters" aria-label="教学章节">{chapters.map((c, i) => <button className="role" aria-pressed={i === chapterIndex} key={c.id} onClick={() => pickChapter(i)}><span className="mono">{String(i + 1).padStart(2, '0')}</span><span title={c.title}>{c.title.split('：')[0]}</span></button>)}</nav><section className="panel writing-tutorial-steps" ref={stepsRef}><div className="writing-step-heading"><strong>操作步骤<span className="writing-desktop-step-count"> · 本章 {chapter?.steps.length ?? 0} 步</span></strong><span className="cap">已完成 {allSteps.filter(s => doneSteps.includes(s.id)).length} / {allSteps.length}</span></div>{chapterSection && <WritingSectionConstraints key={chapterSection.id} section={chapterSection} />}{chapter?.steps.map((s, i) => <div className={`writing-tutorial-step ${i === currentStepIndex ? 'current' : ''}`} aria-current={i === currentStepIndex ? 'step' : undefined} key={s.id}>
  <span className={`sid ${doneSteps.includes(s.id) ? 'done' : i === currentStepIndex ? 'current' : ''}`}>{i + 1}</span>
  <div className="writing-step-content"><p>{s.text}</p>{s.condition && <div className="cond"><span className="tag t-c">条件</span><span>{s.condition}</span></div>}</div>
  <div className="writing-step-actions">{selectedVideoId && doc.chapters.length > 0 && <button className="btn sm writing-step-time" disabled={!videoUrl || !mediaReady || !!videoFailure} onClick={() => seek(s.at)}><span>{formatted(s.at)}</span><span>处</span></button>}<button className="btn sm writing-done-step" role="checkbox" aria-checked={doneSteps.includes(s.id)} onClick={() => toggleDone(s.id)}><span className={`ck ${doneSteps.includes(s.id) ? 'on' : ''}`}>{doneSteps.includes(s.id) && <Check size={10} />}</span>我做完了</button></div>
</div>)}</section>{hasTranscript && <details className="panel writing-mobile-transcript" open={subtitleTab} onToggle={e => setSubtitleTab(e.currentTarget.open)}><summary><span>字幕全文 · {allCaptions.length} 句</span><ChevronDown size={14} /></summary>{allCaptions.map(s => <button className="writing-caption-row" aria-current={allCaptions.filter(x => x.at <= time).at(-1)?.id === s.id ? 'true' : undefined} key={s.id} onClick={() => seek(s.at)}><span className="mono">{formatted(s.at)}</span><span>{s.text}</span></button>)}</details>}
      </main><aside className="panel scroll writing-chapter-list" ref={captionsRef}><div className="writing-step-heading"><div className="seg"><button aria-pressed={!subtitleTab} onClick={() => setSubtitleTab(false)}>章节</button>{hasTranscript && <button aria-pressed={subtitleTab} onClick={() => setSubtitleTab(true)}>字幕全文</button>}</div>{hasTranscript && subtitleTab && <button className="btn ghost sm" aria-pressed={followCaption} onClick={() => setFollowCaption(v => !v)}>跟随播放</button>}</div>{!subtitleTab || !hasTranscript ? chapters.map((c, i) => <button className={`writing-chapter ${i === chapterIndex ? 'on' : ''}`} key={c.id} onClick={() => pickChapter(i)}><span className="mono">{String(i + 1).padStart(2, '0')}</span><span><strong>{c.title}</strong><span className="hint writing-block">{selectedVideoId && doc.chapters.length ? `${formatted(c.start)}–${chapters[i + 1]?.start ? formatted(chapters[i + 1].start) : duration > c.start ? formatted(duration) : '—'} · ` : ''}{c.steps.length} 步</span></span><span className={`tag ${doc.chapters.length > 0 && duration > 0 && time >= (chapters[i + 1]?.start ?? duration) ? 't-o' : i === chapterIndex ? 't-m' : 't-l'}`}>{!selectedVideoId ? i === chapterIndex ? '当前章节' : '图文步骤' : doc.chapters.length > 0 && duration > 0 && time >= (chapters[i + 1]?.start ?? duration) ? '已看完' : i === chapterIndex ? '正在看' : '未看'}</span></button>) : allCaptions.map(s => <button className="writing-caption-row" data-step-id={s.id} aria-current={allCaptions.filter(x => x.at <= time).at(-1)?.id === s.id ? 'true' : undefined} key={s.id} onClick={() => doc.chapters.length && seek(s.at)}>{doc.chapters.length > 0 && <span className="mono">{formatted(s.at)}</span>}<span>{s.text}</span></button>)}<div className="writing-learning-card"><div className="cap">看完以后</div><p className="hint">教学只讲操作。适用范围和例外以已发布原文为准：{doc.scopeIn || '请结合正文判断。'}</p><Link className="btn sm" to={`/document-store/${storeId}/write/${entryId}/read`}>打开需求说明 · 下一步</Link></div></aside></div>}
    {source && <div className="writing-dialog-scrim" onClick={() => setSource(undefined)}><aside className="writing-source-dialog panel scroll" role="dialog" aria-modal="true" aria-label="来源原文" tabIndex={-1} ref={dialog} onClick={e => e.stopPropagation()}><div className="writing-section-heading"><h2>{source.id} · {source.title}</h2><button className="btn ghost" aria-label="关闭来源原文" onClick={() => { setSource(undefined); closeTrigger.current?.focus(); }}><X size={16} /></button></div><p className="hint">{writingSourceHasSnapshot(source) ? `发布时的原文快照 · ${writingSourceSnapshotDate(source) ?? '更新时间未记录'}` : '该版本未保存原文快照'}</p>{!writingSourceHasSnapshot(source) ? <p role="status">该版本没有可核对的来源正文，请打开当前原文核对；当前内容可能与发布时不同。</p> : sourceQuote && source.content.includes(sourceQuote) ? <div className="writing-quoted-source">{source.content.slice(0, source.content.indexOf(sourceQuote))}<mark>{sourceQuote}</mark>{source.content.slice(source.content.indexOf(sourceQuote) + sourceQuote.length)}</div> : <MarkdownViewer content={source.content} />}<Link className="btn" target="_blank" to={writingKnowledgeHref(storeId, source.entryId)}>打开当前原文 <ExternalLink size={13} /></Link></aside></div>}
  </div>;
}
