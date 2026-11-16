import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { approveWritingTeaching, downloadWritingTeaching, generateWritingTeaching, getWritingTeaching, resumeWritingTeaching } from '@/services/real/writing';
import type { WritingTeachingInfo } from '@/services/contracts/writing';

const ACTIVE = ['queued', 'scripting', 'voicing', 'rendering', 'saving'];
const stamp = (n: number) => new Date(Math.round(n * 1000)).toISOString().slice(11, 23);

export function WritingTeachingPanel({ entryId, storeId }: { entryId: string; storeId: string }) {
  const [info, setInfo] = useState<WritingTeachingInfo>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [videoUrl, setVideoUrl] = useState('');
  const [captionUrl, setCaptionUrl] = useState('');
  const [previewReady, setPreviewReady] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const mediaGeneration = useRef(0);
  const teaching = info?.teaching;
  const active = !!teaching && (ACTIVE.includes(teaching.status) || !!info?.recoveryPending);
  const load = useCallback(async () => {
    try {
      const result = await getWritingTeaching(entryId);
      if (!result.success) throw new Error(result.error.message);
      setInfo(result.data);
    } catch (e) { setError(e instanceof Error ? e.message : '教学状态暂不可用，请刷新'); }
  }, [entryId]);
  const invalidateMedia = useCallback(() => { mediaGeneration.current++; }, []);
  useEffect(() => { void load(); return invalidateMedia; }, [load, invalidateMedia]);
  useEffect(() => {
    if (!active) return;
    const poll = window.setInterval(() => void load(), 1800);
    const tick = window.setInterval(() => setElapsed(v => v + 1), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [active, load]);
  useEffect(() => {
    mediaGeneration.current++; setVideoUrl(''); setPreviewReady(false); setConfirmed(false);
  }, [teaching?.id, teaching?.artifactFingerprint]);
  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);
  useEffect(() => {
    if (!teaching?.scenes.length) { setCaptionUrl(''); return; }
    const text = 'WEBVTT\n\n' + teaching.scenes.map((scene, i) => `${i + 1}\n${stamp(scene.start)} --> ${stamp(scene.start + scene.duration)}\n${scene.narration}`).join('\n\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' })); setCaptionUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [teaching?.id, teaching?.artifactFingerprint, teaching?.scenes]);
  async function start() {
    if (!info?.sourceVersion || !info.sourceFingerprint || busy) return;
    setBusy(true); setError('');
    try {
      const key = `map-writing-teaching-request:${entryId}`;
      const payload = { sourceVersion: info.sourceVersion, sourceFingerprint: info.sourceFingerprint, instructions };
      let requestId = crypto.randomUUID().replaceAll('-', '');
      try {
        const pending = JSON.parse(sessionStorage.getItem(key) ?? 'null');
        if (pending?.payload === JSON.stringify(payload)) requestId = pending.requestId;
        sessionStorage.setItem(key, JSON.stringify({ requestId, payload: JSON.stringify(payload) }));
      } catch { /* 服务端文档制作锁仍防止双启动 */ }
      const result = await generateWritingTeaching(entryId, { requestId, ...payload });
      if (!result.success) throw new Error(result.error.message);
      sessionStorage.removeItem(key); setElapsed(0); setInfo({ ...info, teaching: result.data.teaching, sourceCurrent: true });
    } catch (e) { setError(e instanceof Error ? e.message : '提交未完成，请先刷新核对原任务'); }
    finally { setBusy(false); }
  }
  async function preview(portrait: boolean) {
    if (!teaching) return;
    const generation = ++mediaGeneration.current; setBusy(true); setError(''); setPreviewReady(false); setConfirmed(false);
    try {
      const result = await downloadWritingTeaching(entryId, teaching.id, portrait);
      if (generation !== mediaGeneration.current) return;
      setVideoUrl(URL.createObjectURL(result.blob));
    } catch (e) { setError(e instanceof Error ? e.message : '成片暂不可用，请重试'); }
    finally { if (generation === mediaGeneration.current) setBusy(false); }
  }
  async function approve() {
    if (!teaching || !confirmed || !previewReady) return;
    setBusy(true); setError('');
    try {
      const result = await approveWritingTeaching(entryId, teaching);
      if (!result.success) throw new Error(result.error.message);
      setInfo(current => current ? { ...current, teaching: result.data.teaching } : current);
    } catch (e) { setError(e instanceof Error ? e.message : '批准未完成，请刷新核对'); }
    finally { setBusy(false); }
  }
  async function resume() {
    if (!teaching || busy) return;
    setBusy(true); setError('');
    try {
      const result = await resumeWritingTeaching(entryId, teaching.id, teaching.revision);
      if (!result.success) throw new Error(result.error.message);
      setInfo(current => current ? { ...current, teaching: result.data.teaching } : current);
    } catch (e) { setError(e instanceof Error ? e.message : '恢复未完成，请刷新查看原任务'); }
    finally { setBusy(false); }
  }
  return <section className="rv writing-teaching-production" aria-labelledby="writing-teaching-title"><h4 id="writing-teaching-title">从确认文档生成教学视频</h4>
    <p className="hint">系统按文档编排讲解、画面、旁白与字幕。你预览成品、核对重点后，再批准给读者看。</p>
    {!info && <p role="status">正在读取教学状态…</p>}
    {teaching && <><p className="writing-teaching-status" role="status">{active && <MapSpinner size={14} />}{info?.recoveryPending ? '正在核对上次恢复状态，原脚本与配音保留' : teaching.status === 'approved' ? '教学已批准，可供读者学习' : teaching.phase} · 来源文档 v{teaching.source.version}{active && ` · ${teaching.progress}% · 已等待 ${elapsed} 秒`}</p>
      {!info?.sourceCurrent && <p className="hint">此成片对应文档 v{teaching.source.version}，当前文档已是 v{info?.sourceVersion}。批准只适用于该旧版本；新版需要重新制作。</p>}
      {teaching.failure && <p role="alert">{teaching.failure}</p>}
      {teaching.status === 'failed' && !info?.recoveryPending && <button className="btn" disabled={busy} onClick={() => void resume()}>恢复原制作任务</button>}
      {['ready', 'approved'].includes(teaching.status) && <><div className="writing-actions"><button className="btn" disabled={busy} onClick={() => void preview(false)}>预览横版成片</button><button className="btn" disabled={busy} onClick={() => void preview(true)}>预览手机竖版</button></div>
        {videoUrl && <video className="writing-teaching-preview" key={videoUrl} src={videoUrl} controls playsInline preload="metadata" onLoadedMetadata={e => setPreviewReady(Number.isFinite(e.currentTarget.duration) && e.currentTarget.duration > 0)} onError={() => { setPreviewReady(false); setError('成片未能播放，请重新加载后核对'); }}>{captionUrl && <track key={captionUrl} kind="captions" srcLang="zh" label="中文解说" src={captionUrl} default />}</video>}
        {teaching.status === 'ready' && <><label className="chk"><input type="checkbox" checked={confirmed} disabled={!previewReady || busy || !info?.canApprove} onChange={e => setConfirmed(e.target.checked)} /><span>我已预览，并核对作者重点、条件、例外与角色行动。</span></label><button className="btn pri" disabled={!confirmed || !previewReady || busy || !info?.canApprove} onClick={() => void approve()}>批准教学 · 文档 v{teaching.source.version}</button>{!info?.canApprove && <p className="hint">成片可协作预览，由文档作者批准。</p>}</>}
        {teaching.status === 'approved' && <Link className="btn pri" to={`/document-store/${storeId}/write/${entryId}/learn?version=${teaching.source.version}&course=${teaching.id}`}>打开已批准教学</Link>}
      </>}
      {teaching.scenes.length > 0 && <details className="writing-teaching-script"><summary>核对讲解与来源 · {teaching.scenes.length} 个场景</summary>{teaching.scenes.map((scene, i) => <section key={scene.id}><h5>{i + 1}. {scene.title}{scene.pace === 'slow' && <span className="tag t-l">放慢讲解</span>}</h5><ul>{scene.highlights.map((point, j) => <li key={j}>{point}</li>)}</ul><p>{scene.narration}</p><p className="hint">作者重点：{scene.intentIndexes.map(index => teaching.source.intentPoints?.[index]).filter(Boolean).join('；') || '本场承接正文说明'}</p><details><summary>对照确认正文</summary>{scene.paragraphIds.map(id => <blockquote key={id}>{teaching.source.sections.flatMap(s => s.paragraphs).find(p => p.id === id)?.text}</blockquote>)}<p>条件：{teaching.source.sections.find(s => s.id === scene.sectionId)?.condition || '本节无额外条件，请同时核对全文范围与角色限制'}</p><Link className="btn ghost sm" to={`/document-store/${storeId}/write/${entryId}/read?version=${teaching.source.version}`} target="_blank">打开该发布版全文</Link></details></section>)}</details>}
    </>}
    {info && !active && teaching?.status !== 'unknown' && <><label className="writing-input-label">讲解要求或修订意见（选填）<textarea className="field" rows={3} maxLength={2000} value={instructions} disabled={busy} placeholder="例如：先讲停止条件，第二章放慢；保留逐批审核要求。" onChange={e => setInstructions(e.target.value)} /></label><button className="btn" disabled={busy || !info.sourceVersion} onClick={() => void start()}>{busy ? '正在提交…' : teaching ? '重新编排并制作' : '生成教学视频'}</button></>}
    {error && <p role="alert">{error}</p>}<button className="btn ghost sm" disabled={busy} onClick={() => { setError(''); void load(); }}>刷新教学状态</button>
  </section>;
}
