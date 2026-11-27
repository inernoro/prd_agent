import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { downloadCloudFilmExport, getCloudFilmExport, queueCloudFilmExport, readQuickCreationBundle, readQuickCreationPlayer } from '@/services/real/quickCreation';
import { detectBrowserExport, exportFilmInBrowser, type ExportContainer, type ExportProgress } from './browserExport';
import { formatClock } from './format';
import type { QcRun } from './types';

export function BrowserFilmPlayer({ run }: { run: QcRun }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setHtml('');
    setError(undefined);
    void readQuickCreationPlayer(run.id).then(value => { if (current) setHtml(value); }, () => {
      if (current) setError('播放器暂时没读到，作品仍在。');
    });
    return () => { current = false; };
  }, [attempt, run.id]);
  return (
    <div className="space-y-3 p-3 sm:p-5" data-qc="browser-player">
      {html ? <iframe title={run.status === 'trial-ready' ? '试看' : run.title} sandbox="allow-scripts" srcDoc={html}
        className="aspect-[16/10] w-full rounded-xl border border-token-subtle bg-[var(--bg-secondary)]" />
        : error ? <p role="status" className="flex items-center gap-2 text-sm">{error}<Button size="sm" variant="secondary" onClick={() => setAttempt(n => n + 1)}>重新打开</Button></p>
          : <p role="status" className="flex items-center gap-2 text-sm"><MapSpinner size={14} />正在读影片画面和配音</p>}
    </div>
  );
}

function CloudExport({ run, offerRequest }: { run: QcRun; offerRequest: boolean }) {
  const [state, setState] = useState<'none' | 'queued' | 'running' | 'failed' | 'done'>('none');
  const [ahead, setAhead] = useState(0);
  const [estimatedMinutes, setEstimatedMinutes] = useState<number>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const active = state === 'queued' || state === 'running';
  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    const poll = async () => {
      const response = await getCloudFilmExport(run.id, controller.signal);
      if (controller.signal.aborted) return;
      if (response.success) {
        setState(response.data.status); setAhead(response.data.ahead); setEstimatedMinutes(response.data.estimatedMinutes); setError(response.data.error);
        if (response.data.status === 'queued' || response.data.status === 'running') timer = window.setTimeout(poll, 3000);
      } else if (active) timer = window.setTimeout(poll, 4000);
    };
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [active, run.id]);
  const queue = async () => {
    setBusy(true);
    const response = await queueCloudFilmExport(run.id).finally(() => setBusy(false));
    if (response.success) { setState(response.data.status); setAhead(response.data.ahead); setEstimatedMinutes(response.data.estimatedMinutes); setError(response.data.error); }
    else setError(response.error?.message ?? '暂时没有排进去，可以再试');
  };
  const download = async () => {
    setBusy(true);
    try {
      const file = await downloadCloudFilmExport(run.id, run.title);
      if (!file.contentType.startsWith('video/mp4')) throw new Error('导出文件还没就绪');
      const url = URL.createObjectURL(file.blob);
      const link = Object.assign(document.createElement('a'), { href: url, download: `${run.title}.mp4` });
      link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch { setError('暂时没取回导出文件，可以重试下载'); }
    finally { setBusy(false); }
  };
  if (!offerRequest && state === 'none') return null;
  return <div className="space-y-2" data-qc="cloud-export" data-state={state}>
    {active ? <p className="m-0 text-xs text-token-secondary" role="status">
      {state === 'queued' ? `已交给服务器导出，前面还有 ${ahead} 个${estimatedMinutes ? `，预计约 ${estimatedMinutes} 分钟后可以下载` : ''}。` : '服务器正在合成，可以稍后回来下载。'}
    </p> : <Button size="sm" variant="secondary" disabled={busy} onClick={() => void (state === 'done' ? download() : queue())}>
      {state === 'done' ? '下载云端导出的 MP4' : state === 'failed' ? '重试服务器导出' : '请服务器导出'}
    </Button>}
    {error && <p className="m-0 text-xs" role="alert">{error}</p>}
  </div>;
}

export function BrowserExport({ run }: { run: QcRun }) {
  const [container, setContainer] = useState<ExportContainer | null | undefined>();
  const [frameHtml, setFrameHtml] = useState('');
  const [progress, setProgress] = useState<ExportProgress>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [download, setDownload] = useState<{ url: string; name: string }>();
  const iframe = useRef<HTMLIFrameElement>(null);
  const job = useRef<AbortController | null>(null);
  const lastUrl = useRef<string | null>(null);
  useEffect(() => {
    let current = true;
    void detectBrowserExport().then(result => { if (current) setContainer(result); });
    return () => { current = false; job.current?.abort(); if (lastUrl.current) URL.revokeObjectURL(lastUrl.current); };
  }, []);

  const start = async () => {
    if (!container || job.current) return;
    const controller = new AbortController();
    job.current = controller;
    setBusy(true);
    setError(undefined);
    setProgress(undefined);
    if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
    setDownload(undefined);
    try {
      const [html, bundle] = await Promise.all([readQuickCreationPlayer(run.id), readQuickCreationBundle(run.id)]);
      controller.signal.throwIfAborted();
      const frame = await new Promise<Window>((resolve, reject) => {
        const cleanup = () => {
          window.removeEventListener('message', ready);
          controller.signal.removeEventListener('abort', aborted);
          window.clearTimeout(timer);
        };
        const aborted = () => { cleanup(); reject(controller.signal.reason); };
        const ready = (event: MessageEvent) => {
          const target = iframe.current?.contentWindow;
          if (!target || event.source !== target || event.data?.type !== 'map-film-ready') return;
          cleanup(); resolve(target);
        };
        const timer = window.setTimeout(() => { cleanup(); reject(new Error('导出画面没有就绪')); }, 15_000);
        window.addEventListener('message', ready);
        controller.signal.addEventListener('abort', aborted, { once: true });
        setFrameHtml(html);
      });
      const blob = await exportFilmInBrowser(bundle, frame, container, setProgress, controller.signal);
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      lastUrl.current = url;
      setDownload({ url, name: `${run.title}.${container}` });
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '这次没导出成功');
    } finally {
      job.current = null;
      setFrameHtml('');
      setBusy(false);
    }
  };
  if (container === null) return <div className="qc-card mt-3 space-y-1 p-3" data-qc="export-unsupported">
    <div className="text-sm font-medium">这个浏览器不能在本机合成视频</div>
    <p className="m-0 text-xs text-token-secondary">请用电脑上的 Chrome、Edge 或 Safari 打开这一页，也可以排队请服务器导出。</p>
    <CloudExport run={run} offerRequest />
  </div>;
  return (
    <section className="mt-3 space-y-2" data-qc="export-card" data-state={download ? 'done' : busy ? 'exporting' : 'ready'}>
      <iframe ref={iframe} title="导出画面" sandbox="allow-scripts" srcDoc={frameHtml} hidden />
      {busy ? <div className="qc-card space-y-2 p-3" role="status">
        <div className="flex items-center gap-2 text-sm"><MapSpinner size={14} />正在用你的浏览器合成 {container?.toUpperCase()}</div>
        <div className="text-xs text-token-secondary">{progress ? `第 ${progress.frame.toLocaleString()} / ${progress.frames.toLocaleString()} 帧 · 已用 ${formatClock(progress.elapsedSec)} · 约还需 ${formatClock(progress.remainSec ?? 0)}` : '正在准备画面与音轨'}。请保持这个页面在前台。</div>
        {progress && <progress aria-label="导出帧数" value={progress.frame} max={progress.frames} className="w-full" />}
        <Button size="sm" variant="secondary" onClick={() => job.current?.abort()}>取消导出</Button>
      </div> : download ? <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
        已导出 {download.name}<a className="text-[color:var(--accent-primary)] underline" href={download.url} download={download.name}>下载文件</a>
      </div> : <Button size="sm" variant="secondary" data-qc="export-start" disabled={!container} onClick={() => void start()}>
        <Download size={14} />导出 {container === 'webm' ? 'WebM' : 'MP4'} 文件
      </Button>}
      {error && <p className="m-0 text-xs text-[color:var(--accent-fg-error)]" role="alert">{error}</p>}
      <CloudExport run={run} offerRequest={Boolean(error)} />
    </section>
  );
}
