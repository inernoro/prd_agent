import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Sparkles, Square, Download, Trash2, Eye, FileText, Cpu, Share2, Link as LinkIcon, Globe } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { connectSse } from '@/lib/useSseStream';
import { api } from '@/services/api';
import { listPmBriefings, getPmBriefing, deletePmBriefing, toggleBriefingShare, saveBriefingToHosting } from '@/services';
import type { PmBriefing } from '@/services/contracts/pmAgent';
import { toast } from '@/lib/toast';

interface Props {
  projectId: string;
  canManage: boolean;
}

function downloadHtml(title: string, html: string) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title}.html`;
  a.click();
  URL.revokeObjectURL(url);
}

function fmtDateTime(s: string) {
  const d = new Date(s);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 项目简报 —— AI 基于项目实时数据生成对外汇报 HTML 页。
 * 列表 + 生成（SSE 流式过程可视化）+ iframe 预览 + 下载单文件。
 */
export function PmBriefingSection({ projectId, canManage }: Props) {
  const [items, setItems] = useState<PmBriefing[]>([]);
  const [loading, setLoading] = useState(true);
  const [genOpen, setGenOpen] = useState(false);
  const [viewing, setViewing] = useState<PmBriefing | null>(null); // 含 html 的详情
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await listPmBriefings(projectId);
    if (res.success) setItems(res.data.items);
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const openView = async (id: string) => {
    setBusyId(id);
    const res = await getPmBriefing(id);
    setBusyId(null);
    if (res.success) setViewing(res.data);
    else toast.error('加载失败', res.error?.message || '');
  };

  const download = async (b: PmBriefing) => {
    setBusyId(b.id);
    const res = await getPmBriefing(b.id);
    setBusyId(null);
    if (res.success && res.data.html) downloadHtml(res.data.title, res.data.html);
    else toast.error('下载失败', res.error?.message || '');
  };

  const remove = async (b: PmBriefing) => {
    if (!window.confirm(`确定删除简报「${b.title}」？`)) return;
    setBusyId(b.id);
    const res = await deletePmBriefing(b.id);
    setBusyId(null);
    if (res.success) { toast.success('已删除', ''); load(); }
    else toast.error('删除失败', res.error?.message || '');
  };

  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <FileText size={15} style={{ color: '#2563EB' }} />
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>项目简报</span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>AI 汇总项目实时数据生成对外汇报页，可预览 / 下载 HTML 单文件</span>
        {canManage && (
          <Button variant="primary" size="sm" className="ml-auto" onClick={() => setGenOpen(true)}><Sparkles size={13} />生成简报</Button>
        )}
      </div>

      {loading ? (
        <MapSectionLoader text="正在加载简报…" />
      ) : items.length === 0 ? (
        <div className="text-[12px] text-center py-6 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
          {canManage ? '还没有简报。点「生成简报」，AI 会基于目标 / 里程碑 / 任务 / 风险实时数据生成对外汇报页。' : '还没有简报。'}
        </div>
      ) : (
        <div className="flex flex-col">
          {items.map((b) => (
            <div key={b.id} className="group flex items-center gap-3 py-2 px-2 rounded-md hover:bg-[var(--bg-base)] cursor-pointer" onClick={() => openView(b.id)}>
              <FileText size={14} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] truncate" style={{ color: 'var(--text-primary)' }}>{b.title}</div>
                <div className="text-[10.5px] flex items-center gap-2 flex-wrap" style={{ color: 'var(--text-muted)' }}>
                  <span>{fmtDateTime(b.createdAt)}</span>
                  {b.createdByName && <span>{b.createdByName}</span>}
                  {b.model && <span className="inline-flex items-center gap-1 font-mono"><Cpu size={9} />{b.model}</span>}
                  {b.shared && <span className="inline-flex items-center gap-1" style={{ color: '#10B981' }}><Share2 size={9} />分享中</span>}
                  {b.hostedSiteId && <span className="inline-flex items-center gap-1" style={{ color: '#2563EB' }}><Globe size={9} />已托管</span>}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                {busyId === b.id ? <MapSpinner size={13} /> : (
                  <>
                    <button onClick={() => openView(b.id)} className="p-1 rounded" title="预览" style={{ color: 'var(--text-muted)' }}><Eye size={13} /></button>
                    <button onClick={() => download(b)} className="p-1 rounded" title="下载 HTML" style={{ color: 'var(--text-muted)' }}><Download size={13} /></button>
                    {canManage && <button onClick={() => remove(b)} className="p-1 rounded" title="删除" style={{ color: 'var(--text-muted)' }}><Trash2 size={13} /></button>}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {genOpen && (
        <BriefingGenerateModal projectId={projectId}
          onClose={() => setGenOpen(false)}
          onDone={(b) => { setGenOpen(false); setViewing(b); load(); }} />
      )}
      {viewing && <BriefingViewModal briefing={viewing} canManage={canManage} onChanged={load} onClose={() => setViewing(null)} />}
    </div>
  );
}

/** 生成简报模态 —— SSE 阶段 + 思考 + 逐字流，全程可视化（CLAUDE.md 规则 #6 禁止空白等待）。 */
function BriefingGenerateModal({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: (b: PmBriefing) => void }) {
  const [phase, setPhase] = useState<'streaming' | 'failed'>('streaming');
  const [stageMsg, setStageMsg] = useState('连接中…');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('');
  const [content, setContent] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    let briefingId = '';
    let failed: string | null = null;
    (async () => {
      try {
        await connectSse({
          url: api.pm.projects.briefingsGenerate(encodeURIComponent(projectId)),
          method: 'POST',
          signal: controller.signal,
          onEvent: (evt) => {
            if (!evt.data) return;
            try {
              const data = JSON.parse(evt.data) as Record<string, string | undefined>;
              if (evt.event === 'stage') setStageMsg(data.message || '');
              else if (evt.event === 'model') setModel(data.model || '');
              else if (evt.event === 'thinking') setThinking((p) => p + (data.text || ''));
              else if (evt.event === 'typing') setContent((p) => p + (data.text || ''));
              else if (evt.event === 'error') failed = data.message || '生成失败';
              else if (evt.event === 'done' && data.briefingId) briefingId = data.briefingId;
            } catch { /* ignore */ }
          },
        });
      } catch { /* aborted / network */ }
      abortRef.current = null;
      if (briefingId) {
        const res = await getPmBriefing(briefingId);
        if (res.success) { onDone(res.data); return; }
        failed = res.error?.message || '简报加载失败';
      }
      if (failed) { toast.error('生成失败', failed); setPhase('failed'); }
      else setPhase('failed'); // 连接中断
    })();
    return () => { controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const modal = (
    <div className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="rounded-xl border flex flex-col w-full" style={{ maxWidth: 720, height: '70vh', maxHeight: '70vh', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <Sparkles size={17} style={{ color: '#2563EB' }} />
          <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>AI 生成项目简报</div>
          {model && <span className="text-[11px] font-mono ml-2" style={{ color: 'var(--text-muted)' }}>{model}</span>}
          <button onClick={() => { abortRef.current?.abort(); onClose(); }} className="ml-auto p-1 rounded hover:opacity-70 shrink-0" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>
        <div className="flex-1 px-5 py-4 flex flex-col gap-2" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {phase === 'streaming' ? (
            <>
              <div className="flex items-center gap-2 text-[12px]" style={{ color: '#2563EB' }}><MapSpinner size={14} /> {stageMsg}</div>
              {thinking && <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)', maxHeight: 140, overflowY: 'auto' }}><StreamingText text={thinking} streaming mode="blur" /></div>}
              {content && <div className="rounded-lg px-3 py-2 text-[12px] font-mono" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}><StreamingText text={content} streaming mode="blur" /></div>}
            </>
          ) : (
            <div className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>生成未完成（已中断或失败），可关闭后重试。</div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3.5 shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          {phase === 'streaming'
            ? <Button variant="secondary" onClick={() => { abortRef.current?.abort(); onClose(); }}><Square size={13} />停止</Button>
            : <Button variant="ghost" onClick={onClose}>关闭</Button>}
        </div>
      </div>
    </div>
  );
  return createPortal(modal, document.body);
}

/** 简报预览模态 —— iframe 渲染自包含 HTML（sandbox 禁脚本），可下载 / 分享（可撤销）/ 保存到网页托管。 */
function BriefingViewModal({ briefing, canManage, onChanged, onClose }: { briefing: PmBriefing; canManage: boolean; onChanged: () => void; onClose: () => void }) {
  const [b, setB] = useState(briefing);
  const [sharing, setSharing] = useState(false);
  const [hosting, setHosting] = useState(false);

  const shareUrl = b.shareToken ? `${window.location.origin}${api.pm.briefings.sharedView(encodeURIComponent(b.shareToken))}` : '';

  const copyShareUrl = async (url: string) => {
    try { await navigator.clipboard.writeText(url); toast.success('分享链接已复制', '匿名可直接打开，撤销分享后失效'); }
    catch { toast.error('复制失败', url); }
  };

  const toggleShare = async (enabled: boolean) => {
    setSharing(true);
    const res = await toggleBriefingShare(b.id, enabled);
    setSharing(false);
    if (!res.success) { toast.error('操作失败', res.error?.message || ''); return; }
    setB((p) => ({ ...p, shared: res.data.shared, shareToken: res.data.shareToken ?? null }));
    onChanged();
    if (res.data.shared && res.data.shareToken) {
      await copyShareUrl(`${window.location.origin}${api.pm.briefings.sharedView(encodeURIComponent(res.data.shareToken))}`);
    } else if (!res.data.shared) {
      toast.success('已撤销分享', '原链接立即失效');
    }
  };

  const saveToHosting = async () => {
    setHosting(true);
    const res = await saveBriefingToHosting(b.id);
    setHosting(false);
    if (!res.success) { toast.error('保存失败', res.error?.message || ''); return; }
    setB((p) => ({ ...p, hostedSiteId: res.data.siteId }));
    onChanged();
    toast.success('已保存到网页托管', '已在新标签页打开站点');
    window.open(res.data.siteUrl, '_blank', 'noopener');
  };

  const modal = (
    <div className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="rounded-xl border flex flex-col w-full" style={{ maxWidth: 980, height: '90vh', maxHeight: '90vh', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-3.5 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <FileText size={15} style={{ color: '#2563EB' }} />
          <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{b.title}</div>
          {b.model && <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>{b.model}</span>}
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {canManage && (
              b.shared ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => copyShareUrl(shareUrl)}><LinkIcon size={13} />复制分享链接</Button>
                  <Button variant="ghost" size="sm" disabled={sharing} onClick={() => toggleShare(false)}>{sharing ? <MapSpinner size={13} /> : <X size={13} />}撤销分享</Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" disabled={sharing} onClick={() => toggleShare(true)}>{sharing ? <MapSpinner size={13} /> : <Share2 size={13} />}开启分享</Button>
              )
            )}
            {canManage && (
              <Button variant="ghost" size="sm" disabled={hosting} onClick={saveToHosting}>
                {hosting ? <MapSpinner size={13} /> : <Globe size={13} />}{b.hostedSiteId ? '重新保存到托管' : '保存到网页托管'}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => b.html && downloadHtml(b.title, b.html)}><Download size={13} />下载 HTML</Button>
            <button onClick={onClose} className="p-1 rounded hover:opacity-70" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
          </div>
        </div>
        <div className="flex-1" style={{ minHeight: 0, background: '#F3F4F6' }}>
          <iframe title={b.title} srcDoc={b.html || ''} sandbox="" style={{ width: '100%', height: '100%', border: 0, display: 'block' }} />
        </div>
      </div>
    </div>
  );
  return createPortal(modal, document.body);
}
