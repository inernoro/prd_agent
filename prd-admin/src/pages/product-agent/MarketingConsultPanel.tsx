/**
 * 产品管理 — 客户详情「营销问策」面板。
 *
 * 输入客户情况（或一键问策=聚合客户全部信息+动态跟进），结合「问策知识库」由 AI 产出
 * 专业营销评估报告（SSE 流式可视化），可选 4 套专业模版生成 HTML 可视化报告，
 * 一键分享 / 保存到网页托管 / 切模版重渲染（全链路对照项目简报）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Sparkles, Square, X, Cpu, Clock, Eye, Share2, Link as LinkIcon, Globe,
  Download, Maximize2, Minimize2, Palette, ExternalLink,
} from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { connectSse } from '@/lib/useSseStream';
import { toast } from '@/lib/toast';
import {
  MARKETING_TEMPLATES,
  listConsultReports,
  getConsultReport,
  restyleConsultReport,
  shareConsultReport,
  saveConsultToHosting,
  consultGenerateUrl,
  consultSharedUrl,
} from '@/services/real/productAgent';
import type { Customer, MarketingConsultListItem, MarketingConsultReport, MarketingTemplate, MarketingVerdict } from './types';

const VERDICT_META: Record<MarketingVerdict, { label: string; cls: string }> = {
  healthy: { label: '健康', cls: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300' },
  watch: { label: '关注', cls: 'border-amber-400/25 bg-amber-400/10 text-amber-200' },
  risk: { label: '风险', cls: 'border-rose-400/25 bg-rose-400/10 text-rose-300' },
};

function downloadHtml(title: string, html: string) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${title}.html`; a.click();
  URL.revokeObjectURL(url);
}
function fmtTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
const templateLabel = (k: MarketingTemplate) => MARKETING_TEMPLATES.find((t) => t.key === k)?.label ?? k;

export function MarketingConsultPanel({ customer }: { customer: Customer }) {
  const [reports, setReports] = useState<MarketingConsultListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<MarketingConsultReport | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // 生成态
  const [input, setInput] = useState('');
  const [note, setNote] = useState('');
  const [template, setTemplate] = useState<MarketingTemplate>('exec');
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'failed'>('idle');
  const [stageMsg, setStageMsg] = useState('');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('');
  const [content, setContent] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    const res = await listConsultReports(customer.id);
    if (res.success) setReports(res.data.items);
    setLoading(false);
  }, [customer.id]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const openView = async (id: string) => {
    setBusyId(id);
    const res = await getConsultReport(id);
    setBusyId(null);
    if (res.success) setViewing(res.data);
    else toast.error('加载失败', res.error?.message);
  };

  const generate = async () => {
    setPhase('streaming'); setStageMsg('连接中…'); setModel(''); setThinking(''); setContent('');
    const controller = new AbortController();
    abortRef.current = controller;
    let reportId = '';
    let failed: string | null = null;
    try {
      await connectSse({
        url: consultGenerateUrl(customer.id),
        method: 'POST',
        body: { input: input.trim() || undefined, note: note.trim() || undefined, template },
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
            else if (evt.event === 'done' && data.reportId) reportId = data.reportId;
          } catch { /* ignore */ }
        },
      });
    } catch { /* aborted / network */ }
    abortRef.current = null;
    if (reportId) {
      const res = await getConsultReport(reportId);
      if (res.success) {
        setPhase('idle');
        setViewing(res.data);
        void reload();
        return;
      }
      failed = res.error?.message || '报告加载失败';
    }
    if (failed) toast.error('生成失败', failed);
    setPhase('failed');
  };

  const streaming = phase === 'streaming';

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {/* 输入 + 模版 + 生成 */}
      <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-cyan-300" />
          <span className="text-sm font-medium text-white/80">营销问策</span>
          {model && <span className="ml-1 flex items-center gap-1 font-mono text-[11px] text-white/40"><Cpu size={11} />{model}</span>}
        </div>
        <p className="text-xs leading-5 text-white/45">
          结合该客户全部信息、动态跟进与「问策知识库」（全域粉销 / 4FM），AI 产出专业营销评估。留空直接「一键问策」，或填写当前客户情况让评估更聚焦。
        </p>

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={3}
          disabled={streaming}
          placeholder="（可选）描述客户当前情况：经营阶段、近期动作、遇到的问题、想解决的营销诉求等。留空则由系统自动聚合该客户全部信息一键问策。"
          className="resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/40 placeholder:text-white/25 disabled:opacity-50"
        />
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={streaming}
          placeholder="（可选）补充要求：如更侧重渠道力 / 给管理层看 / 语气更正式"
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none focus:border-cyan-500/40 placeholder:text-white/25 disabled:opacity-50"
        />

        <div>
          <div className="mb-1.5 text-xs text-white/50">报告模版</div>
          <TemplatePicker value={template} onChange={setTemplate} disabled={streaming} />
        </div>

        {streaming ? (
          <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-black/20 p-3">
            <div className="flex items-center gap-2 text-xs text-cyan-300"><MapSpinner size={14} /> {stageMsg}</div>
            {thinking && (
              <div className="max-h-32 overflow-y-auto rounded-md bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/45">
                <StreamingText text={thinking} streaming mode="blur" />
              </div>
            )}
            {content && (
              <div className="rounded-md bg-white/[0.03] px-2.5 py-1.5 font-mono text-xs text-white/60">
                <StreamingText text={content} streaming mode="blur" />
              </div>
            )}
            <div className="flex justify-end">
              <button onClick={() => { abortRef.current?.abort(); setPhase('idle'); }} className="flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/60 hover:bg-white/5">
                <Square size={13} /> 停止
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button onClick={generate} className="flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/20 px-4 py-2 text-sm text-cyan-200 hover:bg-cyan-500/30">
              <Sparkles size={14} /> {input.trim() ? '生成问策评估' : '一键问策'}
            </button>
            {phase === 'failed' && <span className="text-xs text-rose-300/80">上次生成未完成，可重试。</span>}
          </div>
        )}
      </div>

      {/* 历史报告 */}
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium text-white/70">历史评估报告</div>
        {loading ? (
          <MapSectionLoader text="正在加载报告…" />
        ) : reports.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/15 py-8 text-center text-sm text-white/40">还没有问策报告。在上方点「一键问策」生成第一份。</div>
        ) : (
          <div className="divide-y divide-white/5 rounded-xl border border-white/10">
            {reports.map((r) => (
              <div key={r.id} className="group flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-white/[0.03]" onClick={() => openView(r.id)}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-white/90">{r.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-white/40">
                    <span className="flex items-center gap-1"><Clock size={10} />{fmtTime(r.createdAt)}</span>
                    {r.createdByName && <span>{r.createdByName}</span>}
                    <span className="flex items-center gap-1"><Palette size={10} />{templateLabel(r.template)}</span>
                    {r.model && <span className="flex items-center gap-1 font-mono"><Cpu size={10} />{r.model}</span>}
                    {r.verdict && <span className={`rounded-full border px-1.5 py-px text-[10px] ${VERDICT_META[r.verdict].cls}`}>{VERDICT_META[r.verdict].label}</span>}
                    {r.shared && <span className="flex items-center gap-1 text-emerald-300"><Share2 size={10} />分享中</span>}
                    {r.hostedSiteUrl && <span className="flex items-center gap-1 text-cyan-300"><Globe size={10} />已托管</span>}
                  </div>
                </div>
                {busyId === r.id ? <MapSpinner size={14} /> : <Eye size={14} className="text-white/30 opacity-0 group-hover:opacity-100" />}
              </div>
            ))}
          </div>
        )}
      </div>

      {viewing && <ConsultViewModal report={viewing} onChanged={reload} onClose={() => setViewing(null)} />}
    </div>
  );
}

function TemplatePicker({ value, onChange, disabled }: { value: MarketingTemplate; onChange: (k: MarketingTemplate) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {MARKETING_TEMPLATES.map((t) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            disabled={disabled}
            title={t.desc}
            className={`rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50 ${on ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-200' : 'border-white/10 text-white/55 hover:bg-white/5'}`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ── 报告预览（iframe + 分享 / 托管 / 切模版） ──

function ConsultViewModal({ report, onChanged, onClose }: { report: MarketingConsultReport; onChanged: () => void; onClose: () => void }) {
  const [r, setR] = useState(report);
  const [sharing, setSharing] = useState(false);
  const [hosting, setHosting] = useState(false);
  const [restyling, setRestyling] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const shareUrl = r.shareToken ? `${window.location.origin}${consultSharedUrl(r.shareToken)}` : '';

  const copyShare = async (url: string) => {
    try { await navigator.clipboard.writeText(url); toast.success('分享链接已复制', '匿名可直接打开，撤销分享后失效'); }
    catch { toast.error('复制失败', url); }
  };

  const toggleShare = async (enabled: boolean) => {
    setSharing(true);
    const res = await shareConsultReport(r.id, enabled);
    setSharing(false);
    if (!res.success) { toast.error('操作失败', res.error?.message); return; }
    setR((p) => ({ ...p, shared: res.data.shared, shareToken: res.data.shareToken }));
    onChanged();
    if (res.data.shared && res.data.shareToken) await copyShare(`${window.location.origin}${consultSharedUrl(res.data.shareToken)}`);
    else if (!res.data.shared) toast.success('已撤销分享', '原链接立即失效');
  };

  const saveHosting = async () => {
    setHosting(true);
    const res = await saveConsultToHosting(r.id);
    setHosting(false);
    if (!res.success) { toast.error('保存到网页托管失败', res.error?.message); return; }
    setR((p) => ({ ...p, hostedSiteId: res.data.siteId, hostedSiteUrl: res.data.siteUrl }));
    onChanged();
    toast.success('已保存到网页托管', '点击「打开托管站点」即可访问');
  };

  const restyle = async (key: MarketingTemplate) => {
    setPickerOpen(false);
    if (key === r.template) return;
    setRestyling(true);
    const res = await restyleConsultReport(r.id, key);
    setRestyling(false);
    if (!res.success) { toast.error('切换模版失败', res.error?.message); return; }
    setR((p) => ({ ...p, template: res.data.template, html: res.data.html }));
    onChanged();
    toast.success('模版已切换', templateLabel(key));
  };

  const containerStyle: React.CSSProperties = fullscreen
    ? { width: '100vw', height: '100vh', maxWidth: '100vw', maxHeight: '100vh', borderRadius: 0 }
    : { maxWidth: 980, width: '100%', height: '90vh', maxHeight: '90vh' };

  return createPortal(
    <div className={`fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 ${fullscreen ? '' : 'p-4'}`} onClick={onClose}>
      <div className="flex flex-col rounded-xl border border-white/10 bg-[#16181d]" style={containerStyle} onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-white/10 px-4 py-3">
          <span className="max-w-[280px] truncate text-sm font-semibold text-white">{r.title}</span>
          {r.model && <span className="font-mono text-[11px] text-white/40">{r.model}</span>}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {r.canRestyle && (
              <ToolBtn onClick={() => setPickerOpen((v) => !v)} disabled={restyling}>
                {restyling ? <MapSpinner size={12} /> : <Palette size={12} />} 模版：{templateLabel(r.template)}
              </ToolBtn>
            )}
            {r.shared ? (
              <>
                <ToolBtn onClick={() => copyShare(shareUrl)}><LinkIcon size={12} /> 复制链接</ToolBtn>
                <ToolBtn onClick={() => toggleShare(false)} disabled={sharing}>{sharing ? <MapSpinner size={12} /> : <X size={12} />} 撤销分享</ToolBtn>
              </>
            ) : (
              <ToolBtn onClick={() => toggleShare(true)} disabled={sharing}>{sharing ? <MapSpinner size={12} /> : <Share2 size={12} />} 开启分享</ToolBtn>
            )}
            {r.hostedSiteUrl ? (
              <ToolBtn onClick={() => window.open(r.hostedSiteUrl!, '_blank', 'noopener')}><ExternalLink size={12} /> 打开托管站点</ToolBtn>
            ) : (
              <ToolBtn onClick={saveHosting} disabled={hosting}>{hosting ? <MapSpinner size={12} /> : <Globe size={12} />} 保存到网页托管</ToolBtn>
            )}
            <ToolBtn onClick={() => r.html && downloadHtml(r.title, r.html)}><Download size={12} /> 下载 HTML</ToolBtn>
            <ToolBtn onClick={() => setFullscreen((v) => !v)}>{fullscreen ? <Minimize2 size={12} /> : <Maximize2 size={12} />} {fullscreen ? '退出全屏' : '全屏'}</ToolBtn>
            <button onClick={onClose} className="rounded p-1 text-white/40 hover:text-white"><X size={16} /></button>
          </div>
        </div>
        {pickerOpen && r.canRestyle && (
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 bg-black/20 px-4 py-2.5">
            <span className="text-[11px] text-white/45">切换模版（即时重渲染，不重新调用 AI）：</span>
            <TemplatePicker value={r.template} onChange={restyle} disabled={restyling} />
          </div>
        )}
        <div className="min-h-0 flex-1 bg-[#f3f4f6]">
          <iframe title={r.title} srcDoc={r.html || ''} sandbox="" style={{ width: '100%', height: '100%', border: 0, display: 'block' }} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ToolBtn({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-white/60 hover:bg-white/5 disabled:opacity-40">
      {children}
    </button>
  );
}
