import { WritingLogo } from './WritingLogo';
import { WritingThreads } from './WritingThreads';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BookOpen, ChevronLeft, ChevronRight, ExternalLink, Check, Play, Pause, RotateCcw, RotateCw, X } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { MarkdownViewer } from '@/components/file-preview/MarkdownViewer';
import { readWriting } from '@/services/real/writing';
import { getDocumentContent } from '@/services/real/documentStore';
import type { WritingReader, WritingSource } from '@/services/contracts/writing';
import { WritingThemeButton } from './WritingWorkspacePage';
import { roleReadingSections, writingKnowledgeHref } from './writingView';

export function WritingReaderPage({ storeId, entryId, tutorial }: { storeId: string; entryId: string; tutorial: boolean }) {
  const navigate = useNavigate();
  const [data, setData] = useState<WritingReader>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [role, setRole] = useState('');
  const [current, setCurrent] = useState('top');
  const [visited, setVisited] = useState<string[]>([]);
  const [source, setSource] = useState<WritingSource>();
  const [sourceQuote, setSourceQuote] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [videoFailure, setVideoFailure] = useState('');
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [caption, setCaption] = useState(true);
  const [subtitleTab, setSubtitleTab] = useState(false);
  const [followCaption, setFollowCaption] = useState(true);
  const [doneSteps, setDoneSteps] = useState<string[]>([]);
  const [chapterIndex, setChapterIndex] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const textArea = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const closeTrigger = useRef<HTMLButtonElement | null>(null);
  const readGeneration = useRef(0);
  const captionsRef = useRef<HTMLElement>(null);
  const fetchData = useCallback(async () => {
    const generation = ++readGeneration.current;
    setLoading(true); setError(''); setData(undefined); setVideoUrl(''); setVideoFailure(''); setTime(0); setDuration(0); setPlaying(false); setChapterIndex(0); setVisited([]); setSource(undefined);
    const result = await readWriting(entryId);
    if (generation !== readGeneration.current) return;
    if (result.success) { setData(result.data); setRole(result.data.publication.roles[0]?.label ?? ''); }
    else setError(result.error.message);
    setLoading(false);
  }, [entryId]);
  useEffect(() => { const generation = readGeneration; void fetchData(); return () => { generation.current++; }; }, [fetchData]);
  useEffect(() => { setTime(0); setPlaying(false); setChapterIndex(0); setDuration(0); setSpeed(1); }, [tutorial]);
  useEffect(() => {
    const videoId = data?.publication.videoEntryId;
    setVideoUrl(''); setVideoFailure('');
    if (!videoId) return;
    let disposed = false;
    void getDocumentContent(videoId).then(result => {
      if (disposed) return;
      if (result.success && result.data.fileUrl) setVideoUrl(result.data.fileUrl);
      else setVideoFailure(result.success ? '视频文件暂不可用' : result.error.message);
    });
    return () => { disposed = true; };
  }, [data?.publication.videoEntryId]);
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
    try { setDoneSteps(JSON.parse(localStorage.getItem(key) ?? '[]')); } catch { setDoneSteps([]); }
  }, [entryId, data]);
  useEffect(() => {
    if (!data || loading || tutorial) return;
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
  const readingSections = roleReadingSections(doc.sections, doc.roles.find(r => r.label === role));
  const go = (id: string) => { setCurrent(id); setVisited(v => v.includes(id) ? v : [...v, id]); textArea.current?.querySelector(`[data-section="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); };
  const openSource = (id: string, trigger: HTMLButtonElement, quote = '') => { setSourceQuote(quote); setSource(doc.sources.find(s => s.id === id)); closeTrigger.current = trigger; };
  const peers = data.entries; const index = peers.findIndex(e => e.id === entryId);
  const chapters = doc.chapters.length ? doc.chapters : doc.sections.map(s => ({ id: s.id, title: s.title, start: 0,
    steps: s.paragraphs.filter(p => !['ask', 'conf'].includes(p.status)).map(p => ({ id: p.id, text: p.text, condition: '', at: 0 })) }));
  const chapter = chapters[Math.min(chapterIndex, chapters.length - 1)];
  const allSteps = chapters.flatMap(c => c.steps);
  const allCaptions = doc.captions?.length ? doc.captions : allSteps;
  const togglePlay = () => { if (!video.current) return; if (video.current.paused) void video.current.play().catch(() => setVideoFailure('视频播放失败，可以继续查看图文步骤')); else video.current.pause(); };
  const seek = (value: number) => { if (video.current && Number.isFinite(value)) video.current.currentTime = Math.max(0, Math.min(value, duration || value)); };
  const pickChapter = (i: number) => { setChapterIndex(i); if (doc.chapters.length) seek(chapters[i].start); };
  const toggleDone = (id: string) => {
    const next = doneSteps.includes(id) ? doneSteps.filter(x => x !== id) : [...doneSteps, id]; setDoneSteps(next);
    try { localStorage.setItem(`map-learning:${entryId}:v${doc.version}`, JSON.stringify(next)); } catch { /* 阅读仍可继续 */ }
  };
  const formatted = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
  return <div className={`${tutorial ? 'writing-tutorial' : 'writing-reader'} writing-root`} data-writing-page={tutorial ? 'tutorial' : 'reader'}><WritingThreads />
    <header className="writing-mobile-header"><Link to={`/document-store/${storeId}/collection`} aria-label="返回合集"><ChevronLeft size={20} /></Link><div><strong>{tutorial ? '教学' : data.template?.type ?? '文档'}</strong><span>合集 · {data.store.name} · {index + 1} / {peers.length}</span></div><WritingThemeButton /></header><header className="writing-top writing-desktop-top"><div className="writing-breadcrumb"><Link to={writingKnowledgeHref(storeId)}><WritingLogo /></Link><Link to="/document-store">团队知识库</Link><span>/</span><Link to={`/document-store/${storeId}/collection`}>合集 · {data.store.name}</Link><span>/</span><span>{tutorial ? '教学' : doc.title}</span></div><div className="writing-actions"><span className="mono">版本 v{doc.version}</span>{data.canEdit && <Link className="btn ghost" to={`/document-store/${storeId}/write/${entryId}`}>作者工作区</Link>}<WritingThemeButton /><button className="btn" onClick={() => navigate(writingKnowledgeHref(storeId, entryId))}>打开原文 <ExternalLink size={12} /></button></div></header>
    <div className="writing-mobile-tabs"><Link className={!tutorial ? 'on' : ''} to={`/document-store/${storeId}/write/${entryId}/read`}>阅读</Link><Link className={tutorial ? 'on' : ''} to={`/document-store/${storeId}/write/${entryId}/learn`}>教学</Link></div>
    {data.affectedSources.length > 0 && <div className="writing-banner" role="status">引用资料有更新，待作者复核：{data.affectedSources.join('、')}。当前显示已发布的 v{doc.version}。</div>}
    {!tutorial ? <div className="writing-reader-layout">
      <aside className="writing-reader-toc scroll"><div className="cap">目录 · 已读 {visited.filter(id => id !== 'top').length} / {doc.sections.length} 节</div><nav className="toc" aria-label="文档目录"><button className={current === 'top' ? 'cur' : ''} onClick={() => go('top')}><span className="mono">00</span>结论与下一步<span className="dot" /></button>{doc.sections.map((s, i) => <button className={current === s.id ? 'cur' : ''} onClick={() => go(s.id)} key={s.id}><span className="mono">{String(i + 1).padStart(2, '0')}</span>{s.title}<span className={`dot ${visited.includes(s.id) ? 'v' : ''}`} /></button>)}</nav>{role && <div className="writing-divided"><div className="cap">按角色 · {role}</div>{readingSections.map((s, i) => <button className="btn ghost" key={s.id} onClick={() => go(s.id)}><span className="mono">{i + 1}</span>{s.title}</button>)}</div>}</aside>
      <main className="writing-reader-body scroll" ref={textArea} onScroll={() => {
        const parent = textArea.current; if (!parent) return;
        const hit = [...parent.querySelectorAll<HTMLElement>('[data-section]')].filter(el => el.getBoundingClientRect().top < parent.getBoundingClientRect().top + parent.clientHeight * .4).at(-1);
        const id = hit?.dataset.section; if (id && id !== current) { setCurrent(id); setVisited(v => v.includes(id) ? v : [...v, id]); }
      }}><article className="art"><div data-section="top"><div className="writing-reader-meta"><span className="tag t-l">{data.template?.type ?? '文档'}</span><span className="mono">v{doc.version} · {doc.authorName} · {doc.reviewerName} 审核 · {new Date(doc.publishedAt).toLocaleDateString('zh-CN')}</span></div><h1 className="writing-reader-title">{doc.title}</h1><div className="cap writing-mb">结论</div>{doc.conclusions.length ? <ol className="writing-conclusions">{doc.conclusions.filter(Boolean).map((c, i) => <li key={i}>{c}</li>)}</ol> : <p>{doc.summary || '正文开头：' + (doc.sections[0]?.paragraphs[0]?.text.slice(0, 60) ?? '')}</p>}<div className="writing-scope-grid"><div className="writing-scope-in"><span className="cap">适用</span><div>{doc.scopeIn || '原文未单独说明，请结合正文判断。'}</div></div><div className="writing-scope-out"><span className="cap">不适用</span><div>{doc.scopeOut || '原文未单独说明。'}</div></div></div>{doc.roles.length > 0 && <section className="writing-actions-panel"><div className="writing-role-heading"><strong>下一步</strong><div role="radiogroup" aria-label="我是"><span className="hint">我是 </span>{doc.roles.map(r => <button className="role" role="radio" aria-checked={r.label === role} onClick={() => setRole(r.label)} key={r.label}>{r.label}</button>)}</div></div>{[...doc.roles].sort((a, b) => Number(b.label === role) - Number(a.label === role)).map(r => <div className={`act ${r.label === role ? 'on' : ''}`} key={r.label}><div className="who">{r.label}</div><div className="what">{r.action}{r.condition && <div className="cond"><span className="tag t-c">条件</span>{r.condition}</div>}</div><button className="btn ghost sm" onClick={() => go(r.sectionId)}>{doc.sections.find(s => s.id === r.sectionId)?.title}<ChevronRight size={12} /></button></div>)}</section>}<div className="writing-reading-order"><span className="hint">建议按这个顺序读</span>{readingSections.map((s, i) => <button className="ord" onClick={() => go(s.id)} key={s.id}><span className="n">{i + 1}</span>{s.title}</button>)}<Link className="btn ghost" to={`/document-store/${storeId}/write/${entryId}/learn`}>开始学习</Link></div></div>
        {doc.sections.map((s, i) => <section className="sec" data-section={s.id} key={s.id}><h2><span className="mono">{String(i + 1).padStart(2, '0')}</span>{s.title}</h2>{s.paragraphs.map(p => <div key={p.id}><MarkdownViewer compact content={p.text} /></div>)}{s.condition && <div className="cond writing-section-condition"><span className="tag t-c">条件</span><span>{s.condition}</span></div>}{s.detail?.rows.length ? <details className="writing-reader-detail"><summary><span><span className="writing-detail-label">{s.detail.label}</span>{s.detail.rows.some(row => row[1] === '必填') && <span className="hint writing-block">必填 {s.detail.rows.filter(row => row[1] === '必填').length} 项：{s.detail.rows.filter(row => row[1] === '必填').map(row => row[0]).join('、')}。缺任何一项都不能提交。</span>}</span><span className="mono writing-expand-label">展开细节</span></summary><table><thead><tr>{s.detail.rows[0].map((_, i) => <th key={i}>{['字段','要求','说明'][i] ?? `内容 ${i + 1}`}</th>)}</tr></thead><tbody>{s.detail.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{j === 1 && ['必填', '选填'].includes(cell) ? <span className={`tag ${cell === '必填' ? 't-m' : 't-l'}`}>{cell}</span> : cell}</td>)}</tr>)}</tbody></table></details> : null}<div className="srcs">{[...new Set(s.paragraphs.flatMap(p => p.citations))].map(id => <button className="sc" key={id} onClick={e => openSource(id, e.currentTarget, s.paragraphs.find(p => p.quotes?.[id])?.quotes?.[id] ?? '')}>{id} · {doc.sources.find(source => source.id === id)?.title}</button>)}</div></section>)}
        {doc.openQuestions.length > 0 && <section className="sec"><h2>待确认事项</h2>{doc.openQuestions.map(q => <p key={q.id}>{q.title}：{q.answer}</p>)}</section>}
      </article></main>
      <aside className="writing-reader-info scroll"><div><div className="cap writing-mb">这份文档</div><div className="kv"><span>版本</span><span>v{doc.version} · {new Date(doc.publishedAt).toLocaleDateString('zh-CN')} 发布</span><span>审核</span><span>{doc.reviewerName}</span><span>作者</span><span>{doc.authorName}</span><span>可见</span><span>沿用知识库权限</span></div></div><div><div className="cap">来源 · {doc.sources.length} 份</div>{doc.sources.map(s => <button className="srow" key={s.id} onClick={e => openSource(s.id, e.currentTarget)}><span className="sid">{s.id}</span><span><span className="cl1 writing-block">{s.title}</span><span className="hint">{new Date(s.updatedAt).toLocaleDateString('zh-CN')} · 发布时快照</span></span></button>)}</div><div className="panel writing-learning-card"><div className="cap">教学</div><strong>{doc.title}</strong><p className="hint">章节、操作步骤与字幕，适合培训和第一次操作。</p><Link className="btn pri sm" to={`/document-store/${storeId}/write/${entryId}/learn`}>开始学习</Link></div><div><div className="cap">合集 · {data.store.name} · {index + 1} / {peers.length}</div>{index > 0 && <Link className="btn ghost writing-block" to={`/document-store/${storeId}/write/${peers[index - 1].id}/read`}>上一篇 · {peers[index - 1].title}</Link>}{index >= 0 && index < peers.length - 1 && <Link className="btn ghost writing-block" to={`/document-store/${storeId}/write/${peers[index + 1].id}/read`}>下一篇 · {peers[index + 1].title}</Link>}</div></aside>
    </div> : <div className="writing-tutorial-layout"><main className="scroll writing-tutorial-body"><div className="writing-tutorial-heading"><div><div className="cap">第 {chapterIndex + 1} / {chapters.length} 章{chapter && ` · ${formatted(chapter.start)}–${formatted(chapters[chapterIndex + 1]?.start ?? duration)}`}</div><h1 className="writing-tutorial-title">{chapter?.title ?? doc.title}</h1></div><span className="hint">{doc.title} · 共 {duration ? `${Math.floor(duration / 60)} 分 ${Math.floor(duration % 60)} 秒` : '—'}</span></div><div className="player" tabIndex={0} aria-label="教学视频" onKeyDown={e => { if ((e.target as HTMLElement).closest('input,textarea,select')) return; if ([' ', 'k', 'K'].includes(e.key)) { e.preventDefault(); togglePlay(); } if (e.key === 'ArrowLeft') { e.preventDefault(); seek(time - 5); } if (e.key === 'ArrowRight') { e.preventDefault(); seek(time + 5); } if (e.key.toLowerCase() === 'c') setCaption(v => !v); const n = Number(e.key); if (n > 0 && n <= chapters.length) pickChapter(n - 1); }}>
      {videoUrl && !videoFailure ? <video ref={video} src={videoUrl} preload="metadata" playsInline onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onError={() => setVideoFailure('视频加载失败，可以继续查看图文步骤')} onLoadedMetadata={e => setDuration(e.currentTarget.duration)} onTimeUpdate={e => { const at = e.currentTarget.currentTime; setTime(at); if (doc.chapters.length) { const i = chapters.reduce((last, c, i) => c.start <= at ? i : last, -1); if (i >= 0) setChapterIndex(i); } }} /> : <div className="ov"><BookOpen size={34} /><strong>{videoFailure || '此文档尚未关联教学视频'}</strong><p>图文步骤仍可查看，完成后勾选「我做完了」。</p></div>}
      {videoUrl && !playing && !videoFailure && <button className="writing-play-overlay" onClick={togglePlay} aria-label="播放教学视频"><span className="writing-play-circle"><Play size={22} fill="currentColor" /></span><span>播放{duration ? ` · ${Math.floor(duration / 60)} 分 ${Math.floor(duration % 60)} 秒` : ''}，默认显示字幕</span></button>}{caption && time > 0 && videoUrl && !videoFailure && <div className="capbox">{allCaptions.filter(s => s.at <= time).at(-1)?.text}</div>}</div>
<div className="writing-player-controls"><button className="btn pri" disabled={!videoUrl || !!videoFailure} aria-label={playing ? '暂停' : '播放'} onClick={togglePlay}>{playing ? <Pause size={13} /> : <Play size={13} />}</button><button className="btn" disabled={!videoUrl} aria-label="后退5秒" onClick={() => seek(time - 5)}><RotateCcw size={13} /></button><button className="btn" disabled={!videoUrl} aria-label="前进5秒" onClick={() => seek(time + 5)}><RotateCw size={13} /></button><span className="mono">{formatted(time)} / {duration ? formatted(duration) : '—'}</span><input className="writing-accessible-seek" type="range" aria-label="播放进度" min="0" max={duration || 1} step=".1" value={time} disabled={!videoUrl} onChange={e => seek(Number(e.target.value))} /><div className="tl writing-timeline" aria-label="按章节播放进度">{chapters.map((c, i) => { const end = chapters[i + 1]?.start ?? duration; const length = Math.max(0, end - c.start); const percent = length ? Math.max(0, Math.min(100, (time - c.start) / length * 100)) : 0; return <button key={c.id} disabled={!videoUrl || !duration || c.start >= duration} aria-label={`跳到${c.title}`} title={c.title} style={{ flex: length || 1 }} onClick={e => { const rect = e.currentTarget.getBoundingClientRect(); seek(c.start + Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * length); }}><svg width="100%" height="8" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect className="fill" width={percent} height="8" /></svg></button>; })}</div><button className="btn sm" aria-pressed={caption} onClick={() => setCaption(v => !v)}>字幕</button><div className="seg" role="group" aria-label="播放倍速">{[1, 1.25, 1.5].map(rate => <button key={rate} aria-pressed={speed === rate} disabled={!videoUrl} onClick={() => { setSpeed(rate); if (video.current) video.current.playbackRate = rate; }}>{rate}×</button>)}</div></div>
<div className="hint writing-keyboard-hint"><span>键盘（先聚焦视频）</span><span><kbd>空格</kbd> 播放 / 暂停</span><span><kbd>←</kbd> <kbd>→</kbd> 后退 / 前进 5 秒</span><span><kbd>C</kbd> 字幕</span><span><kbd>1</kbd>–<kbd>{chapters.length}</kbd> 跳到章节</span></div>
      <nav className="writing-mobile-chapters" aria-label="教学章节">{chapters.map((c, i) => <button className="role" aria-pressed={i === chapterIndex} key={c.id} onClick={() => pickChapter(i)}><span className="mono">{String(i + 1).padStart(2, '0')}</span>{c.title}</button>)}</nav><section className="panel writing-tutorial-steps"><div className="writing-step-heading"><strong>操作步骤 · 本章 {chapter?.steps.length ?? 0} 步</strong><span className="cap">已完成 {allSteps.filter(s => doneSteps.includes(s.id)).length} / {allSteps.length}</span></div>{chapter?.steps.map((s, i) => <div className="writing-tutorial-step" key={s.id}><span className={`sid ${doneSteps.includes(s.id) ? 'done' : time >= s.at ? 'current' : ''}`}>{i + 1}</span><div><p>{s.text}</p>{s.condition && <p className="cond">条件：{s.condition}</p>}</div>{doc.chapters.length > 0 && <button className="btn ghost sm" disabled={!videoUrl} onClick={() => seek(s.at)}>{formatted(s.at)} 处</button>}<button className="btn sm writing-done-step" role="checkbox" aria-checked={doneSteps.includes(s.id)} onClick={() => toggleDone(s.id)}><span className={`ck ${doneSteps.includes(s.id) ? 'on' : ''}`}>{doneSteps.includes(s.id) && <Check size={10} />}</span>我做完了</button></div>)}</section><details className="panel writing-mobile-transcript"><summary>字幕全文 · {allCaptions.length} 句</summary>{allCaptions.map(s => <button className="writing-caption-row" key={s.id} onClick={() => seek(s.at)}><span className="mono">{formatted(s.at)}</span><span>{s.text}</span></button>)}</details>
      </main><aside className="panel scroll writing-chapter-list" ref={captionsRef}><div className="writing-step-heading"><div className="seg"><button aria-pressed={!subtitleTab} onClick={() => setSubtitleTab(false)}>章节</button><button aria-pressed={subtitleTab} onClick={() => setSubtitleTab(true)}>字幕全文</button></div>{subtitleTab && <button className="btn ghost sm" aria-pressed={followCaption} onClick={() => setFollowCaption(v => !v)}>跟随播放</button>}</div>{!subtitleTab ? chapters.map((c, i) => <button className={`writing-chapter ${i === chapterIndex ? 'on' : ''}`} key={c.id} onClick={() => pickChapter(i)}><span className="mono">{String(i + 1).padStart(2, '0')}</span><span><strong>{c.title}</strong><span className="hint writing-block">{doc.chapters.length ? `${formatted(c.start)}–${chapters[i + 1]?.start ? formatted(chapters[i + 1].start) : duration > c.start ? formatted(duration) : '—'} · ` : ''}{c.steps.length} 步</span></span><span className={`tag ${c.steps.length > 0 && c.steps.every(s => doneSteps.includes(s.id)) ? 't-o' : i === chapterIndex ? 't-m' : 't-l'}`}>{c.steps.length > 0 && c.steps.every(s => doneSteps.includes(s.id)) ? '已完成' : i === chapterIndex ? '正在看' : '未看'}</span></button>) : allCaptions.map(s => <button className="writing-caption-row" data-step-id={s.id} aria-current={allCaptions.filter(x => x.at <= time).at(-1)?.id === s.id ? 'true' : undefined} key={s.id} onClick={() => doc.chapters.length && seek(s.at)}>{doc.chapters.length > 0 && <span className="mono">{formatted(s.at)}</span>}<span>{s.text}</span></button>)}<div className="writing-learning-card"><div className="cap">看完以后</div><p className="hint">适用范围和例外以已发布原文为准：{doc.scopeIn || '请结合正文判断。'}</p><Link className="btn sm" to={`/document-store/${storeId}/write/${entryId}/read`}>打开需求说明 · 下一步</Link></div></aside></div>}
    {source && <div className="writing-dialog-scrim" onClick={() => setSource(undefined)}><aside className="writing-source-dialog panel scroll" role="dialog" aria-modal="true" aria-label="来源原文" tabIndex={-1} ref={dialog} onClick={e => e.stopPropagation()}><div className="writing-section-heading"><h2>{source.id} · {source.title}</h2><button className="btn ghost" aria-label="关闭来源原文" onClick={() => { setSource(undefined); closeTrigger.current?.focus(); }}><X size={16} /></button></div><p className="hint">发布时的原文快照 · {new Date(source.updatedAt).toLocaleDateString('zh-CN')}</p>{sourceQuote && source.content.includes(sourceQuote) ? <div className="writing-quoted-source">{source.content.slice(0, source.content.indexOf(sourceQuote))}<mark>{sourceQuote}</mark>{source.content.slice(source.content.indexOf(sourceQuote) + sourceQuote.length)}</div> : <MarkdownViewer content={source.content} />}<Link className="btn" target="_blank" to={writingKnowledgeHref(storeId, source.entryId)}>打开当前原文 <ExternalLink size={13} /></Link></aside></div>}
  </div>;
}
