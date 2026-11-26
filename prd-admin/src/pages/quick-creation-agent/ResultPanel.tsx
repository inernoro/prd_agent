import { useEffect, useMemo, useRef, useState } from 'react';
import { Captions, Check, Maximize, Monitor, Pause, Play, SkipBack, SkipForward, Smartphone, Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/cn';
import { readQuickCreationFilm, readQuickCreationPage } from '@/services/real/quickCreation';
import { StyleFrame, TemplatePageBody } from './TemplateFrames';
import type { QcRun, QcScene, QcTemplate } from './types';
import { formatClock } from './format';

const SCENE_STATUS: Record<QcScene['status'], string> = { ready: '已完成', drawing: '正在画', drawn: '待配音', voicing: '配音中', failed: '没有完成', waiting: '等待中' };

function Wave() {
  return <span className="qc-wave" aria-hidden><i /><i /><i /><i /><i /></span>;
}

/** 作品形状的骨架：一帧 16:9 的画面在呼吸 */
function FrameSkeleton({ big }: { big?: boolean }) {
  return (
    <div className="relative flex aspect-video w-full flex-col justify-center gap-[6%] overflow-hidden rounded-[inherit] bg-[var(--bg-secondary)] px-[8%]" aria-hidden>
      <div className="qc-skel h-[9%] w-[46%]" />
      <div className="grid grid-cols-3 gap-[4%]">
        {[0, 1, 2].map(i => <div key={i} className="qc-skel aspect-[4/3]" style={{ animationDelay: `${i * 0.2}s` }} />)}
      </div>
      {big && <div className="qc-skel h-[5%] w-[30%]" />}
    </div>
  );
}

/** 生成中：视频是「当前这一幕的大画面 + 分镜胶片」，网页是「正在写的页面 + 大纲」 */
export function ProgressPreview({ run, template }: { run: QcRun; template: QcTemplate }) {
  if (run.kind === 'web') {
    const sections = run.sections ?? [];
    const live = run.stages.find(s => s.status === 'running');
    const doneCount = run.status === 'queued' || !sections.length ? 0 : Math.max(1, Math.floor(sections.length * ((live?.progress ?? 50) / 100)));
    return (
      <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 lg:flex-row lg:p-5" data-qc="outline-preview">
        <div className="min-w-0 flex-1 overflow-hidden rounded-[12px] border border-token-subtle bg-[var(--bg-elevated)]">
          <div className="flex items-center gap-1.5 border-b border-token-subtle px-3 py-2" aria-hidden>
            <span className="h-2 w-2 rounded-full bg-[var(--bg-tertiary)]" /><span className="h-2 w-2 rounded-full bg-[var(--bg-tertiary)]" /><span className="h-2 w-2 rounded-full bg-[var(--bg-tertiary)]" />
            <span className="ml-2 truncate text-[11.5px] text-token-muted">{run.title}</span>
          </div>
          {sections.length ? (
            <div className="bg-white"><StyleFrame template={template} /><TemplatePageBody sections={sections} pendingFrom={doneCount} maxHeight="none" /></div>
          ) : <div className="p-4"><FrameSkeleton big /></div>}
        </div>
        <div className="shrink-0 lg:w-[220px]">
          <div className="mb-2 text-[12px] font-medium text-token-secondary">页面大纲 · {doneCount} / {sections.length || '-'} 节</div>
          <ol className="space-y-1.5">
            {sections.map((s, i) => {
              const st = i < doneCount ? 'done' : i === doneCount ? 'live' : 'wait';
              return (
                <li key={s.anchor} className={cn('flex items-center gap-2 rounded-[10px] border px-2.5 py-2 text-[12.5px]', st === 'live' ? 'qc-shimmer border-[color:var(--accent-primary)] bg-[var(--selection-bg)]' : 'border-token-subtle bg-[var(--bg-input)]')}>
                  <span className="w-4 tabular-nums text-token-muted">{i + 1}</span>
                  <span className={cn('min-w-0 flex-1 truncate', st === 'wait' ? 'text-token-muted' : 'text-token-primary')}>{s.title}</span>
                  {st === 'done' && <Check size={13} className="text-[color:var(--accent-fg-success)]" aria-label="已写好" />}
                  {st === 'live' && <span className="text-[11px] font-medium text-[color:var(--accent-primary)]">在写</span>}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    );
  }
  const scenes = run.scenes ?? [];
  const focus = scenes.find(s => s.status === 'failed') ?? scenes.find(s => s.status === 'voicing') ?? scenes.find(s => s.status === 'drawing')
    ?? [...scenes].reverse().find(s => s.status !== 'waiting');
  const started = scenes.filter(s => s.status !== 'waiting').length;
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-2.5 sm:p-4 lg:p-5" style={{ overscrollBehavior: 'contain' }} data-qc="storyboard-preview">
      <div className="mx-auto w-full" style={{ maxWidth: 'min(100%, calc((100dvh - 430px) * 16 / 9))' }}>
        <div className="mb-2 flex h-6 items-center gap-2 text-[12.5px]">
          {focus ? (
            <>
              <span className="font-medium text-token-primary">第 {focus.index} 幕 · {focus.title}</span>
              <span className="inline-flex items-center gap-1.5 rounded-full px-2 leading-[22px]" style={{
                background: focus.status === 'failed' ? 'var(--semantic-danger-soft)' : focus.status === 'ready' ? 'var(--semantic-success-soft)' : 'var(--selection-bg)',
                color: focus.status === 'failed' ? 'var(--accent-fg-error)' : focus.status === 'ready' ? 'var(--accent-fg-success)' : 'var(--accent-primary)' }}>
                {focus.status === 'voicing' && <Wave />}{SCENE_STATUS[focus.status]}
              </span>
            </>
          ) : <span className="text-token-muted">排队中 · 轮到后从第 1 幕开始画</span>}
        </div>
        <div className={cn('relative overflow-hidden rounded-[12px] border shadow-[var(--shadow-card-sm)]',
          focus?.status === 'failed' ? 'border-[color:var(--accent-fg-error)]' : 'border-token-subtle')}>
          {focus ? (
            <div key={focus.index} className={cn('qc-rise', focus.status === 'drawing' && 'qc-shimmer')}><StyleFrame template={template} scene={focus.frameScene} /></div>
          ) : <FrameSkeleton big />}
          {focus && (
            <>
              {focus.status !== 'drawing' && (
                <div className="pointer-events-none absolute bottom-[6%] left-1/2 max-w-[86%] -translate-x-1/2 rounded-md bg-[var(--panel-solid)] px-3 py-1.5 text-center text-[13px] leading-5 text-token-primary shadow-[var(--shadow-card-sm)]">
                  {focus.caption}
                </div>
              )}
            </>
          )}
          {!focus && <div className="absolute inset-x-0 bottom-4 text-center text-[12.5px] text-token-secondary">排到后先出分镜，{scenes.length || 6} 幕会逐个出现在这里</div>}
        </div>
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between text-[12px]">
          <span className="font-medium text-token-secondary">分镜 · {started} / {scenes.length} 幕已出</span>
          <span className="text-token-muted">配音完成的幕标为已完成，全部完成后合成成片</span>
        </div>
        <div className="grid grid-cols-3 gap-2.5 xl:grid-cols-6">
          {scenes.map(s => {
            const on = s.index === focus?.index;
            return (
              <figure key={s.index} className="m-0" data-scene={s.index} data-scene-status={s.status}>
                <div className={cn('overflow-hidden rounded-[8px] border',
                  s.status === 'failed' ? 'border-[color:var(--accent-fg-error)]' : on ? 'border-[color:var(--accent-primary)] shadow-[0_0_0_1px_var(--accent-primary)]' : 'border-token-subtle',
                  s.status === 'drawing' && 'qc-shimmer')}>
                  {s.status === 'waiting' ? <FrameSkeleton /> : <div className={cn(s.status === 'drawn' && 'opacity-80')}><StyleFrame template={template} scene={s.frameScene} /></div>}
                </div>
                <figcaption className="mt-1.5 px-0.5 text-[11.5px] leading-4">
                  <span className="block truncate text-token-secondary"><span className="tabular-nums text-token-muted">{s.index}</span> {s.title}</span>
                  <span className="mt-0.5 flex items-center gap-1" style={{ color: s.status === 'ready' ? 'var(--accent-fg-success)' : s.status === 'failed' ? 'var(--accent-fg-error)' : s.status === 'voicing' || s.status === 'drawing' ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                    {s.status === 'voicing' && <Wave />}{SCENE_STATUS[s.status]}
                  </span>
                </figcaption>
              </figure>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * 成片播放器：直接播放 run.media（真实的视频文件，含音轨），时间、字幕与重点都跟随 video.currentTime。
 * 没有媒体文件时（理论上只在合成刚结束、文件尚未就绪的瞬间）显示首帧并说明原因，控件不可用。
 */
export function VideoPlayer({ run, template }: { run: QcRun; template: QcTemplate }) {
  const scenes = useMemo(() => run.scenes ?? [], [run.scenes]);
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(run.durationSec ?? 0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [filmAttempt, setFilmAttempt] = useState(0);
  const mediaAvailable = !!run.media;
  useEffect(() => {
    setMediaUrl(null);
    setBlocked(null);
    if (!mediaAvailable) return;
    let active = true;
    let objectUrl: string | null = null;
    void readQuickCreationFilm(run.id).then(blob => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setMediaUrl(objectUrl);
    }).catch(() => {
      if (active) setBlocked('成片暂时没能打开，请重试读取');
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [run.id, mediaAvailable, filmAttempt]);
  const media = mediaUrl ? { url: mediaUrl } : null;
  const current = useMemo(() => [...scenes].reverse().find(s => t >= s.startSec) ?? scenes[0], [scenes, t]);
  const currentCaption = run.captions?.find(caption => caption.fromSec <= t && t < caption.toSec)?.text ?? current?.caption;
  const hasCaptions = Boolean(run.captions?.length || scenes.length);

  const seek = (sec: number) => {
    const el = video.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(duration || el.duration || 0, sec));
    setT(el.currentTime);
  };
  const play = async () => {
    const el = video.current;
    if (!el) return;
    if (el.ended) el.currentTime = 0;
    try { await el.play(); setBlocked(null); } catch { setBlocked('浏览器拦下了自动播放，请再点一次播放'); }
  };
  const toggle = () => { const el = video.current; if (!el) return; if (el.paused) void play(); else el.pause(); };
  const sceneJump = (dir: -1 | 1) => {
    const idx = scenes.findIndex(s => s === current);
    const next = scenes[Math.max(0, Math.min(scenes.length - 1, idx + dir))];
    if (next) seek(next.startSec);
  };
  const fullscreen = () => { void box.current?.requestFullscreen?.().catch(() => setBlocked('当前环境不支持页面内全屏，可用浏览器的全屏或大屏入口')); };

  return (
    <div className="h-full space-y-4 overflow-y-auto p-2.5 sm:p-4 lg:p-5" style={{ overscrollBehavior: 'contain' }} data-qc="video-player" data-scene-index={current?.index ?? 1} data-playing={playing ? 'true' : 'false'}>
      <div ref={box} className="mx-auto overflow-hidden rounded-[12px] border border-token-subtle bg-[var(--bg-elevated)] shadow-[var(--shadow-card-sm)]" style={{ maxWidth: 'min(100%, calc((100dvh - 400px) * 16 / 9))' }}>
        <div className="relative">
          {media ? (
            <video ref={video} src={media.url} preload="auto" playsInline muted={muted} data-qc="film"
              className="block aspect-video w-full bg-black" aria-label={`${run.title} 成片`}
              onLoadedMetadata={e => setDuration(e.currentTarget.duration || run.durationSec || 0)}
              onTimeUpdate={e => setT(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
          ) : (
            <div className="relative">
              <StyleFrame template={template} scene={1} />
              {mediaAvailable && <div className="absolute inset-x-0 bottom-0 bg-[var(--bg-elevated)] px-3 py-2 text-sm text-token-primary" role="status">
                {blocked ? <button type="button" className="min-h-11 underline" onClick={() => setFilmAttempt(attempt => attempt + 1)}>重试读取成片</button> : '正在读取成片'}
              </div>}
            </div>
          )}
          {captions && currentCaption && media && (
            <div data-qc="caption" className="pointer-events-none absolute bottom-[6%] left-1/2 max-w-[90%] -translate-x-1/2 rounded-md bg-black/75 px-2.5 py-1 text-center text-[12px] leading-5 text-white sm:px-3 sm:py-1.5 sm:text-[15px] sm:leading-6">{currentCaption}</div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1 bg-[var(--bg-elevated)] px-2 py-1.5">
          <button type="button" aria-label="上一幕" disabled={!media} onClick={() => sceneJump(-1)} className="qc-icon-btn hidden sm:inline-flex"><SkipBack size={16} /></button>
          <button type="button" aria-label={playing ? '暂停' : '播放'} data-qc="play-toggle" disabled={!media} onClick={toggle} className="qc-icon-btn text-token-primary">
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button type="button" aria-label="下一幕" disabled={!media} onClick={() => sceneJump(1)} className="qc-icon-btn hidden sm:inline-flex"><SkipForward size={16} /></button>
          <span data-qc="clock" className="shrink-0 px-1 text-center font-[var(--font-code)] text-[11.5px] text-token-secondary sm:w-[86px] sm:px-0 sm:text-[12px]">{formatClock(t)} / {formatClock(duration)}</span>
          {/* 窄屏进度条单独占一行，按钮不挤压它 */}
          <div className="relative order-first h-6 max-md:h-11 basis-full px-1 sm:order-none sm:mx-2 sm:flex-1 sm:basis-auto sm:px-0">
            <input type="range" min={0} max={Math.max(1, Math.round(duration))} step={1} value={Math.round(t)} disabled={!media} onChange={e => seek(Number(e.target.value))} aria-label="播放进度" className="qc-range absolute inset-0 w-full" />
            {duration > 0 && (run.keyPoints ?? []).map(k => k.atSec != null && (
              <span key={k.text} className="pointer-events-none absolute top-1/2 h-2.5 w-[2px] -translate-y-1/2 rounded bg-[color:var(--text-muted)]" style={{ left: `${(k.atSec / duration) * 100}%` }} />
            ))}
          </div>
          <span className="flex-1 sm:hidden" />
          {/* 手机用系统音量键，窄屏不占位置 */}
          <button type="button" aria-label={muted ? '取消静音' : '静音'} aria-pressed={muted} onClick={() => setMuted(v => !v)} className="qc-icon-btn hidden sm:inline-flex">{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
          <button type="button" aria-label={captions ? '关闭字幕' : '打开字幕'} aria-pressed={captions} disabled={!hasCaptions} data-qc="captions-toggle" onClick={() => setCaptions(v => !v)} className={cn('qc-icon-btn', captions && 'text-token-primary')}><Captions size={16} /></button>
          <button type="button" aria-label="全屏" onClick={fullscreen} className="qc-icon-btn"><Maximize size={16} /></button>
        </div>
      </div>
      {!media && <div className="text-[12px] text-token-muted">成片文件正在写入，几秒后可以播放。</div>}
      {blocked && <div role="status" className="text-[12px] text-token-muted">{blocked}</div>}
      {!!run.keyPoints?.length && (
        <div>
          <div className="mb-2 text-[12px] text-token-muted">片头预告的 {run.keyPoints.length} 个重点 · 点击跳转</div>
          <div className="grid gap-2 sm:grid-cols-3">
            {run.keyPoints.map((k, i) => (
              <button key={k.text} type="button" data-qc={`key-point-${i + 1}`} disabled={!media} onClick={() => { seek(k.atSec ?? 0); void play(); }}
                className={cn('flex items-start gap-2.5 rounded-[10px] border bg-[var(--bg-input)] px-3 py-2.5 text-left text-[12.5px] leading-5 hover-bg-soft max-md:min-h-11',
                  current && k.atSec != null && current.startSec === k.atSec ? 'border-[color:var(--accent-primary)]/60' : 'border-token-subtle')}>
                <span className="font-[var(--font-code)] text-[color:var(--accent-primary)]">{formatClock(k.atSec ?? 0)}</span>
                <span className="text-token-primary">{k.text}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function WebPreview({ run, template }: { run: QcRun; template: QcTemplate }) {
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const [anchor, setAnchor] = useState<string | undefined>();
  const [previewUrl, setPreviewUrl] = useState<string | undefined>();
  const [publishedHtml, setPublishedHtml] = useState<string | undefined>();
  const [previewError, setPreviewError] = useState(false);
  useEffect(() => {
    setPreviewUrl(undefined);
    setPublishedHtml(undefined);
    setPreviewError(false);
    if (!run.previewSiteId) return;
    let active = true;
    void readQuickCreationPage(run.previewSiteId).then(result => {
      if (!active) return;
      if (result.success && result.data.siteUrl) {
        setPublishedHtml(result.data.html);
        const url = new URL(result.data.siteUrl, window.location.origin);
        if (url.protocol === 'https:' || url.protocol === 'http:') setPreviewUrl(url.toString());
        else setPreviewError(true);
      } else setPreviewError(true);
    });
    return () => { active = false; };
  }, [run.previewSiteId]);
  const sections = useMemo(() => {
    if (run.sections?.length) return run.sections;
    const html = publishedHtml ?? run.previewHtml;
    if (!html) return [];
    const preview = new DOMParser().parseFromString(html, 'text/html');
    return Array.from(preview.querySelectorAll<HTMLElement>('h2, h3')).slice(0, 12).flatMap(heading => {
      const title = heading.textContent?.trim();
      const anchor = heading.id || heading.closest('section[id]')?.id;
      return title && anchor ? [{ title, anchor, body: '' }] : [];
    });
  }, [run.sections, run.previewHtml, publishedHtml]);
  const points = run.keyPoints?.length ? run.keyPoints : sections.map(section => ({ text: section.title, anchor: section.anchor }));
  const previewDestination = previewUrl && anchor ? `${previewUrl.split('#')[0]}#${encodeURIComponent(anchor)}` : previewUrl;
  return (
    <div className="h-full space-y-4 overflow-y-auto p-2.5 sm:p-4 lg:p-5" style={{ overscrollBehavior: 'contain' }} data-qc="web-preview" data-active-anchor={anchor ?? ''}>
      <div className="overflow-hidden rounded-[12px] border border-token-subtle bg-[var(--bg-elevated)] shadow-[var(--shadow-card-sm)]">
        <div className="flex items-center gap-2 border-b border-token-subtle px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[12px] text-token-muted">{run.title} · {template.name}</span>
          <div className="hidden rounded-lg border border-token-subtle p-0.5 sm:inline-flex" role="group" aria-label="预览尺寸">
            <button type="button" aria-pressed={device === 'desktop'} aria-label="桌面" onClick={() => setDevice('desktop')} className={cn('qc-icon-btn h-7 w-7', device === 'desktop' && 'bg-token-nested text-token-primary')}><Monitor size={14} /></button>
            <button type="button" data-qc="device-phone" aria-pressed={device === 'phone'} aria-label="手机" onClick={() => setDevice('phone')} className={cn('qc-icon-btn h-7 w-7', device === 'phone' && 'bg-token-nested text-token-primary')}><Smartphone size={14} /></button>
          </div>
        </div>
        <div className="flex justify-center bg-token-nested p-3">
          <div className={cn('overflow-hidden rounded-lg bg-white transition-[width] duration-300', device === 'phone' ? 'w-[300px]' : 'w-full')}>
            {previewDestination || run.previewHtml ? (
              <iframe title={run.title} src={previewDestination} srcDoc={previewDestination ? undefined : run.previewHtml}
                sandbox={previewDestination ? 'allow-scripts' : ''} referrerPolicy="no-referrer"
                className="block h-[560px] w-full border-0" />
            ) : sections.length > 0 ? (
              <TemplatePageBody sections={sections} activeAnchor={anchor} maxHeight={300} />
            ) : <p className="p-4 text-sm text-token-secondary" role="status">
              {previewError ? '暂时无法打开网页预览，可以稍后重新进入任务。' : '正在准备网页预览'}
            </p>}
          </div>
        </div>
      </div>
      {!!points.length && (
        <div>
          <div className="mb-2 text-[12px] text-token-muted">网页章节{previewUrl ? ' · 点击定位' : ''}</div>
          <div className="grid gap-2 sm:grid-cols-3">
            {points.map((k, i) => (
              <button key={(k.anchor ?? '') + k.text} type="button" data-qc={`web-point-${i + 1}`} disabled={!previewUrl || !k.anchor} onClick={() => setAnchor(k.anchor)}
                className={cn('flex items-start gap-2.5 rounded-[10px] border bg-[var(--bg-input)] px-3 py-2.5 text-left text-[12.5px] leading-5 hover-bg-soft max-md:min-h-11', anchor === k.anchor ? 'border-[color:var(--accent-primary)]/60' : 'border-token-subtle')}>
                <span className="font-[var(--font-code)] text-[color:var(--accent-primary)]">{String(i + 1).padStart(2, '0')}</span>
                <span className="text-token-primary">{k.text}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
