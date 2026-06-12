import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Sparkles, Square, Download, Trash2, Eye, FileText, Cpu, Share2, Link as LinkIcon, Globe, Maximize2, Minimize2, Palette, ExternalLink } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { connectSse } from '@/lib/useSseStream';
import { api } from '@/services/api';
import { listPmBriefings, getPmBriefing, deletePmBriefing, toggleBriefingShare, saveBriefingToHosting, listBriefingStyles, restylePmBriefing } from '@/services';
import type { PmBriefing, PmBriefingStyle } from '@/services/contracts/pmAgent';
import { toast } from '@/lib/toast';

interface Props {
  projectId: string;
  canManage: boolean;
  /** 跳转到「资料 → 简报」管理页（报表 tab 轻入口只露最近 3 条，管理走那边） */
  onManageAll?: () => void;
}

export function downloadHtml(title: string, html: string) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title}.html`;
  a.click();
  URL.revokeObjectURL(url);
}

export function fmtDateTime(s: string) {
  const d = new Date(s);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 项目简报 —— AI 基于项目实时数据生成对外汇报 HTML 页。
 * 列表 + 生成（风格可选 + SSE 流式过程可视化）+ iframe 预览（可全屏/切风格）+ 下载/分享/托管。
 */
export function PmBriefingSection({ projectId, canManage, onManageAll }: Props) {
  const [items, setItems] = useState<PmBriefing[]>([]);
  const [loading, setLoading] = useState(true);
  const [genOpen, setGenOpen] = useState(false);
  const [viewing, setViewing] = useState<PmBriefing | null>(null); // 含 html 的详情
  const [busyId, setBusyId] = useState<string | null>(null);
  const [styles, setStyles] = useState<PmBriefingStyle[]>([]);

  const load = useCallback(async () => {
    const res = await listPmBriefings(projectId);
    if (res.success) setItems(res.data.items);
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { listBriefingStyles().then((res) => { if (res.success) setStyles(res.data.items); }); }, []);

  const styleLabel = (key?: string) => styles.find((s) => s.key === key)?.label;

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
    <div className="rounded-lg border p-4 flex flex-col gap-3 shrink-0" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <FileText size={15} style={{ color: '#2563EB' }} />
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>项目简报</span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>AI 汇总项目实时数据生成对外汇报页，可预览 / 分享 / 下载 / 存托管</span>
        <div className="ml-auto flex items-center gap-1.5">
          {onManageAll && items.length > 0 && (
            <Button variant="ghost" size="sm" onClick={onManageAll}>管理全部 ({items.length})</Button>
          )}
          {canManage && (
            <Button variant="primary" size="sm" onClick={() => setGenOpen(true)}><Sparkles size={13} />生成简报</Button>
          )}
        </div>
      </div>

      {loading ? (
        <MapSectionLoader text="正在加载简报…" />
      ) : items.length === 0 ? (
        <div className="text-[12px] text-center py-6 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
          {canManage ? '还没有简报。点「生成简报」，AI 会基于目标 / 里程碑 / 任务 / 风险实时数据生成对外汇报页。' : '还没有简报。'}
        </div>
      ) : (
        <div className="flex flex-col">
          {(onManageAll ? items.slice(0, 3) : items).map((b) => (
            <div key={b.id} className="group flex items-center gap-3 py-2 px-2 rounded-md hover:bg-[var(--bg-base)] cursor-pointer" onClick={() => openView(b.id)}>
              <FileText size={14} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] truncate" style={{ color: 'var(--text-primary)' }}>{b.title}</div>
                <div className="text-[10.5px] flex items-center gap-2 flex-wrap" style={{ color: 'var(--text-muted)' }}>
                  <span>{fmtDateTime(b.createdAt)}</span>
                  {b.createdByName && <span>{b.createdByName}</span>}
                  {styleLabel(b.style) && <span className="inline-flex items-center gap-1"><Palette size={9} />{styleLabel(b.style)}</span>}
                  {b.model && <span className="inline-flex items-center gap-1 font-mono"><Cpu size={9} />{b.model}</span>}
                  {b.shared && <span className="inline-flex items-center gap-1" style={{ color: '#10B981' }}><Share2 size={9} />分享中</span>}
                  {b.hostedSiteUrl && (
                    <a href={b.hostedSiteUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 hover:underline" style={{ color: '#2563EB' }}><Globe size={9} />已托管</a>
                  )}
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
          {onManageAll && items.length > 3 && (
            <button onClick={onManageAll} className="text-[11.5px] text-left py-1.5 px-2 rounded-md hover:bg-[var(--bg-base)]" style={{ color: 'var(--text-muted)' }}>
              还有 {items.length - 3} 份简报，去「资料 - 简报」搜索 / 重命名 / 批量管理
            </button>
          )}
        </div>
      )}

      {genOpen && (
        <BriefingGenerateModal projectId={projectId} styles={styles}
          onClose={() => setGenOpen(false)}
          onDone={(b) => { setGenOpen(false); setViewing(b); load(); }} />
      )}
      {viewing && <BriefingViewModal briefing={viewing} styles={styles} canManage={canManage} onChanged={load} onClose={() => setViewing(null)} />}
    </div>
  );
}

/** 风格选择卡（生成前选择 + 预览弹窗内切换共用） */
export function StylePicker({ styles, value, onChange, disabled }: { styles: PmBriefingStyle[]; value: string; onChange: (k: string) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {styles.map((s) => {
        const active = s.key === value;
        return (
          <button key={s.key} onClick={() => onChange(s.key)} disabled={disabled}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border text-[12px] disabled:opacity-50"
            style={{
              borderColor: active ? s.accent : 'var(--border-subtle)',
              background: active ? `${s.accent}14` : 'var(--bg-base)',
              color: active ? s.accent : 'var(--text-secondary)',
              fontWeight: active ? 600 : 400,
              boxShadow: active ? `0 0 0 1px ${s.accent}` : 'none',
            }}>
            <span className="rounded-full border" style={{ width: 16, height: 16, background: s.pageBg, borderColor: 'var(--border-subtle)', display: 'inline-block' }}>
              <span className="block rounded-full" style={{ width: 6, height: 6, background: s.accent, margin: '5px auto 0' }} />
            </span>
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

/** 生成简报模态 —— 先选风格，再 SSE 阶段 + 思考 + 逐字流，全程可视化（CLAUDE.md 规则 #6 禁止空白等待）。 */
export function BriefingGenerateModal({ projectId, styles, onClose, onDone }: { projectId: string; styles: PmBriefingStyle[]; onClose: () => void; onDone: (b: PmBriefing) => void }) {
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'failed'>('idle');
  const [style, setStyle] = useState('classic');
  const [stageMsg, setStageMsg] = useState('连接中…');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('');
  const [content, setContent] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const start = async () => {
    setPhase('streaming'); setStageMsg('连接中…'); setModel(''); setThinking(''); setContent('');
    const controller = new AbortController();
    abortRef.current = controller;
    let briefingId = '';
    let failed: string | null = null;
    try {
      await connectSse({
        url: `${api.pm.projects.briefingsGenerate(encodeURIComponent(projectId))}?style=${encodeURIComponent(style)}`,
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
    if (failed) toast.error('生成失败', failed);
    setPhase('failed');
  };

  const modal = (
    <div className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="rounded-xl border flex flex-col w-full" style={{ maxWidth: 720, height: '70vh', maxHeight: '70vh', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <Sparkles size={17} style={{ color: '#2563EB' }} />
          <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>AI 生成项目简报</div>
          {model && <span className="text-[11px] font-mono ml-2" style={{ color: 'var(--text-muted)' }}>{model}</span>}
          <button onClick={() => { abortRef.current?.abort(); onClose(); }} className="ml-auto p-1 rounded hover:opacity-70 shrink-0" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>
        <div className="flex-1 px-5 py-4 flex flex-col gap-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {phase === 'idle' && (
            <>
              <div className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
                将汇总本项目的目标 / 里程碑 / 任务 / 风险实时数据，AI 撰写对外简报并渲染为可分享的 HTML 页。先选一个风格：
              </div>
              <StylePicker styles={styles} value={style} onChange={setStyle} />
            </>
          )}
          {phase === 'streaming' && (
            <>
              <div className="flex items-center gap-2 text-[12px]" style={{ color: '#2563EB' }}><MapSpinner size={14} /> {stageMsg}</div>
              {thinking && <div className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)', maxHeight: 140, overflowY: 'auto' }}><StreamingText text={thinking} streaming mode="blur" /></div>}
              {content && <div className="rounded-lg px-3 py-2 text-[12px] font-mono" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}><StreamingText text={content} streaming mode="blur" /></div>}
            </>
          )}
          {phase === 'failed' && (
            <div className="text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>生成未完成（已中断或失败），可重新开始。</div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3.5 shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          {phase === 'streaming'
            ? <Button variant="secondary" onClick={() => { abortRef.current?.abort(); onClose(); }}><Square size={13} />停止</Button>
            : (
              <>
                <Button variant="ghost" onClick={onClose}>取消</Button>
                <Button variant="primary" onClick={start}><Sparkles size={14} />{phase === 'failed' ? '重新生成' : '开始生成'}</Button>
              </>
            )}
        </div>
      </div>
    </div>
  );
  return createPortal(modal, document.body);
}

/** 简报预览模态 —— iframe 渲染（sandbox 禁脚本）；支持全屏、切换风格、下载、分享（可撤销）、保存到网页托管。 */
export function BriefingViewModal({ briefing, styles, canManage, onChanged, onClose }: { briefing: PmBriefing; styles: PmBriefingStyle[]; canManage: boolean; onChanged: () => void; onClose: () => void }) {
  const [b, setB] = useState(briefing);
  const [sharing, setSharing] = useState(false);
  const [hosting, setHosting] = useState(false);
  const [restyling, setRestyling] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [stylePickerOpen, setStylePickerOpen] = useState(false);

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
    if (!res.success) { toast.error('保存到网页托管失败', res.error?.message || ''); return; }
    setB((p) => ({ ...p, hostedSiteId: res.data.siteId, hostedSiteUrl: res.data.siteUrl }));
    onChanged();
    toast.success('已保存到网页托管', '点击「打开托管站点」即可访问');
  };

  const restyle = async (styleKey: string) => {
    if (styleKey === b.style) { setStylePickerOpen(false); return; }
    setRestyling(true);
    const res = await restylePmBriefing(b.id, styleKey);
    setRestyling(false);
    setStylePickerOpen(false);
    if (!res.success) { toast.error('切换风格失败', res.error?.message || ''); return; }
    setB((p) => ({ ...p, style: res.data.style, html: res.data.html }));
    onChanged();
    toast.success('风格已切换', styles.find((s) => s.key === styleKey)?.label || styleKey);
  };

  const containerStyle: React.CSSProperties = fullscreen
    ? { width: '100vw', height: '100vh', maxWidth: '100vw', maxHeight: '100vh', borderRadius: 0, background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }
    : { maxWidth: 980, height: '90vh', maxHeight: '90vh', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' };

  const modal = (
    <div className={`surface-backdrop fixed inset-0 z-[100] flex items-center justify-center ${fullscreen ? '' : 'p-4'}`} onClick={onClose}>
      <div className="rounded-xl border flex flex-col w-full" style={containerStyle} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-3.5 shrink-0 border-b flex-wrap" style={{ borderColor: 'var(--border-subtle)' }}>
          <FileText size={15} style={{ color: '#2563EB' }} />
          <div className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)', maxWidth: 320 }}>{b.title}</div>
          {b.model && <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--text-muted)' }}>{b.model}</span>}
          <div className="ml-auto flex items-center gap-1.5 shrink-0 flex-wrap">
            {canManage && b.canRestyle && (
              <Button variant="ghost" size="sm" disabled={restyling} onClick={() => setStylePickerOpen((v) => !v)}>
                {restyling ? <MapSpinner size={13} /> : <Palette size={13} />}风格：{styles.find((s) => s.key === b.style)?.label || '经典商务'}
              </Button>
            )}
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
            {b.hostedSiteUrl ? (
              <Button variant="ghost" size="sm" onClick={() => window.open(b.hostedSiteUrl!, '_blank', 'noopener')}><ExternalLink size={13} />打开托管站点</Button>
            ) : canManage ? (
              <Button variant="ghost" size="sm" disabled={hosting} onClick={saveToHosting}>{hosting ? <MapSpinner size={13} /> : <Globe size={13} />}保存到网页托管</Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => b.html && downloadHtml(b.title, b.html)}><Download size={13} />下载 HTML</Button>
            <Button variant="ghost" size="sm" onClick={() => setFullscreen((v) => !v)} title={fullscreen ? '退出全屏' : '全屏预览'}>
              {fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}{fullscreen ? '退出全屏' : '全屏'}
            </Button>
            <button onClick={onClose} className="p-1 rounded hover:opacity-70" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
          </div>
        </div>
        {stylePickerOpen && canManage && b.canRestyle && (
          <div className="px-5 py-3 shrink-0 border-b flex items-center gap-3 flex-wrap" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)' }}>
            <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>切换风格（即时重渲染，不重新调用 AI）：</span>
            <StylePicker styles={styles} value={b.style || 'classic'} onChange={restyle} disabled={restyling} />
          </div>
        )}
        <div className="flex-1" style={{ minHeight: 0, background: '#F3F4F6' }}>
          <iframe title={b.title} srcDoc={b.html || ''} sandbox="" style={{ width: '100%', height: '100%', border: 0, display: 'block' }} />
        </div>
      </div>
    </div>
  );
  return createPortal(modal, document.body);
}
