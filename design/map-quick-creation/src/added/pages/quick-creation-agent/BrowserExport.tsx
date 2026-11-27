/**
 * 成片导出：在用户自己的浏览器里合成视频文件，服务器只存画面代码和配音。
 * 播放本来就不需要视频文件（右边的播放器直接跑画面代码 + 配音）；只有要把视频拿去别处用时才导出。
 * 浏览器合成不了（老 Safari、安卓 Firefox 等）才请服务器代为导出，排队执行，作为兜底。
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Download, Laptop, Server, X } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { requestServerExport } from '@/services/real/quickCreation';
import { detectBrowserExport, exportFilmInBrowser, exportPlan, type ExportContainer, type ExportProgress, type ExportResult } from './browserExport';
import { formatClock } from './format';
import type { QcRun } from './types';

type State =
  | { s: 'idle' }
  | { s: 'exporting'; p: ExportProgress }
  | { s: 'done'; r: ExportResult }
  | { s: 'failed'; msg: string }
  | { s: 'server'; position: number; etaMin: number };

const mb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;

export function BrowserExport({ run }: { run: QcRun }) {
  const bundle = run.bundle;
  const [container, setContainer] = useState<ExportContainer | null | undefined>(undefined);
  const [state, setState] = useState<State>({ s: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const phone = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
  useEffect(() => { if (bundle) void detectBrowserExport(bundle).then(setContainer); }, [bundle]);
  useEffect(() => () => abort.current?.abort(), []);
  if (!bundle || run.kind !== 'video') return null;
  const durationSec = run.durationSec ?? 60;
  const plan = exportPlan(bundle, durationSec, phone);
  const fmt = container === 'webm' ? 'WebM' : 'MP4';

  const start = async () => {
    if (!container) return;
    abort.current = new AbortController();
    setState({ s: 'exporting', p: { frame: 0, frames: plan.frames, elapsedSec: 0, remainSec: plan.estSec } });
    try {
      const r = await exportFilmInBrowser({ bundle, durationSec, title: run.title, container, phone, mediaUrl: run.media?.url }, p => setState({ s: 'exporting', p }), abort.current.signal);
      setState({ s: 'done', r });
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') { setState({ s: 'idle' }); return; }
      setState({ s: 'failed', msg: '合成到一半停下了，可能是这台设备内存不够。可以关掉其他页面后重试，或请服务器导出。' });
    }
  };
  const viaServer = async () => {
    const res = await requestServerExport(run.id);
    if (res.success) setState({ s: 'server', position: res.data.position, etaMin: res.data.etaMin });
    else setState({ s: 'failed', msg: `${res.error?.message || '服务器这次没有接单'}，请稍后再试` });
  };

  if (state.s === 'exporting') {
    const pct = state.p.frames ? Math.round((state.p.frame / state.p.frames) * 100) : 0;
    return (
      <div className="mt-3 rounded-[10px] border border-token-subtle bg-[var(--bg-secondary)] p-3" data-qc="export-card" data-state="exporting">
        <div className="flex items-center gap-2 text-[13px] font-medium text-token-primary"><MapSpinner size={13} />正在用你的浏览器合成 {fmt}</div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--border-default)]"><div className="qc-bar-live h-full rounded-full transition-[width] duration-200" style={{ width: `${pct}%` }} /></div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[12px] tabular-nums text-token-secondary">
          <span>第 {state.p.frame.toLocaleString('en-US')} / {state.p.frames.toLocaleString('en-US')} 帧</span>
          <span>已用 {formatClock(state.p.elapsedSec)}</span>
          {state.p.remainSec != null && <span>还需约 {formatClock(state.p.remainSec)}</span>}
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-[12px] text-token-muted">保持这个页面在前台，切走会变慢。</span>
          <Button size="xs" variant="ghost" data-qc="export-cancel" onClick={() => abort.current?.abort()}><X size={12} />取消</Button>
        </div>
      </div>
    );
  }
  if (state.s === 'done') {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border border-token-subtle bg-[var(--bg-secondary)] p-3" data-qc="export-card" data-state="done">
        <span className="inline-flex min-w-0 flex-1 items-center gap-2 text-[13px] text-token-primary"><Check size={15} className="shrink-0 text-[color:var(--accent-fg-success)]" aria-hidden />
          <span className="min-w-0 truncate">已导出 {state.r.fileName} · {mb(state.r.bytes)}</span></span>
        <a href={state.r.url} download={state.r.fileName} data-qc="export-download"
          className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-[var(--border-default)] px-3 text-[12px] font-medium text-token-primary hover-bg-soft max-md:h-11"><Download size={13} />下载</a>
      </div>
    );
  }
  if (state.s === 'server') {
    return (
      <div className="mt-3 rounded-[10px] border border-token-subtle bg-[var(--bg-secondary)] p-3 text-[12.5px] leading-5 text-token-secondary" data-qc="export-card" data-state="server">
        已交给服务器导出：前面还有 {state.position} 个，预计 {state.etaMin} 分钟后可以下载，完成后会通知你。
      </div>
    );
  }
  return (
    <div className="mt-3 border-t border-token-subtle pt-3" data-qc="export-idle">
      {container === undefined && <div className="flex h-8 items-center gap-2 text-[12px] text-token-muted"><MapSpinner size={12} />正在看这个浏览器能不能合成视频…</div>}
      {container && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Button size="sm" variant="secondary" className="max-md:min-h-11" data-qc="export-start" onClick={() => void start()}><Laptop size={13} />导出 {fmt} 文件</Button>
          <span className="text-[12px] text-token-muted">在你的浏览器里合成，约 {formatClock(plan.estSec)}，不占服务器</span>
        </div>
      )}
      {container === null && (
        <div>
          <p className="m-0 text-[12.5px] leading-5 text-token-secondary" data-qc="export-unsupported">这个浏览器不能在本机合成视频。用电脑上的 Chrome、Edge 或 Safari 打开这一页就能导出；也可以请服务器代为导出（要排队）。</p>
          <Button size="sm" variant="secondary" className="mt-2 max-md:min-h-11" data-qc="export-server" onClick={() => void viaServer()}><Server size={13} />请服务器导出</Button>
        </div>
      )}
      {state.s === 'failed' && <p className="m-0 mt-2 text-[12px] text-token-secondary" role="alert">{state.msg}</p>}
    </div>
  );
}
