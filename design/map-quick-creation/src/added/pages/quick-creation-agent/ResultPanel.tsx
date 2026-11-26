import { useMemo, useRef, useState } from 'react';
import { Captions, Maximize, Monitor, Pause, Play, SkipBack, SkipForward, Smartphone, Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/design/Badge';
import { TemplateFrame, TemplatePageBody } from './TemplateFrames';
import type { QcRun, QcScene, QcTemplate } from './types';
import { formatClock } from './format';

export function TemplatePreview({ template }: { template: QcTemplate }) {
  return (
    <div className="space-y-3" data-qc="template-preview">
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-token-subtle">
        <TemplateFrame frame={template.frame} scene={template.kind === 'video' ? 2 : 1} />
      </div>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-token-primary">{template.name}</div>
          <div className="mt-1 text-[12.5px] leading-6 text-token-secondary">{template.tagline}。{template.goodFor}</div>
        </div>
        <Badge size="sm">{template.kind === 'video' ? '示例帧来自真实成片' : '示例页来自真实发布'}</Badge>
      </div>
    </div>
  );
}

const SCENE_STATUS: Record<QcScene['status'], string> = { ready: '已完成', drawing: '正在画', drawn: '待配音', voicing: '配音中', failed: '没有完成', waiting: '排队后开始' };

/** 生成中：分镜（视频）或页面大纲（网页）逐个亮起 */
export function ProgressPreview({ run, template }: { run: QcRun; template: QcTemplate }) {
  if (run.kind === 'web') {
    const sections = run.sections ?? [];
    return (
      <div className="space-y-3" data-qc="outline-preview">
        <div className="text-[12.5px] text-token-secondary">{sections.length ? '大纲已出，页面按节生成；先完成的节可以先看。' : '排到后先出大纲，这里会逐节亮起。'}</div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="overflow-hidden rounded-[var(--radius-card)] border border-token-subtle"><TemplateFrame frame={template.frame} /></div>
          <ol className="space-y-1.5">
            {sections.map((s, i) => (
              <li key={s.anchor} className="flex items-center gap-2 rounded-[var(--radius-field)] border border-token-subtle bg-token-nested px-3 py-2 text-[12.5px]">
                <span className="w-5 text-token-muted">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-token-primary">{s.title}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    );
  }
  const scenes = run.scenes ?? [];
  return (
    <div className="space-y-3" data-qc="storyboard-preview">
      <div className="text-[12.5px] text-token-secondary">{scenes.some(s => s.status !== 'waiting') ? '分镜先出，配音完成的幕会标出时长；全部完成后合成为成片。' : '排到后先出分镜，这里会逐幕亮起。'}</div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        {scenes.map(s => (
          <figure key={s.index} className="m-0 space-y-1.5" data-scene={s.index} data-scene-status={s.status}>
            <div className={cn('relative overflow-hidden rounded-[var(--radius-field)] border',
              s.status === 'failed' ? 'border-[color:var(--accent-fg-error)]' : s.status === 'voicing' || s.status === 'drawing' ? 'border-[color:var(--accent-primary)]' : 'border-token-subtle')}>
              {s.status === 'waiting' ? (
                <div className="flex aspect-video items-center justify-center bg-token-nested text-[12px] text-token-muted">{SCENE_STATUS.waiting}</div>
              ) : (
                <div className={cn((s.status === 'drawing' || s.status === 'drawn') && 'opacity-70')}><TemplateFrame frame={template.frame} scene={s.frameScene} /></div>
              )}
            </div>
            <figcaption className="flex items-center gap-1.5 text-[11.5px]">
              <span className="min-w-0 flex-1 truncate text-token-secondary">第 {s.index} 幕 · {s.title}</span>
              {s.status !== 'waiting' && <Badge size="sm" variant={s.status === 'ready' ? 'success' : s.status === 'failed' ? 'danger' : 'subtle'}>{SCENE_STATUS[s.status]}</Badge>}
            </figcaption>
          </figure>
        ))}
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
  const media = run.media;
  const current = useMemo(() => [...scenes].reverse().find(s => t >= s.startSec) ?? scenes[0], [scenes, t]);

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
    <div className="space-y-3" data-qc="video-player" data-scene-index={current?.index ?? 1} data-playing={playing ? 'true' : 'false'}>
      <div ref={box} className="overflow-hidden rounded-[var(--radius-card)] border border-token-subtle bg-black">
        <div className="relative">
          {media ? (
            <video ref={video} src={media.url} preload="auto" playsInline muted={muted} data-qc="film"
              className="block aspect-video w-full bg-black" aria-label={`${run.title} 成片`}
              onLoadedMetadata={e => setDuration(e.currentTarget.duration || run.durationSec || 0)}
              onTimeUpdate={e => setT(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
          ) : (
            <TemplateFrame frame={template.frame} scene={1} />
          )}
          {captions && current && media && (
            <div data-qc="caption" className="pointer-events-none absolute bottom-[6%] left-1/2 max-w-[90%] -translate-x-1/2 rounded-md bg-black/75 px-2.5 py-1 text-center text-[12px] leading-5 text-white sm:px-3 sm:py-1.5 sm:text-[15px] sm:leading-6">{current.caption}</div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1 bg-[var(--bg-elevated)] px-2 py-1.5">
          <button type="button" aria-label="上一幕" disabled={!media} onClick={() => sceneJump(-1)} className="qc-icon-btn"><SkipBack size={16} /></button>
          <button type="button" aria-label={playing ? '暂停' : '播放'} data-qc="play-toggle" disabled={!media} onClick={toggle} className="qc-icon-btn text-token-primary">
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button type="button" aria-label="下一幕" disabled={!media} onClick={() => sceneJump(1)} className="qc-icon-btn"><SkipForward size={16} /></button>
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
          <button type="button" aria-label={captions ? '关闭字幕' : '打开字幕'} aria-pressed={captions} data-qc="captions-toggle" onClick={() => setCaptions(v => !v)} className={cn('qc-icon-btn', captions && 'text-token-primary')}><Captions size={16} /></button>
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
                className={cn('flex items-start gap-2.5 rounded-[var(--radius-field)] border bg-token-nested px-3 py-2.5 text-left text-[12.5px] leading-5 hover-bg-soft max-md:min-h-11',
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
  const sections = run.sections ?? [];
  return (
    <div className="space-y-3" data-qc="web-preview" data-active-anchor={anchor ?? ''}>
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-token-subtle bg-[var(--bg-elevated)]">
        <div className="flex items-center gap-2 border-b border-token-subtle px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[12px] text-token-muted">{run.title} · {template.name}</span>
          <div className="hidden rounded-lg border border-token-subtle p-0.5 sm:inline-flex" role="group" aria-label="预览尺寸">
            <button type="button" aria-pressed={device === 'desktop'} aria-label="桌面" onClick={() => setDevice('desktop')} className={cn('qc-icon-btn h-7 w-7', device === 'desktop' && 'bg-token-nested text-token-primary')}><Monitor size={14} /></button>
            <button type="button" data-qc="device-phone" aria-pressed={device === 'phone'} aria-label="手机" onClick={() => setDevice('phone')} className={cn('qc-icon-btn h-7 w-7', device === 'phone' && 'bg-token-nested text-token-primary')}><Smartphone size={14} /></button>
          </div>
        </div>
        <div className="flex justify-center bg-token-nested p-3">
          <div className={cn('overflow-hidden rounded-lg bg-white transition-[width] duration-300', device === 'phone' ? 'w-[300px]' : 'w-full')}>
            <TemplateFrame frame={template.frame} scene={anchor ? sections.findIndex(s => s.anchor === anchor) + 1 : 1} />
            <TemplatePageBody sections={sections} activeAnchor={anchor} />
          </div>
        </div>
      </div>
      {!!run.keyPoints?.length && (
        <div>
          <div className="mb-2 text-[12px] text-token-muted">页首导读的 {run.keyPoints.length} 个重点 · 点击定位</div>
          <div className="grid gap-2 sm:grid-cols-3">
            {run.keyPoints.map((k, i) => (
              <button key={k.text} type="button" data-qc={`web-point-${i + 1}`} onClick={() => setAnchor(k.anchor)}
                className={cn('flex items-start gap-2.5 rounded-[var(--radius-field)] border bg-token-nested px-3 py-2.5 text-left text-[12.5px] leading-5 hover-bg-soft max-md:min-h-11', anchor === k.anchor ? 'border-[color:var(--accent-primary)]/60' : 'border-token-subtle')}>
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
