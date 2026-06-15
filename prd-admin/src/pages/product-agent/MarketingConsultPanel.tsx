/**
 * 产品管理 — 营销问策子模块（独立智能体）。
 *
 * 布局：顶部显眼介绍 banner + 左侧问策列表 + 右侧 AI 输入/回答。
 * 不强制选客户：默认自由文本输入「客户情况」即可问策；可选「选择已有客户一键问策」
 * （后端自动聚合该客户全部信息 + 动态跟进 + 问策知识库）。生成走 SSE 流式可视化，
 * 产出 4 套专业模版 HTML 报告，可切模版 / 分享 / 保存网页托管（全链路对照项目简报）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Sparkles, Square, X, Cpu, Share2, Link as LinkIcon, Globe,
  Download, Maximize2, Minimize2, Palette, ExternalLink, Plus, FileText,
} from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { connectSse } from '@/lib/useSseStream';
import { toast } from '@/lib/toast';
import {
  MARKETING_TEMPLATES,
  listAllConsultReports,
  listCustomers,
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

export function MarketingConsultModule({ initialCustomerId }: { initialCustomerId: string | null }) {
  const [reports, setReports] = useState<MarketingConsultListItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [viewing, setViewing] = useState<MarketingConsultReport | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // 组合（新问策）态
  const [input, setInput] = useState('');
  const [note, setNote] = useState('');
  const [template, setTemplate] = useState<MarketingTemplate>('exec');
  const [pickCustomerId, setPickCustomerId] = useState<string>(initialCustomerId ?? '');
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'failed'>('idle');
  const [stageMsg, setStageMsg] = useState('');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('');
  const [content, setContent] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const reloadList = useCallback(async () => {
    const res = await listAllConsultReports();
    if (res.success) setReports(res.data.items);
    setLoadingList(false);
  }, []);
  useEffect(() => { void reloadList(); }, [reloadList]);
  useEffect(() => {
    void listCustomers({}).then((res) => { if (res.success) setCustomers(res.data.items); });
  }, []);
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // 从客户列表/详情的快捷入口带入：预选客户并进入新问策
  useEffect(() => {
    if (initialCustomerId) { setPickCustomerId(initialCustomerId); setViewing(null); }
  }, [initialCustomerId]);

  const openReport = async (id: string) => {
    setBusyId(id);
    const res = await getConsultReport(id);
    setBusyId(null);
    if (res.success) setViewing(res.data);
    else toast.error('加载失败', res.error?.message);
  };

  const newConsult = () => { setViewing(null); setPhase('idle'); };

  const streaming = phase === 'streaming';

  const generate = async () => {
    if (!pickCustomerId && !input.trim()) { toast.error('请输入客户情况，或选择一个已有客户'); return; }
    setPhase('streaming'); setStageMsg('连接中…'); setModel(''); setThinking(''); setContent(''); setViewing(null);
    const controller = new AbortController();
    abortRef.current = controller;
    let reportId = '';
    let failed: string | null = null;
    try {
      await connectSse({
        url: consultGenerateUrl(),
        method: 'POST',
        body: { customerId: pickCustomerId || undefined, input: input.trim() || undefined, note: note.trim() || undefined, template },
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
        setPhase('idle'); setInput(''); setNote('');
        setViewing(res.data);
        void reloadList();
        return;
      }
      failed = res.error?.message || '报告加载失败';
    }
    if (failed) toast.error('生成失败', failed);
    setPhase('failed');
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 显眼介绍 banner */}
      <div className="flex items-start gap-3 rounded-2xl border border-cyan-500/25 bg-gradient-to-br from-cyan-500/[0.12] to-transparent p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-500/15">
          <Sparkles size={20} className="text-cyan-300" />
        </div>
        <div className="min-w-0">
          <div className="text-base font-semibold text-white">营销问策智能体</div>
          <div className="mt-0.5 text-xs leading-5 text-white/55">
            基于<span className="text-cyan-200/90">米多四力模型（4FM：产品力 · 渠道力 · 场景力 · 传播力）</span>与<span className="text-cyan-200/90">全域粉销</span>理念，为商户/客户做专业营销评估，并一键生成可分享的可视化报告。
          </div>
        </div>
      </div>

      {/* 左列表 + 右工作区 */}
      <div className="flex gap-4">
        {/* 左：问策列表 */}
        <div className="flex w-64 shrink-0 flex-col gap-2">
          <button
            onClick={newConsult}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-3 py-2 text-sm text-cyan-200 hover:bg-cyan-500/25"
          >
            <Plus size={14} /> 新问策
          </button>
          <div className="overflow-hidden rounded-xl border border-white/10">
            {loadingList ? (
              <div className="py-8"><MapSectionLoader text="加载中…" /></div>
            ) : reports.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-white/40">还没有问策记录。在右侧开始第一份评估。</div>
            ) : (
              <div className="max-h-[64vh] divide-y divide-white/5 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
                {reports.map((r) => {
                  const on = viewing?.id === r.id;
                  return (
                    <button
                      key={r.id}
                      onClick={() => openReport(r.id)}
                      className={`flex w-full flex-col gap-1 px-3 py-2.5 text-left ${on ? 'bg-cyan-500/10' : 'hover:bg-white/[0.03]'}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <FileText size={12} className="shrink-0 text-white/35" />
                        <span className="truncate text-[13px] text-white/85">{r.customerName || '自由问策'}</span>
                        {busyId === r.id && <MapSpinner size={11} />}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 pl-[18px] text-[10px] text-white/40">
                        <span>{fmtTime(r.createdAt)}</span>
                        {r.verdict && <span className={`rounded-full border px-1 py-px ${VERDICT_META[r.verdict].cls}`}>{VERDICT_META[r.verdict].label}</span>}
                        {r.shared && <Share2 size={9} className="text-emerald-300" />}
                        {r.hostedSiteUrl && <Globe size={9} className="text-cyan-300" />}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 右：输入 / 回答 */}
        <div className="min-w-0 flex-1">
          {viewing ? (
            <ConsultReportView report={viewing} onChanged={reloadList} onNew={newConsult} />
          ) : (
            <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-white/80">新的营销问策</span>
                {model && <span className="ml-1 flex items-center gap-1 font-mono text-[11px] text-white/40"><Cpu size={11} />{model}</span>}
              </div>

              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={5}
                disabled={streaming}
                placeholder="输入客户情况：经营阶段、所在行业/区域、近期动作、遇到的问题、想解决的营销诉求等。也可在下方选择一个已有客户做「一键问策」（自动带入其全部信息与动态跟进）。"
                className="resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-500/40 placeholder:text-white/25 disabled:opacity-50"
              />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-white/45">一键问策已有客户（可选）：</span>
                <select
                  value={pickCustomerId}
                  onChange={(e) => setPickCustomerId(e.target.value)}
                  disabled={streaming}
                  className="min-w-[180px] rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white outline-none focus:border-cyan-500/40 disabled:opacity-50"
                >
                  <option value="">不绑定客户（用上方自由文本）</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.merchantNo ? `（${c.merchantNo}）` : ''}</option>
                  ))}
                </select>
              </div>
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
                    <div className="max-h-40 overflow-y-auto rounded-md bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/45">
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
                    <Sparkles size={14} /> {pickCustomerId && !input.trim() ? '一键问策' : '生成问策评估'}
                  </button>
                  {phase === 'failed' && <span className="text-xs text-rose-300/80">上次生成未完成，可重试。</span>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
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

// ── 报告预览（右侧内联 + 可全屏） ──

function ConsultReportView({ report, onChanged, onNew }: { report: MarketingConsultReport; onChanged: () => void; onNew: () => void }) {
  const [r, setR] = useState(report);
  const [sharing, setSharing] = useState(false);
  const [hosting, setHosting] = useState(false);
  const [restyling, setRestyling] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => { setR(report); }, [report]);

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

  const toolbar = (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-white/10 px-3 py-2.5">
      <span className="max-w-[260px] truncate text-sm font-semibold text-white">{r.title}</span>
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
        {!fullscreen && <ToolBtn onClick={onNew}><Plus size={12} /> 新问策</ToolBtn>}
      </div>
    </div>
  );

  const stylePickerBar = pickerOpen && r.canRestyle && (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 bg-black/20 px-3 py-2.5">
      <span className="text-[11px] text-white/45">切换模版（即时重渲染，不重新调用 AI）：</span>
      <TemplatePicker value={r.template} onChange={restyle} disabled={restyling} />
    </div>
  );

  if (fullscreen) {
    return createPortal(
      <div className="fixed inset-0 z-[10000] flex flex-col bg-[#16181d]">
        {toolbar}
        {stylePickerBar}
        <div className="min-h-0 flex-1 bg-[#f3f4f6]">
          <iframe title={r.title} srcDoc={r.html || ''} sandbox="" style={{ width: '100%', height: '100%', border: 0, display: 'block' }} />
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[#16181d]">
      {toolbar}
      {stylePickerBar}
      <div className="bg-[#f3f4f6]" style={{ height: '72vh' }}>
        <iframe title={r.title} srcDoc={r.html || ''} sandbox="" style={{ width: '100%', height: '100%', border: 0, display: 'block' }} />
      </div>
    </div>
  );
}

function ToolBtn({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-[11px] text-white/60 hover:bg-white/5 disabled:opacity-40">
      {children}
    </button>
  );
}
